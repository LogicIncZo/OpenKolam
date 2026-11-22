/**
 * Command algebra with exact undo: every command is data; `invert` produces
 * its exact inverse against the pre-state. Laws (verified in tests):
 *   apply(apply(s, c), invert(s, c)) == s
 *   invert(apply(s, c), invert-after-apply) round-trips
 *
 * Z-order note: `add`/`addMany` carry an insertion index, so undoing a
 * removal restores the kolam's exact z-position (the scene projection that
 * the law test compares includes array order).
 */
import { GridSpec, KolamDoc } from '@logicinczo/dotkolam';
import { Scene, SceneKolam, SceneStroke, setGatesInDoc, applyGridSpec } from './scene.js';

export type Cmd =
  | { t: 'add'; kolam: SceneKolam; index?: number }
  /** Removals carry the removed data so the inverse is self-contained
   * (invert runs against the post-state, where the kolam is already gone). */
  | { t: 'remove'; kolam: SceneKolam; index: number }
  | { t: 'move'; id: string; from: { x: number; y: number }; to: { x: number; y: number } }
  | { t: 'setTransform'; id: string; prev: Pick<SceneKolam, 'rot' | 'reflect' | 'scale'>; next: Pick<SceneKolam, 'rot' | 'reflect' | 'scale'> }
  | { t: 'rename'; id: string; from: string; to: string }
  | {
      t: 'gates';
      id: string;
      pairs: [number, number, number, number][];
      prev: ('open' | 'closed')[];
      next: ('open' | 'closed')[];
    }
  /**
   * Grow/shrink a draft kolam's dot grid; gate states carry over by node key.
   * prevPos/nextPos compensate the bbox-center pivot so existing pulli stay
   * stationary in world space (omitted when the position is unchanged).
   */
  | {
      t: 'setGrid';
      id: string;
      prev: GridSpec;
      next: GridSpec;
      prevPos?: { x: number; y: number };
      nextPos?: { x: number; y: number };
    }
  /** Batch move of several kolams (multi-select drag). */
  | { t: 'moveMany'; moves: { id: string; from: { x: number; y: number }; to: { x: number; y: number } }[] }
  /** Append several kolams in order (duplicate/paste). */
  | { t: 'addMany'; kolams: SceneKolam[]; index?: number }
  /** Remove several kolams in one undoable step (eraser, marquee delete). */
  | { t: 'removeMany'; items: { kolam: SceneKolam; index: number }[] }
  /** Insert decoration strokes at the given indices (ascending). */
  | { t: 'addStrokes'; strokes: { stroke: SceneStroke; index: number }[] }
  /** Remove decoration strokes in one undoable step. */
  | { t: 'removeStrokes'; items: { stroke: SceneStroke; index: number }[] }
  /** Move a kolam from z-index `from` to z-index `to` (raise/lower). */
  | { t: 'reorder'; id: string; from: number; to: number }
  /** Several commands as one undoable gesture (eraser sweep, paste, delete-selection). */
  | { t: 'group'; cmds: Cmd[] };

export interface History {
  stack: Cmd[];
  idx: number; // next redo position; idx-1 = last applied
}

export const newHistory = (): History => ({ stack: [], idx: 0 });

export function apply(scene: Scene, c: Cmd): Scene {
  switch (c.t) {
    case 'add': {
      const idx = c.index ?? scene.kolams.length;
      const kolams = [...scene.kolams];
      kolams.splice(Math.min(idx, kolams.length), 0, c.kolam);
      return { ...scene, kolams, nextId: Math.max(scene.nextId, idNum(c.kolam.id) + 1) };
    }
    case 'remove':
      return { ...scene, kolams: scene.kolams.filter((k) => k.id !== c.kolam.id) };
    case 'move':
      return mapKolam(scene, c.id, (k) => ({ ...k, x: c.to.x, y: c.to.y }));
    case 'setTransform':
      return mapKolam(scene, c.id, (k) => ({ ...k, ...c.next }));
    case 'rename':
      return mapKolam(scene, c.id, (k) => ({ ...k, name: c.to }));
    case 'gates':
      return mapKolam(scene, c.id, (k) => {
        const doc = setGates(k.doc, c.pairs, c.next);
        return { ...k, doc };
      });
    case 'setGrid':
      return mapKolam(scene, c.id, (k) => ({
        ...k,
        doc: applyGridSpec(k.doc, c.next),
        ...(c.nextPos ? { x: c.nextPos.x, y: c.nextPos.y } : {}),
      }));
    case 'moveMany':
      return {
        ...scene,
        kolams: scene.kolams.map((k) => {
          const m = c.moves.find((q) => q.id === k.id);
          return m ? { ...k, x: m.to.x, y: m.to.y } : k;
        }),
      };
    case 'addMany': {
      const idx = c.index ?? scene.kolams.length;
      const kolams = [...scene.kolams];
      kolams.splice(Math.min(idx, kolams.length), 0, ...c.kolams);
      return {
        ...scene,
        kolams,
        nextId: c.kolams.reduce((acc, k) => Math.max(acc, idNum(k.id) + 1), scene.nextId),
      };
    }
    case 'removeMany':
      return { ...scene, kolams: scene.kolams.filter((k) => !c.items.some((x) => x.kolam.id === k.id)) };
    case 'addStrokes': {
      const strokes = [...scene.strokes];
      // insert in ascending index order, clamped to the current length
      const sorted = [...c.strokes].sort((a, b) => a.index - b.index);
      for (const s of sorted) strokes.splice(Math.min(s.index, strokes.length), 0, s.stroke);
      return { ...scene, strokes };
    }
    case 'removeStrokes': {
      const strokes = scene.strokes.filter((s) => !c.items.some((x) => x.stroke.id === s.id));
      return { ...scene, strokes };
    }
    case 'reorder': {
      const kolams = [...scene.kolams];
      const item = kolams[c.from];
      if (!item || item.id !== c.id) throw new Error(`reorder: no kolam at index ${c.from} (wanted ${c.id})`);
      kolams.splice(c.from, 1);
      kolams.splice(Math.min(c.to, kolams.length), 0, item);
      return { ...scene, kolams };
    }
    case 'group':
      return c.cmds.reduce((s, sub) => apply(s, sub), scene);
  }
}

export function invert(scene: Scene, c: Cmd): Cmd {
  switch (c.t) {
    case 'add': {
      const index = scene.kolams.findIndex((k) => k.id === c.kolam.id);
      return { t: 'remove', kolam: c.kolam, index };
    }
    case 'remove': {
      // self-contained: the removed kolam rides in the command
      return { t: 'add', kolam: c.kolam, index: c.index };
    }
    case 'move':
      return { ...c, from: c.to, to: c.from };
    case 'setTransform':
      return { ...c, prev: c.next, next: c.prev };
    case 'rename':
      return { ...c, from: c.to, to: c.from };
    case 'gates':
      return { ...c, prev: c.next, next: c.prev };
    case 'setGrid':
      return {
        ...c,
        prev: c.next,
        next: c.prev,
        ...(c.nextPos ? { prevPos: c.nextPos } : {}),
        ...(c.prevPos ? { nextPos: c.prevPos } : {}),
      };
    case 'moveMany':
      return { ...c, moves: c.moves.map((m) => ({ ...m, from: m.to, to: m.from })) };
    case 'addMany': {
      const items = c.kolams.map((k) => ({ kolam: k, index: scene.kolams.findIndex((q) => q.id === k.id) }));
      return { t: 'removeMany', items };
    }
    case 'removeMany': {
      // re-insert at the original indices, highest first so lower indices stay valid
      const adds = [...c.items]
        .sort((a, b) => b.index - a.index)
        .map((x) => ({ t: 'add', kolam: x.kolam, index: x.index }) as Cmd);
      return { t: 'group', cmds: adds };
    }
    case 'addStrokes': {
      const items = c.strokes.map((s) => ({ stroke: s.stroke, index: scene.strokes.findIndex((q) => q.id === s.stroke.id) }));
      return { t: 'removeStrokes', items };
    }
    case 'removeStrokes': {
      // addStrokes applies in ascending index order, restoring exact positions
      return { t: 'addStrokes', strokes: [...c.items].sort((a, b) => a.index - b.index) };
    }
    case 'reorder':
      return { ...c, from: c.to, to: c.from };
    case 'group': {
      const inv: Cmd[] = [];
      let s: Scene = scene;
      for (const sub of [...c.cmds].reverse()) {
        const i = invert(s, sub);
        inv.push(i);
        s = apply(s, i);
      }
      return { t: 'group', cmds: inv };
    }
  }
}

export function doCmd(scene: Scene, h: History, c: Cmd): { scene: Scene; history: History } {
  const next = apply(scene, c);
  const stack = [...h.stack.slice(0, h.idx), c];
  return { scene: next, history: { stack, idx: stack.length } };
}

export function undo(scene: Scene, h: History): { scene: Scene; history: History } | null {
  if (h.idx === 0) return null;
  const c = h.stack[h.idx - 1]!;
  const inv = invert(scene, c);
  return { scene: apply(scene, inv), history: { stack: h.stack, idx: h.idx - 1 } };
}

export function redo(scene: Scene, h: History): { scene: Scene; history: History } | null {
  if (h.idx >= h.stack.length) return null;
  const c = h.stack[h.idx]!;
  return { scene: apply(scene, c), history: { stack: h.stack, idx: h.idx + 1 } };
}

// --- helpers ---

function mapKolam(scene: Scene, id: string, f: (k: SceneKolam) => SceneKolam): Scene {
  return { ...scene, kolams: scene.kolams.map((k) => (k.id === id ? f(k) : k)) };
}

const idNum = (id: string): number => {
  const m = /\d+$/.exec(id);
  return m ? parseInt(m[0], 10) : 0;
};

function setGates(
  doc: SceneKolam['doc'],
  pairs: [number, number, number, number][],
  states: ('open' | 'closed')[],
): KolamDoc {
  return setGatesInDoc(doc, pairs, states);
}
