---
# Loads only when Claude works on deployment: Bicep, Docker, CI/CD workflows.
paths:
  - "infra/**"
  - "Dockerfile"
  - ".dockerignore"
  - ".github/workflows/**"
---

# Infrastructure and CI/CD conventions

- Ask before changing anything that affects the live Azure apps: `infra/*.bicep`,
  `.github/workflows/deploy.yml`, or the container's start command.
- Bicep must pass `az bicep lint` and `az bicep build` (CI runs both on every file in `infra/`).
- Secrets come from Key Vault references; never put secret values in Bicep, workflows or the image.
- GitHub Actions signs in to Azure with OIDC; never add stored Azure credentials or publish profiles.
- The demo image (`Dockerfile`) must stay keyless and keep answering `/healthz` and `/api/config`
  as the CI smoke test expects. Run `docker build` locally if you change it.
- Keep the CI checks that prove the servers refuse unsafe public binding.
- For Azure Container Apps, Key Vault or Bicep syntax, check Microsoft Learn rather than guessing.
  The Microsoft Learn MCP server can be added for this.
- Keep action versions pinned as the existing workflows do, and keep Node versions consistent
  with CI (22 for the backend job, 24 for the web job and the image).
