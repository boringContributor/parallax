import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';
import { AU_KM, D2R, EQ_TO_ECL, toThree, formatDistance } from '../core/astro';
import { material, V_PARS, V_END, F_PARS, F_START } from '../core/shaders';
import { json, f32, texture, type MissionsData, type MissionTrack } from '../core/data';
import { MISSIONS } from '../core/missions';
import { sampleTrack, trackRange } from '../core/track';
import { sunGlow, ringTexture } from '../core/fx';
import { missionCard } from './earth';
import type { Layer, Selectable, Toggle, FrameCtx } from '../core/types';
import type { Labels } from '../core/labels';
import type { Sky } from './sky';

export const AU = 100; // scene units per AU
const J2000 = 2451545.0;

interface PlanetDef {
  name: string; body: Astronomy.Body; km: number; tex: string; color: string; pole: [number, number]; rotH: number; periodD: number;
}
const PLANETS: PlanetDef[] = [
  { name: 'Mercury', body: Astronomy.Body.Mercury, km: 2439.7, tex: 'mercury.jpg', color: '#b9b0a6', pole: [281.01, 61.41], rotH: 1407.6, periodD: 87.969 },
  { name: 'Venus', body: Astronomy.Body.Venus, km: 6051.8, tex: 'venus.jpg', color: '#e8cf9a', pole: [272.76, 67.16], rotH: -5832.5, periodD: 224.701 },
  { name: 'Earth', body: Astronomy.Body.Earth, km: 6371, tex: 'earth_day.jpg', color: '#6fb6ff', pole: [0, 90], rotH: 23.934, periodD: 365.256 },
  { name: 'Mars', body: Astronomy.Body.Mars, km: 3389.5, tex: 'mars.jpg', color: '#e27b58', pole: [317.68, 52.89], rotH: 24.623, periodD: 686.98 },
  { name: 'Jupiter', body: Astronomy.Body.Jupiter, km: 69911, tex: 'jupiter.jpg', color: '#d8b38a', pole: [268.05, 64.49], rotH: 9.925, periodD: 4332.59 },
  { name: 'Saturn', body: Astronomy.Body.Saturn, km: 58232, tex: 'saturn.jpg', color: '#e3cf9b', pole: [40.59, 83.54], rotH: 10.656, periodD: 10759.22 },
  { name: 'Uranus', body: Astronomy.Body.Uranus, km: 25362, tex: 'uranus.jpg', color: '#9fe3e8', pole: [257.31, -15.18], rotH: -17.24, periodD: 30688.5 },
  { name: 'Neptune', body: Astronomy.Body.Neptune, km: 24622, tex: 'neptune.jpg', color: '#6c8cff', pole: [299.36, 43.46], rotH: 16.11, periodD: 60182 },
  { name: 'Pluto', body: Astronomy.Body.Pluto, km: 1188.3, tex: 'moon.jpg', color: '#cdb8a0', pole: [132.99, -6.16], rotH: -153.3, periodD: 90560 },
];
const displayRadius = (km: number) => 0.35 * Math.pow(km / 6371, 0.45);
const SUN_R = 2.4;

/** Helio ecliptic J2000 position (AU → scene) via astronomy-engine (VSOP87). */
function helio(body: Astronomy.Body, date: Date, out = new THREE.Vector3()) {
  const v = Astronomy.RotateVector(Astronomy.Rotation_EQJ_ECL(), Astronomy.HelioVector(body, date));
  return toThree(v.x * AU, v.y * AU, v.z * AU, out);
}

const ASTEROID_CLASSES: Record<string, { label: string; color: string; codes: number[] }> = {
  belt: { label: 'Main belt asteroids', color: '#b8a58b', codes: [0, 1, 2, 3, 11] },
  trojans: { label: 'Jupiter Trojans', color: '#7fdc8a', codes: [4] },
  neo: { label: 'Near-Earth asteroids', color: '#ff8a5c', codes: [7, 8, 9, 10] },
  outer: { label: 'Centaurs & trans-Neptunian', color: '#8fb8ff', codes: [5, 6] },
};

export class SolarLayer implements Layer {
  id = 'solar' as const;
  label = 'Solar System';
  scene = new THREE.Scene();
  minDistance = 0.3;
  maxDistance = 90000;
  speeds: [string, number][] = [['1 day/s', 86400], ['1 week/s', 604800], ['1 month/s', 2629800], ['1 year/s', 31557600]];
  toggles: Toggle[] = [];
  anchor!: Selectable;
  onPick?: (s: Selectable) => void;

  private planets: { def: PlanetDef; group: THREE.Group; mesh: THREE.Mesh; r: number; pos: THREE.Vector3; orbit: THREE.Line; t0: number; sel: Selectable }[] = [];
  private moon!: THREE.Mesh;
  private craft: { id: string; track: MissionTrack; pos: THREE.Vector3; ok: boolean; marker: THREE.Sprite; line: THREE.Line; sel: Selectable }[] = [];
  private craftGroup = new THREE.Group();
  private orbitGroup = new THREE.Group();
  private asteroidPoints!: THREE.Points;
  private asteroidData!: Float32Array;
  private asteroidVisible: Record<string, boolean> = { belt: true, trojans: true, neo: true, outer: true };
  private asteroidMask = { value: new THREE.Vector4(1, 1, 1, 1) };
  private astDays = { value: 0 };
  private namedAsteroids: Selectable[] = [];
  private helioGroup = new THREE.Group();
  private sunMat!: THREE.ShaderMaterial;
  private selectables_: Selectable[] = [];
  private jdU = { value: 0 };
  private sunGain = { value: 1 };
  private sunGlowSprite!: THREE.Sprite;
  currentDate = new Date();

  constructor(private sky: Sky, private labels: Labels) {}

  async load(progress?: (m: string) => void) {
    progress?.('Planet textures');
    await this.buildSun();
    await this.buildPlanets();
    progress?.('Spacecraft trajectories (JPL Horizons)');
    const missions = await json<MissionsData>('missions.json').catch(() => null);
    if (missions) this.buildSpacecraft(missions);
    progress?.('Asteroid orbits (JPL SBDB)');
    await this.buildAsteroids().catch((e) => console.warn('asteroids', e));
    this.buildScaleGuides();
    this.buildToggles();
    this.scene.add(this.orbitGroup, this.craftGroup, this.helioGroup, new THREE.AmbientLight(0xffffff, 0.035));
  }

  private async buildSun() {
    const tex = await texture('sun.jpg');
    this.sunMat = material({
      transparent: false, depthWrite: true,
      uniforms: { uMap: { value: tex }, uGain: this.sunGain },
      vertexShader: /* glsl */ `${V_PARS}
        varying vec2 vUv; varying vec3 vN; varying vec3 vW;
        void main() { vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w; ${V_END} }`,
      fragmentShader: /* glsl */ `${F_PARS}
        uniform sampler2D uMap; uniform float uGain; varying vec2 vUv; varying vec3 vN; varying vec3 vW;
        void main() {
          ${F_START}
          vec2 uv = vUv + 0.004 * vec2(sin(vUv.y * 60.0 + uTime * 0.7), cos(vUv.x * 80.0 - uTime * 0.5));
          vec3 c = texture2D(uMap, uv).rgb;
          float mu = max(dot(normalize(vN), normalize(cameraPosition - vW)), 0.0);
          float limb = 0.45 + 0.55 * pow(mu, 0.6);                       // limb darkening
          gl_FragColor = vec4(c * vec3(1.9, 1.45, 1.0) * limb * 2.2 * uGain, 1.0);
        }`,
    });
    const sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 96, 48), this.sunMat);
    const glow = this.sunGlowSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunGlow(), blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(2.2, 1.9, 1.5) }));
    glow.scale.setScalar(SUN_R * 22);
    this.scene.add(sun, glow, new THREE.PointLight(0xfff4e6, 3.2, 0, 0));
    this.labels.occluders.push({ center: new THREE.Vector3(), radius: SUN_R });
    this.anchor = {
      id: 'sun', name: 'Sun', kind: 'star', layer: 'solar', radius: SUN_R,
      position: (o) => o.set(0, 0, 0),
      info: () => ({ kicker: 'G2V star', title: 'Sun', color: '#ffcf70', rows: [['Radius', '696,000 km (shown ×5)'], ['Distance to galactic centre', '≈ 26,500 ly']], body: 'Planet sizes are exaggerated so they stay visible; all distances and positions are real.' }),
    };
    this.selectables_.push(this.anchor);
    this.labels.add({ text: 'Sun', cls: 'body', position: (o) => o.set(0, 0, 0), near: 40, onClick: () => this.onPick?.(this.anchor) });
  }

  private async buildPlanets() {
    const now = new Date();
    for (const def of PLANETS) {
      const r = displayRadius(def.km);
      const tex = await texture(def.tex);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
      if (def.name === 'Pluto') mat.color.set('#e8d0b8');
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 32), mat);
      const group = new THREE.Group();
      const [ra, dec] = def.pole;
      const eq = new THREE.Vector3(Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)).applyMatrix3(EQ_TO_ECL);
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toThree(eq.x, eq.y, eq.z).normalize());
      group.add(mesh);
      if (def.name === 'Saturn') group.add(await this.saturnRings(r));
      if (def.name === 'Earth') {
        this.moon = new THREE.Mesh(new THREE.SphereGeometry(r * 0.27, 32, 16), new THREE.MeshStandardMaterial({ map: await texture('moon.jpg'), roughness: 1 }));
        this.scene.add(this.moon);
      }
      this.scene.add(group);

      // Orbit: one full period sampled once; the fading trail is animated in the shader via orbital phase.
      const N = 540, pts: number[] = [], phase: number[] = [], v = new THREE.Vector3();
      const t0 = now.getTime();
      for (let k = 0; k <= N; k++) {
        helio(def.body, new Date(t0 + (k / N) * def.periodD * 864e5), v);
        pts.push(v.x, v.y, v.z);
        phase.push(k / N);
      }
      const og = new THREE.BufferGeometry();
      og.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      og.setAttribute('phase', new THREE.Float32BufferAttribute(phase, 1));
      const orbit = new THREE.Line(og, material({
        blending: THREE.AdditiveBlending,
        uniforms: { uColor: { value: new THREE.Color(def.color) }, uPhase: { value: 0 } },
        vertexShader: /* glsl */ `${V_PARS} attribute float phase; varying float vP;
          void main() { vP = phase; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${V_END} }`,
        fragmentShader: /* glsl */ `${F_PARS} uniform vec3 uColor; uniform float uPhase; varying float vP;
          void main() { ${F_START} float age = fract(uPhase - vP); float a = 0.10 + 0.75 * pow(1.0 - age, 3.0);
            gl_FragColor = vec4(uColor * a, 1.0); }`,
      }));
      orbit.frustumCulled = false;
      this.orbitGroup.add(orbit);

      const pos = group.position;
      const entry = {
        def, group, mesh, r, pos, orbit, t0,
        sel: {
          id: 'planet:' + def.name, name: def.name, kind: def.name === 'Pluto' ? 'dwarf planet' : 'planet', layer: 'solar' as const, radius: r,
          position: (o: THREE.Vector3) => o.copy(pos),
          info: () => {
            const au = pos.length() / AU;
            const e = helio(Astronomy.Body.Earth, this.currentDate);
            return {
              kicker: def.name === 'Pluto' ? 'Dwarf planet' : 'Planet', title: def.name, color: def.color,
              rows: [
                ['Distance from Sun', `${au.toFixed(3)} AU`],
                ...(def.name !== 'Earth' ? [['Distance from Earth', formatDistance(pos.distanceTo(e) / AU * AU_KM)] as [string, string]] : []),
                ['Orbital period', def.periodD > 1000 ? `${(def.periodD / 365.25).toFixed(1)} years` : `${def.periodD.toFixed(1)} days`],
                ['Radius', `${def.km.toLocaleString('en-US')} km`],
                ['Light travel time', `${(au * 499 / 60).toFixed(1)} min from the Sun`],
              ],
              body: def.name === 'Earth' ? 'Zoom in to drop into Earth orbit and see every tracked satellite.' : undefined,
            };
          },
        } as Selectable,
      };
      this.planets.push(entry);
      this.selectables_.push(entry.sel);
      if (def.name === 'Earth') this.earthSel = entry.sel;
      this.labels.add({ text: def.name, cls: 'body', color: def.color, position: (o) => o.copy(pos), near: r * 4, onClick: () => this.onPick?.(entry.sel) });
    }
  }
  earthSel!: Selectable;

  private async saturnRings(r: number) {
    const tex = await texture('saturn_ring.png');
    const inner = r * 1.24, outer = r * 2.27;
    const g = new THREE.RingGeometry(inner, outer, 128, 1);
    const uv = g.attributes.uv as THREE.BufferAttribute, p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const d = Math.hypot(p.getX(i), p.getY(i));
      uv.setXY(i, (d - inner) / (outer - inner), 0.5);
    }
    const ring = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, roughness: 1, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    return ring;
  }

  private buildSpacecraft(m: MissionsData) {
    const tex = ringTexture();
    for (const [id, track] of Object.entries(m.helio)) {
      const meta = MISSIONS[id];
      const color = new THREE.Color(meta?.color || '#ffffff');
      const pts: number[] = [], jds: number[] = [];
      for (let k = 0; k < track.xyz.length; k += 3) {
        const v = toThree(track.xyz[k] * AU, track.xyz[k + 1] * AU, track.xyz[k + 2] * AU);
        pts.push(v.x, v.y, v.z);
        jds.push(track.jd0 + (k / 3) * track.step - J2000);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      g.setAttribute('jd', new THREE.Float32BufferAttribute(jds, 1));
      const line = new THREE.Line(g, material({
        blending: THREE.AdditiveBlending,
        uniforms: { uColor: { value: color }, uJd: this.jdU },
        vertexShader: /* glsl */ `${V_PARS} attribute float jd; varying float vJd;
          void main() { vJd = jd; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${V_END} }`,
        fragmentShader: /* glsl */ `${F_PARS} uniform vec3 uColor; uniform float uJd; varying float vJd;
          void main() { ${F_START}
            float dt = vJd - uJd;                                   // days relative to now
            float a = dt < 0.0 ? 0.12 + 0.75 * exp(dt / 120.0)       // past: bright, fading with age
                               : 0.28 * step(0.45, fract(vJd / 6.0)); // future: dashed
            gl_FragColor = vec4(uColor * a, 1.0); }`,
      }));
      line.frustumCulled = false;
      const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, sizeAttenuation: false, depthWrite: false, transparent: true }));
      marker.scale.setScalar(0.02);
      this.craftGroup.add(line, marker);
      const pos = marker.position;
      const [a, b] = trackRange(track);
      const entry = {
        id, track, pos, ok: false, marker, line,
        sel: {
          id: 'mission:' + id, name: meta?.short || track.name, kind: 'mission', layer: 'solar' as const, radius: 1.5, keywords: track.name,
          position: (o: THREE.Vector3) => o.copy(pos),
          info: () => {
            const raw: [number, number, number] = [0, 0, 0];
            const ok = sampleTrack(track, Astronomy.MakeTime(this.currentDate).ut + J2000, raw);
            const au = Math.hypot(...raw);
            const e = helio(Astronomy.Body.Earth, this.currentDate).divideScalar(AU);
            const fromEarth = Math.hypot(raw[0] - e.x, raw[1] - -e.z, raw[2] - e.y) * AU_KM;
            const speed = this.speedKmS(track);
            return missionCard(id, track.name, ok ? [
              ['Distance from Sun', `${au.toFixed(au > 10 ? 1 : 3)} AU`],
              ['Distance from Earth', formatDistance(fromEarth)],
              ['Heliocentric speed', `${speed.toFixed(1)} km/s`],
              ['Signal delay (one way)', lightTime(fromEarth)],
              ['Ephemeris window', `${fmtJd(a)} → ${fmtJd(b)}`],
            ] : [['Ephemeris window', `${fmtJd(a)} → ${fmtJd(b)} (outside current time)`]]);
          },
        } as Selectable,
      };
      this.craft.push(entry);
      this.selectables_.push(entry.sel);
      this.labels.add({ text: meta?.short || track.name, cls: 'mission', color: meta?.color, position: (o) => o.copy(pos), visible: () => entry.ok && this.craftGroup.visible, onClick: () => this.onPick?.(entry.sel) });
    }
  }

  private speedKmS(track: MissionTrack) {
    const jd = Astronomy.MakeTime(this.currentDate).ut + J2000;
    const a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [0, 0, 0];
    if (!sampleTrack(track, jd - 0.5, a) || !sampleTrack(track, jd + 0.5, b)) return 0;
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * AU_KM / 86400;
  }

  private async buildAsteroids() {
    const [data, meta] = await Promise.all([f32('asteroids.bin'), json<{ classes: string[]; names: [number, string][] }>('asteroids-meta.json')]);
    this.asteroidData = data;
    const n = data.length / 9;
    const g = new THREE.BufferGeometry();
    // a, e, i | Ω, ω, M0 | epoch, H, class+flags
    const el0 = new Float32Array(n * 3), el1 = new Float32Array(n * 3), el2 = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      el0.set([data[k * 9], data[k * 9 + 1], data[k * 9 + 2]], k * 3);
      el1.set([data[k * 9 + 3], data[k * 9 + 4], data[k * 9 + 5]], k * 3);
      el2.set([data[k * 9 + 6], data[k * 9 + 7], data[k * 9 + 8]], k * 3);
    }
    g.setAttribute('position', new THREE.BufferAttribute(el0, 3)); // a,e,i (not a position; shader computes one)
    g.setAttribute('el1', new THREE.BufferAttribute(el1, 3));
    g.setAttribute('el2', new THREE.BufferAttribute(el2, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.asteroidPoints = new THREE.Points(g, material({
      blending: THREE.AdditiveBlending,
      uniforms: { uDays: this.astDays, uAU: { value: AU }, uMask: this.asteroidMask },
      vertexShader: /* glsl */ `${V_PARS}
        attribute vec3 el1; attribute vec3 el2;
        uniform float uDays, uAU; uniform vec4 uMask;
        varying vec3 vColor; varying float vA;
        const float K = 0.01720209895; // Gaussian gravitational constant (rad/day, AU^1.5)
        void main() {
          float a = position.x, e = position.y, inc = radians(position.z);
          float om = radians(el1.x), w = radians(el1.y);
          float M = mod(radians(el1.z) + K * pow(a, -1.5) * (uDays - el2.x), 6.2831853);
          float E = e < 0.8 ? M : 3.14159265;
          for (int k = 0; k < 8; k++) E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
          vec2 pq = vec2(a * (cos(E) - e), a * sqrt(1.0 - e * e) * sin(E));
          float co = cos(om), so = sin(om), ci = cos(inc), si = sin(inc), cw = cos(w), sw = sin(w);
          vec3 P = vec3(co * cw - so * sw * ci, so * cw + co * sw * ci, sw * si);
          vec3 Q = vec3(-co * sw - so * cw * ci, -so * sw + co * cw * ci, cw * si);
          vec3 r = (P * pq.x + Q * pq.y) * uAU;                  // ecliptic J2000
          vec4 mv = modelViewMatrix * vec4(r.x, r.z, -r.y, 1.0);   // → three.js (Y up)
          gl_Position = projectionMatrix * mv;
          float code = el2.z; float cls = mod(code, 16.0); float flags = floor(code / 16.0);
          bool neo = cls >= 7.0 && cls <= 10.0, tro = cls == 4.0, outer = cls == 5.0 || cls == 6.0;
          float vis = neo ? uMask.z : tro ? uMask.y : outer ? uMask.w : uMask.x;
          vColor = neo ? (mod(flags, 4.0) >= 2.0 ? vec3(1.0, 0.25, 0.2) : vec3(1.0, 0.55, 0.32))
                 : tro ? vec3(0.45, 0.9, 0.52) : outer ? vec3(0.55, 0.72, 1.0) : vec3(0.78, 0.7, 0.58);
          float bright = clamp((17.0 - el2.y) / 10.0, 0.15, 1.0);
          vA = vis * (neo ? 0.8 : 0.1 + 0.3 * bright);
          gl_PointSize = (neo ? 2.0 : 1.0 + 1.3 * bright) * uPixelRatio * step(0.5, vis);
          ${V_END}
        }`,
      fragmentShader: /* glsl */ `${F_PARS} varying vec3 vColor; varying float vA;
        void main() { ${F_START} vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0 || vA <= 0.0) discard;
          gl_FragColor = vec4(vColor * vA * (1.0 - r2), 1.0); }`,
    }));
    this.asteroidPoints.frustumCulled = false;
    this.scene.add(this.asteroidPoints);

    // Named ones (bright + potentially hazardous) are searchable; CPU Kepler for their positions
    for (const [k, full] of meta.names) {
      const name = full.replace(/^\d+\s+/, '').replace(/\s*\(.*\)$/, '') || full;
      const cls = meta.classes[data[k * 9 + 8] % 16] || 'AST';
      const pha = Math.floor(data[k * 9 + 8] / 16) & 2;
      const sel: Selectable = {
        id: 'ast:' + k, name, kind: 'asteroid', layer: 'solar', radius: 0.5, keywords: full + (pha ? ' PHA hazardous' : ''),
        position: (o) => this.asteroidPos(k, o),
        info: () => {
          const a = data[k * 9], e = data[k * 9 + 1], i = data[k * 9 + 2], H = data[k * 9 + 7];
          const p = this.asteroidPos(k, new THREE.Vector3());
          const earth = helio(Astronomy.Body.Earth, this.currentDate);
          return {
            kicker: `${classLabel(cls)}${pha ? ' · potentially hazardous' : ''}`, title: full.trim(), color: pha ? '#ff4136' : '#d8c3a5',
            rows: [
              ['Semi-major axis', `${a.toFixed(3)} AU`], ['Eccentricity', e.toFixed(3)], ['Inclination', `${i.toFixed(2)}°`],
              ['Period', `${Math.pow(a, 1.5).toFixed(2)} years`], ['Absolute magnitude H', H.toFixed(2)],
              ['Distance from Earth', formatDistance(p.distanceTo(earth) / AU * AU_KM)],
            ],
            link: { label: 'JPL Small-Body Database', url: `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${encodeURIComponent(name)}` },
          };
        },
      };
      this.namedAsteroids.push(sel);
      if (data[k * 9 + 7] < 5.5) this.labels.add({ text: name, cls: 'minor', position: (o) => sel.position(o), far: 900, visible: () => this.asteroidVisible.belt, onClick: () => this.onPick?.(sel) });
    }
  }

  private asteroidPos(k: number, out: THREE.Vector3) {
    const d = this.asteroidData;
    const a = d[k * 9], e = d[k * 9 + 1], inc = d[k * 9 + 2] * D2R, om = d[k * 9 + 3] * D2R, w = d[k * 9 + 4] * D2R;
    const M = (d[k * 9 + 5] * D2R + 0.01720209895 * Math.pow(a, -1.5) * (this.astDays.value - d[k * 9 + 6])) % (2 * Math.PI);
    let E = e < 0.8 ? M : Math.PI;
    for (let j = 0; j < 12; j++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const x = a * (Math.cos(E) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const co = Math.cos(om), so = Math.sin(om), ci = Math.cos(inc), si = Math.sin(inc), cw = Math.cos(w), sw = Math.sin(w);
    const X = (co * cw - so * sw * ci) * x + (-co * sw - so * cw * ci) * y;
    const Y = (so * cw + co * sw * ci) * x + (-so * sw + co * cw * ci) * y;
    const Z = sw * si * x + cw * si * y;
    return toThree(X * AU, Y * AU, Z * AU, out);
  }

  private buildScaleGuides() {
    // Ecliptic distance rings + heliopause
    for (const au of [1, 5, 10, 30, 50, 100]) {
      const pts: number[] = [];
      for (let k = 0; k <= 256; k++) { const a = (k / 256) * Math.PI * 2; pts.push(Math.cos(a) * au * AU, 0, Math.sin(a) * au * AU); }
      const ring = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
        new THREE.LineBasicMaterial({ color: 0x3a5078, transparent: true, opacity: 0.22, depthWrite: false }));
      this.helioGroup.add(ring);
      this.labels.add({ text: `${au} AU`, cls: 'scale', position: (o) => o.set(au * AU * 0.7071, 0, au * AU * 0.7071), near: au * AU * 0.3, far: au * AU * 12, visible: () => this.helioGroup.visible });
    }
    const hp = new THREE.Mesh(new THREE.SphereGeometry(120 * AU, 64, 32), material({
      side: THREE.BackSide, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `${V_PARS} varying vec3 vN; varying vec3 vW;
        void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; ${V_END} }`,
      fragmentShader: /* glsl */ `${F_PARS} varying vec3 vN; varying vec3 vW;
        void main() { ${F_START} float f = pow(1.0 - abs(dot(normalize(vN), normalize(cameraPosition - vW))), 4.0);
          gl_FragColor = vec4(vec3(0.25, 0.45, 0.9) * f * 0.35, 1.0); }`,
    }));
    this.helioGroup.add(hp);
    this.labels.add({ text: 'Heliopause', sub: '≈120 AU · edge of the solar wind', cls: 'scale', position: (o) => o.set(0, 120 * AU * 0.5, 120 * AU * 0.866), near: 3000, visible: () => this.helioGroup.visible });
  }

  private buildToggles() {
    const n = this.asteroidData ? this.asteroidData.length / 9 : 0;
    const counts: Record<string, number> = { belt: 0, trojans: 0, neo: 0, outer: 0 };
    for (let k = 0; k < n; k++) {
      const c = this.asteroidData[k * 9 + 8] % 16;
      for (const [key, def] of Object.entries(ASTEROID_CLASSES)) if (def.codes.includes(c)) counts[key]++;
    }
    const keys = ['belt', 'trojans', 'neo', 'outer'];
    this.toggles = [
      { id: 'craft', label: 'Active missions', color: '#ffd166', count: this.craft.length, value: true, set: (v) => (this.craftGroup.visible = v) },
      { id: 'orbits', label: 'Planet orbits', color: '#6fb6ff', value: true, set: (v) => (this.orbitGroup.visible = v) },
      ...keys.map((key, idx) => ({
        id: key, label: ASTEROID_CLASSES[key].label, color: ASTEROID_CLASSES[key].color, count: counts[key], value: true,
        set: (v: boolean) => { this.asteroidVisible[key] = v; this.asteroidMask.value.setComponent(idx, v ? 1 : 0); },
      })),
      { id: 'guides', label: 'Distance rings & heliopause', value: true, set: (v) => (this.helioGroup.visible = v) },
      { id: 'const', label: 'Constellation figures', value: false, set: (v) => (this.sky.lines.visible = v) },
    ];
  }

  update({ clock, camera }: FrameCtx) {
    const date = clock.date;
    // A sub-pixel HDR Sun would bloom into a giant halo from the outer system: tame it with distance
    const dSun = camera.position.length();
    this.sunGain.value = THREE.MathUtils.lerp(1, 0.18, THREE.MathUtils.smoothstep(dSun, 300, 6000));
    this.sunGlowSprite.material.opacity = THREE.MathUtils.lerp(1, 0.35, THREE.MathUtils.smoothstep(dSun, 300, 6000));
    this.currentDate = date;
    const time = Astronomy.MakeTime(date);
    const days = time.tt; // days since J2000 (TT)
    this.astDays.value = days;
    this.jdU.value = time.ut;
    for (const p of this.planets) {
      helio(p.def.body, date, p.pos);
      p.mesh.rotation.y = ((clock.ms / 36e5) / p.def.rotH) * Math.PI * 2 % (Math.PI * 2);
      const ph = ((clock.ms - p.t0) / 864e5) / p.def.periodD;
      (p.orbit.material as THREE.ShaderMaterial).uniforms.uPhase.value = ((ph % 1) + 1) % 1;
      if (p.def.name === 'Earth') {
        const m = Astronomy.RotateVector(Astronomy.Rotation_EQJ_ECL(), Astronomy.GeoMoon(time));
        this.moon.position.copy(toThree(m.x, m.y, m.z).normalize().multiplyScalar(p.r * 3.2)).add(p.pos);
      }
    }
    const jd = time.ut + J2000;
    const raw: [number, number, number] = [0, 0, 0];
    for (const c of this.craft) {
      c.ok = sampleTrack(c.track, jd, raw);
      c.marker.visible = c.ok;
      if (!c.ok) continue;
      toThree(raw[0] * AU, raw[1] * AU, raw[2] * AU, c.pos);
      // Craft orbiting a planet would hide inside its (exaggerated) sphere → push them just outside
      for (const p of this.planets) {
        const d = c.pos.distanceTo(p.pos);
        if (d < p.r * 1.8) {
          if (d < 1e-6) c.pos.set(0, 1, 0); else c.pos.sub(p.pos);
          c.pos.setLength(p.r * 1.8).add(p.pos);
          break;
        }
      }
    }
  }

  pick(ray: THREE.Raycaster): Selectable | null {
    const v = new THREE.Vector3();
    let best: Selectable | null = null, bestScore = 0.015;
    const candidates = [...this.selectables_, ...(this.asteroidVisible.belt || this.asteroidVisible.neo ? this.namedAsteroids : [])];
    for (const s of candidates) {
      if (s.kind === 'mission' && !this.craftGroup.visible) continue;
      s.position(v);
      const dist = v.distanceTo(ray.ray.origin);
      const ang = ray.ray.distanceToPoint(v) / dist;
      const lim = Math.max(s.kind === 'asteroid' ? 0.006 : 0.015, s.kind === 'planet' || s.kind === 'star' ? (s.radius * 1.2) / dist : 0);
      const score = ang / lim * 0.015;
      if (ang < lim && score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  selectables() {
    return [...this.selectables_, ...this.namedAsteroids];
  }

  home() {
    return { position: new THREE.Vector3(-380, 620, 900), target: new THREE.Vector3() };
  }

  flySpeed(pos: THREE.Vector3) {
    let d = pos.length();
    for (const p of this.planets) d = Math.min(d, pos.distanceTo(p.pos));
    return Math.max(0.5, d * 0.5);
  }

  onEnter() {
    this.scene.add(this.sky.group);
    this.sky.setFrame(EQ_TO_ECL);
    this.sky.setBrightness(1);
  }
}

function classLabel(c: string) {
  return ({ MBA: 'Main-belt asteroid', IMB: 'Inner main belt', OMB: 'Outer main belt', MCA: 'Mars-crosser', TJN: 'Jupiter Trojan', TNO: 'Trans-Neptunian object', CEN: 'Centaur', APO: 'Apollo (Earth-crossing)', AMO: 'Amor (near-Earth)', ATE: 'Aten (Earth-crossing)', IEO: 'Atira (inside Earth’s orbit)' } as Record<string, string>)[c] || 'Asteroid';
}
function fmtJd(jd: number) {
  return new Date((jd - 2440587.5) * 864e5).toISOString().slice(0, 10);
}
function lightTime(km: number) {
  const s = km / 299792.458;
  return s < 120 ? `${s.toFixed(1)} s` : s < 7200 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`;
}
