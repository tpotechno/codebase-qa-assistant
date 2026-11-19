---
# Loads only when Claude works on the Angular web UI.
paths:
  - "web/src/**/*.ts"
  - "web/src/**/*.html"
  - "web/src/**/*.scss"
---

# Angular 21 conventions (web/)

## Before writing Angular code
- Call the `angular-cli` MCP tool `get_best_practices` at the start of Angular work, and use
  `search_documentation` for any API you're not certain exists in Angular 21.
- Generate new pieces with the CLI from `web/` (`npx ng generate component <name>`) so file
  naming and structure stay consistent, then adjust.

## Components
- Standalone components only (dependencies go in `imports: []`); no NgModules.
- `changeDetection: ChangeDetectionStrategy.OnPush` on every component.
- The app is zoneless (no zone.js). State that the template reads must be a signal or `computed()`,
  or the view won't update.
- `inject()` for dependencies, not constructor injection.
- Signal-based APIs: `input()`, `output()`, `signal()`, `computed()`. Not `@Input`/`@Output` decorators.
- Members the template uses are `protected`; injected services are `private readonly`.
- File naming follows the existing style: `ask.ts`, `ask.html`, `ask.scss` (no `.component` suffix),
  class name `Ask`, selector prefix `app-`.
- Separate `templateUrl` and `styleUrl` files.

## Templates
- Built-in control flow: `@if`, `@for` (always with `track`), `@switch`. Not `*ngIf`/`*ngFor`.
- Keep logic out of templates; move it to `computed()` signals or small pure functions
  (like `tool-summary.ts`).
- Accessibility: every input has a `<label>`, buttons have a `type`, regions get `aria-label`.
- Model output is rendered only through `MarkdownPipe` bound with `[innerHTML]`, so raw HTML is
  escaped and Angular sanitizes the result. Never use `bypassSecurityTrustHtml`.

## Styles and formatting
- SCSS. Respect the component style budget in `angular.json` (warning at 4 kB, error at 8 kB).
- Prettier settings in `web/.prettierrc`: single quotes, print width 100.

## Data and streaming
- HTTP and SSE calls live in `api.ts` and `sse.ts`; components don't call `fetch` directly.
- Long requests must be cancellable (`AbortController`), as in `Ask.stop()`.
- Shared shapes live in `models.ts` and must match what `src/web-app.ts` sends.

## Tests
- Vitest (`describe`/`it`/`expect`), spec file next to the code (`sse.spec.ts`).
- Run `npm run web:test` from the repo root, or `npx ng test --watch=false` from `web/`.
