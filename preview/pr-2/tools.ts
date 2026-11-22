/**
 * Tool framework: tldraw-style pointer tools whose native primitives are
 * kolam primitives — pulli (dots), gate channels, and freehand flour ink.
 *
 * Tools are pure interaction: they translate pointer gestures into harness
 * commands (exact inverse algebra) and declarative overlay state. All
 * rendering and DOM live in main.ts. Gate edits round-trip through the
 * dotkolam bridge (sysFromDoc -> mutate -> docFromSys) via the `gates` and
 * `setGrid` commands — never ad-hoc pattern rewriting.
 */
import {
  GateState,
  GateSystem,
  buildGrid,
  fromDisplay,
  nodeKey,
  pickDot,
  pickGate,
  scaleDistance,
  sysFromDoc,
} from '@logicinczo/dotkolam';
import {
  Scene,
  SceneKolam,
  SceneStroke,
  docToWorld,
  kolamBBoxWorld,
  makeDraftDoc,
  specCenter,
  strokeBBox,
  worldToDoc,
} from '../src/harness/scene.js';
import { Cmd } from '../src/harness/commands.js';
import {
  Rect,
  SnapGuide,
  pointInRect,
  rectsOverlap,
  snapGuides,
  strokeHit,
  strokeNearPath,
} from '../src/harness/geometry.js';
import { simplifyInk } from './ink.js';

export type ToolId = 'select' | 'hand' | 'dot' | 'pen' | 'ink' | 'eraser';

export interface ToolOptions {
  penMode: 'flip' | 'open' | 'closed';
  gridShape: 'rect' | 'diamond';
  inkColor: string;
  inkWidth: number;
  snapOn: boolean;
}

export const INK_COLORS: Record<string, string> = {
  chalk: '#f2ead9',
  gold: '#e8b04b',
  leaf: '#7ec8a9',
  ink: '#221c14',
};

export const DEFAULT_OPTIONS: ToolOptions = {
  penMode: 'flip',
  gridShape: 'rect',
  inkColor: '#f2ead9',
  inkWidth: 0.3,
  snapOn: false,
};

export interface HoverChannel {
  kolamId: string;
  /** channel endpoints, doc-local display units */
  a: [number, number];
  b: [number, number];
  interior: boolean;
}

/** Declarative overlay pieces; main.ts turns these into SVG elements. */
export interface OverlayState {
  marquee: Rect | null;
  inkPreview: [number, number][] | null;
  inkColor: string;
  inkWidth: number;
  hoverKolam: string | null;
  hoverStroke: string | null;
  hoverChannel: HoverChannel | null;
  /** kolams/strokes marked for erasure this gesture */
  eraseKolams: string[];
  eraseStrokes: string[];
  /** draft dots marked for erasure, world coords */
  eraseDots: [number, number][];
  /** ghost dot preview for the dot tool, world coords */
  dotGhost: [number, number] | null;
  guides: SnapGuide[];
}

export const emptyOverlay = (): OverlayState => ({
  marquee: null,
  inkPreview: null,
  inkColor: '#f2ead9',
  inkWidth: 0.3,
  hoverKolam: null,
  hoverStroke: null,
  hoverChannel: null,
  eraseKolams: [],
  eraseStrokes: [],
  eraseDots: [],
  dotGhost: null,
  guides: [],
});

export interface ToolCtx {
  scene(): Scene;
  run(c: Cmd): void;
  zoom(): number;
  selection(): Set<string>;
  setSelection(ids: string[]): void;
  /** declarative overlay pieces (rendered rAF-coalesced) */
  overlay(): OverlayState;
  /** rebuild the whole world layer (scene changed outside a command) */
  requestWorld(): void;
  /** rebuild the overlay layer */
  requestOverlay(): void;
  /** live-update one kolam's group from an out-of-scene GateSystem (pen preview) */
  updateKolamLive(id: string, sys: GateSystem): void;
  /** clear any live preview rendering */
  clearLive(): void;
  /** camera moved outside history; schedule persistence */
  noteCameraChange(): void;
  toast(msg: string): void;
  options(): ToolOptions;
}

export interface Tool {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly cursor: string;
  onDown?(ctx: ToolCtx, ev: PointerEvent, w: { x: number; y: number }): void;
  onMove?(ctx: ToolCtx, ev: PointerEvent, w: { x: number; y: number }): void;
  onUp?(ctx: ToolCtx, ev: PointerEvent, w: { x: number; y: number }): void;
  onHover?(ctx: ToolCtx, w: { x: number; y: number }): void;
  cancel?(ctx: ToolCtx): void;
}

// ---------- shared picking ----------

/** Topmost kolam whose world bbox contains the point. */
function kolamAt(scene: Scene, w: { x: number; y: number }, pad = 0.3): SceneKolam | null {
  for (let i = scene.kolams.length - 1; i >= 0; i--) {
    const k = scene.kolams[i]!;
    if (pointInRect([w.x, w.y], kolamBBoxWorld(k), pad)) return k;
  }
  return null;
}

/** Topmost stroke within tol of the point. */
function strokeAt(scene: Scene, w: { x: number; y: number }, tol = 0.5): SceneStroke | null {
  for (let i = scene.strokes.length - 1; i >= 0; i--) {
    const s = scene.strokes[i]!;
    if (strokeHit(s.points, [w.x, w.y], tol)) return s;
  }
  return null;
}

/** Interior channels of a system in doc-local display units. */
function interiorChannels(
  sys: GateSystem,
): { key: string; a: [number, number]; b: [number, number] }[] {
  return sys.interior.map((g) => ({
    key: nodeKey(g.node),
    a: [g.a.x / 2, g.a.y / 2] as [number, number],
    b: [g.b.x / 2, g.b.y / 2] as [number, number],
  }));
}

const PATH_CLICK_PX = 4; // screen px: pointer travel below which a drag is a click

const screenDist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(bx - ax, by - ay);

function normalizedRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1),
    maxY: Math.max(y0, y1),
  };
}

function unionRect(rs: Rect[]): Rect {
  if (rs.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...rs.map((r) => r.minX)),
    minY: Math.min(...rs.map((r) => r.minY)),
    maxX: Math.max(...rs.map((r) => r.maxX)),
    maxY: Math.max(...rs.map((r) => r.maxY)),
  };
}

function strokeBadge(k: SceneKolam): string {
  const a = k.doc.analysis;
  if (!a) return 'unanalyzed';
  return a.isOneStroke ? 'one stroke ✓' : `${a.loopCount} loops`;
}

/** Inclusive segment intersection (endpoints touch; collinear overlap counts). */
function segInclusive(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]): number => {
    const cross = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    if (Math.abs(cross) < 1e-9) return 0;
    return cross > 0 ? 1 : -1;
  };
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) {
    return (
      Math.min(a[0], b[0]) <= Math.max(c[0], d[0]) + 1e-9 &&
      Math.max(a[0], b[0]) >= Math.min(c[0], d[0]) - 1e-9 &&
      Math.min(a[1], b[1]) <= Math.max(c[1], d[1]) + 1e-9 &&
      Math.max(a[1], b[1]) >= Math.min(c[1], d[1]) - 1e-9
    );
  }
  return false;
}

// ---------- select ----------

type SelGesture =
  | { kind: 'move'; originX: number; originY: number; orig: Map<string, { x: number; y: number }>; moved: boolean }
  | { kind: 'marquee'; startX: number; startY: number; base: string[] }
  | null;

let selGesture: SelGesture = null;

export const selectTool: Tool = {
  id: 'select',
  label: 'Select',
  shortcut: 'V',
  cursor: 'cursor-select',
  onDown(ctx, ev, w) {
    const scene = ctx.scene();
    const k = kolamAt(scene, w);
    const s = k ? null : strokeAt(scene, w);
    const sel = ctx.selection();
    if (ev.shiftKey) {
      if (k) {
        if (sel.has(k.id)) sel.delete(k.id);
        else sel.add(k.id);
      } else if (s) {
        if (sel.has(s.id)) sel.delete(s.id);
        else sel.add(s.id);
      }
    } else if ((k && !sel.has(k.id)) || (!k && s && !sel.has(s.id))) {
      ctx.setSelection(k ? [k.id] : s ? [s.id] : []);
    } else if (k || s) {
      // shift-toggle mutated the set in place; sync so the inspector refreshes
      ctx.setSelection([...sel]);
    }
    ctx.requestOverlay();
    if (ev.button !== 0) return;
    const selectedKolamIds = [...ctx.selection()].filter((id) => scene.kolams.some((q) => q.id === id));
    if (k && selectedKolamIds.includes(k.id)) {
      const orig = new Map<string, { x: number; y: number }>();
      for (const id of selectedKolamIds) {
        const q = scene.kolams.find((z) => z.id === id)!;
        orig.set(id, { x: q.x, y: q.y });
      }
      selGesture = { kind: 'move', originX: w.x, originY: w.y, orig, moved: false };
    } else if (!k && !s) {
      selGesture = { kind: 'marquee', startX: w.x, startY: w.y, base: ev.shiftKey ? [...ctx.selection()] : [] };
    }
  },
  onMove(ctx, _ev, w) {
    const ges = selGesture;
    if (!ges) return;
    const scene = ctx.scene();
    if (ges.kind === 'move') {
      let dx = w.x - ges.originX;
      let dy = w.y - ges.originY;
      if (ctx.options().snapOn) {
        dx = Math.round(dx * 2) / 2;
        dy = Math.round(dy * 2) / 2;
      }
      const moving: Rect[] = [];
      for (const [id, orig] of ges.orig) {
        const k = scene.kolams.find((q) => q.id === id);
        if (!k) continue;
        k.x = orig.x + dx;
        k.y = orig.y + dy;
        moving.push(kolamBBoxWorld(k));
        ges.moved = true;
      }
      // tldraw-style alignment guides vs the other kolams
      const others = scene.kolams.filter((q) => !ges.orig.has(q.id)).map(kolamBBoxWorld);
      const snap = snapGuides(unionRect(moving), others, 0.6);
      if (snap.dx !== 0 || snap.dy !== 0) {
        for (const [id] of ges.orig) {
          const k = scene.kolams.find((q) => q.id === id);
          if (!k) continue;
          k.x += snap.dx;
          k.y += snap.dy;
        }
      }
      ctx.overlay().guides = snap.guides;
      ctx.requestWorld();
      ctx.requestOverlay();
    } else {
      ctx.overlay().marquee = normalizedRect(ges.startX, ges.startY, w.x, w.y);
      ctx.requestOverlay();
    }
  },
  onUp(ctx, _ev, w) {
    const ges = selGesture;
    selGesture = null;
    if (!ges) return;
    const scene = ctx.scene();
    if (ges.kind === 'move') {
      if (ges.moved) {
        const moves = [...ges.orig.entries()].map(([id, orig]) => {
          const k = scene.kolams.find((q) => q.id === id)!;
          return { id, from: { x: orig.x, y: orig.y }, to: { x: k.x, y: k.y } };
        });
        for (const [id, orig] of ges.orig) {
          const k = scene.kolams.find((q) => q.id === id);
          if (k) {
            k.x = orig.x;
            k.y = orig.y;
          }
        }
        ctx.run({ t: 'moveMany', moves });
      }
      ctx.overlay().guides = [];
    } else {
      const r = normalizedRect(ges.startX, ges.startY, w.x, w.y);
      const hits = [
        ...scene.kolams.filter((k) => rectsOverlap(kolamBBoxWorld(k), r)).map((k) => k.id),
        ...scene.strokes.filter((s) => rectsOverlap(strokeBBox(s), r)).map((s) => s.id),
      ];
      ctx.setSelection([...new Set([...ges.base, ...hits])]);
      ctx.overlay().marquee = null;
    }
    ctx.clearLive();
    ctx.requestWorld();
    ctx.requestOverlay();
  },
  onHover(ctx, w) {
    const k = kolamAt(ctx.scene(), w);
    const s = k ? null : strokeAt(ctx.scene(), w);
    const ov = ctx.overlay();
    const hovK = k?.id ?? null;
    const hovS = s?.id ?? null;
    if (ov.hoverKolam !== hovK || ov.hoverStroke !== hovS) {
      ov.hoverKolam = hovK;
      ov.hoverStroke = hovS;
      ctx.requestOverlay();
    }
  },
  cancel(ctx) {
    selGesture = null;
    ctx.overlay().guides = [];
    ctx.overlay().marquee = null;
    ctx.requestOverlay();
  },
};

// ---------- hand ----------

type PanGesture = { startX: number; startY: number; camX: number; camY: number } | null;
let panGesture: PanGesture = null;

export const handTool: Tool = {
  id: 'hand',
  label: 'Pan',
  shortcut: 'H',
  cursor: 'cursor-hand',
  onDown(ctx, ev) {
    if (ev.button !== 0 && ev.button !== 1) return;
    panGesture = { startX: ev.clientX, startY: ev.clientY, camX: ctx.scene().camera.x, camY: ctx.scene().camera.y };
  },
  onMove(ctx, ev) {
    const ges = panGesture;
    if (!ges) return;
    const cam = ctx.scene().camera;
    cam.x = ges.camX - (ev.clientX - ges.startX) / ctx.zoom();
    cam.y = ges.camY - (ev.clientY - ges.startY) / ctx.zoom();
    ctx.requestWorld();
    ctx.requestOverlay();
  },
  onUp(ctx) {
    if (panGesture) ctx.noteCameraChange();
    panGesture = null;
  },
  cancel() {
    panGesture = null;
  },
};

// ---------- dot (pulli) ----------

type DotGesture = { startX: number; startY: number; moved: boolean } | null;
let dotGesture: DotGesture = null;

/** Snapped world lattice point under the cursor: the draft's lattice if inside one, else the integer grid. */
function ghostDot(ctx: ToolCtx, w: { x: number; y: number }): [number, number] {
  const k = kolamAt(ctx.scene(), w, 0.1);
  if (k && k.doc.grid.spec.kind === 'custom') {
    const d = worldToDoc(k, [w.x, w.y]);
    return docToWorld(k, [Math.round(d[0]), Math.round(d[1])]);
  }
  return [Math.round(w.x), Math.round(w.y)];
}

function placeDot(ctx: ToolCtx, w: { x: number; y: number }): void {
  const scene = ctx.scene();
  const k = kolamAt(scene, w, 0.1);
  if (k && k.doc.grid.spec.kind === 'custom') {
    const spec = k.doc.grid.spec;
    const d = worldToDoc(k, [w.x, w.y]);
    const q: [number, number] = [Math.round(d[0]), Math.round(d[1])];
    if (spec.dots.some(([x, y]) => x === q[0] && y === q[1])) {
      ctx.toast('a pulli already sits there');
      return;
    }
    const next = { kind: 'custom' as const, dots: [...spec.dots, q].sort((a, b) => a[1] - b[1] || a[0] - b[0]) };
    const c0 = specCenter(spec);
    const c1 = specCenter(next);
    ctx.run({
      t: 'setGrid',
      id: k.id,
      prev: spec,
      next,
      prevPos: { x: k.x, y: k.y },
      nextPos: { x: k.x + c1[0] - c0[0], y: k.y + c1[1] - c0[1] },
    });
    const fresh = ctx.scene().kolams.find((z) => z.id === k.id)!;
    ctx.toast(`pulli added — ${strokeBadge(fresh)}`);
    return;
  }
  if (k) {
    ctx.toast('generated kolams keep their grid — sow pulli on empty canvas or on drafts');
    return;
  }
  const p: [number, number] = [Math.round(w.x), Math.round(w.y)];
  const doc = makeDraftDoc([p], `Draft ${scene.nextId}`);
  const nk: SceneKolam = {
    id: `k${scene.nextId}`,
    name: doc.meta?.name ?? `Draft ${scene.nextId}`,
    x: p[0],
    y: p[1],
    scale: 1,
    rot: 0,
    reflect: false,
    doc,
  };
  ctx.run({ t: 'add', kolam: nk });
  ctx.setSelection([nk.id]);
  ctx.toast('draft started — click to add pulli, drag to sow a grid, pen to open gates');
}

function createGridKolam(ctx: ToolCtx, x0: number, y0: number, x1: number, y1: number): void {
  const scene = ctx.scene();
  const cols = Math.max(1, Math.min(60, Math.round(Math.abs(x1 - x0))));
  const rows = Math.max(1, Math.min(60, Math.round(Math.abs(y1 - y0))));
  let dots: [number, number][];
  if (ctx.options().gridShape === 'diamond') {
    const m = Math.min(cols, rows);
    const n = Math.max(1, m % 2 === 1 ? m : m - 1); // classic diamond row count (odd)
    dots = [];
    for (let r = 0; r < n; r++) {
      const wdt = 2 * Math.min(r, n - 1 - r) + 1;
      const off = (n - wdt) / 2;
      for (let i = 0; i < wdt; i++) dots.push([off + i, r]);
    }
  } else {
    dots = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) dots.push([i, j]);
  }
  const doc = makeDraftDoc(dots, `Draft ${scene.nextId}`);
  const nk: SceneKolam = {
    id: `k${scene.nextId}`,
    name: doc.meta?.name ?? `Draft ${scene.nextId}`,
    x: (Math.min(x0, x1) + Math.max(x0, x1)) / 2,
    y: (Math.min(y0, y1) + Math.max(y0, y1)) / 2,
    scale: 1,
    rot: 0,
    reflect: false,
    doc,
  };
  ctx.run({ t: 'add', kolam: nk });
  ctx.setSelection([nk.id]);
  const a = doc.analysis!;
  ctx.toast(`grid draft — ${a.dotCount} pulli, ${a.isOneStroke ? 'one stroke ✓' : `${a.loopCount} loops`}`);
}

export const dotTool: Tool = {
  id: 'dot',
  label: 'Pulli',
  shortcut: 'G',
  cursor: 'cursor-dot',
  onDown(ctx, _ev, w) {
    dotGesture = { startX: w.x, startY: w.y, moved: false };
    ctx.overlay().dotGhost = null;
  },
  onMove(ctx, ev, w) {
    const ges = dotGesture;
    if (!ges) return;
    if (screenDist(ev.clientX, ev.clientY, ges.startX, ges.startY) > PATH_CLICK_PX) ges.moved = true;
    const ov = ctx.overlay();
    ov.marquee = ges.moved ? normalizedRect(ges.startX, ges.startY, w.x, w.y) : null;
    ov.dotGhost = ges.moved ? null : ghostDot(ctx, w);
    ctx.requestOverlay();
  },
  onUp(ctx, _ev, w) {
    const ges = dotGesture;
    dotGesture = null;
    const ov = ctx.overlay();
    ov.marquee = null;
    ov.dotGhost = null;
    if (!ges) return;
    if (ges.moved) createGridKolam(ctx, ges.startX, ges.startY, w.x, w.y);
    else placeDot(ctx, w);
    ctx.requestWorld();
    ctx.requestOverlay();
  },
  onHover(ctx, w) {
    const ov = ctx.overlay();
    const ghost = ghostDot(ctx, w);
    const cur = ov.dotGhost;
    if (!cur || cur[0] !== ghost[0] || cur[1] !== ghost[1]) {
      ov.dotGhost = ghost;
      ctx.requestOverlay();
    }
  },
  cancel(ctx) {
    dotGesture = null;
    const ov = ctx.overlay();
    ov.marquee = null;
    ov.dotGhost = null;
    ctx.requestOverlay();
  },
};

// ---------- gate pen ----------

type PenGesture = {
  kolamId: string;
  sys: GateSystem;
  lastW: { x: number; y: number };
  /** nodeKey -> gesture bookkeeping (first-touch prev state + display pair) */
  touched: Map<string, { pair: [number, number, number, number]; prev: GateState }>;
} | null;
let penGesture: PenGesture = null;

function penPick(
  ctx: ToolCtx,
  k: SceneKolam,
  sys: GateSystem,
  w: { x: number; y: number },
): { key: string; a: [number, number]; b: [number, number]; interior: boolean; state: GateState } | null {
  const d = worldToDoc(k, [w.x, w.y]);
  const tol = Math.abs(8 / (ctx.zoom() * k.scale)); // ~8 screen px in doc-local units
  const hit = pickGate(sys, fromDisplay({ x: d[0], y: d[1] }), scaleDistance(tol));
  if (!hit) return null;
  return {
    key: nodeKey(hit.node),
    a: [hit.a.x / 2, hit.a.y / 2] as [number, number],
    b: [hit.b.x / 2, hit.b.y / 2] as [number, number],
    interior: hit.interior,
    state: sys.states.get(nodeKey(hit.node)) ?? 'closed',
  };
}

function penApply(
  ctx: ToolCtx,
  gesture: NonNullable<PenGesture>,
  key: string,
  chan: { a: [number, number]; b: [number, number] },
): void {
  const mode = ctx.options().penMode;
  const cur = gesture.sys.states.get(key) ?? 'closed';
  const target: GateState = mode === 'open' ? 'open' : mode === 'closed' ? 'closed' : cur === 'open' ? 'closed' : 'open';
  if (!gesture.touched.has(key)) {
    const [ax, ay] = chan.a;
    const [bx, by] = chan.b;
    gesture.touched.set(key, { pair: [ax, ay, bx, by], prev: cur });
  }
  if (target !== cur) gesture.sys.states.set(key, target);
  ctx.updateKolamLive(gesture.kolamId, gesture.sys);
}

export const penTool: Tool = {
  id: 'pen',
  label: 'Gate pen',
  shortcut: 'P',
  cursor: 'cursor-pen',
  onDown(ctx, _ev, w) {
    const scene = ctx.scene();
    const k = kolamAt(scene, w, 0.6);
    if (!k) {
      ctx.toast('hover a kolam, then sweep the pen through its channels');
      return;
    }
    const sys = sysFromDoc(k.doc);
    penGesture = { kolamId: k.id, sys, lastW: w, touched: new Map() };
    ctx.overlay().hoverChannel = null;
    const hit = penPick(ctx, k, sys, w);
    if (hit && hit.interior) penApply(ctx, penGesture, hit.key, hit);
  },
  onMove(ctx, _ev, w) {
    const scene = ctx.scene();
    const ges = penGesture;
    if (!ges) {
      // hover highlight
      const k = kolamAt(scene, w, 0.6);
      let chan: HoverChannel | null = null;
      if (k) {
        const sys = sysFromDoc(k.doc);
        const hit = penPick(ctx, k, sys, w);
        if (hit) chan = { kolamId: k.id, a: hit.a, b: hit.b, interior: hit.interior };
      }
      const ov = ctx.overlay();
      const cur = ov.hoverChannel;
      const same =
        (cur === null && chan === null) ||
        (cur !== null &&
          chan !== null &&
          cur.kolamId === chan.kolamId &&
          cur.a[0] === chan.a[0] &&
          cur.a[1] === chan.a[1] &&
          cur.b[0] === chan.b[0] &&
          cur.b[1] === chan.b[1]);
      if (!same) {
        ov.hoverChannel = chan;
        ov.hoverKolam = k?.id ?? null;
        ctx.requestOverlay();
      }
      return;
    }
    const k = scene.kolams.find((q) => q.id === ges.kolamId);
    if (!k) {
      penGesture = null;
      return;
    }
    const fromDoc = worldToDoc(k, [ges.lastW.x, ges.lastW.y]);
    const toDoc = worldToDoc(k, [w.x, w.y]);
    ges.lastW = w;
    const seg: [[number, number], [number, number]] = [fromDoc, toDoc];
    for (const ch of interiorChannels(ges.sys)) {
      if (ges.touched.has(ch.key)) continue;
      if (segInclusive(seg[0]!, seg[1]!, ch.a, ch.b)) penApply(ctx, ges, ch.key, ch);
    }
  },
  onUp(ctx) {
    const ges = penGesture;
    penGesture = null;
    ctx.clearLive();
    if (!ges || ges.touched.size === 0) return;
    const pairs: [number, number, number, number][] = [];
    const prev: GateState[] = [];
    const next: GateState[] = [];
    for (const [key, rec] of ges.touched) {
      pairs.push(rec.pair);
      prev.push(rec.prev);
      next.push(ges.sys.states.get(key) ?? rec.prev);
    }
    ctx.run({ t: 'gates', id: ges.kolamId, pairs, prev, next });
    const fresh = ctx.scene().kolams.find((q) => q.id === ges.kolamId)!;
    ctx.toast(`${ges.touched.size} gate${ges.touched.size === 1 ? '' : 's'} — ${strokeBadge(fresh)}`);
  },
  cancel(ctx) {
    if (penGesture) {
      ctx.clearLive();
      penGesture = null;
    }
    ctx.overlay().hoverChannel = null;
    ctx.requestOverlay();
  },
};

// ---------- ink ----------

type InkGesture = { lastScreenX: number; lastScreenY: number; points: [number, number][] } | null;
let inkGesture: InkGesture = null;

export const inkTool: Tool = {
  id: 'ink',
  label: 'Ink',
  shortcut: 'I',
  cursor: 'cursor-ink',
  onDown(ctx, ev, w) {
    inkGesture = { lastScreenX: ev.clientX, lastScreenY: ev.clientY, points: [[w.x, w.y]] };
    const ov = ctx.overlay();
    ov.inkPreview = inkGesture.points;
    ov.inkColor = ctx.options().inkColor;
    ov.inkWidth = ctx.options().inkWidth;
    ctx.requestOverlay();
  },
  onMove(ctx, ev, w) {
    const ges = inkGesture;
    if (!ges) return;
    if (screenDist(ev.clientX, ev.clientY, ges.lastScreenX, ges.lastScreenY) >= 3) {
      ges.lastScreenX = ev.clientX;
      ges.lastScreenY = ev.clientY;
      ges.points.push([w.x, w.y]);
      ctx.overlay().inkPreview = ges.points;
      ctx.requestOverlay();
    }
  },
  onUp(ctx) {
    const ges = inkGesture;
    inkGesture = null;
    ctx.overlay().inkPreview = null;
    if (!ges || ges.points.length < 2) {
      ctx.requestOverlay();
      return;
    }
    const tol = 2.5 / ctx.zoom();
    const pts = simplifyInk(ges.points, tol);
    const scene = ctx.scene();
    const stroke: SceneStroke = {
      id: `s${scene.nextId}`,
      points: pts,
      color: ctx.options().inkColor,
      width: ctx.options().inkWidth,
    };
    ctx.run({ t: 'addStrokes', strokes: [{ stroke, index: scene.strokes.length }] });
    ctx.toast('flour ink laid down');
  },
  cancel(ctx) {
    inkGesture = null;
    ctx.overlay().inkPreview = null;
    ctx.requestOverlay();
  },
};

// ---------- eraser ----------

type EraseGesture = {
  kolams: Set<string>;
  strokes: Set<string>;
  /** kolam id -> dot keys ("x,y" of doc-local display ints) marked for removal */
  dots: Map<string, Set<string>>;
  lastFrom: { x: number; y: number } | null;
} | null;
let eraseGesture: EraseGesture = null;

function describeErase(g: NonNullable<EraseGesture>): string {
  const parts: string[] = [];
  if (g.kolams.size > 0) parts.push(`${g.kolams.size} kolam${g.kolams.size === 1 ? '' : 's'}`);
  let dots = 0;
  for (const [, keys] of g.dots) dots += keys.size;
  if (dots > 0) parts.push(`${dots} pulli`);
  if (g.strokes.size > 0) parts.push(`${g.strokes.size} stroke${g.strokes.size === 1 ? '' : 's'}`);
  return parts.join(', ') || 'nothing';
}

function eraseAt(ctx: ToolCtx, from: { x: number; y: number }, to: { x: number; y: number }): void {
  const g = eraseGesture;
  if (!g) return;
  const scene = ctx.scene();
  const seg: [[number, number], [number, number]] = [[from.x, from.y], [to.x, to.y]];
  // decoration strokes (topmost first)
  for (let i = scene.strokes.length - 1; i >= 0; i--) {
    const s = scene.strokes[i]!;
    if (!g.strokes.has(s.id) && strokeNearPath(s, seg, 0.5)) g.strokes.add(s.id);
  }
  for (const k of scene.kolams) {
    const d = worldToDoc(k, [to.x, to.y]);
    const tolDoc = Math.abs(10 / (ctx.zoom() * k.scale)); // ~10 screen px
    const hit = pickDot(buildGrid(k.doc.grid.spec), fromDisplay({ x: d[0], y: d[1] }), scaleDistance(tolDoc));
    if (!hit) continue;
    if (k.doc.grid.spec.kind === 'custom') {
      // drafts erase pulli-by-pulli
      let set = g.dots.get(k.id);
      if (!set) {
        set = new Set();
        g.dots.set(k.id, set);
      }
      set.add(`${hit.x / 2},${hit.y / 2}`);
    } else {
      // generated kolams are atomic: sweeping over a pulli erases the kolam
      g.kolams.add(k.id);
    }
  }
  const ov = ctx.overlay();
  ov.eraseKolams = [...g.kolams];
  ov.eraseStrokes = [...g.strokes];
  ov.eraseDots = [...g.dots.entries()].flatMap(([id, keys]) => {
    const k = scene.kolams.find((q) => q.id === id);
    if (!k) return [];
    return [...keys].map((key) => {
      const [sx, sy] = key.split(',');
      const dx = Number(sx);
      const dy = Number(sy);
      return Number.isFinite(dx) && Number.isFinite(dy) ? docToWorld(k, [dx, dy]) : ([0, 0] as [number, number]);
    });
  });
  ctx.requestOverlay();
}

export const eraserTool: Tool = {
  id: 'eraser',
  label: 'Eraser',
  shortcut: 'E',
  cursor: 'cursor-eraser',
  onDown(ctx, _ev, w) {
    eraseGesture = { kolams: new Set(), strokes: new Set(), dots: new Map(), lastFrom: w };
    eraseAt(ctx, w, w);
  },
  onMove(ctx, _ev, w) {
    const ges = eraseGesture;
    if (!ges) return;
    eraseAt(ctx, ges.lastFrom ?? w, w);
    ges.lastFrom = w;
  },
  onUp(ctx) {
    const g = eraseGesture;
    eraseGesture = null;
    if (!g) return;
    const cmds: Cmd[] = [];
    const scene = ctx.scene();
    // draft dot removals (whole-kolam removal if the last pulli goes)
    for (const [id, keys] of g.dots) {
      if (g.kolams.has(id)) continue;
      const k = scene.kolams.find((q) => q.id === id);
      if (!k || k.doc.grid.spec.kind !== 'custom') continue;
      const spec = k.doc.grid.spec;
      const remaining = spec.dots.filter(([x, y]) => !keys.has(`${x},${y}`));
      if (remaining.length === 0) {
        g.kolams.add(id);
        continue;
      }
      const nextSpec = { kind: 'custom' as const, dots: [...remaining].sort((a, b) => a[1] - b[1] || a[0] - b[0]) };
      const c0 = specCenter(spec);
      const c1 = specCenter(nextSpec);
      cmds.push({
        t: 'setGrid',
        id,
        prev: spec,
        next: nextSpec,
        prevPos: { x: k.x, y: k.y },
        nextPos: { x: k.x + c1[0] - c0[0], y: k.y + c1[1] - c0[1] },
      });
    }
    if (g.strokes.size > 0) {
      cmds.push({
        t: 'removeStrokes',
        items: scene.strokes.map((s, index) => ({ stroke: s, index })).filter((x) => g.strokes.has(x.stroke.id)),
      });
    }
    if (g.kolams.size > 0) {
      cmds.push({
        t: 'removeMany',
        items: scene.kolams.map((k, index) => ({ kolam: k, index })).filter((x) => g.kolams.has(x.kolam.id)),
      });
    }
    const ov = ctx.overlay();
    ov.eraseKolams = [];
    ov.eraseStrokes = [];
    ov.eraseDots = [];
    if (cmds.length === 0) {
      ctx.requestOverlay();
      return;
    }
    const sel = ctx.selection();
    if ([...sel].some((id) => g.kolams.has(id) || g.strokes.has(id))) {
      ctx.setSelection([...sel].filter((id) => !g.kolams.has(id) && !g.strokes.has(id)));
    }
    ctx.run(cmds.length === 1 ? cmds[0]! : { t: 'group', cmds });
    ctx.toast(`erased ${describeErase(g)}`);
  },
  onHover(ctx, w) {
    eraseAt(ctx, w, w);
  },
  cancel(ctx) {
    eraseGesture = null;
    const ov = ctx.overlay();
    ov.eraseKolams = [];
    ov.eraseStrokes = [];
    ov.eraseDots = [];
    ctx.requestOverlay();
  },
};

// ---------- registry ----------

export const TOOLS: Record<ToolId, Tool> = {
  select: selectTool,
  hand: handTool,
  dot: dotTool,
  pen: penTool,
  ink: inkTool,
  eraser: eraserTool,
};

export const TOOL_ORDER: ToolId[] = ['select', 'hand', 'dot', 'pen', 'ink', 'eraser'];
