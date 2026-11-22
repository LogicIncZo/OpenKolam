/**
 * Freehand ink processing: distance-based sampling filter and
 * Douglas-Peucker simplification for decoration strokes. Pure; no DOM.
 */

/** Drop samples closer than minDist to the previously kept point. */
export function minDistanceFilter(
  points: [number, number][],
  minDist: number,
): [number, number][] {
  if (points.length === 0) return [];
  const out: [number, number][] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const last = out[out.length - 1]!;
    const p = points[i]!;
    const dx = p[0] - last[0];
    const dy = p[1] - last[1];
    if (dx * dx + dy * dy >= minDist * minDist) out.push(p);
  }
  return out;
}

/**
 * Douglas-Peucker polyline simplification: keeps points that deviate more
 * than `tolerance` from the segment joining their neighbors. Deterministic.
 */
export function simplifyInk(
  points: [number, number][],
  tolerance: number,
): [number, number][] {
  if (points.length <= 2) return [...points];
  const keep = new Set<number>([0, points.length - 1]);
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo]!;
    const b = points[hi]!;
    let maxD = -1;
    let maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d2 = pointSegDist2(points[i]!, a, b);
      if (d2 > maxD) {
        maxD = d2;
        maxI = i;
      }
    }
    if (maxD > tolerance * tolerance && maxI > 0) {
      keep.add(maxI);
      stack.push([lo, maxI], [maxI, hi]);
    }
  }
  return points.filter((_, i) => keep.has(i));
}

function pointSegDist2(p: [number, number], a: [number, number], b: [number, number]): number {
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
