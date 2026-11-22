# AGENTS.md — working guide for AI coding agents

OpenKolam (the **Kolam Harness**): an offline infinite-canvas web app for
rule-bound **sikku kolam** — Idea → Prompt → Draw plus manual gate editing.
The kolam model (grid, gates, trace, validator, generator, prompt parser,
renderer) is **not implemented here**: it comes from the
[`@logicinczo/dotkolam`](https://github.com/LogicIncZo/dotkolam) package —
consumed as a **git dependency** on the public dotkolam repo, SHA-pinned in
`package.json` (npm runs the dep's `prepare` build on install; the same
package is also published to GitHub Packages). This repo is the app around
it. Start from `README.md`.

## Hard invariants (breaking any of these is a bug, not a design change)

1. **Harness command algebra (P8).** Every new harness command in
   `src/harness/commands.ts` is data with an exact inverse: the laws in
   `test/harness.test.ts` (`apply(apply(s,c), invert(s,c)) == s` on the
   visible projection, redo = inverse of undo at every depth, scene JSON
   round-trip identity, NaN-free placement) must keep holding. Add the
   command to the law test.
2. **Validity invariance.** Kolam validity is invariant under every command —
   the UI cannot produce an invalid kolam. Gate edits must round-trip through
   the core gate system (`sysFromDoc` → mutate → `docFromSys` from
   `dotkolam`), never by rewriting `pattern.gates` ad hoc.
3. **The model lives in dotkolam.** Never fork/copy core model logic
   (reflection, crossing, tracing) into this repo. If the app needs something
   the package doesn't expose, extend `dotkolam` (browser-safe barrel
   `src/index.ts`) and bump the dependency version here.
4. **Zero runtime dependencies besides `@logicinczo/dotkolam`.** `dependencies`
   stays `{"@logicinczo/dotkolam": …}` (git dependency, SHA-pinned — bump the
   SHA in `package.json` **and** run `npm install` to refresh
   `package-lock.json` together). Dev deps are tooling only (typescript, tsx,
   esbuild, @types/node).
5. **Strict TypeScript everywhere.** `strict`, `noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes` are on (see `tsconfig.json`), and the tsc
   pass covers `src/`, `app/`, and `test/` — `app/main.ts` is typechecked,
   not just esbuild-bundled. No suppression flags; never `any`.
6. **Offline.** The app makes no network calls; the bundle must stay
   self-contained (esbuild `bundle: true`, relative `./bundle.js`).

## Commands

Node 22 (CI), ESM everywhere. From the repo root:

```bash
npm install                      # @logicinczo/dotkolam (git dep, public clone) + dev tooling
npm run build                    # tsc typecheck + esbuild bundle → app/bundle.js
npm test                         # P8 harness-law suite
npm run serve                    # http://127.0.0.1:4173/app/
```

Full CI parity: `npm run build && npm test` (see `.github/workflows/ci.yml`).

## Change protocol

Run before finishing any task:

1. `npm run build` (typecheck + bundle), then `npm test`.
2. New scene command ⇒ new law-test cases in `test/harness.test.ts`
   (invariant 1). New UI behavior that touches scene/commands needs a test
   that a hand-mutated command/state rejects or round-trips.
3. `dotkolam` version bumps: coordinate with that repo's release (tag `v*`
   triggers its publish workflow to GitHub Packages); the app must build and
   pass tests against the pinned `^` version in `package.json`.
4. Commit only what the task asks.

## Conventions

- ESM (`"type": "module"`, NodeNext): relative imports inside the repo end in
  `.js` (e.g. `import { Scene } from '../src/harness/scene.js';`); package
  imports are plain `import { … } from '@logicinczo/dotkolam'`.
- Style: 2-space indent, single quotes, semicolons, trailing commas where
  legal; doc-comment header on each module explaining its role.
- Tests: `node:test` + `node:assert/strict` run via `tsx`
  (`test/harness.test.ts`).
- Terminology: dots are *pulli*, gates are open/closed, loops/strokes as in
  the Kolam-JSON spec.

## Pitfalls

- `app/main.ts` pins some imports with `void ident;` to keep esbuild from
  tree-shaking test hooks — check before "cleaning them up".
- Browser E2E hooks (`window.__kolamTest`, the `kolam:test-export` DOM
  event) are intentional; keep them working when touching export paths.
- `app/index.html` loads `./bundle.js` relatively so the app works at any
  base path (GitHub Pages project URL included); don't make it absolute.
- Placement/undo logic must stay NaN-free (`findFreeSpot` laws); never let a
  command leave the scene with NaN coordinates.
