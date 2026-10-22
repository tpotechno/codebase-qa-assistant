// The public demo on Azure Container Apps: one small container that scales to zero when idle.
// It runs the scripted demo (no API keys, nothing sent to Claude or GitHub).

@description('Azure region. Defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('Name of the Container App; also the first label of its public host name.')
param appName string = 'codebase-qa-demo'

@description('Registry created by registry.bicep.')
param registryName string

@description('Full image reference to run, e.g. myregistry.azurecr.io/codebase-qa-demo:<git sha>.')
param image string

var tags = { project: 'codebase-qa-assistant' }
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var port = 3335

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 } // a public page should never run up a logging bill
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// The app pulls its image with this identity, so no registry password exists anywhere.
resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-pull'
  location: location
  tags: tags
}

resource canPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: port
        transport: 'auto'
        allowInsecure: false // plain HTTP is redirected to HTTPS
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: pullIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'demo'
          image: image
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'DEMO_HOST', value: '0.0.0.0' }
            { name: 'DEMO_PORT', value: string(port) }
            // The server only answers requests addressed to its own host name.
            { name: 'PUBLIC_HOSTS', value: '${appName}.${env.properties.defaultDomain}' }
          ]
          probes: [
            { type: 'Startup', httpGet: { path: '/healthz', port: port }, periodSeconds: 2, failureThreshold: 30 }
            { type: 'Liveness', httpGet: { path: '/healthz', port: port }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: port }, periodSeconds: 10 }
          ]
        }
      ]
      // Scale to zero when nobody is using it; one replica at most, because drafts live in memory.
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '20' } } }]
      }
    }
  }
  dependsOn: [canPull]
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
