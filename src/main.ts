import './style.css';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { animate } from 'animejs';
import { SimClock, type Mode } from './core/clock';
import { CameraRig } from './core/controls';
import { Labels } from './core/labels';
import { shared } from './core/shaders';
import { json, texture, type EventsData, type LaunchesData, type StarsData } from './core/data';
import { MISSIONS } from './core/missions';
import { loadEvents, loadLaunches } from './core/live';
import type { Layer, LayerId, Selectable } from './core/types';
import { Sky } from './layers/sky';
import { EarthLayer } from './layers/earth';
import { SolarLayer } from './layers/solar';
import { GalaxyLayer } from './layers/galaxy';
import { Hud, earthFeed, solarFeed, galaxyFeed, layerFeedTitle } from './ui/hud';

// ------------------------------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1e-4, 1e8);
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(new THREE.Scene(), camera);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.85, 0.55, 0.62);
composer.addPass(renderPass);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  shared.uPixelRatio.value = renderer.getPixelRatio();
  shared.uPxScale.value = innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
addEventListener('resize', resize);
function updateFov() {
  camera.updateProjectionMatrix();
  shared.uPxScale.value = innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
resize();

const clock = new SimClock();
const rig = new CameraRig(camera, renderer.domElement);
const labelHost = document.createElement('div');
labelHost.id = 'labels';
document.body.appendChild(labelHost);

// ------------------------------------------------------------------------------------------ state
let mode: Mode = 'flow';
let active: Layer;
let selected: Selectable | null = null;
let following = true;
let flight: { stop(): void; locked: boolean } | null = null;
let transitioning = false;
const lastSelPos = new THREE.Vector3();
const layers = {} as Record<LayerId, Layer>;
const ready: Record<LayerId, boolean> = { earth: false, solar: false, galaxy: false };
const labelSets = {} as Record<LayerId, Labels>;
const speedFor: Record<LayerId, number> = { earth: 1, solar: 86400, galaxy: 2 };
let events: EventsData | null = null, launches: LaunchesData | null = null;

const hud = new Hud({
  layer: (id) => goToLayer(id),
  mode: (m) => setMode(m),
  speed: (r) => {
    speedFor[active.id] = r;
    if (active.id === 'galaxy') clock.myrRate = r; else clock.rate = r;
    if (mode === 'fly') setMode('flow');
    refreshSpeeds();
  },
  now: () => { clock.now(); speedFor.earth = 1; if (active.id === 'earth') clock.rate = 1; refreshSpeeds(); hud.toast('Back to live time'); },
  select: (s) => select(s, true),
  deselect: () => select(null),
  follow: (on) => (following = on),
  drill: () => drill(),
  search: (q) => search(q),
});

function setMode(m: Mode) {
  mode = m;
  clock.running = m === 'flow';
  rig.setMode(m === 'flow' ? 'orbit' : 'fly');
  rig.orbit.autoRotate = m === 'flow' && !selected;
  hud.setMode(m);
  refreshSpeeds();
}

function refreshSpeeds() {
  const rate = active.id === 'galaxy' ? clock.myrRate : clock.rate;
  hud.setSpeeds(active.speeds, rate, clock.running);
}

// ------------------------------------------------------------------------------------------ selection & camera flights
function select(s: Selectable | null, fly = false) {
  if (s && s.layer !== active.id) {
    goToLayer(s.layer, () => select(s, true));
    return;
  }
  selected?.onDeselect?.();
  selected = s;
  rig.orbit.autoRotate = mode === 'flow' && !s;
  if (!s) { hud.showInfo(null); return; }
  s.onSelect?.();
  s.position(lastSelPos);
  hud.setFollow(following = true);
  hud.showInfo(s, s.info(), drillLabel(s));
  if (fly) flyTo(s, frameDistance(s));
}

function drillLabel(s: Selectable) {
  if (active.id === 'solar' && s.id === 'planet:Earth') return 'Enter Earth orbit →';
  if (active.id === 'galaxy' && s.id === 'sun-galaxy') return 'Enter the Solar System →';
  if (active.id === 'solar' && s.id === 'sun') return 'Zoom out to the Milky Way →';
  if (active.id === 'earth' && s.id === 'earth') return 'Zoom out to the Solar System →';
  return undefined;
}
function drill() {
  if (!selected) return;
  if (active.id === 'solar' && selected.id === 'planet:Earth') goToLayer('earth');
  else if (active.id === 'galaxy') goToLayer('solar');
  else if (active.id === 'solar') goToLayer('galaxy');
  else if (active.id === 'earth') goToLayer('solar');
}

function frameDistance(s: Selectable) {
  const byKind: Record<string, number> = { satellite: 1.2, mission: active.id === 'earth' ? 400 : 6, launch: 4, 'open cluster': 60, maser: 900, 'globular cluster': 1600, 'spiral arm': 9000, 'black hole': 5000, asteroid: 8 };
  if (s.kind === 'star') return active.id === 'galaxy' ? (s.id === 'sun-galaxy' ? 40 : 6) : s.radius * 8;
  return byKind[s.kind] ?? s.radius * 5;
}

/** anime.js-driven flight: target glides to the object, distance changes logarithmically (handles 1e6× zooms). */
function flyTo(s: Selectable | null, dist: number, duration = 1800, endTarget?: THREE.Vector3, endDir?: THREE.Vector3, locked = false) {
  flight?.stop();
  const startT = rig.orbit.target.clone();
  const startDir = camera.position.clone().sub(startT);
  const d0 = Math.max(startDir.length(), 1e-6);
  startDir.normalize();
  const dir1 = (endDir || startDir).clone().normalize();
  const tgt = new THREE.Vector3(), dir = new THREE.Vector3();
  const o = { t: 0 };
  rig.orbit.enabled = false;
  const anim = animate(o, {
    t: 1, duration, ease: 'inOutCubic',
    onUpdate: () => {
      if (s) s.position(tgt); else tgt.copy(endTarget!);
      const target = startT.clone().lerp(tgt, o.t);
      const d = Math.exp(Math.log(d0) * (1 - o.t) + Math.log(dist) * o.t);
      dir.copy(startDir).lerp(dir1, o.t).normalize();
      rig.orbit.target.copy(target);
      camera.position.copy(target).addScaledVector(dir, d);
      camera.lookAt(target);
    },
    onComplete: () => { flight = null; rig.orbit.enabled = mode === 'flow'; if (s) s.position(lastSelPos); },
  });
  flight = { locked, stop: () => { anim.pause(); flight = null; rig.orbit.enabled = mode === 'flow'; } };
}

// ------------------------------------------------------------------------------------------ layers & transitions
function activate(layer: Layer) {
  if (active) { active.onExit?.(); labelSets[active.id].setActive(false); }
  active = layer;
  layer.onEnter?.();
  renderPass.scene = layer.scene;
  labelSets[layer.id].setActive(true);
  rig.orbit.minDistance = layer.minDistance;
  rig.orbit.maxDistance = layer.maxDistance;
  if (active.id === 'galaxy') clock.myrRate = speedFor.galaxy; else clock.rate = speedFor[active.id];
  // Earth orbit is the "right now" view: coming back from a time-lapse elsewhere snaps to live time
  if (layer.id === 'earth' && Math.abs(clock.ms - Date.now()) > 6 * 36e5) { clock.now(); speedFor.earth = 1; hud.toast('Back to live time'); }
  bloom.strength = layer.id === 'galaxy' ? 0.75 : layer.id === 'solar' ? 0.8 : 0.55;
  bloom.threshold = layer.id === 'galaxy' ? 0.62 : layer.id === 'solar' ? 0.7 : 0.85;
  bloom.radius = layer.id === 'earth' ? 0.35 : 0.55;
  refreshNav();
  hud.setToggles('Show', layer.toggles);
  refreshSpeeds();
  hud.setFeed(`<h3>${layerFeedTitle(layer)}</h3>` + feedFor(layer));
}

function refreshNav() {
  hud.setLayers((['earth', 'solar', 'galaxy'] as LayerId[]).map((id) => ({ id, label: layers[id]?.label ?? id, ready: ready[id] })), active.id);
}

function feedFor(layer: Layer) {
  if (layer.id === 'earth') {
    const e = layer as EarthLayer;
    return earthFeed(launches, events, e.sats.length, e.satsFetched, e.satsPartial, e.satsLive);
  }
  if (layer.id === 'solar') {
    const list = Object.entries(MISSIONS).filter(([id]) => (layers.solar as SolarLayer).selectables().some((s) => s.id === 'mission:' + id))
      .map(([, m]) => ({ name: m.short, color: m.color, sub: `${m.agency} · ${m.launched}` }));
    return solarFeed(events, list);
  }
  return galaxyFeed();
}

function goToLayer(id: LayerId, then?: () => void) {
  if (transitioning || !ready[id]) { if (!ready[id]) hud.toast('Still loading that scale…'); return; }
  if (id === active.id) {
    const h = active.home();
    select(null);
    flyTo(null, h.position.distanceTo(h.target), 1600, h.target, h.position.clone().sub(h.target));
    then?.();
    return;
  }
  const from = active.id;
  const viewDir = camera.position.clone().sub(rig.orbit.target).normalize();
  transitioning = true;
  flight?.stop();
  select(null);
  hud.warp(() => {
    const next = layers[id];
    activate(next);
    const home = next.home();
    const homeDir = home.position.clone().sub(home.target).normalize();
    const zoomOut = order(id) > order(from);
    if (zoomOut && next.anchor) {
      // start tight on the anchor (Earth / Sun) we just came from, then pull back
      const a = next.anchor.position(new THREE.Vector3());
      const startDist = id === 'solar' ? 4 : 2.5;
      rig.orbit.target.copy(a);
      camera.position.copy(a).addScaledVector(viewDir, startDist);
      flyTo(null, home.position.distanceTo(home.target), id === 'galaxy' ? 5200 : 3200, home.target, homeDir, true);
    } else if (!zoomOut && from !== 'earth') {
      // arriving from outside: start far, fly in
      const startDist = id === 'earth' ? 3000 : 40000;
      rig.orbit.target.copy(home.target);
      camera.position.copy(home.target).addScaledVector(viewDir.lengthSq() ? viewDir : homeDir, startDist);
      flyTo(null, home.position.distanceTo(home.target), 3000, home.target, homeDir, true);
    } else {
      rig.orbit.target.copy(home.target);
      camera.position.copy(home.target).addScaledVector(homeDir, home.position.distanceTo(home.target) * 1.6);
      flyTo(null, home.position.distanceTo(home.target), 2200, home.target, homeDir, true);
    }
    camera.lookAt(rig.orbit.target);
    animate(camera, { fov: [72, 50], duration: 1600, ease: 'outCubic', onUpdate: updateFov });
    setTimeout(() => { transitioning = false; then?.(); }, 700);
  });
}
const order = (id: LayerId) => ({ earth: 0, solar: 1, galaxy: 2 })[id];

/** Zooming past a layer's edge hands over to the neighbouring scale. */
function checkHandoff() {
  if (transitioning || flight) return;
  const pos = camera.position;
  if (active.id === 'earth' && pos.length() > active.maxDistance * 0.97 && ready.solar) goToLayer('solar');
  else if (active.id === 'solar') {
    const earth = (layers.solar as SolarLayer).earthSel.position(new THREE.Vector3());
    if (pos.distanceTo(earth) < 1.6) goToLayer('earth');
    else if (pos.length() > active.maxDistance * 0.97 && ready.galaxy) goToLayer('galaxy');
  } else if (active.id === 'galaxy' && pos.distanceTo(active.anchor!.position(new THREE.Vector3())) < 0.08) goToLayer('solar');
}

// ------------------------------------------------------------------------------------------ search
function search(q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: [number, Selectable][] = [];
  for (const id of ['earth', 'solar', 'galaxy'] as LayerId[]) {
    if (!ready[id]) continue;
    for (const s of layers[id].selectables()) {
      const name = s.name.toLowerCase();
      let score = -1;
      if (name === needle) score = 0;
      else if (name.startsWith(needle)) score = 1;
      else if (name.includes(needle)) score = 2;
      else if (s.keywords?.toLowerCase().includes(needle)) score = 3;
      if (score >= 0) out.push([score * 1000 + (s.kind === 'satellite' ? 100 : 0) + name.length, s]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]).slice(0, 12).map((x) => x[1]);
}

// ------------------------------------------------------------------------------------------ picking
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
  if (flight && e.button === 0) flight.stop();
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
  down = null;
  const hit = pickAt(e.clientX, e.clientY);
  if (hit) select(hit, true);
});
renderer.domElement.addEventListener('dblclick', () => { if (selected && drillLabel(selected)) drill(); });
let hoverT = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons || performance.now() - hoverT < 50) return;
  hoverT = performance.now();
  const hit = pickAt(e.clientX, e.clientY);
  renderer.domElement.style.cursor = hit ? 'pointer' : '';
  hud.tooltip(hit ? `${hit.name}  ·  ${hit.kind}` : null, e.clientX, e.clientY);
});
renderer.domElement.addEventListener('pointerleave', () => hud.tooltip(null));
function pickAt(x: number, y: number) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return active.pick(ray, camera);
}
renderer.domElement.addEventListener('wheel', () => { if (flight && !flight.locked) flight.stop(); }, { passive: true });
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input')) return;
  if (e.key === 'Escape') select(null);
  if (e.key === 'Tab') { e.preventDefault(); setMode(mode === 'flow' ? 'fly' : 'flow'); }
  if (e.key === '1') goToLayer('earth');
  if (e.key === '2') goToLayer('solar');
  if (e.key === '3') goToLayer('galaxy');
});

// ------------------------------------------------------------------------------------------ frame loop
const timer = new THREE.Timer();
let infoT = 0;
const tmp = new THREE.Vector3();
function frame(ts: number) {
  requestAnimationFrame(frame);
  timer.update(ts);
  const dt = Math.min(timer.getDelta(), 0.1);
  shared.uTime.value += dt;
  clock.tick(dt);
  active.update({ clock, dt, camera, selected });

  if (selected && following && !flight && mode === 'flow') {
    selected.position(tmp);
    const delta = tmp.clone().sub(lastSelPos);
    if (delta.lengthSq() > 0) rig.follow(delta);
    lastSelPos.copy(tmp);
  } else if (selected) selected.position(lastSelPos);

  rig.update(dt, active.flySpeed(camera.position));
  checkHandoff();

  composer.render();
  labelSets[active.id].update(camera, innerWidth, innerHeight);

  if (ts - infoT > 250) {
    infoT = ts;
    if (selected) hud.refreshInfo(selected.info());
    if (active.id === 'galaxy') hud.setTime(`${clock.myr >= 0 ? '+' : ''}${clock.myr.toFixed(1)} Myr`, 'galactic time from today', clock.myr === 0);
    else {
      const d = clock.date;
      hud.setTime(d.toISOString().slice(11, 19) + ' UTC', d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }), clock.isLive);
    }
  }
}

// ------------------------------------------------------------------------------------------ boot
async function boot() {
  hud.loading('Reading the sky', 5);
  const [mw, stars, constellations] = await Promise.all([
    texture('milkyway.jpg'), json<StarsData>('stars.json'), json<number[][][]>('constellations.json'),
  ]);
  const sky = new Sky(mw, stars, constellations);
  [events, launches] = await Promise.all([loadEvents(), loadLaunches()]);

  for (const id of ['earth', 'solar', 'galaxy'] as LayerId[]) labelSets[id] = new Labels(labelHost);
  const earth = new EarthLayer(sky, labelSets.earth);
  const solar = new SolarLayer(sky, labelSets.solar);
  const galaxy = new GalaxyLayer(labelSets.galaxy);
  Object.assign(layers, { earth, solar, galaxy });
  for (const l of [earth, solar, galaxy]) l.onPick = (s: Selectable) => select(s, true);

  await earth.load((m) => hud.loading(m, 40));
  ready.earth = true;
  hud.loading('Propagating satellites', 85);
  activate(earth);
  earth.update({ clock, dt: 0, camera, selected: null });
  const h = earth.home();
  camera.position.copy(h.position).multiplyScalar(3.2);
  rig.orbit.target.copy(h.target);
  camera.lookAt(h.target);
  setMode('flow');
  requestAnimationFrame(frame);
  hud.loading(null);
  hud.intro();
  flyTo(null, h.position.length(), 3200, h.target, h.position.clone().normalize());

  // The bigger scales stream in behind the scenes
  solar.load().then(() => { ready.solar = true; refreshNav(); }).catch((e) => hud.toast('Solar System failed: ' + e.message));
  galaxy.load().then(() => { ready.galaxy = true; refreshNav(); }).catch((e) => hud.toast('Milky Way failed: ' + e.message));
}

boot().catch((e) => {
  console.error(e);
  hud.loading(`Could not load data: ${e.message}`);
});

if (import.meta.env.DEV) Object.assign(window, { __app: { get flight() { return flight; }, get transitioning() { return transitioning; }, layers, camera, rig, clock, select: (s: Selectable | null) => select(s, true), goToLayer, search, setMode } });
