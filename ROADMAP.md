# OpenKolam roadmap

Releases start at **v0.0.1** — the baseline: the offline infinite-canvas
Kolam Harness with native kolam drawing tools (pulli / gate pen / ink /
eraser), Idea → Prompt → Draw, exact undo/redo for every operation,
per-PR deploy previews, and the Kolam Harness command algebra (P8 laws).
Versions track release tags; the kolam model comes from
[`@logicinczo/dotkolam`](https://github.com/LogicIncZo/dotkolam) (its
[roadmap](https://github.com/LogicIncZo/dotkolam/blob/main/ROADMAP.md)
pairs with this one).

Milestones track releases on GitHub; this file is the narrative view.

## Release process — the milestone gate

- All work lands on `dev` through PRs from feature branches
  (`feat/…`, `fix/…`, `chore/…`); CI (`npm run build && npm test`) must be
  green before a feature PR merges into `dev`.
- **`dev` → `main` is a human-reviewed milestone gate.** One release PR per
  milestone, reviewed and merged by a human — agents and automation must
  never merge, push, or fast-forward `main` (a branch ruleset enforces the
  PR-only flow). Merging the release PR deploys the site (GitHub Pages);
  tag `vX.Y.Z` on `main` for the release.
- A milestone is ready for human review when every issue in it is closed on
  `dev` and CI parity passes.

## v0.1.0 — next

- [ ] **Ink selection & move** — decoration strokes are selectable but
      static; make them movable like kolams (with law-tested commands)
- [ ] **Free transform handles** — rotate/scale beyond quarter-turns
      (generalize `setTransform`), tldraw-style handles on the selection
- [ ] **Touch gestures** — pinch-zoom and two-finger pan on the canvas
- [ ] **Scene sharing via URL** — encode the whole scene in the URL hash
      (stays fully offline; no backend)
- [ ] **Robot path (g-code export)** — export a kolam's `drawingOrder` as
      GRBL g-code for pen plotters, consuming dotkolam's exporter
- [ ] **PWA shell** — installable, offline-first app wrapper

## later

- Motif library / stamps — needs `components`/`uses` composition in
  dotkolam (schema exists, core implementation pending)
- Draw-in animation export (video/GIF of the stroke sequence)
- Tamil UI strings (localization)
- Multi-kolam layout tools (arrange grid of kolams for printing)
- Eraser refinements: erase decoration sub-segments, not only whole strokes
