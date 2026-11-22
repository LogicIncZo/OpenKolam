/**
 * Tool-layer tests: harness laws for the new commands (setGrid, moveMany,
 * addMany/removeMany, addStrokes/removeStrokes, reorder, group), geometry
 * helpers, doc<->world transforms, draft growth (stationary pulli), and the
 * pointer tools driven headlessly through a fake ToolCtx.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, canonicalJSON, validateDoc } from '@logicinczo/dotkolam';
import {
  Scene, SceneKolam, SceneStroke, newScene, sceneToJSON, sceneFromJSON,
  makeDraftDoc, applyGridSpec, specCenter, docToWorld, worldToDoc, kolamBBoxWorld,
} from '../src/harness/scene.js';
import { newHistory, doCmd, undo, redo, Cmd } from '../src/harness/commands.js';
import {
  segSegIntersect, pathCrossesChannel, strokeHit, snapGuides, rectsOverlap, pointInRect,
} from '../src/harness/geometry.js';
import { simplifyInk, minDistanceFilter } from '../app/ink.js';
import { ToolCtx, ToolOptions, DEFAULT_OPTIONS, emptyOverlay, TOOLS, ToolId } from '../app/tools.js';

function mkKolam(id: string, rows = 5): SceneKolam {
  const r = generate({ grid: { kind: 'diamond', rows }, symmetry: 'C4', seed: id });
  return {
    id,
    name: id,
    x: 0,
    y: 0,
    scale: 1,
    rot: 0,
    reflect: false,
    doc: r.doc,
    gen: { symmetry: 'C4', density: 0.55, strokes: 'one', seed: id },
  };
}

function draftKolam(id: string, dots: [number, number][], x = 0, y = 0): SceneKolam {
  return { id, name: id, x, y, scale: 1, rot: 0, reflect: false, doc: makeDraftDoc(dots, id) };
}

// ---------- laws: every new command ----------

test('law sweep across every command kind (setGrid, moveMany, addMany/removeMany, strokes, reorder, group)', () => {
  let scene = newScene();
  let hist = newHistory();
  const s1: SceneStroke = { id: 's1', points: [[0, 0], [1, 1]], color: '#f2ead9', width: 0.3 };
  const s2: SceneStroke = { id: 's2', points: [[2, 2], [3, 3]], color: '#e8b04b', width: 0.5 };
  const s3: SceneStroke = { id: 's3', points: [[5, 5], [6, 6]], color: '#7ec8a9', width: 0.2 };
  const k9 = draftKolam('k9', [[10, 10]], 10, 10);
  const ops: Cmd[] = [
    { t: 'add', kolam: draftKolam('k1', [[0, 0]]) },
    { t: 'add', kolam: draftKolam('k2', [[4, 0]], 4, 0), index: 0 },
    {
      t: 'setGrid',
      id: 'k1',
      prev: { kind: 'custom', dots: [[0, 0]] },
      next: { kind: 'custom', dots: [[0, 0], [1, 0]] },
      prevPos: { x: 0, y: 0 },
      nextPos: { x: 0.5, y: 0 },
    },
    {
      t: 'moveMany',
      moves: [
        { id: 'k1', from: { x: 0.5, y: 0 }, to: { x: 2, y: 3 } },
        { id: 'k2', from: { x: 4, y: 0 }, to: { x: 6, y: 1 } },
      ],
    },
    { t: 'addStrokes', strokes: [{ stroke: s1, index: 0 }] },
    { t: 'addStrokes', strokes: [{ stroke: s2, index: 0 }] },
    { t: 'removeStrokes', items: [{ stroke: s1, index: 0 }] },
    { t: 'addMany', kolams: [k9] },
    { t: 'removeMany', items: [{ kolam: k9, index: 2 }] },
    { t: 'reorder', id: 'k1', from: 1, to: 0 },
    { t: 'gates', id: 'k1', pairs: [[0, 0, 1, 0]], prev: ['closed'], next: ['open'] },
    {
      t: 'group',
      cmds: [
        { t: 'move', id: 'k2', from: { x: 6, y: 1 }, to: { x: 0, y: 0 } },
        { t: 'addStrokes', strokes: [{ stroke: s3, index: 0 }] },
      ],
    },
  ];
  const snap = (sc: Scene): string => canonicalJSON({ kolams: sc.kolams, strokes: sc.strokes, camera: sc.camera });
  const snapshots: string[] = [];
  for (const c of ops) {
    snapshots.push(snap(scene));
    const r = doCmd(scene, hist, c);
    scene = r.scene;
    hist = r.history;
  }
  const finalSnap = snap(scene);
  for (let i = 0; i < ops.length; i++) {
    const r = undo(scene, hist);
    assert.ok(r);
    scene = r.scene;
    hist = r.history;
  }
  assert.equal(snap(scene), snapshots[0], 'undo-all returns to start');
  for (let i = 0; i < ops.length; i++) {
    const r = redo(scene, hist);
    assert.ok(r);
    scene = r.scene;
    hist = r.history;
  }
  assert.equal(snap(scene), finalSnap, 'redo-all returns to final');
  for (let d = 0; d < ops.length; d++) {
    let s = scene;
    let h = hist;
    for (let i = 0; i <= d; i++) {
      const r = undo(s, h)!;
      s = r.scene;
      h = r.history;
    }
    for (let i = 0; i <= d; i++) {
      const r = redo(s, h)!;
      s = r.scene;
      h = r.history;
    }
    assert.equal(snap(s), finalSnap, `undo/redo depth ${d} identity`);
  }
});

test('undoing removeMany restores exact z-order', () => {
  let scene = newScene();
  const h0 = newHistory();
  const r1 = doCmd(scene, h0, { t: 'add', kolam: mkKolam('k1') });
  const r2 = doCmd(r1.scene, r1.history, { t: 'add', kolam: mkKolam('k2', 7) });
  const r3 = doCmd(r2.scene, r2.history, { t: 'add', kolam: mkKolam('k3', 3) });
  scene = r3.scene;
  const before = canonicalJSON(scene.kolams.map((k) => k.id));
  const k1 = scene.kolams[0]!;
  const k3 = scene.kolams[2]!;
  const r4 = doCmd(scene, r3.history, { t: 'removeMany', items: [{ kolam: k1, index: 0 }, { kolam: k3, index: 2 }] });
  assert.deepEqual(r4.scene.kolams.map((k) => k.id), ['k2']);
  const back = undo(r4.scene, r4.history)!;
  assert.equal(canonicalJSON(back.scene.kolams.map((k) => k.id)), before, 'z-order restored exactly');
});

// ---------- setGrid semantics ----------

test('setGrid carries gate states by node key and keeps the doc valid (L3)', () => {
  const d = draftKolam('d', [[0, 0], [1, 0]]);
  const v0 = validateDoc(d.doc);
  assert.equal(v0.valid, true, JSON.stringify(v0.issues.slice(0, 3)));
  // open the single gate, then grow the draft with a third dot
  const opened = applyGridSpec(d.doc, { kind: 'custom', dots: [[0, 0], [1, 0]] });
  const pat = opened.pattern;
  assert.ok(pat);
  const withOpen = { ...d.doc, pattern: pat };
  const gate = withOpen.pattern!.gates[0]!;
  gate.state = 'open';
  const grown = applyGridSpec(withOpen, { kind: 'custom', dots: [[0, 0], [1, 0], [2, 0]] });
  const vg = validateDoc(grown);
  assert.equal(vg.valid, true, JSON.stringify(vg.issues.slice(0, 3)));
  // the previously opened gate is still open
  const again = grown.pattern!.gates.find(
    (g) => (g.a[0] === 0 && g.b[0] === 1) || (g.b[0] === 0 && g.a[0] === 1),
  );
  assert.equal(again?.state, 'open', 'gate state carried across grid growth');
  // shrink back: the gate disappears with its channel
  const shrunk = applyGridSpec(grown, { kind: 'custom', dots: [[0, 0], [2, 0]] });
  assert.equal(shrunk.pattern!.gates.length, 0);
  assert.equal(validateDoc(shrunk).valid, true);
});

test('draft growth is stationary: pulli keep their world positions', () => {
  const d = draftKolam('d', [[0, 0]]);
  const c0 = specCenter(d.doc.grid.spec);
  const next = { kind: 'custom' as const, dots: [[0, 0], [1, 0]] as [number, number][] };
  const c1 = specCenter(next);
  const moved = { ...d, x: d.x + c1[0] - c0[0], y: d.y + c1[1] - c0[1], doc: applyGridSpec(d.doc, next) };
  assert.deepEqual(docToWorld(moved, [0, 0]), [0, 0], 'original pulli stays at the origin');
  assert.deepEqual(docToWorld(moved, [1, 0]), [1, 0], 'new pulli lands where it was placed');
});

// ---------- serialization ----------

test('scene JSON round-trip keeps strokes; v1.0 files load with empty strokes', () => {
  let scene = newScene();
  const r1 = doCmd(scene, newHistory(), { t: 'add', kolam: mkKolam('k1') });
  scene = r1.scene;
  const r2 = doCmd(scene, r1.history, {
    t: 'addStrokes',
    strokes: [{ stroke: { id: 's1', points: [[0, 0], [1, 1]], color: '#f2ead9', width: 0.3 }, index: 0 }],
  });
  scene = r2.scene;
  const file = sceneToJSON(scene);
  assert.equal(file.harnessVersion, '1.1');
  const back = sceneFromJSON(JSON.parse(JSON.stringify(file)));
  assert.equal(canonicalJSON(back), canonicalJSON(scene));
  // v1.0 back-compat
  const legacy = { harnessVersion: '1.0', scene: { nextId: 1, camera: { x: 0, y: 0, zoom: 24 }, kolams: [mkKolam('k1')] } };
  const loaded = sceneFromJSON(legacy);
  assert.equal(loaded.strokes.length, 0);
  assert.equal(loaded.kolams.length, 1);
  assert.throws(() => sceneFromJSON({ hello: 1 }));
});

// ---------- transforms ----------

test('docToWorld/worldToDoc round-trip across rot/reflect/scale', () => {
  const k = mkKolam('k1');
  for (const rot of [0, 1, 2, 3] as const) {
    for (const reflect of [false, true]) {
      for (const scale of [1, 2.5]) {
        const placed: SceneKolam = { ...k, x: 7, y: -3, rot, reflect, scale };
        const p: [number, number] = [1.5, -0.5];
        const w = docToWorld(placed, p);
        const back = worldToDoc(placed, w);
        assert.ok(Math.abs(back[0] - p[0]) < 1e-9 && Math.abs(back[1] - p[1]) < 1e-9, `rot=${rot} reflect=${reflect} scale=${scale}`);
      }
    }
  }
});

// ---------- geometry helpers ----------

test('segSegIntersect: crossing, touching, collinear, and negative cases', () => {
  const seg = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean =>
    segSegIntersect(a, b, c, d);
  assert.equal(seg([0, 0], [2, 0], [1, -1], [1, 1]), true, 'proper crossing');
  assert.equal(seg([0, 0], [2, 0], [1, 0], [1, 1]), true, 'endpoint touch');
  assert.equal(seg([0, 0], [2, 0], [3, -1], [3, 1]), false, 'beyond the segment');
  assert.equal(seg([0, 0], [2, 0], [0, -1], [2, -1]), false, 'parallel');
  assert.equal(seg([0, 0], [2, 0], [1, 0], [3, 0]), true, 'collinear overlap');
  assert.equal(seg([0, 0], [2, 0], [0.5, 0], [0.9, 0]), true, 'collinear contained');
});

test('pathCrossesChannel detects pen sweeps across a channel', () => {
  const channel: [[number, number], [number, number]] = [[0, 0], [2, 0]];
  assert.equal(pathCrossesChannel([[-1, -1], [0.5, -1], [0.5, 1]], channel), true, 'sweep crossing');
  assert.equal(pathCrossesChannel([[-1, -1], [1, -0.5], [3, -0.5]], channel), false, 'passes above');
  assert.equal(pathCrossesChannel([[1, 1], [1, 0], [1, -1]], channel), true, 'touch at the midpoint');
});

test('strokeHit and pointInRect/rectsOverlap', () => {
  const pts: [number, number][] = [[0, 0], [2, 2]];
  assert.equal(strokeHit(pts, [1, 1], 0.1), true);
  assert.equal(strokeHit(pts, [1.2, 1], 0.1), false);
  assert.equal(strokeHit(pts, [1.2, 1], 0.3), true);
  assert.equal(pointInRect([0.5, 0.5], { minX: 0, minY: 0, maxX: 1, maxY: 1 }), true);
  assert.equal(pointInRect([1.1, 0.5], { minX: 0, minY: 0, maxX: 1, maxY: 1 }, 0.2), true);
  assert.equal(rectsOverlap({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { minX: 0.5, minY: 0.5, maxX: 2, maxY: 2 }), true);
  assert.equal(rectsOverlap({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { minX: 1.1, minY: 0.5, maxX: 2, maxY: 2 }), false);
});

test('snapGuides: exact alignment, threshold, and deterministic nearest pick', () => {
  const moving = { minX: 0, minY: 0, maxX: 2, maxY: 2 };
  const other = { minX: 5, minY: 5, maxX: 7, maxY: 7 };
  const far = snapGuides(moving, [other], 0.5);
  assert.deepEqual(far.guides, []);
  // my maxX (4.7) sits 0.3 from other's minX (5): snap by dx = 0.3
  const near = snapGuides({ minX: 2.7, minY: 0, maxX: 4.7, maxY: 2 }, [other], 0.5);
  assert.equal(Math.abs(near.dx - 0.3) < 1e-9, true);
  assert.ok(near.guides.some((g) => g.axis === 'x' && g.pos === 5));
  assert.ok(!near.guides.some((g) => g.axis === 'y'), 'no y guide when far');
  // identical rects: every candidate delta is 0, first (min-edge) wins deterministically
  const center = snapGuides({ minX: 5, minY: 5, maxX: 7, maxY: 7 }, [other], 0.5);
  assert.ok(center.guides.some((g) => g.axis === 'x' && g.pos === 5));
  assert.ok(center.guides.some((g) => g.axis === 'y' && g.pos === 5));
  assert.equal(center.dx, 0);
  assert.equal(center.dy, 0);
});

// ---------- ink processing ----------

test('ink simplification: min-distance filter and Douglas-Peucker', () => {
  const pts: [number, number][] = [[0, 0], [0.01, 0], [0.02, 0], [1, 0], [1.01, 0.01]];
  const filtered = minDistanceFilter(pts, 0.1);
  assert.deepEqual(filtered, [[0, 0], [1, 0]]);
  const jitter: [number, number][] = [[0, 0], [0.5, 0.01], [1, 0], [1.5, -0.01], [2, 0]];
  const simple = simplifyInk(jitter, 0.1);
  assert.deepEqual(simple, [[0, 0], [2, 0]]);
  const bend: [number, number][] = [[0, 0], [1, 1], [2, 0]];
  assert.equal(simplifyInk(bend, 0.1).length, 3, 'real bend is kept');
});

// ---------- headless tool tests ----------

interface FakeCtx extends ToolCtx {
  cmds: Cmd[];
  toasts: string[];
  live: string[];
}

function makeCtx(opts: Partial<ToolOptions> = {}): FakeCtx {
  const state: { scene: Scene } = { scene: newScene() };
  const hist = newHistory();
  const cmds: Cmd[] = [];
  const toasts: string[] = [];
  const live: string[] = [];
  const overlay = emptyOverlay();
  const selection = new Set<string>();
  return {
    cmds,
    toasts,
    live,
    scene: () => state.scene,
    run(c: Cmd): void {
      const r = doCmd(state.scene, hist, c);
      state.scene = r.scene;
      cmds.push(c);
    },
    zoom: () => state.scene.camera.zoom,
    selection: () => selection,
    setSelection(ids: string[]): void {
      selection.clear();
      for (const id of ids) selection.add(id);
    },
    overlay: () => overlay,
    requestWorld(): void {},
    requestOverlay(): void {},
    updateKolamLive(id: string): void {
      live.push(id);
    },
    clearLive(): void {},
    noteCameraChange(): void {},
    toast(m: string): void {
      toasts.push(m);
    },
    options: (): ToolOptions => ({ ...DEFAULT_OPTIONS, ...opts }),
  };
}

const ev = (x: number, y: number, button = 0, shiftKey = false): PointerEvent =>
  ({ clientX: x, clientY: y, button, shiftKey }) as unknown as PointerEvent;

function toolSequence(id: ToolId): { down: (ctx: ToolCtx, e: PointerEvent, w?: { x: number; y: number }) => void; move: (ctx: ToolCtx, e: PointerEvent, w?: { x: number; y: number }) => void; up: (ctx: ToolCtx, e: PointerEvent, w?: { x: number; y: number }) => void } {
  const t = TOOLS[id];
  return {
    down: (ctx, e, w) => t.onDown?.(ctx, e, w ?? worldOf(e)),
    move: (ctx, e, w) => t.onMove?.(ctx, e, w ?? worldOf(e)),
    up: (ctx, e, w) => t.onUp?.(ctx, e, w ?? worldOf(e)),
  };
}

// world coords derived from clientX/Y with zoom 24 around (0,0): w = (client - center)/zoom
function worldOf(e: PointerEvent): { x: number; y: number } {
  return { x: e.clientX / 24, y: e.clientY / 24 };
}

test('dot tool: click creates a draft, second click grows it, undo reverts', () => {
  const ctx = makeCtx();
  const dot = toolSequence('dot');
  const pe = (wx: number, wy: number): PointerEvent => ev(wx * 24, wy * 24);
  dot.down(ctx, pe(5, 5), { x: 5, y: 5 });
  dot.up(ctx, pe(5, 5), { x: 5, y: 5 });
  assert.equal(ctx.scene().kolams.length, 1);
  const k = ctx.scene().kolams[0]!;
  assert.equal(k.id, 'k1');
  assert.equal(k.doc.grid.spec.kind, 'custom');
  assert.deepEqual(k.doc.grid.spec.kind === 'custom' ? k.doc.grid.spec.dots : [], [[5, 5]]);
  assert.equal(k.x, 5);
  assert.equal(k.y, 5);
  assert.equal(validateDoc(k.doc).valid, true);
  // second click adds a pulli at (6,5) and keeps the first stationary
  dot.down(ctx, pe(6, 5), { x: 6, y: 5 });
  dot.up(ctx, pe(6, 5), { x: 6, y: 5 });
  const grown = ctx.scene().kolams[0]!;
  assert.deepEqual(grown.doc.grid.spec.kind === 'custom' ? grown.doc.grid.spec.dots : [], [[5, 5], [6, 5]]);
  assert.deepEqual(docToWorld(grown, [5, 5]), [5, 5], 'original pulli stationary');
  assert.deepEqual(docToWorld(grown, [6, 5]), [6, 5], 'new pulli at the clicked spot');
  assert.equal(ctx.cmds.length, 2);
  assert.equal(ctx.cmds[1]!.t, 'setGrid');
  // drag-sow a 3x2 rect grid on empty canvas
  dot.down(ctx, pe(20, 20), { x: 20, y: 20 });
  dot.move(ctx, pe(23, 22), { x: 23, y: 22 });
  dot.up(ctx, pe(23, 22), { x: 23, y: 22 });
  assert.equal(ctx.scene().kolams.length, 2);
  const grid = ctx.scene().kolams[1]!;
  assert.deepEqual(grid.doc.grid.spec.kind === 'custom' ? grid.doc.grid.spec.dots.length : 0, 6);
});

test('gate pen: sweeping a channel opens it live and commits one undoable command', () => {
  const ctx = makeCtx();
  const draft = draftKolam('k1', [[0, 0], [1, 0], [0, 1], [1, 1]], 0.5, 0.5);
  ctx.run({ t: 'add', kolam: draft });
  assert.equal(draft.doc.analysis!.loopCount, 4, 'all-closed 2x2 = four circles');
  const pen = toolSequence('pen');
  // channel between (0,0)-(1,0) sits at world y=0, x in [0,1] (k at (0.5,0.5), doc center (0.5,0.5))
  const pe = (wx: number, wy: number): PointerEvent => ev(wx * 24, wy * 24);
  pen.down(ctx, pe(0.5, -1), { x: 0.5, y: -1 });
  pen.move(ctx, pe(0.5, 0.4), { x: 0.5, y: 0.4 });
  pen.up(ctx, pe(0.5, 0.4), { x: 0.5, y: 0.4 });
  assert.equal(ctx.cmds.length, 2);
  const c = ctx.cmds[1]!;
  assert.equal(c.t, 'gates');
  assert.equal(ctx.live.length > 0, true, 'live preview updates during the sweep');
  const fresh = ctx.scene().kolams[0]!;
  assert.equal(fresh.doc.analysis!.loopCount, 3, 'figure-eight merged two circles');
  assert.equal(validateDoc(fresh.doc).valid, true);
  // undo returns to four circles: replay the two commands and undo the last
  let scene = newScene();
  let hist = newHistory();
  const r1 = doCmd(scene, hist, { t: 'add', kolam: draft });
  scene = r1.scene;
  hist = r1.history;
  const r2 = doCmd(scene, hist, c as Cmd);
  scene = r2.scene;
  hist = r2.history;
  assert.equal(scene.kolams[0]!.doc.analysis!.loopCount, 3);
  const back = undo(scene, hist)!;
  assert.equal(back.scene.kolams[0]!.doc.analysis!.loopCount, 4);
});

test('eraser: draft pulli erase one by one; generated kolams erase whole; strokes erase', () => {
  const ctx = makeCtx();
  const draft = draftKolam('k1', [[0, 0]], 0, 0);
  ctx.run({ t: 'add', kolam: draft });
  ctx.run({
    t: 'setGrid',
    id: 'k1',
    prev: { kind: 'custom', dots: [[0, 0]] },
    next: { kind: 'custom', dots: [[0, 0], [1, 0]] },
    prevPos: { x: 0, y: 0 },
    nextPos: { x: 0.5, y: 0 },
  });
  const k2 = mkKolam('k2');
  k2.x = 10;
  ctx.run({ t: 'add', kolam: k2 });
  ctx.run({
    t: 'addStrokes',
    strokes: [{ stroke: { id: 's1', points: [[-3, 0], [-1, 0]], color: '#f2ead9', width: 0.3 }, index: 0 }],
  });
  const erase = toolSequence('eraser');
  const pe = (wx: number, wy: number): PointerEvent => ev(wx * 24, wy * 24);
  // sweep through the draft pulli at (1,0)
  erase.down(ctx, pe(1.01, 0), { x: 1.01, y: 0 });
  erase.move(ctx, pe(1.05, 0.01), { x: 1.05, y: 0.01 });
  erase.up(ctx, pe(1.05, 0.01), { x: 1.05, y: 0.01 });
  const k1 = ctx.scene().kolams.find((q) => q.id === 'k1')!;
  assert.deepEqual(k1.doc.grid.spec.kind === 'custom' ? k1.doc.grid.spec.dots : [], [[0, 0]]);
  assert.equal(k1.x, 0, 'draft re-pivots so the remaining pulli stays put');
  assert.deepEqual(docToWorld(k1, [0, 0]), [0, 0]);
  // sweep through the generated kolam's center pulli at (10,0): whole kolam goes
  erase.down(ctx, pe(10, 0), { x: 10, y: 0 });
  erase.up(ctx, pe(10, 0), { x: 10, y: 0 });
  assert.equal(ctx.scene().kolams.length, 1, 'generated kolam erased whole');
  assert.equal(ctx.scene().kolams[0]!.id, 'k1');
  // erase the draft's last pulli: the draft disappears entirely
  erase.down(ctx, pe(0, 0), { x: 0, y: 0 });
  erase.up(ctx, pe(0, 0), { x: 0, y: 0 });
  assert.equal(ctx.scene().kolams.length, 0);
  // now erase the stroke
  erase.down(ctx, pe(-2, 0), { x: -2, y: 0 });
  erase.up(ctx, pe(-2, 0), { x: -2, y: 0 });
  assert.equal(ctx.scene().strokes.length, 0);
});

test('select tool: marquee multi-select, group drag commits moveMany, delete works', () => {
  const ctx = makeCtx();
  ctx.run({ t: 'add', kolam: mkKolam('k1') });
  ctx.run({ t: 'add', kolam: mkKolam('k2', 7) });
  ctx.scene().kolams[1]!.x = 8;
  ctx.scene().kolams[1]!.y = 8;
  const sel = toolSequence('select');
  const pe = (wx: number, wy: number): PointerEvent => ev(wx * 24, wy * 24);
  // marquee over everything
  sel.down(ctx, pe(-10, -10), { x: -10, y: -10 });
  sel.move(ctx, pe(12, 12), { x: 12, y: 12 });
  sel.up(ctx, pe(12, 12), { x: 12, y: 12 });
  assert.equal(ctx.selection().size, 2);
  // drag from inside k1: both kolams move together
  sel.down(ctx, pe(0, 0), { x: 0, y: 0 });
  sel.move(ctx, pe(1.5, 0.5), { x: 1.5, y: 0.5 });
  sel.up(ctx, pe(1.5, 0.5), { x: 1.5, y: 0.5 });
  const c = ctx.cmds[ctx.cmds.length - 1]!;
  assert.equal(c.t, 'moveMany');
  assert.equal(ctx.scene().kolams[0]!.x, 1.5);
  assert.equal(ctx.scene().kolams[1]!.x, 9.5);
  // undo restores both
  let scene = ctx.scene();
  let hist = newHistory();
  for (const op of ctx.cmds) {
    const r = doCmd(scene, hist, op);
    scene = r.scene;
    hist = r.history;
  }
  const back = undo(scene, hist)!;
  assert.equal(back.scene.kolams[0]!.x, 0);
  assert.equal(back.scene.kolams[1]!.x, 8);
  // delete selection removes both in one grouped command
  ctx.setSelection(['k1', 'k2']);
  ctx.run({
    t: 'group',
    cmds: [{ t: 'removeMany', items: ctx.scene().kolams.map((k, index) => ({ kolam: k, index })) }],
  });
  assert.equal(ctx.scene().kolams.length, 0);
});

test('kolam bbox world covers rotated kolams; marquee selection hits rotated shapes', () => {
  const k = { ...mkKolam('k1'), rot: 1 as const };
  const b = kolamBBoxWorld(k);
  assert.ok(b.maxX - b.minX > 1);
});
