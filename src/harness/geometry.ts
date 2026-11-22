/**
 * Geometry helpers for the drawing tools: hit-testing, pen-stroke/channel
 * intersection, marquee overlap, snapping guides, zoom-to-fit. Pure data in
 * world/display coordinates; no DOM (headless-testable).
 */
import { Scene, SceneStroke, strokeBBox, kolamBBoxWorld } from './scene.js';

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Squared distance from p to the closest point on segment [a, b]. */
export function pointSegDist2(p: [number, number], a: [number, number], b: [number, number]): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return apx * apx + apy * apy;
  const t = Math.max(0, Math.min(1, (abx * apx + aby * apy) / len2));
  const dx = apx - t * abx;
  const dy = apy - t * aby;
  return dx * dx + dy * dy;
}

/**
 * Inclusive segment intersection test (endpoints touching count; collinear
 * overlap counts). Used for pen strokes sweeping across gate channels.
 */
export function segSegIntersect(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]): number => {
    const cross = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    if (Math.abs(cross) < 1e-9) return 0; // collinear
    return cross > 0 ? 1 : -1;
  };
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  // collinear special cases: bounding-box overlap on the shared axis
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

/** True if the pointer path crosses the channel segment (either direction). */
export function pathCrossesChannel(
  path: [number, number][],
  channel: [[number, number], [number, number]],
): boolean {
  for (let i = 1; i < path.length; i++) {
    if (segSegIntersect(path[i - 1]!, path[i]!, channel[0], channel[1])) return true;
  }
  return false;
}

/** True if any stroke segment lies within tol of point p. */
export function strokeHit(points: [number, number][], p: [number, number], tol: number): boolean {
  const t2 = tol * tol;
  for (let i = 1; i < points.length; i++) {
    if (pointSegDist2(p, points[i - 1]!, points[i]!) <= t2) return true;
  }
  return false;
}

/** True if the pointer path passes within tol of any stroke segment. */
export function strokeNearPath(stroke: SceneStroke, path: [number, number][], tol: number): boolean {
  for (const [a, b] of pairsOf(path)) {
    for (let i = 1; i < stroke.points.length; i++) {
      if (segSegDist2Within(stroke.points[i - 1]!, stroke.points[i]!, a, b, tol)) return true;
    }
  }
  return false;
}

function pairsOf(p: [number, number][]): [[number, number], [number, number]][] {
  const out: [[number, number], [number, number]][] = [];
  for (let i = 1; i < p.length; i++) out.push([p[i - 1]!, p[i]!]);
  return out;
}

function segSegDist2Within(a: [number, number], b: [number, number], c: [number, number], d: [number, number], tol: number): boolean {
  // cheap conservative test: either endpoint pair within tol, or segments intersect
  const t2 = tol * tol;
  if (pointSegDist2(a, c, d) <= t2 || pointSegDist2(b, c, d) <= t2) return true;
  if (pointSegDist2(c, a, b) <= t2 || pointSegDist2(d, a, b) <= t2) return true;
  return segSegIntersect(a, b, c, d);
}

export function pointInRect(p: [number, number], r: Rect, pad = 0): boolean {
  return p[0] >= r.minX - pad && p[0] <= r.maxX + pad && p[1] >= r.minY - pad && p[1] <= r.maxY + pad;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

// --- snapping guides (tldraw-style alignment while dragging) ---

export interface SnapGuide {
  axis: 'x' | 'y';
  /** world coordinate of the guide line */
  pos: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/**
 * Align the moving bbox's center and edges to other bboxes' centers and
 * edges. The closest candidate per axis wins (ties resolved by the first in
 * `others` order, which is the scene z-order — deterministic). Threshold is
 * in world units.
 */
export function snapGuides(moving: Rect, others: Rect[], threshold: number): SnapResult {
  const targets = (r: Rect): { x: number[]; y: number[] } => ({
    x: [r.minX, (r.minX + r.maxX) / 2, r.maxX],
    y: [r.minY, (r.minY + r.maxY) / 2, r.maxY],
  });
  const mine = targets(moving);
  let bx: { delta: number; pos: number } | null = null;
  let by: { delta: number; pos: number } | null = null;
  for (const o of others) {
    const t = targets(o);
    for (const m of mine.x) {
      for (const cand of t.x) {
        const delta = cand - m;
        if (Math.abs(delta) <= threshold && (bx === null || Math.abs(delta) < Math.abs(bx.delta))) {
          bx = { delta, pos: cand };
        }
      }
    }
    for (const m of mine.y) {
      for (const cand of t.y) {
        const delta = cand - m;
        if (Math.abs(delta) <= threshold && (by === null || Math.abs(delta) < Math.abs(by.delta))) {
          by = { delta, pos: cand };
        }
      }
    }
  }
  return {
    dx: bx?.delta ?? 0,
    dy: by?.delta ?? 0,
    guides: [
      ...(bx ? [{ axis: 'x' as const, pos: bx.pos }] : []),
      ...(by ? [{ axis: 'y' as const, pos: by.pos }] : []),
    ],
  };
}

/** Union bbox of every kolam and stroke (null on an empty scene). */
export function sceneContentBox(scene: Scene): Rect | null {
  const boxes: Rect[] = [
    ...scene.kolams.map((k) => kolamBBoxWorld(k)),
    ...scene.strokes.map((s) => strokeBBox(s)),
  ];
  if (boxes.length === 0) return null;
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    maxY: Math.max(...boxes.map((b) => b.maxY)),
  };
}
