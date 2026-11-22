/**
 * Kolam Harness — infinite-canvas app.
 * Idea → Prompt → Draw, plus native kolam drawing tools, all offline.
 *
 * The kolam model (grid, gates, trace, generator, prompt parser, renderer)
 * comes from the @logicinczo/dotkolam package
 * (https://github.com/LogicIncZo/dotkolam).
 *
 * Rendering is two SVG layers inside #canvas: #world (decoration strokes +
 * kolam objects) and #overlay (selection, hover, gesture previews, snapping
 * guides). Layer rebuilds are rAF-coalesced; hit-testing is geometric (no
 * per-element pointer listeners), routing through the tool framework in
 * tools.ts.
 */
import {
  GateSystem,
  KolamDoc,
  GridSpec,
  canonicalJSON,
  curveLength,
  curveToPath,
  docFromSys,
  generate,
  parsePrompt,
  renderSVG,
  sysFromDoc,
  traceCurves,
} from '@logicinczo/dotkolam';
import {
  Scene, SceneKolam, newScene, findFreeSpot, bboxOfDoc, sceneToJSON, sceneFromJSON,
  kolamBBoxWorld, docToWorld,
} from '../src/harness/scene.js';
import { Cmd, History, newHistory, doCmd, undo, redo } from '../src/harness/commands.js';
import { sceneContentBox } from '../src/harness/geometry.js';
import {
  ToolId, ToolCtx, ToolOptions, TOOLS, TOOL_ORDER, OverlayState, emptyOverlay, DEFAULT_OPTIONS,
} from './tools.js';

const svg = document.querySelector('#canvas') as SVGSVGElement;
const SVGNS = 'http://www.w3.org/2000/svg';

// ---------- state ----------
let scene: Scene = newScene();
let hist: History = newHistory();
const selected = new Set<string>();
let activeTool: ToolId = 'select';
let routingTool: ToolId | null = null; // tool receiving the active pointer gesture
let spaceHand = false;
let toolBeforeSpace: ToolId | null = null;
let showDots = true;
let smooth = true;
let theme: 'flour' | 'paper' = 'flour';
let toolOpts: ToolOptions = { ...DEFAULT_OPTIONS, snapOn: false };
let clipboard: SceneKolam[] = [];
let livePreview: { id: string; sys: GateSystem } | null = null;
let lastPromptEcho = '';

const overlayState: OverlayState = emptyOverlay();

const PALETTE = {
  flour: { stroke: '#f2ead9', dot: '#c9a36a', ground: '#241a11' },
  paper: { stroke: '#221c14', dot: '#8a6d3b', ground: '#f0e9db' },
};

// ---------- scene helpers ----------

function addGenerated(text: string): void {
  const pr = parsePrompt(text);
  const r = generate({
    grid: pr.params.grid,
    symmetry: pr.params.symmetry,
    density: pr.params.density,
    strokes: pr.params.strokes,
    seed: pr.params.seed,
    ...(pr.params.name !== undefined ? { name: pr.params.name } : {}),
  });
  const b = bboxOfDoc(r.doc);
  const spot = findFreeSpot(scene, b.maxX - b.minX + 2, b.maxY - b.minY + 2);
  const k: SceneKolam = {
    id: `k${scene.nextId}`,
    name: pr.params.name ?? `${describeGrid(pr.params.grid)} kolam`,
    x: spot.x,
    y: spot.y,
    scale: 1,
    rot: 0,
    reflect: false,
    doc: r.doc,
    gen: {
      symmetry: r.doc.pattern?.symmetry?.group ?? 'C4',
      density: pr.params.density,
      strokes: String(pr.params.strokes),
      seed: pr.params.seed,
    },
  };
  run({ t: 'add', kolam: k });
  selected.clear();
  selected.add(k.id);
  lastPromptEcho = pr.interpretation.join(' · ');
  toast(`drew ${k.name} — ${r.achieved.isOneStroke ? 'one stroke ✓' : `${r.achieved.loops} loops`} · ${lastPromptEcho}`);
  centerOn(k);
}

function describeGrid(g: GridSpec): string {
  switch (g.kind) {
    case 'square': return `${g.size}×${g.size}`;
    case 'rectangle': return `${g.cols}×${g.rows}`;
    case 'diamond': return `diamond ${g.rows}`;
    case 'rows': return g.widths.join('-');
    case 'custom': return `${g.dots.length} dots`;
  }
}

function run(c: Cmd): void {
  const r = doCmd(scene, hist, c);
  scene = r.scene;
  hist = r.history;
  scheduleAutosave();
  requestWorld();
}

function centerOn(k: SceneKolam): void {
  scene.camera.x = k.x;
  scene.camera.y = k.y;
  noteCameraChange();
  requestWorld();
}

function noteCameraChange(): void {
  scheduleAutosave();
}

// ---------- rendering (two layers, rAF-coalesced) ----------

function el(name: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const worldG = el('g', { id: 'world' }) as SVGGElement;
const overlayG = el('g', { id: 'overlay' }) as SVGGElement;
svg.append(worldG, overlayG);

let worldDirty = true;
let overlayDirty = true;
let rafPending = false;

function requestWorld(): void {
  worldDirty = true;
  requestFlush();
}
function requestOverlay(): void {
  overlayDirty = true;
  requestFlush();
}
function requestFlush(): void {
  if (!rafPending) {
    rafPending = true;
    // rAF is paused for hidden/backgrounded tabs; flush synchronously there
    // so the world layer and HUD are never left stale.
    if (document.hidden) flush();
    else requestAnimationFrame(flush);
  }
}

function flush(): void {
  rafPending = false;
  if (worldDirty) {
    buildWorld();
    worldDirty = false;
    overlayDirty = true; // outlines etc. ride on scene changes
  }
  if (overlayDirty) {
    buildOverlay();
    overlayDirty = false;
  }
  updateMiniToolbar();
  updateHud();
}

function cameraTransform(): string {
  const { x: cx, y: cy, zoom } = scene.camera;
  const W = svg.clientWidth || 1200;
  const H = svg.clientHeight || 800;
  return `translate(${W / 2},${H / 2}) scale(${zoom}) translate(${-cx},${-cy})`;
}

function buildWorld(): void {
  document.body.classList.toggle('light', theme === 'paper');
  const camT = cameraTransform();
  worldG.setAttribute('transform', camT);
  overlayG.setAttribute('transform', camT);
  worldG.innerHTML = '';

  const pal = PALETTE[theme];
  // decoration strokes (below kolams)
  for (const s of scene.strokes) {
    worldG.appendChild(
      el('polyline', {
        class: 'ink',
        points: s.points.map((p) => `${p[0]},${p[1]}`).join(' '),
        stroke: s.color,
        'stroke-width': s.width,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        fill: 'none',
        'data-stroke': s.id,
      }),
    );
  }
  for (const k of scene.kolams) {
    const live = livePreview && livePreview.id === k.id ? livePreview.sys : null;
    worldG.appendChild(buildKolamGroup(k, pal, live));
  }
  updateInspector();
}

function buildKolamGroup(k: SceneKolam, pal: (typeof PALETTE)['flour'], sysOverride: GateSystem | null): SVGGElement {
  const g = el('g', {
    class: 'kolam',
    transform: `translate(${k.x},${k.y}) rotate(${k.rot * 90}) scale(${k.reflect ? -k.scale : k.scale},${k.scale})`,
    'data-id': k.id,
  }) as SVGGElement;
  const b = bboxOfDoc(k.doc);
  const mx = (b.minX + b.maxX) / 2;
  const my = (b.minY + b.maxY) / 2;
  const inner = el('g', { transform: `translate(${-mx},${-my})` });

  const sys = sysOverride ?? sysFromDoc(k.doc);
  const { curves } = traceCurves(sys, smooth ? 'smooth' : 'lattice');
  const curvesG = el('g', { class: 'curves' });
  for (const c of curves) {
    const len = curveLength(c);
    curvesG.appendChild(
      el('path', {
        d: curveToPath(c),
        stroke: pal.stroke,
        'stroke-width': 0.09,
        'data-length': len.toFixed(3),
        fill: 'none',
      }),
    );
  }
  inner.appendChild(curvesG);

  if (showDots) {
    const dotsG = el('g');
    for (const d of sys.grid.dots) {
      dotsG.appendChild(el('circle', { cx: d.x / 2, cy: d.y / 2, r: 0.13, fill: pal.dot }));
    }
    inner.appendChild(dotsG);
  }

  g.appendChild(inner);
  return g;
}

function rebuildKolamGroup(id: string): void {
  const k = scene.kolams.find((q) => q.id === id);
  const g = worldG.querySelector(`g.kolam[data-id="${id}"]`);
  if (!k || !g) return;
  const live = livePreview && livePreview.id === id ? livePreview.sys : null;
  g.replaceWith(buildKolamGroup(k, PALETTE[theme], live));
}

function rectEl(r: { minX: number; minY: number; maxX: number; maxY: number }, attrs: Record<string, string | number>): SVGElement {
  return el('rect', {
    x: r.minX,
    y: r.minY,
    width: Math.max(0.01, r.maxX - r.minX),
    height: Math.max(0.01, r.maxY - r.minY),
    ...attrs,
  });
}

function buildOverlay(): void {
  const pal = PALETTE[theme];
  const z = scene.camera.zoom;
  const hw = (svg.clientWidth || 1200) / z / 2;
  const hh = (svg.clientHeight || 800) / z / 2;
  overlayG.innerHTML = '';
  const ov = overlayState;
  const selKolams = scene.kolams.filter((k) => selected.has(k.id));
  const selStrokes = scene.strokes.filter((s) => selected.has(s.id));

  // hover highlight (single object under cursor, not selected)
  if (ov.hoverKolam && !selected.has(ov.hoverKolam)) {
    const k = scene.kolams.find((q) => q.id === ov.hoverKolam);
    if (k) {
      overlayG.appendChild(
        rectEl(kolamBBoxWorld(k), { fill: 'none', stroke: pal.stroke, 'stroke-width': 1.5 / z, opacity: 0.25, rx: 0.4 }),
      );
    }
  }
  if (ov.hoverStroke && !selected.has(ov.hoverStroke)) {
    const s = scene.strokes.find((q) => q.id === ov.hoverStroke);
    if (s) {
      overlayG.appendChild(
        el('polyline', {
          points: s.points.map((p) => `${p[0]},${p[1]}`).join(' '),
          fill: 'none', stroke: pal.stroke, 'stroke-width': s.width + 3 / z, opacity: 0.2, 'stroke-linecap': 'round',
        }),
      );
    }
  }

  // selection outlines
  for (const k of selKolams) {
    overlayG.appendChild(
      rectEl(kolamBBoxWorld(k), {
        fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.5 / z,
        'stroke-dasharray': `${4 / z} ${3 / z}`, rx: 0.4, 'data-sel': k.id,
      }),
    );
  }
  for (const s of selStrokes) {
    overlayG.appendChild(
      el('polyline', {
        points: s.points.map((p) => `${p[0]},${p[1]}`).join(' '),
        fill: 'none', stroke: 'var(--accent)', 'stroke-width': s.width + 4 / z, opacity: 0.45,
        'stroke-linecap': 'round', 'data-sel': s.id,
      }),
    );
  }

  // pen hover channel (doc-local -> world)
  if (ov.hoverChannel) {
    const k = scene.kolams.find((q) => q.id === ov.hoverChannel!.kolamId);
    if (k) {
      const a = docToWorld(k, ov.hoverChannel.a);
      const b = docToWorld(k, ov.hoverChannel.b);
      overlayG.appendChild(
        el('line', {
          x1: a[0], y1: a[1], x2: b[0], y2: b[1],
          stroke: ov.hoverChannel.interior ? '#7ec8a9' : 'var(--ink-dim)',
          'stroke-width': 9 / z, opacity: 0.4, 'stroke-linecap': 'round',
          ...(ov.hoverChannel.interior ? {} : { 'stroke-dasharray': `${3 / z} ${3 / z}` }),
        }),
      );
    }
  }

  // erasure targets
  for (const id of ov.eraseKolams) {
    const k = scene.kolams.find((q) => q.id === id);
    if (k) overlayG.appendChild(rectEl(kolamBBoxWorld(k), { fill: 'none', stroke: '#e07856', 'stroke-width': 2 / z, opacity: 0.8 }));
  }
  for (const id of ov.eraseStrokes) {
    const s = scene.strokes.find((q) => q.id === id);
    if (s) {
      overlayG.appendChild(
        el('polyline', {
          points: s.points.map((p) => `${p[0]},${p[1]}`).join(' '),
          fill: 'none', stroke: '#e07856', 'stroke-width': s.width + 4 / z, opacity: 0.85, 'stroke-linecap': 'round',
        }),
      );
    }
  }
  for (const p of ov.eraseDots) {
    overlayG.appendChild(el('circle', { cx: p[0], cy: p[1], r: 0.3, fill: 'none', stroke: '#e07856', 'stroke-width': 2 / z, opacity: 0.9 }));
  }

  // dot ghost
  if (ov.dotGhost) {
    overlayG.appendChild(el('circle', { cx: ov.dotGhost[0], cy: ov.dotGhost[1], r: 0.16, fill: 'var(--accent)', opacity: 0.7 }));
  }

  // marquee / rubber band
  if (ov.marquee) {
    overlayG.appendChild(
      rectEl(ov.marquee, { fill: 'var(--accent)', opacity: 0.12, stroke: 'var(--accent)', 'stroke-width': 1.5 / z, rx: 0.3 }),
    );
  }

  // ink preview
  if (ov.inkPreview && ov.inkPreview.length >= 2) {
    overlayG.appendChild(
      el('polyline', {
        points: ov.inkPreview.map((p) => `${p[0]},${p[1]}`).join(' '),
        fill: 'none', stroke: ov.inkColor, 'stroke-width': ov.inkWidth,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.9,
      }),
    );
  }

  // snapping guides
  for (const g of ov.guides) {
    if (g.axis === 'x') {
      overlayG.appendChild(el('line', { x1: g.pos, y1: scene.camera.y - hh, x2: g.pos, y2: scene.camera.y + hh, stroke: '#e06898', 'stroke-width': 1.2 / z }));
    } else {
      overlayG.appendChild(el('line', { x1: scene.camera.x - hw, y1: g.pos, x2: scene.camera.x + hw, y2: g.pos, stroke: '#e06898', 'stroke-width': 1.2 / z }));
    }
  }
}

// ---------- tool context ----------

const toolCtx: ToolCtx = {
  scene: () => scene,
  run,
  zoom: () => scene.camera.zoom,
  selection: () => selected,
  setSelection(ids: string[]): void {
    selected.clear();
    for (const id of ids) selected.add(id);
    updateInspector();
  },
  overlay: () => overlayState,
  requestWorld,
  requestOverlay,
  updateKolamLive(id: string, sys: GateSystem): void {
    livePreview = { id, sys };
    rebuildKolamGroup(id);
  },
  clearLive(): void {
    if (!livePreview) return;
    const id = livePreview.id;
    livePreview = null;
    rebuildKolamGroup(id);
  },
  noteCameraChange,
  toast,
  options: () => toolOpts,
};

// ---------- pointer routing ----------

svg.addEventListener('pointerdown', (ev) => {
  const w = screenToWorld(ev.clientX, ev.clientY);
  if (ev.button === 1 || spaceHand) {
    routingTool = 'hand';
  } else if (ev.button === 0) {
    routingTool = activeTool;
  } else {
    return;
  }
  ev.preventDefault();
  svg.setPointerCapture(ev.pointerId);
  TOOLS[routingTool].onDown?.(toolCtx, ev, w);
});

svg.addEventListener('pointermove', (ev) => {
  const w = screenToWorld(ev.clientX, ev.clientY);
  if (routingTool) {
    TOOLS[routingTool].onMove?.(toolCtx, ev, w);
  } else {
    TOOLS[activeTool].onHover?.(toolCtx, w);
  }
});

svg.addEventListener('pointerup', (ev) => {
  const tool = routingTool;
  routingTool = null;
  if (!tool) return;
  const w = screenToWorld(ev.clientX, ev.clientY);
  TOOLS[tool].onUp?.(toolCtx, ev, w);
});

svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const before = screenToWorld(ev.clientX, ev.clientY);
  const factor = Math.exp(-ev.deltaY * 0.0012);
  scene.camera.zoom = Math.min(240, Math.max(2, scene.camera.zoom * factor));
  const after = screenToWorld(ev.clientX, ev.clientY);
  scene.camera.x += before.x - after.x;
  scene.camera.y += before.y - after.y;
  noteCameraChange();
  requestWorld();
}, { passive: false });

function screenToWorld(px: number, py: number): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;
  const { x: cx, y: cy, zoom } = scene.camera;
  return { x: cx + (px - rect.left - W / 2) / zoom, y: cy + (py - rect.top - H / 2) / zoom };
}

// ---------- zoom to fit ----------

function zoomToFit(): void {
  const box = sceneContentBox(scene);
  if (!box) return;
  const W = svg.clientWidth || 1200;
  const H = svg.clientHeight || 800;
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  scene.camera.x = (box.minX + box.maxX) / 2;
  scene.camera.y = (box.minY + box.maxY) / 2;
  scene.camera.zoom = Math.min(240, Math.max(2, Math.min(W / Math.max(1, w + 2), H / Math.max(1, h + 2))));
  noteCameraChange();
  requestWorld();
  toast('zoomed to fit');
}

// ---------- selection actions ----------

function selectedKolams(): SceneKolam[] {
  return scene.kolams.filter((k) => selected.has(k.id));
}

function rotateSelection(): void {
  const ks = selectedKolams();
  if (ks.length === 0) return;
  const cmds: Cmd[] = ks.map((k) => ({
    t: 'setTransform',
    id: k.id,
    prev: { rot: k.rot, reflect: k.reflect, scale: k.scale },
    next: { rot: ((k.rot + 1) % 4) as 0 | 1 | 2 | 3, reflect: k.reflect, scale: k.scale },
  }));
  run(cmds.length === 1 ? cmds[0]! : { t: 'group', cmds });
}

function reflectSelection(): void {
  const ks = selectedKolams();
  if (ks.length === 0) return;
  const cmds: Cmd[] = ks.map((k) => ({
    t: 'setTransform',
    id: k.id,
    prev: { rot: k.rot, reflect: k.reflect, scale: k.scale },
    next: { rot: k.rot, reflect: !k.reflect, scale: k.scale },
  }));
  run(cmds.length === 1 ? cmds[0]! : { t: 'group', cmds });
}

function duplicateSelection(): void {
  const ks = selectedKolams();
  if (ks.length === 0) return;
  let id = scene.nextId;
  const copies = ks.map((k) => ({ ...k, id: `k${id++}`, x: k.x + 1.5, y: k.y + 1.5 }));
  run({ t: 'addMany', kolams: copies });
  selected.clear();
  for (const c of copies) selected.add(c.id);
  requestWorld();
  toast(`duplicated ${copies.length} kolam${copies.length === 1 ? '' : 's'}`);
}

function raiseLowerSelection(dir: 1 | -1): void {
  const ks = selectedKolams();
  if (ks.length !== 1) return;
  const k = ks[0]!;
  const from = scene.kolams.findIndex((q) => q.id === k.id);
  const to = from + dir;
  if (to < 0 || to >= scene.kolams.length) return;
  run({ t: 'reorder', id: k.id, from, to });
}

function deleteSelection(): void {
  const kItems = scene.kolams
    .map((k, index) => ({ kolam: k, index }))
    .filter((x) => selected.has(x.kolam.id));
  const sItems = scene.strokes
    .map((s, index) => ({ stroke: s, index }))
    .filter((x) => selected.has(x.stroke.id));
  if (kItems.length === 0 && sItems.length === 0) return;
  const cmds: Cmd[] = [];
  if (sItems.length > 0) cmds.push({ t: 'removeStrokes', items: sItems });
  if (kItems.length > 0) cmds.push({ t: 'removeMany', items: kItems });
  run(cmds.length === 1 ? cmds[0]! : { t: 'group', cmds });
  selected.clear();
  requestWorld();
  updateInspector();
}

function copySelection(): void {
  const ks = selectedKolams();
  if (ks.length === 0) return;
  clipboard = ks.map((k) => structuredClone(k));
  toast(`copied ${ks.length} kolam${ks.length === 1 ? '' : 's'}`);
}

function pasteClipboard(): void {
  if (clipboard.length === 0) return;
  let id = scene.nextId;
  const copies = clipboard.map((k) => ({ ...structuredClone(k), id: `k${id++}`, x: k.x + 2, y: k.y + 2 }));
  run({ t: 'addMany', kolams: copies });
  selected.clear();
  for (const c of copies) selected.add(c.id);
  requestWorld();
  toast(`pasted ${copies.length} kolam${copies.length === 1 ? '' : 's'}`);
}

// ---------- animation ----------

function animateLast(): void {
  const groups = Array.from(worldG.querySelectorAll('g.kolam'));
  const target = selected.size === 1
    ? groups.find((g) => g.getAttribute('data-id') === [...selected][0])
    : groups[groups.length - 1];
  if (!target) return;
  animateGroup(target as SVGGElement);
}

function animateGroup(g: SVGGElement): void {
  const paths = Array.from(g.querySelectorAll('.curves path')) as SVGPathElement[];
  let delay = 0;
  for (const p of paths) {
    const len = parseFloat(p.getAttribute('data-length') ?? '0') || 1;
    const dur = Math.max(400, Math.min(4000, len * scene.camera.zoom * 0.9));
    p.style.strokeDasharray = `${len}`;
    p.style.strokeDashoffset = `${len}`;
    p.animate(
      [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
      { duration: dur, delay, fill: 'forwards', easing: 'ease-in-out' },
    );
    delay += dur * 0.9;
  }
}

// ---------- inspector ----------

function updateInspector(): void {
  const empty = document.querySelector('#inspEmpty') as HTMLElement;
  const body = document.querySelector('#inspBody') as HTMLElement;
  const ks = selectedKolams();
  if (ks.length !== 1) {
    empty.hidden = false;
    body.hidden = true;
    const strokes = [...selected].filter((id) => scene.strokes.some((s) => s.id === id)).length;
    empty.innerHTML = ks.length + strokes > 1
      ? `${ks.length + strokes} object${ks.length + strokes === 1 ? '' : 's'} selected`
      : 'Nothing selected.<br/><small>Pick a tool on the left, or draw from a prompt.</small>';
    (document.querySelector('#promptEcho') as HTMLElement).innerHTML = lastPromptEcho ? `<b>interpreted as</b><br/>${lastPromptEcho}` : '';
    return;
  }
  const k = ks[0]!;
  empty.hidden = true;
  body.hidden = false;
  const a = k.doc.analysis!;
  (document.querySelector('#inspName') as HTMLElement).textContent = k.name;
  const badge = document.querySelector('#inspBadge') as HTMLElement;
  badge.textContent = a.isOneStroke ? 'one stroke ✓ (Brahmamudi)' : `${a.loopCount} closed loops`;
  badge.classList.toggle('multi', !a.isOneStroke);
  const facts: [string, string][] = [
    ['grid', describeGrid(k.doc.grid.spec)],
    ['dots', String(a.dotCount)],
    ['gates', String(a.gateCount)],
    ['segments', String(a.totalSegments)],
    ['symmetry', k.doc.pattern?.symmetry?.group ?? '—'],
    ['prastāra', k.doc.pattern?.index ?? '—'],
  ];
  if (k.gen) facts.push(['seed', k.gen.seed], ['density', String(k.gen.density)]);
  (document.querySelector('#inspFacts') as HTMLElement).innerHTML = facts
    .map(([x, v]) => `<span>${x}</span><b>${v}</b>`)
    .join('');
  const prims = document.querySelector('#inspPrims') as HTMLElement;
  const entries = Object.entries(a.primitiveCounts) as [string, number][];
  const max = Math.max(1, ...entries.map(([, v]) => v));
  prims.innerHTML = entries
    .map(([name, v]) => `<div class="bar" style="height:${(v / max) * 100}%" title="${name}: ${v}"><span>${name.slice(0, 2)}</span></div>`)
    .join('');
  (document.querySelector('#inspJson') as HTMLElement).textContent = canonicalJSON(k.doc);
}

// ---------- persistence ----------

const LS_KEY = 'kolam-harness-scene-v1';
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(sceneToJSON(scene)));
    } catch {
      /* storage full: ignore */
    }
  }, 400);
}

function restoreAutosave(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const s = sceneFromJSON(JSON.parse(raw));
    scene = s;
    hist = newHistory();
    toast(`restored ${scene.kolams.length} kolam${scene.kolams.length === 1 ? '' : 's'} from this browser`);
  } catch {
    /* corrupt: start fresh */
  }
}

// ---------- exports ----------

function download(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function selectedKolam(): SceneKolam | undefined {
  const ks = selectedKolams();
  return ks.length === 1 ? ks[0] : undefined;
}

function exportJson(): void {
  const k = selectedKolam();
  if (!k) return;
  download(`${slug(k.name)}.kolam.json`, new Blob([canonicalJSON(k.doc) + '\n'], { type: 'application/json' }));
}

function exportSvg(): void {
  const k = selectedKolam();
  if (!k) return;
  const pal = PALETTE[theme];
  const svgText = renderSVG(k.doc, {
    width: 900,
    showDots,
    strokeColor: pal.stroke,
    dotColor: pal.dot,
    background: pal.ground,
    padding: 1.4,
  });
  download(`${slug(k.name)}.svg`, new Blob([svgText], { type: 'image/svg+xml' }));
}

async function exportPng(): Promise<void> {
  const k = selectedKolam();
  if (!k) return;
  const pal = PALETTE[theme];
  const svgText = renderSVG(k.doc, {
    width: 1600,
    showDots,
    strokeColor: pal.stroke,
    dotColor: pal.dot,
    background: pal.ground,
    padding: 1.4,
  });
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('rasterize failed'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = Math.round((1600 * img.height) / Math.max(1, img.width));
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((b) => b && download(`${slug(k.name)}.png`, b), 'image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kolam';
}

// ---------- toolbar wiring ----------

const $ = (sel: string) => document.querySelector(sel) as HTMLButtonElement;

$('#promptForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = ($('#prompt') as HTMLInputElement).value.trim();
  if (text) addGenerated(text);
});
document.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) => {
  c.addEventListener('click', () => {
    ($('#prompt') as HTMLInputElement).value = c.dataset.prompt!;
    addGenerated(c.dataset.prompt!);
  });
});

// tools rail
const TOOL_ICONS: Record<ToolId, string> = {
  select: '✥',
  hand: '✋',
  dot: '•',
  pen: '✎',
  ink: '❦',
  eraser: '⌫',
};

function buildToolRail(): void {
  const group = document.querySelector('#toolGroup') as HTMLElement;
  group.innerHTML = '';
  for (const id of TOOL_ORDER) {
    const t = TOOLS[id];
    const b = document.createElement('button');
    b.className = 'tool';
    b.id = `tool-${id}`;
    b.title = `${t.label} (${t.shortcut})`;
    b.textContent = TOOL_ICONS[id];
    b.addEventListener('click', () => setTool(id));
    group.appendChild(b);
  }
}

function setTool(id: ToolId): void {
  if (spaceHand) return; // temporary hand overrides tool switching
  TOOLS[activeTool].cancel?.(toolCtx);
  activeTool = id;
  routingTool = null;
  Object.assign(overlayState, emptyOverlay());
  for (const tid of TOOL_ORDER) {
    $(`#tool-${tid}`).classList.toggle('active', tid === id);
  }
  svg.setAttribute('class', TOOLS[id].cursor);
  buildOptionsBar();
  requestOverlay();
}

function buildOptionsBar(): void {
  const bar = document.querySelector('#toolOptions') as HTMLElement;
  const t = TOOLS[activeTool];
  const seg = (opts: [string, string][], current: string, apply: (v: string) => void): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.className = 'seg';
    for (const [v, label] of opts) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = v === current ? 'active' : '';
      b.addEventListener('click', () => {
        apply(v);
        buildOptionsBar();
      });
      wrap.appendChild(b);
    }
    return wrap;
  };
  bar.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'opt-label';
  label.textContent = t.label;
  bar.appendChild(label);
  if (activeTool === 'select') {
    const snapBtn = document.createElement('button');
    snapBtn.textContent = 'half-unit snap';
    snapBtn.className = toolOpts.snapOn ? 'active' : '';
    snapBtn.addEventListener('click', () => {
      toolOpts.snapOn = !toolOpts.snapOn;
      ($('#btnSnap') as HTMLButtonElement).classList.toggle('active', toolOpts.snapOn);
      buildOptionsBar();
    });
    bar.appendChild(snapBtn);
    bar.appendChild(hint('drag to marquee · shift-click to multi-select'));
  } else if (activeTool === 'dot') {
    bar.appendChild(
      seg([['rect', '▭ grid'], ['diamond', '◆ diamond']], toolOpts.gridShape, (v) => {
        toolOpts.gridShape = v as ToolOptions['gridShape'];
      }),
    );
    bar.appendChild(hint('click: one pulli · drag: sow a grid'));
  } else if (activeTool === 'pen') {
    bar.appendChild(
      seg([['flip', 'flip'], ['open', 'open'], ['closed', 'close']], toolOpts.penMode, (v) => {
        toolOpts.penMode = v as ToolOptions['penMode'];
      }),
    );
    bar.appendChild(hint('sweep through channels to draw'));
  } else if (activeTool === 'ink') {
    const colors = document.createElement('div');
    colors.className = 'seg colors';
    for (const [name, hex] of Object.entries({ chalk: '#f2ead9', gold: '#e8b04b', leaf: '#7ec8a9', ink: '#221c14' })) {
      const b = document.createElement('button');
      b.className = 'swatch' + (toolOpts.inkColor === hex ? ' active' : '');
      b.style.background = hex;
      b.title = name;
      b.addEventListener('click', () => {
        toolOpts.inkColor = hex;
        buildOptionsBar();
      });
      colors.appendChild(b);
    }
    bar.appendChild(colors);
    bar.appendChild(
      seg([['0.15', 'fine'], ['0.3', 'medium'], ['0.55', 'bold']], String(toolOpts.inkWidth), (v) => {
        toolOpts.inkWidth = parseFloat(v);
      }),
    );
    bar.appendChild(hint('freehand decoration — never part of the kolam model'));
  } else if (activeTool === 'eraser') {
    bar.appendChild(hint('sweep over pulli: erases drafts dot-by-dot, kolams whole'));
  } else {
    bar.appendChild(hint('drag to pan · space holds the hand tool'));
  }
}

function hint(text: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'opt-hint';
  s.textContent = text;
  return s;
}

// undo/redo
$('#btnUndo').addEventListener('click', () => {
  const r = undo(scene, hist);
  if (r) { scene = r.scene; hist = r.history; scheduleAutosave(); requestWorld(); }
});
$('#btnRedo').addEventListener('click', () => {
  const r = redo(scene, hist);
  if (r) { scene = r.scene; hist = r.history; scheduleAutosave(); requestWorld(); }
});

$('#btnRotate').addEventListener('click', rotateSelection);
$('#btnReflect').addEventListener('click', reflectSelection);
$('#btnDup').addEventListener('click', duplicateSelection);
$('#btnDelete').addEventListener('click', deleteSelection);
$('#btnReplay').addEventListener('click', animateLast);
$('#btnDots').addEventListener('click', () => { showDots = !showDots; $('#btnDots').classList.toggle('active', showDots); requestWorld(); });
$('#btnSmooth').addEventListener('click', () => { smooth = !smooth; $('#btnSmooth').classList.toggle('active', smooth); requestWorld(); });
$('#btnTheme').addEventListener('click', () => { theme = theme === 'flour' ? 'paper' : 'flour'; requestWorld(); });
$('#btnSnap').addEventListener('click', () => {
  toolOpts.snapOn = !toolOpts.snapOn;
  $('#btnSnap').classList.toggle('active', toolOpts.snapOn);
  buildOptionsBar();
});
$('#btnFit').addEventListener('click', zoomToFit);

$('#btnSaveScene').addEventListener('click', () => {
  download('canvas.harness.json', new Blob([JSON.stringify(sceneToJSON(scene), null, 2)], { type: 'application/json' }));
});
$('#btnExportScene').addEventListener('click', () => {
  // serialize the live world layer (kolams + decorations), minus overlay chrome
  const clone = worldG.cloneNode(true) as SVGGElement;
  clone.setAttribute('xmlns', SVGNS);
  const { x: cx, y: cy, zoom } = scene.camera;
  const W = svg.clientWidth || 1200;
  const H = svg.clientHeight || 800;
  const text =
    `<svg xmlns="${SVGNS}" viewBox="${cx - W / 2 / zoom} ${cy - H / 2 / zoom} ${W / zoom} ${H / zoom}" width="${W}" height="${H}">` +
    clone.outerHTML.replaceAll('class="kolam "', 'class="kolam"') +
    '</svg>';
  download('canvas.svg', new Blob([text], { type: 'image/svg+xml' }));
  toast('exported whole canvas as SVG');
});
$('#btnLoadScene').addEventListener('click', () => $('#fileInput').click());
$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const text = await f.text();
    const parsed = JSON.parse(text);
    if (parsed && (parsed.harnessVersion === '1.1' || parsed.harnessVersion === '1.0')) {
      scene = sceneFromJSON(parsed);
      hist = newHistory();
      selected.clear();
      scheduleAutosave();
      requestWorld();
      toast(`loaded scene (${scene.kolams.length} kolams)`);
    } else {
      const doc = parsed as KolamDoc;
      const b = bboxOfDoc(doc);
      const spot = findFreeSpot(scene, b.maxX - b.minX + 2, b.maxY - b.minY + 2);
      const k: SceneKolam = {
        id: `k${scene.nextId}`,
        name: doc.meta?.name ?? 'imported kolam',
        x: spot.x,
        y: spot.y,
        scale: 1,
        rot: 0,
        reflect: false,
        doc,
      };
      selected.clear();
      selected.add(k.id);
      run({ t: 'add', kolam: k });
      toast('imported Kolam-JSON');
    }
  } catch (err) {
    toast(`could not read file: ${(err as Error).message}`);
  }
  ($('#fileInput') as HTMLInputElement).value = '';
});
$('#btnClear').addEventListener('click', () => {
  if (!scene.kolams.length && !scene.strokes.length) return;
  if (confirm('Clear the whole canvas?')) {
    scene = newScene();
    hist = newHistory();
    selected.clear();
    scheduleAutosave();
    requestWorld();
  }
});
$('#btnReroll').addEventListener('click', () => {
  const k = selectedKolam();
  if (!k) return;
  if (!k.gen) { toast('this kolam has no generator provenance'); return; }
  const seed = `${k.gen.seed}~${Math.floor(Math.random() * 1e6)}`;
  const r = generate({
    grid: k.doc.grid.spec,
    symmetry: k.gen.symmetry as never,
    density: k.gen.density,
    strokes: k.gen.strokes === 'any' ? 'any' : 1,
    seed,
    name: k.name,
  });
  const replacement: SceneKolam = { ...k, doc: r.doc, gen: { ...k.gen, seed } };
  scene = { ...scene, kolams: scene.kolams.map((q) => (q.id === k.id ? replacement : q)) };
  scheduleAutosave();
  requestWorld();
  animateLast();
  toast(`rerolled — ${r.achieved.isOneStroke ? 'one stroke ✓' : `${r.achieved.loops} loops`}`);
});
$('#btnExportJson').addEventListener('click', exportJson);
$('#btnExportSvg').addEventListener('click', exportSvg);
$('#btnExportPng').addEventListener('click', () => void exportPng());

// ---------- mini toolbar (floating over the selection) ----------

function updateMiniToolbar(): void {
  const bar = document.querySelector('#miniToolbar') as HTMLElement;
  const boxes = [
    ...selectedKolams().map(kolamBBoxWorld),
    ...scene.strokes.filter((s) => selected.has(s.id)).map((s) => s.points).map((pts) => ({
      minX: Math.min(...pts.map((p) => p[0])),
      minY: Math.min(...pts.map((p) => p[1])),
      maxX: Math.max(...pts.map((p) => p[0])),
      maxY: Math.max(...pts.map((p) => p[1])),
    })),
  ];
  if (boxes.length === 0) {
    bar.style.display = 'none';
    return;
  }
  const minX = Math.min(...boxes.map((b) => b.minX));
  const minY = Math.min(...boxes.map((b) => b.minY));
  const maxX = Math.max(...boxes.map((b) => b.maxX));
  const rect = svg.getBoundingClientRect();
  const z = scene.camera.zoom;
  // #stage-relative screen coords of the selection bbox top-center
  const px = (minX + maxX) / 2;
  const left = (px - scene.camera.x) * z + rect.width / 2;
  const top = (minY - scene.camera.y) * z + rect.height / 2 - 46;
  bar.style.display = 'flex';
  bar.style.left = `${Math.max(4, left - 60)}px`;
  bar.style.top = `${Math.max(4, top)}px`;
}

function wireMiniToolbar(): void {
  const on = (id: string, f: () => void): void => $(id).addEventListener('click', f);
  on('#mtRotate', rotateSelection);
  on('#mtReflect', reflectSelection);
  on('#mtDup', duplicateSelection);
  on('#mtRaise', () => raiseLowerSelection(1));
  on('#mtLower', () => raiseLowerSelection(-1));
  on('#mtDelete', deleteSelection);
}
wireMiniToolbar();

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) ($('#btnRedo') as HTMLButtonElement).click();
    else ($('#btnUndo') as HTMLButtonElement).click();
  } else if (meta && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelection();
  } else if (meta && e.key.toLowerCase() === 'c') {
    copySelection();
  } else if (meta && e.key.toLowerCase() === 'v') {
    pasteClipboard();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelection();
  } else if (e.key === ' ' && !spaceHand) {
    e.preventDefault();
    spaceHand = true;
    toolBeforeSpace = activeTool;
    svg.setAttribute('class', TOOLS.hand.cursor);
  } else if (e.key === 'Escape') {
    TOOLS[activeTool].cancel?.(toolCtx);
    setTool('select');
  } else if (e.key === '1') setTool('select');
  else if (e.key === '2') setTool('pen');
  else if (!meta) {
    const k = e.key.toLowerCase();
    if (k === 'v') setTool('select');
    else if (k === 'h') setTool('hand');
    else if (k === 'g') setTool('dot');
    else if (k === 'p') setTool('pen');
    else if (k === 'i') setTool('ink');
    else if (k === 'e') setTool('eraser');
    else if (k === 'r') rotateSelection();
    else if (k === 'f') reflectSelection();
    else if (k === 'z') zoomToFit();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ' && spaceHand) {
    spaceHand = false;
    setTool(toolBeforeSpace ?? 'select');
    toolBeforeSpace = null;
  }
});

// ---------- toast ----------

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string): void {
  const t = document.querySelector('#toast') as HTMLElement;
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}

// ---------- hud ----------

function updateHud(): void {
  (document.querySelector('#zoomLabel') as HTMLElement).textContent = `${(scene.camera.zoom / 24).toFixed(1)}×`;
  const parts: string[] = [`${scene.kolams.length} kolam${scene.kolams.length === 1 ? '' : 's'}`];
  if (scene.strokes.length > 0) parts.push(`${scene.strokes.length} ink`);
  (document.querySelector('#countLabel') as HTMLElement).textContent = parts.join(' · ');
}

// ---------- boot ----------

window.addEventListener('resize', () => requestWorld());
buildToolRail();
restoreAutosave();
if (scene.kolams.length === 0) {
  addGenerated('9 pulli diamond sikku kolam, 4-fold, one stroke');
  scene.camera.zoom = 26;
}
setTool('select');
requestWorld();
flush(); // first paint does not wait for rAF (hidden-tab safe)
// animate the welcome kolam once fonts/layout settle
setTimeout(() => {
  const g = worldG.querySelector('g.kolam');
  if (g) animateGroup(g as SVGGElement);
}, 300);

// used by tests
void docFromSys;
void generate;

// E2E test hook: verify export content directly (browser download itself is
// handled by the anchor+blob mechanism, which is browser-provided). Results
// travel via DOM (sandboxed bridge worlds share the DOM, not window).
document.addEventListener('kolam:test-export', async () => {
  document.getElementById('exportProbe')?.remove();
  const k = selectedKolam();
  const holder = document.createElement('div');
  holder.id = 'exportProbe';
  holder.setAttribute('data-json', k ? canonicalJSON(k.doc) : 'null');
  const svgText = k
    ? renderSVG(k.doc, { width: 1600, showDots, strokeColor: PALETTE[theme].stroke, dotColor: PALETTE[theme].dot, background: PALETTE[theme].ground, padding: 1.4 })
    : 'null';
  holder.setAttribute('data-svg', k ? renderSVG(k.doc, { width: 900, showDots, strokeColor: PALETTE[theme].stroke, dotColor: PALETTE[theme].dot, background: PALETTE[theme].ground, padding: 1.4 }) : 'null');
  // PNG: rasterize the same SVG through an offscreen canvas
  let png = 'null';
  if (k) {
    try {
      const blob = new Blob([svgText], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('rasterize failed'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = Math.round((1600 * img.height) / Math.max(1, img.width));
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      png = canvas.toDataURL('image/png').slice(0, 64);
      URL.revokeObjectURL(url);
    } catch (e) {
      png = `error: ${(e as Error).message}`;
    }
  }
  holder.setAttribute('data-png', png);
  document.body.appendChild(holder);
});
(window as unknown as Record<string, unknown>).__kolamTest = {
  exportJsonText: () => {
    const k = selectedKolam();
    return k ? canonicalJSON(k.doc) : null;
  },
  exportSvgText: () => {
    const k = selectedKolam();
    if (!k) return null;
    const pal = PALETTE[theme];
    return renderSVG(k.doc, {
      width: 900,
      showDots,
      strokeColor: pal.stroke,
      dotColor: pal.dot,
      background: pal.ground,
      padding: 1.4,
    });
  },
  exportPngCanvas: () => {
    const k = selectedKolam();
    if (!k) return null;
    const pal = PALETTE[theme];
    const svgText = renderSVG(k.doc, {
      width: 1600,
      showDots,
      strokeColor: pal.stroke,
      dotColor: pal.dot,
      background: pal.ground,
      padding: 1.4,
    });
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    return new Promise<string | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1600;
        canvas.height = Math.round((1600 * img.height) / Math.max(1, img.width));
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png').slice(0, 60));
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  },
  // tool-system hooks for browser E2E
  setTool: (id: string) => setTool(id as ToolId),
  toolId: () => activeTool,
  selectedIds: () => [...selected],
  strokeCount: () => scene.strokes.length,
  sceneJSON: () => canonicalJSON(scene),
};
