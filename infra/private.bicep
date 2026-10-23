// The real assistant, private to its owner: the same image as the demo, running the real
// web server (Claude API + GitHub), behind Container Apps authentication with GitHub sign-in.
// Keys live in Key Vault; this file only references them, so no secret passes through
// GitHub or the deployment.
//
// Two stages, so keys can be added before anything needs them:
//   deployApp = false  creates the vault and the app's identity, and reports the app's URL
//                      (needed to register the GitHub OAuth app)
//   deployApp = true   also creates the Container App and its sign-in configuration

@description('Azure region. Defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('Name of the Container App; also the first label of its host name.')
param appName string = 'codebase-qa'

@description('Existing Container Apps environment (created by main.bicep).')
param environmentName string = 'codebase-qa-demo-env'

@description('Registry created by registry.bicep.')
param registryName string

@description('Image to run (the same one the demo runs).')
param image string

@description('Create the Container App. Leave false until the Key Vault secrets exist.')
param deployApp bool = false

@description('Comma-separated GitHub usernames allowed to sign in.')
param allowedGithubUsers string = ''

@description('Client ID of the GitHub OAuth app used for sign-in (not a secret).')
param githubOAuthClientId string = ''

@description('Spend cap per review, in US dollars.')
param reviewMaxBudgetUsd string = '1'

@description('Key Vault name: 3-24 letters, digits and hyphens, globally unique.')
param vaultName string = 'cqakv${uniqueString(resourceGroup().id)}'

var tags = { project: 'codebase-qa-assistant' }
var port = 3334
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource env 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true // access by Azure role, not vault access policies
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

// One identity for the app: pulls the image and reads its secrets, nothing else.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-id'
  location: location
  tags: tags
}

resource canPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource canReadSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, kvSecretsUserRoleId)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

var fqdn = '${appName}.${env.properties.defaultDomain}'
var secretNames = ['anthropic-api-key', 'github-token', 'github-oauth-secret']

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: port
        transport: 'auto'
        allowInsecure: false
      }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
      // References only: the values stay in Key Vault and are read by the app's identity.
      secrets: map(secretNames, name => {
        name: name
        keyVaultUrl: '${vault.properties.vaultUri}secrets/${name}'
        identity: identity.id
      })
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          command: ['node_modules/.bin/tsx']
          args: ['src/web-server.ts']
          // The review agent runs Claude Code as a child process, so this gets more room than the demo.
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'GITHUB_TOKEN', secretRef: 'github-token' }
            { name: 'WEB_HOST', value: '0.0.0.0' }
            { name: 'WEB_PORT', value: string(port) }
            { name: 'PUBLIC_HOSTS', value: fqdn }
            { name: 'ALLOWED_GITHUB_USERS', value: allowedGithubUsers }
            { name: 'REVIEW_MAX_BUDGET_USD', value: reviewMaxBudgetUsd }
          ]
          probes: [
            { type: 'Startup', httpGet: { path: '/healthz', port: port }, periodSeconds: 2, failureThreshold: 30 }
            { type: 'Liveness', httpGet: { path: '/healthz', port: port }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: port }, periodSeconds: 10 }
          ]
        }
      ]
      // One replica: drafts and the run limit live in memory. Scales to zero when idle.
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
  dependsOn: [canPull, canReadSecrets]
}

// Sign-in in front of every request. Unauthenticated visitors are sent to GitHub; the
// server then checks the signed-in username against ALLOWED_GITHUB_USERS.
resource auth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = if (deployApp) {
  parent: app
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'github'
      excludedPaths: ['/healthz']
    }
    identityProviders: {
      gitHub: {
        enabled: true
        registration: {
          clientId: githubOAuthClientId
          clientSecretSettingName: 'github-oauth-secret'
        }
      }
    }
  }
}

output vaultName string = vault.name
output url string = 'https://${fqdn}'
output oauthCallbackUrl string = 'https://${fqdn}/.auth/login/github/callback'
