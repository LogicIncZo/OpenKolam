# OpenKolam (Kolam Harness)

[![CI](https://github.com/LogicIncZo/OpenKolam/actions/workflows/ci.yml/badge.svg)](https://github.com/LogicIncZo/OpenKolam/actions/workflows/ci.yml)
[![App on GitHub Pages](https://img.shields.io/badge/app-github%20pages-e8b04b)](https://logicinczo.github.io/OpenKolam/)
[![License: MIT](https://img.shields.io/badge/license-MIT-7ec8a9)](LICENSE)
[![powered by dotkolam](https://img.shields.io/badge/powered%20by-%40logicinczo%2Fdotkolam-b9a88f)](https://github.com/LogicIncZo/dotkolam)

**Run it**: [Kolam Harness in the browser](https://logicinczo.github.io/OpenKolam/) (fully offline once loaded)

**OpenKolam** is the Kolam Harness: an offline **infinite-canvas web app** for
rule-bound **sikku kolam**. The kolam model itself — grid, gates, trace,
validator, generator, prompt parser, renderer — comes from the
[`@logicinczo/dotkolam`](https://github.com/LogicIncZo/dotkolam) package
(Kolam-JSON spec + reference implementation, published on GitHub Packages);
this repo is the app around it.

## Features

- **Infinite canvas**: pan (drag), zoom (wheel), no bounds; kolams are world
  objects you can move, rotate 90°, mirror, duplicate, delete — with exact
  undo/redo.
- **Idea → Prompt → Draw**: type e.g. `15 pulli dense sikku kolam, 4-fold,
  seed pongal`; the deterministic parser reads grid shape (incl. Tamil
  conventions like `7-1`), symmetry, density, one-stroke vs multi-loop, seed
  and motifs, generates, and places the kolam with a live draw-in animation.
- **Manual drawing**: drop to the ✱ gate-edit mode, click any channel
  between two dots of the selected kolam to toggle open/closed; the badge
  shows `one stroke ✓` or `n loops` live. Manual construction is structured:
  you cannot break the traditional rules.
- **Persistence**: autosaves to the browser; save/load `.harness.json`
  scenes; import Kolam-JSON; export per-kolam JSON/SVG/PNG or the whole
  canvas as SVG.

## Quick start

```bash
npm install
npm run serve      # → http://127.0.0.1:4173/app/
```

No registry auth needed: the `@logicinczo/dotkolam` dependency resolves as a
**git dependency** on the public
[dotkolam](https://github.com/LogicIncZo/dotkolam) repo (SHA-pinned in
`package.json`; npm runs its `prepare` build on install). The same package is
also published to GitHub Packages
([`@logicinczo/dotkolam`](https://github.com/LogicIncZo/dotkolam/pkgs/npm/%40logicinczo%2Fdotkolam))
for registry-style installs.

Development:

```bash
npm run build      # tsc typecheck (src/ + app/ + test/) + esbuild bundle → app/bundle.js
npm test           # P8 harness laws: exact undo/redo, round-trips, NaN-free camera
```

## Architecture

```
app/main.ts           DOM app: canvas, tools, prompt form, inspector, persistence
app/index.html        static chrome (bundle loaded relatively — deployable anywhere)
src/harness/scene.ts  scene model: kolams on the canvas, camera, placement (pure data, no DOM)
src/harness/commands.ts  command algebra with exact inverse (undo/redo)
test/harness.test.ts  P8 law suite (uses dotkolam's generator/validator as oracles)
```

Every scene command is data with an exact inverse, and kolam validity is
invariant under every command — the UI cannot produce an invalid kolam
(verified by the P8 property tests against `dotkolam`'s validator).

## License

MIT. The Kolam-JSON specification and docs live in
[dotkolam](https://github.com/LogicIncZo/dotkolam) (code MIT, docs CC-BY-4.0).
Traditional art form belongs to its practitioners — these projects only
formalize a respectful computational model of it.
