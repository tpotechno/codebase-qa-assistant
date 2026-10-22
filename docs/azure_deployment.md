# Deploying the demo to Azure

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

Every change to the Azure resources goes through the Bicep files, so the infrastructure is reviewed in pull requests like the code.

## Security notes

- **The server only answers its own host name.** The Bicep passes the Container App's FQDN as `PUBLIC_HOSTS`, and the existing Host and Origin checks reject everything else. Only `/healthz` is answered for any Host, because the platform's probes arrive by IP.
- **Every response sets `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.**
- **The image contains no secrets.** `.dockerignore` excludes `.env`, git history and local `node_modules`. The container runs as the unprivileged `node` user.
- **Visitors can't steer the tools.** The scripted model makes the same calls every time, and `read_file` refuses paths outside the repository in any case.
- **One replica at most.** Drafts waiting to be "posted" live in memory, so a second replica could receive the post for a draft it never saw. The scripted demo needs nothing more.

## Troubleshooting

- **`AADSTS700213` / "no matching federated identity record"** means the token's subject didn't match. The error shows the subject GitHub presented. Compare it with `az ad app federated-credential list --id <AZURE_CLIENT_ID> -o table`, making sure you check the app whose ID is in the `AZURE_CLIENT_ID` variable. Older guides use the form without IDs (`repo:owner/repo:environment:...`), which no longer matches. A new or corrected credential can take a few minutes to take effect, so wait before re-running.
- **`AuthorizationFailed` on a role assignment** means step 4's second role is missing.
- **The first deploy fails pulling the image.** A new role assignment can take a few minutes to reach the registry. Re-run the workflow.
- **`MissingSubscriptionRegistration`** means step 1 hasn't finished. Wait a minute and re-run.
- **Logs:** portal → the Container App → *Log stream*, or `az containerapp logs show -n codebase-qa-demo -g codebase-qa-demo-rg --follow`.

## Tearing it down

```bash
az group delete --name codebase-qa-demo-rg
az ad app delete --id <AZURE_CLIENT_ID>
```
