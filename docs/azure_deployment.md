# Deploying to Azure

Two apps run on **Azure Container Apps** from the same image:

- **The public demo**: scripted, no keys, safe to share. Covered first.
- **The private app**: the real assistant (Claude API, real GitHub PRs) behind GitHub sign-in, for its owner only. See [The private app](#the-private-app).

The public demo runs on **Azure Container Apps**. Every merge to `main` builds a container image, pushes it to **Azure Container Registry**, and rolls it out, from the GitHub Actions workflow in `.github/workflows/deploy.yml`.

The demo is the scripted mode (`npm run web:demo`). The code search and file reading are real, over this repository's own source. The assistant's decisions and words are scripted, reviews use a sample pull request, and nothing is sent to Claude or GitHub. No API key exists in the image or in Azure, so a public URL costs nothing in model usage.

## What gets created

| Resource | Purpose | Defined in |
|---|---|---|
| Container Registry (Basic) | Holds the demo images. No admin user: pushes use the workflow's Entra ID identity, pulls use a managed identity | `infra/registry.bicep` |
| Log Analytics workspace | Container logs, 30-day retention, capped at 1 GB/day | `infra/main.bicep` |
| Container Apps environment | Hosts the app | `infra/main.bicep` |
| User-assigned managed identity | Lets the app pull from the registry (`AcrPull` on the registry only) | `infra/main.bicep` |
| Container App | 0.25 vCPU / 0.5 GiB, HTTPS only, scales from **0** to 1 replica, `/healthz` probes | `infra/main.bicep` |

**Cost.** Roughly **$5 a month**, almost all of it the registry's Basic tier. When nobody is using the demo it scales to zero, which stays inside the Container Apps monthly free grant. The trade-off is a few seconds of cold start on the first visit after it's been idle.

## How the deploy signs in (no stored secrets)

The workflow uses **OpenID Connect**. On each run GitHub issues a short-lived token whose subject says "this is tpotechno/codebase-qa-assistant, environment azure-demo", written with the owner's and repo's numeric IDs: `repo:tpotechno@44557011/codebase-qa-assistant@1426449283:environment:azure-demo`. Azure has been told to trust exactly that, through a *federated credential* on an app registration. The IDs never change, so a repo someone created later under the same name can't match it. So:

- There is no Azure password, client secret or publish profile in GitHub. The repository variables below are identifiers, not secrets.
- A fork, another branch's workflow, or another repository can't deploy: their tokens carry a different subject.
- The identity's roles are scoped to one resource group.

## One-time setup (about 10 minutes)

Run these in **Azure Cloud Shell** (the `>_` button at the top of portal.azure.com, choose **Bash**), so nothing needs installing. Change `LOCATION` if you want a different region.

```bash
RG=codebase-qa-demo-rg
LOCATION=westus2
REPO=tpotechno/codebase-qa-assistant

# 1. Let the subscription use the services involved (once per subscription; takes a minute or two).
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait
az provider register --namespace Microsoft.ContainerRegistry --wait
az provider register --namespace Microsoft.ManagedIdentity --wait

# 2. The resource group everything lives in.
az group create --name $RG --location $LOCATION
RG_ID=$(az group show --name $RG --query id -o tsv)

# 3. An identity for GitHub Actions, trusted only for this repo's azure-demo environment.
APP_ID=$(az ad app create --display-name codebase-qa-github-deploy --query appId -o tsv)
SP_ID=$(az ad sp create --id $APP_ID --query id -o tsv)
# GitHub's token subject includes the owner's and repo's numeric IDs:
#   repo:<owner>@<owner id>/<repo>@<repo id>:environment:azure-demo
OWNER_ID=$(curl -s https://api.github.com/repos/$REPO | jq -r .owner.id)
REPO_ID=$(curl -s https://api.github.com/repos/$REPO | jq -r .id)
SUBJECT="repo:${REPO%%/*}@$OWNER_ID/${REPO##*/}@$REPO_ID:environment:azure-demo"
echo "Trusting: $SUBJECT"
az ad app federated-credential create --id $APP_ID --parameters "{
  \"name\": \"github-azure-demo\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"$SUBJECT\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"

# 4. What it may do, in this resource group only: create resources, and grant the
#    app's pull identity access to the registry.
az role assignment create --assignee-object-id $SP_ID --assignee-principal-type ServicePrincipal \
  --role Contributor --scope $RG_ID
az role assignment create --assignee-object-id $SP_ID --assignee-principal-type ServicePrincipal \
  --role "Role Based Access Control Administrator" --scope $RG_ID

# 5. The values GitHub needs.
echo "AZURE_CLIENT_ID=$APP_ID"
echo "AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)"
echo "AZURE_SUBSCRIPTION_ID=$(az account show --query id -o tsv)"
echo "AZURE_RESOURCE_GROUP=$RG"
```

Then in GitHub, under the repository's **Settings → Secrets and variables → Actions → Variables** tab, add the four values printed at the end as **repository variables**. Use the Variables tab, not Secrets: they are identifiers, and the workflow reads them as `vars.*`.

Finally, start the first deploy from **Actions → Deploy demo to Azure → Run workflow**. Later merges to `main` deploy on their own. When the run finishes, its summary and the `azure-demo` environment show the demo's URL.

Until the variables exist, the deploy job is skipped rather than failing, so merging this before the setup is harmless.

## What a deploy does

1. Signs in to Azure with OIDC.
2. Deploys `infra/registry.bicep` (no-op after the first run).
3. Builds the image (`Dockerfile`: the Angular UI is built in one stage, the server runs in the other) and pushes it tagged with the commit SHA.
4. Deploys `infra/main.bicep` with that image. Container Apps starts a new revision and moves traffic once `/healthz` passes.
5. Smoke-tests the live URL: health, `/api/config` reports demo mode, and the UI is served.
6. Deploys `infra/private.bicep`. Until `PRIVATE_APP_ENABLED` is `true`, this creates only the Key Vault and the app's identity. After that, it also rolls out the private app and checks that it refuses unauthenticated requests.

Every change to the Azure resources goes through the Bicep files, so the infrastructure is reviewed in pull requests like the code.

## Security notes

- **The server only answers its own host name.** The Bicep passes the Container App's FQDN as `PUBLIC_HOSTS`, and the existing Host and Origin checks reject everything else. Only `/healthz` is answered for any Host, because the platform's probes arrive by IP.
- **Every response sets `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`.** The page sends a `Referer` only to the app itself, never to other sites. It has to be `same-origin` rather than `no-referrer`: Container Apps authentication refuses signed-in POSTs that carry no `Referer`.
- **The image contains no secrets.** `.dockerignore` excludes `.env`, git history and local `node_modules`. The container runs as the unprivileged `node` user.
- **Visitors can't steer the tools.** The scripted model makes the same calls every time, and `read_file` refuses paths outside the repository in any case.
- **One replica at most.** Drafts waiting to be "posted" live in memory, so a second replica could receive the post for a draft it never saw. The scripted demo needs nothing more.
- **The private app** has its own protections; see [The private app](#the-private-app).

## Troubleshooting

- **`AADSTS700213` / "no matching federated identity record"** means the token's subject didn't match. The error shows the subject GitHub presented. Compare it with `az ad app federated-credential list --id <AZURE_CLIENT_ID> -o table`, making sure you check the app whose ID is in the `AZURE_CLIENT_ID` variable. Older guides use the form without IDs (`repo:owner/repo:environment:...`), which no longer matches. A new or corrected credential can take a few minutes to take effect, so wait before re-running.
- **`AuthorizationFailed` on a role assignment** means step 4's second role is missing.
- **The first deploy fails pulling the image.** A new role assignment can take a few minutes to reach the registry. Re-run the workflow.
- **`MissingSubscriptionRegistration`** names a service the subscription hasn't enabled yet. Register the namespace in the message (`az provider register --namespace <name> --wait`) and re-run. If you did step 1, wait a minute: registration may still be in progress.
- **Logs:** portal → the Container App → *Log stream*, or `az containerapp logs show -n codebase-qa-demo -g codebase-qa-demo-rg --follow`.

## The private app

The real assistant, hosted for you alone. It's the same image and the same Container Apps environment as the demo, but it runs `src/web-server.ts`: real Claude calls, real GitHub PRs, and posting reviews with your token.

**How it's protected**

- **Sign-in at the door.** Container Apps authentication sends every visitor to GitHub to sign in before any request reaches the app. Only `/healthz` is exempt.
- **An allowlist in the app.** The platform passes the signed-in identity in the `X-MS-CLIENT-PRINCIPAL` header, and overwrites any copy a client sends. The server takes the GitHub **login** from that header's claims and admits only logins in `ALLOWED_GITHUB_USERS` (by default the repository owner); anyone else signed in gets a 403. It never matches on the display name, which any GitHub user can set to someone else's username. If it's bound to a public address without an allowlist, the server refuses to start.
- **Keys in Key Vault.** The Anthropic key, the GitHub token and the OAuth client secret are stored only in Key Vault. The Container App holds references, read with its own managed identity (`Key Vault Secrets User` on that vault only). They never pass through GitHub, the Bicep or the deploy logs.
- **The same limits as locally:** the per-review dollar cap (`REVIEW_MAX_BUDGET_USD`, default $1), the 10-minute timeout, two runs at a time, and the read-only review agent.

**Cost.** About $0 when idle: it scales to zero, and Key Vault charges fractions of a cent per thousand reads. What you pay for is Claude usage, capped per review.

### Setup (about 10 minutes, after the demo is working)

**1. Enable Key Vault** for the subscription, in Cloud Shell (Bash):

```bash
az provider register --namespace Microsoft.KeyVault --wait
```

**2. Let a deploy run** (merge to `main`, or **Actions → Deploy demo to Azure → Run workflow**). Its summary has a **Private app** section with the Key Vault name, the app's homepage URL and its authorization callback URL.

**3. Create the GitHub OAuth app** that sign-in uses: on GitHub, **Settings → Developer settings → OAuth Apps → New OAuth App**.
- Application name: `Codebase Q&A (private)`
- Homepage URL and Authorization callback URL: the two URLs from the run summary
- Register it. Copy the **Client ID**, then **Generate a new client secret** and copy it straight away, because GitHub shows it only once.

**4. Put the three secrets in Key Vault.** First give yourself permission to write secrets in that vault, which is a one-time step. `read -s` keeps each value off the screen and out of shell history:

```bash
RG=codebase-qa-demo-rg
VAULT=<Key Vault name from the run summary>
az role assignment create --assignee "$(az ad signed-in-user show --query id -o tsv)" \
  --role "Key Vault Secrets Officer" --scope "$(az keyvault show --name $VAULT --query id -o tsv)"
# The new role can take a minute; if the next command says Forbidden, wait and retry.

read -rsp "Anthropic API key: " v; echo; az keyvault secret set --vault-name $VAULT --name anthropic-api-key --value "$v" -o none
read -rsp "GitHub token: " v; echo; az keyvault secret set --vault-name $VAULT --name github-token --value "$v" -o none
read -rsp "GitHub OAuth client secret: " v; echo; az keyvault secret set --vault-name $VAULT --name github-oauth-secret --value "$v" -o none
unset v
```

The GitHub token is the fine-grained token you use locally: Pull requests read and write on the repos you want reviewed.

**5. Turn it on.** Add these **repository variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
|---|---|
| `PRIVATE_OAUTH_CLIENT_ID` | The OAuth app's Client ID (not a secret) |
| `PRIVATE_APP_ENABLED` | `true` |
| `PRIVATE_ALLOWED_USERS` | Optional. Comma-separated GitHub usernames; defaults to the repository owner |

**6. Deploy** (run the workflow again). Then open the app's URL, sign in with GitHub, and approve the OAuth app the first time. The footer shows who you're signed in as, with a sign-out link.

### Changing a key

Set the new value with `az keyvault secret set` as in step 4, then restart the app so it reads it:

```bash
az containerapp revision restart -n codebase-qa -g $RG \
  --revision "$(az containerapp revision list -n codebase-qa -g $RG --query '[0].name' -o tsv)"
```

### Private app troubleshooting

- **The deploy fails with a Key Vault or secret error** (for example "unable to fetch secret") when `PRIVATE_APP_ENABLED` is `true`. A secret from step 4 is missing or misnamed: the names must be exactly `anthropic-api-key`, `github-token` and `github-oauth-secret`.
- **GitHub says "The redirect_uri is not associated with this application"** when the OAuth app's callback URL doesn't exactly match the one in the run summary.
- **You sign in and get "… isn't allowed to use this app"** when your GitHub username (login, not display name) isn't in `PRIVATE_ALLOWED_USERS` (or the owner default). If the response also lists `claimTypes`, the sign-in arrived without a recognizable GitHub login claim; those claim names (no values) show what the platform sent.
- **Every Ask or Review fails with an empty `403`**, and the response has `x-ms-middleware-request-id` but no `x-frame-options`. The sign-in layer refused the POST before it reached the app, which happens when the request carries no `Referer`. The app's `Referrer-Policy: same-origin` makes the browser send one; check that a proxy or browser extension isn't stripping it.
- **Reviews or answers fail with an authentication error** when the Anthropic key or GitHub token in Key Vault is wrong. Fix it as in *Changing a key*.

## Tearing it down

```bash
az group delete --name codebase-qa-demo-rg
az ad app delete --id <AZURE_CLIENT_ID>
az keyvault purge --name <Key Vault name>   # deleted vaults are kept 7 days unless purged
```

Also delete the GitHub OAuth app under Developer settings.
