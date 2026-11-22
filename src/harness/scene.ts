/**
 * Kolam Harness scene model: kolam objects on an infinite canvas.
 * Pure data + transforms; no DOM (headless-testable).
 */
import { KolamDoc, GridSpec, buildGrid, buildGates, findGateByDots, docFromSys, sysFromDoc, nodeKey } from '@logicinczo/dotkolam';

export interface SceneKolam {
  id: string;
  name: string;
  /** world position of the kolam's bounding-box center (display units) */
  x: number;
  y: number;
  scale: number;
  rot: 0 | 1 | 2 | 3; // quarter turns
  reflect: boolean;
  doc: KolamDoc; // authoritative Kolam-JSON (L3)
  gen?: {
    symmetry: string;
    density: number;
    strokes: string;
    seed: string;
  };
}

/**
 * A freehand decoration stroke on the canvas (rice-flour flourish). Purely a
 * scene object: it never enters any KolamDoc, so the kolam model stays
 * untouched by freehand ink.
 */
export interface SceneStroke {
  id: string;
  /** world polyline points (display units), simplified */
  points: [number, number][];
  color: string;
  width: number;
}

export interface Scene {
  kolams: SceneKolam[]; // z-order = array order (last on top)
  /** decoration strokes (z-order = array order, rendered below kolams) */
  strokes: SceneStroke[];
  nextId: number;
  camera: { x: number; y: number; zoom: number };
}

export function newScene(): Scene {
  return { kolams: [], strokes: [], nextId: 1, camera: { x: 0, y: 0, zoom: 24 } };
}

export function bboxOfDoc(doc: KolamDoc): { minX: number; minY: number; maxX: number; maxY: number } {
  const grid = buildGrid(doc.grid.spec);
  const xs = grid.dots.map((d) => d.x / 2);
  const ys = grid.dots.map((d) => d.y / 2);
  return {
    minX: Math.min(...xs) - 1,
    minY: Math.min(...ys) - 1,
    maxX: Math.max(...xs) + 1,
    maxY: Math.max(...ys) + 1,
  };
}

// --- kolam transforms (doc-local display units <-> world display units) ---
// Rendering: translate(k.x,k.y) · rotate(rot*90°, svg y-down cw) · scale(reflect?-s:s, s) · translate(-bboxCenter)

/** Transform a doc-local display point into world coordinates. */
export function docToWorld(k: SceneKolam, p: [number, number]): [number, number] {
  const b = bboxOfDoc(k.doc);
  let x = (p[0] - (b.minX + b.maxX) / 2) * (k.reflect ? -k.scale : k.scale);
  let y = (p[1] - (b.minY + b.maxY) / 2) * k.scale;
  if (k.rot === 1) { const t = x; x = -y; y = t; }
  else if (k.rot === 2) { x = -x; y = -y; }
  else if (k.rot === 3) { const t = x; x = y; y = -t; }
  return [k.x + x, k.y + y];
}

/** Inverse of docToWorld: world point -> doc-local display coords. */
export function worldToDoc(k: SceneKolam, w: [number, number]): [number, number] {
  const b = bboxOfDoc(k.doc);
  let x = w[0] - k.x;
  let y = w[1] - k.y;
  if (k.rot === 1) { const t = x; x = y; y = -t; }
  else if (k.rot === 2) { x = -x; y = -y; }
  else if (k.rot === 3) { const t = x; x = -y; y = t; }
  const s = k.reflect ? -k.scale : k.scale;
  return [x / s + (b.minX + b.maxX) / 2, y / k.scale + (b.minY + b.maxY) / 2];
}

/** World-space bounding box of a placed kolam (covers curves + margin). */
export function kolamBBoxWorld(k: SceneKolam): { minX: number; minY: number; maxX: number; maxY: number } {
  const b = bboxOfDoc(k.doc);
  const corners: [number, number][] = [
    docToWorld(k, [b.minX, b.minY]),
    docToWorld(k, [b.maxX, b.minY]),
    docToWorld(k, [b.minX, b.maxY]),
    docToWorld(k, [b.maxX, b.maxY]),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Bounding box of a decoration stroke (world coords). */
export function strokeBBox(s: SceneStroke): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = s.points.map((p) => p[0]);
  const ys = s.points.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// --- draft kolams (hand-drawn, custom dot grids) ---

/** Build a fresh all-closed L3 doc over a custom dot set (display units). */
export function makeDraftDoc(dots: [number, number][], name?: string): KolamDoc {
  const sys = buildGates(buildGrid({ kind: 'custom', dots }), 'all-closed');
  return docFromSys(sys, {
    includeIndex: true,
    ...(name !== undefined ? { meta: { name } } : {}),
  });
}

/**
 * Rebuild a kolam doc over a new grid spec, carrying gate states by node key:
 * persisting channels keep their open/closed bit, new channels start closed.
 * Goes through the mandated bridge (sysFromDoc -> mutate -> docFromSys).
 */
export function applyGridSpec(doc: KolamDoc, next: GridSpec): KolamDoc {
  const prevSys = sysFromDoc(doc);
  const sys = buildGates(buildGrid(next), 'all-closed');
  for (const g of sys.interior) {
    const prev = prevSys.states.get(nodeKey(g.node));
    if (prev) sys.states.set(nodeKey(g.node), prev);
  }
  return docFromSys(sys, {
    meta: doc.meta,
    render: doc.render,
    symmetry: doc.pattern?.symmetry,
    includeIndex: true,
  });
}

/**
 * Center (doc-local display coords) of a spec's dot set. Kolams are placed by
 * their bbox center, so growing a draft moves this pivot; commands pair a
 * spec change with the position compensation (see `setGrid`) to keep
 * existing pulli stationary in world space.
 */
export function specCenter(spec: GridSpec): [number, number] {
  const grid = buildGrid(spec);
  const xs = grid.dots.map((d) => d.x / 2);
  const ys = grid.dots.map((d) => d.y / 2);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/** Find a free spot on a coarse placement grid (Chebyshev-ring spiral, with margin). */
export function findFreeSpot(scene: Scene, w: number, h: number): { x: number; y: number } {
  const MARGIN = 1.5;
  const occupied = scene.kolams.map((k) => {
    const b = bboxOfDoc(k.doc);
    return {
      x0: k.x + (b.minX - 1) * k.scale - MARGIN,
      y0: k.y + (b.minY - 1) * k.scale - MARGIN,
      x1: k.x + (b.maxX + 1) * k.scale + MARGIN,
      y1: k.y + (b.maxY + 1) * k.scale + MARGIN,
    };
  });
  const free = (x: number, y: number): boolean => {
    const x0 = x - w / 2, y0 = y - h / 2, x1 = x + w / 2, y1 = y + h / 2;
    return !occupied.some((o) => !(x1 < o.x0 || x0 > o.x1 || y1 < o.y0 || y0 > o.y1));
  };
  for (let ring = 0; ring < 400; ring++) {
    // all lattice points with max(|x|,|y|) == ring, step 4 (two dot-spacings)
    if (ring === 0) {
      if (free(0, 0)) return { x: 0, y: 0 };
      continue;
    }
    const r = ring * 4;
    for (let t = -r; t <= r; t += 4) {
      // four sides of the square ring
      for (const [x, y] of [
        [t, -r], [t, r], [-r, t], [r, t],
      ] as [number, number][]) {
        if (free(x, y)) return { x, y };
      }
    }
  }
  return { x: scene.kolams.length * 4, y: 0 };
}

/** Flip a set of gates inside a kolam doc; returns a refreshed doc (L3). */
export function flipGatesInDoc(
  doc: KolamDoc,
  pairs: [number, number, number, number][], // [ax, ay, bx, by] per gate
): { doc: KolamDoc; prev: ('open' | 'closed')[] } {
  const sys = sysFromDoc(doc);
  const prev: ('open' | 'closed')[] = [];
  for (const [ax, ay, bx, by] of pairs) {
    const node = findGateByDots(sys, [ax, ay], [bx, by]);
    if (!node) continue;
    const key = `${node.x},${node.y}`;
    const cur = (sys.states.get(key) === 'open' ? 'open' : 'closed') as 'open' | 'closed';
    prev.push(cur);
    sys.states.set(key, cur === 'open' ? 'closed' : 'open');
  }
  const refreshed = docFromSys(sys, {
    meta: doc.meta,
    render: doc.render,
    symmetry: doc.pattern?.symmetry,
    includeIndex: true,
  });
  return { doc: refreshed, prev };
}

/** Set explicit gate states (for undo). */
export function setGatesInDoc(
  doc: KolamDoc,
  pairs: [number, number, number, number][],
  states: ('open' | 'closed')[],
): KolamDoc {
  const sys = sysFromDoc(doc);
  pairs.forEach(([ax, ay, bx, by], i) => {
    const node = findGateByDots(sys, [ax, ay], [bx, by]);
    if (node) sys.states.set(`${node.x},${node.y}`, states[i] ?? 'closed');
  });
  return docFromSys(sys, {
    meta: doc.meta,
    render: doc.render,
    symmetry: doc.pattern?.symmetry,
    includeIndex: true,
  });
}

// --- serialization ---

export interface SceneFile {
  harnessVersion: '1.0' | '1.1';
  scene: {
    nextId: number;
    camera: Scene['camera'];
    kolams: SceneKolam[];
    strokes?: SceneStroke[]; // '1.1' only
  };
}

export function sceneToJSON(scene: Scene): SceneFile {
  return {
    harnessVersion: '1.1',
    scene: { nextId: scene.nextId, camera: scene.camera, kolams: scene.kolams, strokes: scene.strokes },
  };
}

export function sceneFromJSON(v: unknown): Scene {
  const f = v as SceneFile;
  if (!f || (f.harnessVersion !== '1.1' && f.harnessVersion !== '1.0') || !f.scene) {
    throw new Error('not a .harness.json file');
  }
  return {
    kolams: f.scene.kolams,
    strokes: f.scene.strokes ?? [], // '1.0' scenes have no decorations
    nextId: f.scene.nextId,
    camera: f.scene.camera ?? { x: 0, y: 0, zoom: 24 },
  };
}
