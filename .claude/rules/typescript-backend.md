---
# Loads only when Claude works on the Node/TypeScript backend, its tests or TS scripts.
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
  - "scripts/**/*.ts"
---

# Backend TypeScript conventions

## Language and modules
- ESM only (`"type": "module"`), TypeScript `strict`, run with `tsx` (no compile step).
- Import Node built-ins with the `node:` prefix (`node:fs/promises`, `node:path`).
- Local imports include the `.ts` extension (`./tools.ts`). SDK subpath imports use the
  package's `.js` path (`@modelcontextprotocol/sdk/server/mcp.js`).
- Use `import type` for type-only imports.
- Double quotes, 2-space indent, trailing commas in multi-line literals; match the surrounding file.
- No `any`. Use `unknown` and narrow; cast caught errors as `(e as Error).message`, as elsewhere.

## Tools and the MCP server
- Every tool input is validated with a zod schema. Keep the schema, the tool description and
  the README "Tools" table in sync.
- Tools return compact text (file:line hits, numbered lines, capped results) to save tokens.
  Keep existing caps such as `READ_WINDOW` and `MAX_FILES_SCANNED` unless asked.
- Tool failures return text starting with `Error:` (the MCP layer marks those `isError`) rather
  than throwing to the model.
- Any path argument goes through `safeResolve(root, relPath)`. Never call `fs` with a raw model-supplied path.
- New repo tools are read-only: register them with the `readOnly` annotations.

## Configuration and output
- Read config from `process.env` (loaded by `dotenv`), validate it with the existing parsers
  (`parsePort`, `parseBudget`, `parseList`) and fail fast with a clear message.
- Add new variables to `.env.example` with a comment explaining them.
- CLIs: the answer goes to stdout; progress, tool-call traces and diagnostics go to stderr.

## Claude API, Agent SDK, MCP SDK
- Don't invent SDK methods or parameters. Check the installed type definitions in
  `node_modules/@anthropic-ai/...` and `node_modules/@modelcontextprotocol/sdk` first.
- Keep the review agent's spend cap (`REVIEW_MAX_BUDGET_USD`) and turn limits in place.

## Tests
- Use `node:test` (`test`) and `node:assert/strict`; one `*.test.ts` file per module in `test/`.
- No network: use fakes from `test/fixtures/` (e.g. `fake-github.ts`) and scripted model responses.
- Cover the failure paths too: path escapes, bad input, missing tokens.
