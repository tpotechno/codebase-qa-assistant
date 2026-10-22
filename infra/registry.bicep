// Container registry for the demo image. Deployed first, so the image can be pushed
// before main.bicep points the Container App at it.

@description('Azure region. Defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('Registry name: 5-50 letters and digits, globally unique.')
@minLength(5)
@maxLength(50)
param registryName string = 'cqa${uniqueString(resourceGroup().id)}'

var tags = { project: 'codebase-qa-assistant' }
var acrPushRoleId = '8311e382-0749-4cb8-b61a-304f252e45ec'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    // No admin user: pushes use Entra ID (the deploy workflow's identity), pulls use a managed identity.
    adminUserEnabled: false
  }
}

// Whoever deploys this (the GitHub Actions identity) may push images to this registry only.
resource deployerCanPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, deployer().objectId, acrPushRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPushRoleId)
    principalId: deployer().objectId
    principalType: 'ServicePrincipal'
  }
}

output registryName string = registry.name
output loginServer string = registry.properties.loginServer
