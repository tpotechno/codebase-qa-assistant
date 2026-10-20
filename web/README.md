# Web UI

Angular 21 front end for the Codebase Q&A and PR Review Assistant (standalone components, signals, zoneless).

It talks to the local API server in the parent project (`src/web-server.ts`). See the main [README](../README.md#web-ui) for setup.

| Command (from the repo root) | What it does |
|---|---|
| `npm run web:install` | Install the web app's packages |
| `npm run web:build` | Production build into `web/dist/`, served by `npm run web` |
| `npm run web:dev` | `ng serve` on port 4200 with live reload, proxying `/api` to `npm run web` on port 3334 |
| `npm run web:test` | Unit tests (Vitest) |
| `npm run web:demo` | The UI with a scripted stand-in for Claude, on port 3335; no API key needed |

Source layout: `app/ask` and `app/review` are the two views, `app/trace` is the step list both share, `app/api.ts` streams Server-Sent Events from the API over `fetch`.
