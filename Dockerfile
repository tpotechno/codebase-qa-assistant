# The public demo: the web UI with a scripted model over this repository's own source.
# No API keys are needed or present in the image. See docs/azure_deployment.md.

# ---- Build the Angular UI ----
FROM node:24-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npx ng build

# ---- Runtime ----
FROM node:24-slim
ENV NODE_ENV=production \
    DEMO_HOST=0.0.0.0 \
    DEMO_PORT=3335
# The folder name is what the UI shows as the repository being asked about.
WORKDIR /codebase-qa-assistant
COPY package.json package-lock.json ./
# tsx (a devDependency) runs the TypeScript sources directly, so dev dependencies are kept.
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force
# The source is also the corpus the demo's search_code, read_file and search_docs tools read.
COPY . .
COPY --from=web /build/web/dist ./web/dist
USER node
EXPOSE 3335
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3335/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "scripts/demo-server.ts"]
