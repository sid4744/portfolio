import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createInkMaterial, prepareModel, applyInk, PAPER } from './ink.js';
import { titleCard } from './card.js';
import { catIcon } from './icons.js';

const R = 12;                 // sphere radius
const ITEM_SIZE = 5.2;        // on-sphere model size
const FOCUS_DIST = 6.5;       // how close "focus" flies to an item
const D_MIN = -(R - 3), D_MAX = R * 2.4;

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const pad = (n) => String(n + 1).padStart(2, '0');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ───────────────────────── data ─────────────────────────
const [projectsRaw, site] = await Promise.all([
  fetch('data/projects.json').then((r) => r.json()),
  fetch('data/site.json').then((r) => r.json()).catch(() => ({ name: 'Portfolio' })),
]);
// Order by category so each category forms a band on the sphere.
const catOrder = [...new Set(projectsRaw.map((p) => p.category || 'Other'))];
const projects = projectsRaw
  .map((p, i) => ({ ...p, category: p.category || 'Other', _i: i }))
  .sort((a, b) => catOrder.indexOf(a.category) - catOrder.indexOf(b.category) || a._i - b._i);
const byId = new Map(projects.map((p, i) => [p.id, i]));

document.title = `${site.name || 'Portfolio'} — Projects`;
$('#brand').textContent = (site.name || 'Portfolio').toUpperCase();

// ───────────────────────── capability ─────────────────────────
function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}
const params = new URLSearchParams(location.search);
const weak = (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);
const canSphere = hasWebGL() && !params.has('lite');
// Phones and tablets: touch controls, and "light" mode, where models are shown as their thumbnail discs
// (a few KB each) instead of streaming ~60 MB of 3D files; the real model still loads on the project page.
const coarse = matchMedia('(pointer: coarse)').matches;
const LITE = !params.has('full') && (params.has('light') || weak || (coarse && Math.min(innerWidth, innerHeight) < 900));
if (coarse) document.body.classList.add('touch');
let mode = 'index';

// ───────────────────────── index view (also the fallback) ─────────────────────────
let activeCat = null;
function buildIndex() {
  $('#indexTitle').textContent = `${projects.length} projects`;
  const chips = $('#chips');
  chips.replaceChildren(
    el('button', { class: 'ink mode on', type: 'button', onclick: () => setCat(null) }, 'All'),
    ...catOrder.map((c) => el('button', { class: 'ink mode', type: 'button', onclick: () => setCat(c) }, catIcon(c), c)),
  );
  $('#grid').replaceChildren(...projects.map((p, i) => {
    const thumb = p.cover || (p.model ? `media/thumbs/${p.id}.png` : null);
    return el('button', { class: 'card ink', type: 'button', 'data-cat': p.category, onclick: () => openProject(i) },
      thumb ? el('img', { src: thumb, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : null,
      el('span', { class: 'num' }, pad(i)),
      el('span', { class: 'meta' }, el('b', {}, p.title), el('span', {}, [p.category, p.year].filter(Boolean).join(' · '))));
  }));
}
function setCat(c) {
  activeCat = c;
  document.querySelectorAll('#chips button').forEach((b, i) => b.classList.toggle('on', c ? b.textContent === c : i === 0));
  let shown = 0;
  document.querySelectorAll('.card').forEach((card) => { const on = !c || card.dataset.cat === c; card.hidden = !on; if (on) shown++; });
  $('#indexTitle').textContent = c ? `${shown} ${c}` : `${projects.length} projects`;
  document.querySelectorAll('#legend button').forEach((b) => b.classList.toggle('on', !!c && b.dataset.cat === c));
  document.querySelector('#index')?.scrollTo?.({ top: 0 });
  sphere?.setFilter(c);
}

function setMode(m) {
  if (m === 'sphere' && !canSphere) m = 'index';
  mode = m;
  document.body.classList.toggle('index-mode', m === 'index');
  $('#index').hidden = m !== 'index';
  document.querySelectorAll('.mode[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
}

// ───────────────────────── sphere ─────────────────────────
let sphere = null;
const loader = new GLTFLoader();
const modelCache = new Map();
const loadModel = (url) => {
  if (!modelCache.has(url)) modelCache.set(url, loader.loadAsync(url));
  return modelCache.get(url);
};

function fibonacciPoint(k, n) {
  const y = 1 - (2 * (k + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const t = k * Math.PI * (3 - Math.sqrt(5));
  return new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r);
}
const dirToAngles = (d) => ({ yaw: Math.atan2(d.x, -d.z), pitch: Math.asin(clamp(d.y, -1, 1)) });
const anglesToDir = (yaw, pitch) => new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));

// Soft vignette for the floating pictures: solid in the middle, fading smoothly to nothing at the edge (no hard border).
let _vignette = null;
function vignetteMap() {
  if (_vignette) return _vignette;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, '#fff'); grad.addColorStop(0.55, '#fff'); grad.addColorStop(0.8, '#777'); grad.addColorStop(1, '#000');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  return (_vignette = new THREE.CanvasTexture(c));
}

// Soft cyber-yellow halo that appears behind the project under the mouse (or focused with the keyboard).
let _glow = null;
function glowMap() {
  if (_glow) return _glow;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(252,238,10,0.95)'); grad.addColorStop(0.35, 'rgba(252,238,10,0.55)'); grad.addColorStop(0.7, 'rgba(252,238,10,0.14)'); grad.addColorStop(1, 'rgba(252,238,10,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  return (_glow = new THREE.CanvasTexture(c));
}

function startSphere() {
  const canvas = $('#gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  const dpr = Math.min(window.devicePixelRatio || 1, LITE ? 1.5 : 2);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(PAPER, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 200);

  // Sphere skeleton: thin lines, so the "sphere" reads without competing with the work.
  const lineMat = new THREE.LineBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.28 });
  const g = new THREE.Group();
  for (let i = -3; i <= 3; i++) {
    const lat = (i / 4) * (Math.PI / 2), pts = [];
    for (let a = 0; a <= 96; a++) { const t = (a / 96) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(t) * Math.cos(lat) * R, Math.sin(lat) * R, Math.sin(t) * Math.cos(lat) * R)); }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
  }
  for (let i = 0; i < 12; i++) {
    const lon = (i / 12) * Math.PI * 2, pts = [];
    for (let a = 0; a <= 64; a++) { const t = (a / 64) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(t) * Math.cos(lon) * R, Math.sin(t) * R, Math.cos(t) * Math.sin(lon) * R)); }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
  }
  scene.add(g);
  // Dust, for depth and a bit of noise in 3D.
  const dust = new Float32Array(1800 * 3);
  for (let i = 0; i < 1800; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(R * (0.2 + Math.random() * 1.1)); dust.set([v.x, v.y, v.z], i * 3); }
  const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dust, 3));
  scene.add(new THREE.Points(dg, new THREE.PointsMaterial({ color: 0x050505, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.55 })));

  // Items
  const labels = $('#labels');
  const items = projects.map((p, i) => {
    const dir = fibonacciPoint(i, projects.length);
    const holder = new THREE.Group();
    holder.position.copy(dir).multiplyScalar(R);
    scene.add(holder);
    const mat = createInkMaterial({ cell: 1.6 * dpr });
    let ph = new THREE.Mesh(new THREE.OctahedronGeometry(0.5), mat);
    let card = null;
    if (!p.model || LITE) {               // flat disc facing the centre: cover image, a model's thumbnail (light mode), or a generated title card
      ph.geometry.dispose();
      const cmat = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, alphaMap: vignetteMap(), depthWrite: false });
      const apply = (tex) => { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; cmat.map = tex; cmat.needsUpdate = true; };
      const src = p.model ? `media/thumbs/${p.id}.png` : p.cover;
      if (src) new THREE.TextureLoader().load(src, apply, undefined, () => apply(new THREE.CanvasTexture(titleCard(p, i))));
      else apply(new THREE.CanvasTexture(titleCard(p, i)));
      card = new THREE.Mesh(new THREE.CircleGeometry(ITEM_SIZE / 2, 72), cmat);      // pictures float as discs, not squares

      holder.lookAt(0, 0, 0);
      ph = card;
    }
    holder.add(ph);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(ITEM_SIZE * 0.62, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    hit.userData.index = i;
    holder.add(hit);
    const tag = el('div', { class: 'tag ink' }, pad(i), el('b', {}, p.title), el('small', {}, p.category));
    labels.append(tag);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap(), transparent: true, depthWrite: false, opacity: 0 }));
    glow.renderOrder = -1; glow.visible = false; scene.add(glow);
    return { glow, g: 0, p, i, dir, tdir: dir.clone(), sc: 1, tsc: 1, holder, mat, ph, card, hit, tag, spin: Math.random() * 6, phase: Math.random() * 6, hover: 0, dim: 0, targetDim: 0, model: null, ang: dirToAngles(dir), sx: 0, sy: 0 };
  });
  const hitMeshes = items.map((it) => it.hit);

  // Legend
  $('#legend').replaceChildren(...catOrder.map((c) => el('button', { class: 'ink', type: 'button', 'data-cat': c, onclick: () => setCat(activeCat === c ? null : c) },
    catIcon(c), c, el('i', {}, String(projects.filter((p) => p.category === c).length)))));

  // Stream models in, nearest-to-view first.
  let loaded = 0, finished = 0;
  const total = items.filter((it) => it.p.model && !it.card).length;
  const setProgress = () => {
    $('#loadText').textContent = `LOADING ${String(finished).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
    $('#loadBar').style.width = `${(finished / Math.max(1, total)) * 100}%`;
    if (finished >= Math.min(total, 8)) document.body.classList.remove('booting');
  };
  const queue = items.filter((it) => it.p.model && !it.card);
  async function pump() {
    while (queue.length) {
      const fwd = anglesToDir(view.yaw, view.pitch);
      queue.sort((a, b) => b.dir.dot(fwd) - a.dir.dot(fwd));
      const it = queue.shift();
      try {
        const gltf = await loadModel(it.p.model);
        const root = prepareModel(gltf.scene, it.p, { size: ITEM_SIZE });
        applyInk(root, it.mat);
        it.holder.remove(it.ph); it.ph.geometry.dispose();
        it.holder.add(root);
        it.model = root; loaded++;
      } catch (e) { console.warn('model failed', it.p.id, e); }
      finished++; setProgress();
    }
  }
  setProgress();

  // ── view state ──
  const view = { yaw: 0, pitch: 0.1, d: D_MAX * 0.7, tD: 0, vyaw: 0, vpitch: 0, tween: null, idle: 0 };
  pump(); pump(); // two in flight
  let focus = -1, hover = -1, detailOpen = false;

  const flyTo = (yaw, pitch, d, dur = 1.1) => {
    let dy = ((yaw - view.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    view.tween = { t: 0, dur, y0: view.yaw, p0: view.pitch, d0: view.d, y1: view.yaw + dy, p1: clamp(pitch, -1.4, 1.4), d1: clamp(d, D_MIN, D_MAX) };
    view.tD = view.tween.d1; view.vyaw = view.vpitch = 0;
  };
  const focusItem = (i, { fly = true } = {}) => {
    focus = i;
    if (i < 0) return;
    const it = items[i];
    if (fly) flyTo(it.ang.yaw, it.ang.pitch, R - FOCUS_DIST);
    showTip(null);
  };
  const stepFocus = (dir) => {
    const n = items.length;
    focusItem(focus < 0 ? (dir > 0 ? 0 : n - 1) : (focus + dir + n) % n);
  };

  // ── input ──
  const pointer = { down: false, x: 0, y: 0, sx: 0, sy: 0, moved: 0, id: null, inside: false };
  const pointers = new Map(); let pinch = null;          // active fingers; two of them = pinch to move in and out
  const TAP = coarse ? 12 : 6;                           // how far a finger may wander and still count as a tap
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); view.tween = null; view.idle = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), t0: view.tD };
      pointer.down = false; pointer.moved = 9999; canvas.classList.remove('drag'); return;
    }
    pointer.downHover = pickAt(e.clientX, e.clientY);
    pointer.down = true; pointer.x = pointer.sx = e.clientX; pointer.y = pointer.sy = e.clientY; pointer.moved = 0; pointer.id = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    canvas.classList.add('drag');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      view.tD = clamp(pinch.t0 + (pinch.d0 - d) * 0.035, D_MIN, D_MAX); view.idle = 0; return;
    }
    pointer.inside = true; pointer.cx = e.clientX; pointer.cy = e.clientY;
    if (!pointer.down) return;
    const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved += Math.abs(dx) + Math.abs(dy);
    const k = (camera.fov * Math.PI / 180) / canvas.clientHeight; // radians per pixel
    view.yaw -= dx * k; view.pitch = clamp(view.pitch + dy * k, -1.45, 1.45);
    view.vyaw = -dx * k * 60; view.vpitch = dy * k * 60; view.idle = 0; focus = -1;
  });
  const endDrag = (e) => {
    pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null;
    if (!pointer.down) return;
    pointer.down = false; canvas.classList.remove('drag');
    if (pointer.moved < TAP && pointer.downHover >= 0) openProject(pointer.downHover);
    else if (pointer.moved < TAP) focus = -1;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', (e) => { pointers.delete(e.pointerId); pointer.inside = false; hover = -1; showTip(null); });

  // Mouse wheel zooms; two-finger trackpad scroll looks around; pinch (ctrl+wheel) zooms.
  let trackpad = false;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); view.tween = null; view.idle = 0;
    if (e.deltaX !== 0 || (e.deltaMode === 0 && (Math.abs(e.deltaY) < 40 || !Number.isInteger(e.deltaY)))) trackpad = true;
    if (e.ctrlKey) { view.tD = clamp(view.tD + e.deltaY * 0.06, D_MIN, D_MAX); return; }
    if (trackpad && !e.shiftKey && e.deltaMode === 0) {
      const k = (camera.fov * Math.PI / 180) / canvas.clientHeight;
      view.yaw += e.deltaX * k * 1.3; view.pitch = clamp(view.pitch - e.deltaY * k * 1.3, -1.45, 1.45); focus = -1;
    } else {
      const step = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
      view.tD = clamp(view.tD + Math.sign(step) * Math.min(Math.abs(step), 240) * 0.012, D_MIN, D_MAX);
    }
  }, { passive: false });

  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input,textarea,select')) return;
    if (e.key === 'Escape') { if (closeLightbox()) return; if (!$('#about').hidden) closeAbout(); else if (detailOpen) closeProject(); else focus = -1; return; }
    if (detailOpen || !$('#about').hidden) {
      if (detailOpen && (e.key === 'ArrowRight')) { e.preventDefault(); openProject((currentIdx + 1) % projects.length); }
      if (detailOpen && (e.key === 'ArrowLeft')) { e.preventDefault(); openProject((currentIdx - 1 + projects.length) % projects.length); }
      return;
    }
    if (mode !== 'sphere') return;
    const k = e.key.toLowerCase();
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd', '+', '=', '-', '_'].includes(k)) { e.preventDefault(); keys.add(k); view.tween = null; view.idle = 0; if (k.startsWith('arrow') || 'ad'.includes(k)) focus = -1; }
    else if (k === 'tab') { e.preventDefault(); stepFocus(e.shiftKey ? -1 : 1); }
    else if (k === ']' || k === '.') stepFocus(1);
    else if (k === '[' || k === ',') stepFocus(-1);
    else if (k === 'enter') { const t = focus >= 0 ? focus : hover; if (t >= 0) openProject(t); }
    else if (k === 'home' || k === '0') { focus = -1; flyTo(0, 0.1, 0); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  // Minimap
  const mini = $('#mini'), mctx = mini.getContext('2d');
  mini.addEventListener('pointerdown', (e) => {
    const r = mini.getBoundingClientRect();
    const yaw = ((e.clientX - r.left) / r.width - 0.5) * Math.PI * 2;
    const pitch = (0.5 - (e.clientY - r.top) / r.height) * Math.PI;
    focus = -1; flyTo(yaw, pitch, view.tD, 0.9);
  });
  const drawMini = () => {
    const w = mini.width, h = mini.height;
    mctx.fillStyle = '#f4f4f1'; mctx.fillRect(0, 0, w, h);
    mctx.strokeStyle = 'rgba(0,0,0,.25)'; mctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { mctx.beginPath(); mctx.moveTo(0, h * i / 4); mctx.lineTo(w, h * i / 4); mctx.stroke(); }
    for (let i = 1; i < 8; i++) { mctx.beginPath(); mctx.moveTo(w * i / 8, 0); mctx.lineTo(w * i / 8, h); mctx.stroke(); }
    for (const it of items) {
      const x = (it.ang.yaw / (Math.PI * 2) + 0.5) * w, y = (0.5 - it.ang.pitch / Math.PI) * h;
      mctx.fillStyle = it.i === focus || it.i === hover ? '#000' : (it.targetDim ? 'rgba(0,0,0,.2)' : 'rgba(0,0,0,.8)');
      const s = it.i === focus || it.i === hover ? 9 : 5; mctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
    const fx = (camera.fov * camera.aspect) / 360 * w, fy = camera.fov / 180 * h;
    const cx = ((((view.yaw / (Math.PI * 2)) + 0.5) % 1) + 1) % 1 * w, cy = (0.5 - view.pitch / Math.PI) * h;
    mctx.fillStyle = 'rgba(252, 238, 10, .55)'; mctx.fillRect(cx - fx / 2, cy - fy / 2, fx, fy);
    mctx.strokeStyle = '#000'; mctx.lineWidth = 2; mctx.strokeRect(cx - fx / 2, cy - fy / 2, fx, fy);
  };

  // Tooltip
  const tip = $('#tip');
  // The label that follows the mouse: number, title and category of the project under the cursor.
  function showTip(i) {
    if (i == null || i < 0) { tip.hidden = true; return; }
    tip.hidden = false; tip.textContent = `${pad(i)}   ${projects[i].title.toUpperCase()}   ·   ${projects[i].category.toUpperCase()}`;
  }


  // ── resize ──
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = camera.aspect < 0.85 ? 88 : 68;      // tall phone screens: a wider view so more than one project fits
    camera.updateProjectionMatrix();
    for (const it of items) it.mat.uniforms.uCell.value = 1.6 * renderer.getPixelRatio();
  };
  window.addEventListener('resize', resize); resize();

  // ── loop ──
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), tmp = new THREE.Vector3();
  // Which project is under a screen point (ignores ones dimmed out by a category filter).
  function pickAt(x, y) {
    ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    for (const h of ray.intersectObjects(hitMeshes, false)) { const idx = h.object.userData.index; if (!items[idx].targetDim) return idx; }
    return -1;
  }
  const clock = new THREE.Clock();
  let tint = 0;
  function frame() {
    requestAnimationFrame(frame);
    if (mode !== 'sphere') { clock.getDelta(); return; }
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;

    // keyboard
    const turn = 1.1 * dt * (camera.fov / 68);
    if (keys.has('arrowleft') || keys.has('a')) view.yaw -= turn;
    if (keys.has('arrowright') || keys.has('d')) view.yaw += turn;
    if (keys.has('arrowup')) view.pitch = clamp(view.pitch + turn, -1.45, 1.45);
    if (keys.has('arrowdown')) view.pitch = clamp(view.pitch - turn, -1.45, 1.45);
    if (keys.has('w') || keys.has('+') || keys.has('=')) view.tD = clamp(view.tD - 9 * dt, D_MIN, D_MAX);
    if (keys.has('s') || keys.has('-') || keys.has('_')) view.tD = clamp(view.tD + 9 * dt, D_MIN, D_MAX);

    if (view.tween) {
      const tw = view.tween; tw.t += dt / tw.dur; const k = ease(Math.min(1, tw.t));
      view.yaw = tw.y0 + (tw.y1 - tw.y0) * k; view.pitch = tw.p0 + (tw.p1 - tw.p0) * k; view.d = tw.d0 + (tw.d1 - tw.d0) * k;
      if (tw.t >= 1) view.tween = null;
    } else {
      if (!pointer.down) { view.yaw += view.vyaw * dt; view.pitch = clamp(view.pitch + view.vpitch * dt, -1.45, 1.45); const f = Math.pow(0.04, dt); view.vyaw *= f; view.vpitch *= f; }
      view.d += (view.tD - view.d) * (1 - Math.pow(0.002, dt));
      view.idle += dt;
      if (view.idle > 10 && !detailOpen && focus < 0 && !pointer.down && keys.size === 0) view.yaw += 0.04 * dt;
    }

    // camera: sits at -forward*d and looks along forward (d=0 → turn on the spot)
    const f = anglesToDir(view.yaw, view.pitch);
    camera.position.copy(f).multiplyScalar(-view.d);
    camera.lookAt(tmp.copy(camera.position).add(f));
    camera.updateMatrixWorld();

    // hover pick
    hover = -1;
    if (pointer.inside && !pointer.down && !detailOpen) {
      hover = pickAt(pointer.cx, pointer.cy);
      canvas.classList.toggle('hot', hover >= 0);
      if (hover >= 0) { showTip(hover); tip.style.transform = `translate(${pointer.cx + 16}px, ${pointer.cy + 16}px)`; tip.style.left = 0; tip.style.top = 0; } else showTip(null);
    }

    tint += dt;
    for (const it of items) {
      const on = it.i === hover || it.i === focus;
      it.hover += ((on ? 1 : 0) - it.hover) * (1 - Math.pow(0.0005, dt));
      it.dim += (it.targetDim - it.dim) * (1 - Math.pow(0.001, dt));
      it.mat.uniforms.uHover.value = it.hover; it.mat.uniforms.uDim.value = it.dim; it.mat.uniforms.uTime.value = t;
      it.spin += dt * (0.25 + it.hover * 0.9);
      const obj = it.model || it.ph;
      if (it.card) { obj.rotation.y = Math.sin(it.spin * 0.6) * 0.3; it.card.material.opacity = 1 - it.dim * 0.85; }
      else obj.rotation.y = it.spin;
      const glide = 1 - Math.pow(0.02, dt);
      if (it.dir.distanceToSquared(it.tdir) > 1e-7) { it.dir.lerp(it.tdir, glide).normalize(); it.ang = dirToAngles(it.dir); }
      it.sc += (it.tsc - it.sc) * glide;
      it.holder.visible = it.sc > 0.02;
      it.holder.position.copy(it.dir).multiplyScalar(R).addScaledVector(it.dir, Math.sin(t * 0.6 + it.phase) * 0.18);
      if (it.card) it.holder.lookAt(0, 0, 0);
      // halo behind the selected project
      it.g += ((on ? 1 : 0) - it.g) * (1 - Math.pow(0.002, dt));
      it.glow.visible = it.g > 0.01 && it.holder.visible;
      if (it.glow.visible) {
        it.glow.material.opacity = it.g * 0.66;
        it.glow.position.copy(it.holder.position).addScaledVector(it.dir, 2.2);
        const gs = ITEM_SIZE * 1.9 * Math.max(it.sc, 0.001) * (1 + 0.05 * Math.sin(t * 3));
        it.glow.scale.set(gs, gs, 1);
      }
      const s = (1 + it.hover * 0.14) * Math.max(it.sc, 0.001); it.holder.scale.setScalar(s);

      // label
      tmp.copy(it.holder.position).project(camera);
      const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1 && !it.targetDim;
      const cen = Math.hypot(tmp.x, tmp.y);
      // Under the mouse the cursor label does the talking; the picture's own tag only keeps its number.
      const show = hover >= 0 ? false : (it.i === focus || (cen < 0.22 && view.d < R * 0.5));
      it.tag.classList.toggle('show', show);
      it.tag.style.opacity = vis ? (on ? 1 : clamp(1.15 - cen * 0.8, 0.25, 1)) : 0;
      it.tag.style.transform = `translate(${((tmp.x + 1) / 2) * window.innerWidth + 14}px, ${((1 - tmp.y) / 2) * window.innerHeight - 30}px)`;
    }
    renderer.render(scene, camera);
    if (((tint * 20) | 0) !== (((tint - dt) * 20) | 0)) drawMini();
  }
  frame();

  return {
    items,
    // Show only one category: its projects spread over the whole sphere, the rest shrink away.
    setFilter(c) {
      const shown = items.filter((it) => !c || it.p.category === c), n = shown.length;
      const grow = clamp(Math.sqrt(items.length / Math.max(n, 1)) * 0.6, 1, 1.5);
      shown.forEach((it, k) => { it.tdir = fibonacciPoint(k, n); it.tsc = grow; });
      for (const it of items) {
        const on = !c || it.p.category === c;
        it.targetDim = on ? 0 : 1;
        if (!on) { it.tsc = 0; it.tdir = it.dir.clone(); }
      }
      focus = -1; hover = -1;   // the camera stays exactly where it is
    },
    focusItem, flyTo, view,
    setDetail(open) { detailOpen = open; },
    focusIndex: () => focus,
  };
}

// ───────────────────────── detail ─────────────────────────
let currentIdx = -1;
let viewer = null;

function disposeViewer() {
  if (!viewer) return;
  cancelAnimationFrame(viewer.raf);
  viewer.controls.dispose();
  viewer.renderer.dispose();
  viewer.renderer.domElement.remove();
  viewer = null;
}

async function startViewer(p) {
  disposeViewer();
  const host = $('#viewer'), cover = $('#dCover');
  cover.hidden = true;
  host.querySelector('.viewer-hint').hidden = true;
  const fallbackImg = p.cover || (p.model ? `media/thumbs/${p.id}.png` : titleCard(p, currentIdx, 900).toDataURL());
  const showImg = () => { cover.src = fallbackImg; cover.hidden = false; cover.onerror = () => { cover.hidden = true; }; };
  if (!p.model || !canSphere) { showImg(); return; }

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr); renderer.setClearColor(0x000000, 0);
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(6.4, 3.6, 8.6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.autoRotate = true; controls.autoRotateSpeed = 1.1;
  controls.minDistance = 3; controls.maxDistance = 16; controls.enablePan = false;
  const mat = createInkMaterial({ cell: 1.5 * dpr });
  const state = { renderer, controls, raf: 0 };
  viewer = state;
  try {
    const gltf = await loadModel(p.model);
    if (viewer !== state) return;
    const root = prepareModel(gltf.scene, p, { size: 4.6 });
    applyInk(root, mat); scene.add(root);
    host.querySelector('.viewer-hint').hidden = false;
  } catch (e) { console.warn(e); if (viewer === state) { disposeViewer(); showImg(); } return; }
  const resize = () => { const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); mat.uniforms.uCell.value = 1.5 * renderer.getPixelRatio(); };
  resize(); state.resize = resize;
  const loop = (ms) => { state.raf = requestAnimationFrame(loop); mat.uniforms.uTime.value = ms / 1000; controls.update(); renderer.render(scene, camera); };
  loop(0);
}
window.addEventListener('resize', () => viewer?.resize?.());

function row(k, v) { return v ? [el('dt', {}, k), el('dd', {}, v)] : []; }

function openProject(i, { push = true } = {}) {
  const p = projects[i]; if (!p) return;
  currentIdx = i;
  const info = $('#info'), rowsEl = $('#rows');
  const hasRows = (p.blocks || []).some((bl) => bl.t === 'imgs');
  const desc = p.description || [];
  const textEl = (t) => (t.startsWith('## ') ? el('h3', {}, t.slice(3)) : el('p', {}, t));
  info.replaceChildren(...[
    el('div', { class: 'kicker' }, `${pad(i)} / ${String(projects.length).padStart(2, '0')}  ·  ${p.category.toUpperCase()}`),
    el('h2', { id: 'dTitle' }, p.title),
    p.summary ? el('p', { class: 'lede' }, p.summary) : null,
    ...(hasRows ? [] : desc.map(textEl)),
    el('dl', {}, ...row('Year', p.year), ...row('Status', p.status), ...row('Category', p.category)),
    p.tech?.length ? el('ul', { class: 'tags' }, p.tech.map((t) => el('li', {}, t))) : null,
    p.links?.length ? el('div', { class: 'links' }, p.links.map((l) => el('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.label + ' ↗'))) : null,
    !hasRows && p.images?.length ? el('div', { class: 'gallery' }, p.images.map((src) => el('img', { src, alt: '', loading: 'lazy', onclick: () => openLightbox(src) }))) : null,
  ].filter(Boolean));
  // Rows: pictures on the left, the text they belong to on the right, in page order.
  rowsEl.replaceChildren();
  if (hasRows) {
    const at = new Map(); (p.blocks || []).filter((bl) => bl.t === 'imgs').forEach((bl) => at.set(bl.after, [...(at.get(bl.after) || []), ...bl.srcs]));
    const mkRow = (texts, srcs) => el('div', { class: 'row' + (texts.length ? '' : ' solo') },
      el('div', { class: 'rimgs' + (srcs.length >= 4 ? ' cols2' : '') }, srcs.map((src) => el('img', { src, alt: '', loading: 'lazy', onclick: () => openLightbox(src) }))),
      texts.length ? el('div', { class: 'rtext ink' }, el('div', { class: 'in' }, texts.map(textEl))) : null);
    const rows = []; let pending = [];
    if (at.has(-1)) rows.push(mkRow([], at.get(-1)));
    desc.forEach((t, k) => {
      pending.push(t);
      if (at.has(k)) { rows.push(mkRow(pending, at.get(k))); pending = []; }
    });
    if (pending.length) rows.push(el('div', { class: 'row' }, el('div', { class: 'rimgs' }), el('div', { class: 'rtext ink' }, el('div', { class: 'in' }, pending.map(textEl)))));
    rowsEl.append(...rows);
  }
  $('#detail').classList.toggle('rows', hasRows);
  info.scrollTop = 0; $('#detail').scrollTop = 0;
  const sheet = $('#detail'); sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
  sphere?.setDetail(true);
  if (sphere && mode === 'sphere') sphere.focusItem(i);
  startViewer(p);
  if (push) history.pushState({ p: p.id }, '', `#/p/${p.id}`);
  $('#dClose').focus({ preventScroll: true });
}
function openLightbox(src) {
  const lb = $('#lightbox'); lb.replaceChildren(el('img', { src, alt: '' })); lb.hidden = false;
}
function closeLightbox() { const lb = $('#lightbox'); if (lb.hidden) return false; lb.hidden = true; lb.replaceChildren(); return true; }
$('#lightbox').addEventListener('click', closeLightbox);
function closeProject({ push = true } = {}) {
  const sheet = $('#detail'); sheet.classList.remove('open');
  setTimeout(() => { if (!sheet.classList.contains('open')) { sheet.hidden = true; disposeViewer(); } }, 480);
  sphere?.setDetail(false); currentIdx = -1;
  if (push && location.hash) history.pushState(null, '', location.pathname + location.search);
}

function openAbout() {
  const b = $('#aboutBody');
  b.replaceChildren(...[
    el('div', { class: 'kicker' }, 'ABOUT'),
    el('h2', {}, site.name || ''),
    site.tagline ? el('p', { class: 'lede' }, site.tagline) : null,
    ...(site.about || []).map((t) => el('p', {}, t)),
    el('div', { class: 'links' },
      site.email ? el('a', { href: `mailto:${site.email}` }, site.email) : null,
      ...(site.links || []).map((l) => el('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.label + ' ↗'))),
  ].filter(Boolean));
  const s = $('#about');
  s.querySelector('.about-photo')?.remove();
  s.classList.toggle('has-photo', !!site.photo);
  if (site.photo) s.prepend(el('div', { class: 'about-photo' }, el('img', { src: site.photo, alt: site.name || 'Portrait' })));
  s.hidden = false; requestAnimationFrame(() => s.classList.add('open'));
}
function closeAbout() { const s = $('#about'); s.classList.remove('open'); setTimeout(() => { if (!s.classList.contains('open')) s.hidden = true; }, 480); }

// ───────────────────────── wire up ─────────────────────────
buildIndex();
document.querySelectorAll('.mode[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#aboutBtn').addEventListener('click', openAbout);
$('#brand').addEventListener('click', () => { closeProject(); closeAbout(); if (mode === 'sphere') sphere?.flyTo(0, 0.1, 0); });
$('#dClose').addEventListener('click', () => closeProject());
$('#aClose').addEventListener('click', closeAbout);
$('#dPrev').addEventListener('click', () => openProject((currentIdx - 1 + projects.length) % projects.length));
$('#dNext').addEventListener('click', () => openProject((currentIdx + 1) % projects.length));
window.addEventListener('popstate', () => {
  const m = location.hash.match(/^#\/p\/(.+)$/);
  if (m && byId.has(m[1])) openProject(byId.get(m[1]), { push: false }); else if (currentIdx >= 0) closeProject({ push: false });
});

let sphereNote = '';
if (canSphere) {
  try {
    sphere = startSphere();
    if (coarse) $('#hints').textContent = 'DRAG TO LOOK · PINCH TO ZOOM · TAP TO OPEN';
    setMode('sphere');
  } catch (e) {
    console.error('Sphere failed to start', e); sphere = null; sphereNote = `The 3D view could not start on this device (${String(e.message || e).slice(0, 90)}). Showing the list instead.`;
    document.body.classList.remove('booting'); $('#legend').hidden = true; document.querySelector('.mode[data-mode="sphere"]').hidden = true; setMode('index');
  }
} else {
  sphereNote = hasWebGL() ? '' : 'This browser has no WebGL, so the 3D view is off. Showing the list instead.';
  document.body.classList.remove('booting');
  $('#legend').hidden = true;
  document.querySelector('.mode[data-mode="sphere"]').hidden = true;
  setMode('index');
}
if (sphereNote) $('.index-head').append(el('p', { class: 'fallback-note' }, sphereNote));

const first = location.hash.match(/^#\/p\/(.+)$/);
if (first && byId.has(first[1])) openProject(byId.get(first[1]), { push: false });
window.__portfolio = { get sphere() { return sphere; }, projects, openProject };
