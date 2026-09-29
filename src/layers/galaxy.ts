import * as THREE from 'three';
import { R0, Z_SUN, colorFromKelvin, colorFromBV, kelvinFromBpRp, mulberry32, gaussian, toThree } from '../core/astro';
import { material, V_PARS, V_END, F_PARS, F_START, SPRITE_FN, STAR_FRAG_FN } from '../core/shaders';
import { json, f32, type StarsData } from '../core/data';
import { glowTexture, ringTexture } from '../core/fx';
import type { Layer, Selectable, Toggle, FrameCtx } from '../core/types';
import type { Labels } from '../core/labels';

/*
 * Units: parsec. Frame: galactocentric (astropy): GC at origin, Sun at (-8122, 0, 20.8), rotation clockwise seen from the NGP.
 *
 * Spiral arms: global log-spiral fit (shared pitch 9.42°, rms 8 % in R) to the 132 arm-tagged maser parallaxes of
 * Reid et al. 2019, done for this project. ln(R/kpc) = c − tan(ψ)·β, β = galactocentric azimuth from the Sun, positive
 * in the direction of rotation. The Local (Orion) arm uses its own fit (ψ = 11.0°).
 */
const PITCH = Math.tan(9.42 * Math.PI / 180);
const ARMS = [
  { name: 'Perseus Arm', c: 2.3124, young: 1.0, old: 1.0, color: '#7fb2ff' },
  { name: 'Scutum–Centaurus Arm', c: 1.6635, young: 1.0, old: 1.0, color: '#ff9f6b' },
  { name: 'Sagittarius–Carina Arm', c: 1.9112, young: 0.9, old: 0.45, color: '#ffd36b' },
  { name: 'Norma–Outer Arm', c: 1.4821, young: 0.8, old: 0.45, color: '#c49bff' },
];
const LOCAL_ARM = { name: 'Local (Orion) Arm', c: 2.142, pitch: Math.tan(11.0 * Math.PI / 180), b0: -40, b1: 70 };
const MASER_ARM: Record<string, { label: string; color: string }> = {
  Per: { label: 'Perseus', color: '#7fb2ff' }, ScN: { label: 'Scutum–Centaurus', color: '#ff9f6b' }, ScF: { label: 'Scutum–Centaurus', color: '#ff9f6b' },
  CtN: { label: 'Scutum–Centaurus', color: '#ff9f6b' }, SgN: { label: 'Sagittarius–Carina', color: '#ffd36b' }, SgF: { label: 'Sagittarius–Carina', color: '#ffd36b' },
  Nor: { label: 'Norma', color: '#c49bff' }, Out: { label: 'Outer', color: '#c49bff' }, Loc: { label: 'Local (Orion)', color: '#7dffcf' },
  LoS: { label: 'Local spur', color: '#7dffcf' }, '3kN': { label: '3-kpc arm', color: '#ff7a7a' }, '3kF': { label: '3-kpc arm', color: '#ff7a7a' },
  GC: { label: 'Galactic centre', color: '#ffffff' }, AqS: { label: 'Aquila spur', color: '#aaaaaa' },
};

// Rotation: flat-ish curve, spiral pattern Ωp ≈ 28 km/s/kpc, bar Ωb ≈ 39 km/s/kpc (Portail+2017). 1 km/s ≈ 1.0227 pc/Myr.
const KMS = 1.0227;
const vc = (R: number) => 235 * (1 - Math.exp(-R / 1000));
const omega = (R: number) => (KMS * vc(R)) / Math.max(R, 1);
const OMEGA_P = 0.028 * KMS;
const OMEGA_B = 0.039 * KMS;
const OMEGA_SUN = omega(R0);
const BAR_ANGLE = 27 * Math.PI / 180; // near end at positive longitudes

const ROT_GLSL = /* glsl */ `
uniform float uMyr, uOmegaP, uOmegaB;
float omegaOf(float R) { return 1.0227 * 235.0 * (1.0 - exp(-R / 1000.0)) / max(R, 1.0); }
vec3 rotated(vec3 rpz, float kind) {
  float w = kind < 0.5 ? omegaOf(rpz.x) : kind < 1.5 ? uOmegaP : uOmegaB;
  float p = rpz.y - w * uMyr;
  return vec3(rpz.x * cos(p), rpz.z, -rpz.x * sin(p));
}`;

function rotPos(R: number, phi: number, z: number, kind: number, t: number, out: THREE.Vector3) {
  const w = kind === 0 ? omega(R) : kind === 1 ? OMEGA_P : OMEGA_B;
  const p = phi - w * t;
  return out.set(R * Math.cos(p), z, -R * Math.sin(p));
}
const polar = (x: number, y: number) => [Math.hypot(x, y), Math.atan2(y, x)] as const;

// ---------------------------------------------------------------------------------------------- potential for GC orbits
const G = 4.30091e-3; // pc (km/s)^2 / Msun
const BULGE = { GM: G * 1.0e10, a: 500 };
const DISK = { GM: G * 6.8e10, a: 3000, b: 280 };
const HALO_RS = 16000;
const HALO_GM = (() => {
  const R = R0, vb = (BULGE.GM * R) / (R + BULGE.a) ** 2;
  const D = Math.hypot(R, DISK.a + DISK.b);
  const vd = (DISK.GM * R * R) / D ** 3;
  const need = 233 * 233 - vb - vd;
  return need / (R * (Math.log(1 + R / HALO_RS) / (R * R) - 1 / (R * (HALO_RS + R))));
})();
function accel(x: number, y: number, z: number, out: number[]) {
  const r = Math.hypot(x, y, z) + 1e-6, R2 = x * x + y * y;
  const fb = -BULGE.GM / ((r + BULGE.a) ** 2 * r);
  const s = Math.hypot(z, DISK.b), D3 = (R2 + (DISK.a + s) ** 2) ** 1.5;
  const fdR = -DISK.GM / D3, fdz = (-DISK.GM * (DISK.a + s)) / (s * D3);
  const fh = -HALO_GM * (Math.log(1 + r / HALO_RS) / (r * r) - 1 / (r * (HALO_RS + r))) / r;
  out[0] = (fb + fh + fdR) * x;
  out[1] = (fb + fh + fdR) * y;
  out[2] = (fb + fh) * z + fdz * z;
}

export class GalaxyLayer implements Layer {
  id = 'galaxy' as const;
  label = 'Milky Way';
  scene = new THREE.Scene();
  minDistance = 0.02;
  maxDistance = 180000;
  speeds: [string, number][] = [['0.5 Myr/s', 0.5], ['2 Myr/s', 2], ['10 Myr/s', 10]];
  toggles: Toggle[] = [];
  anchor!: Selectable;
  onPick?: (s: Selectable) => void;

  private u = { uMyr: { value: 0 }, uOmegaP: { value: OMEGA_P }, uOmegaB: { value: OMEGA_B } };
  private modelStars!: THREE.Points;
  private dust!: THREE.Points;
  private glow!: THREE.Mesh;
  private neighbourhood = new THREE.Group(); // Sun + Gaia + named stars: co-rotates with the Sun
  private gaia!: THREE.Points;
  private clusters!: THREE.Points;
  private clusterData: { name: string; R: number; phi: number; z: number; age: number; members: number; dist: number; r50: number }[] = [];
  private masers!: THREE.Points;
  private maserData: { name: string; alias: string; R: number; phi: number; z: number; arm: string; dist: number; err: number }[] = [];
  private gcs!: THREE.Points;
  private gcData: { name: string; orbit: Float32Array; dist: number; rperi: number; rapo: number }[] = [];
  private gcOrbits = new THREE.Group();
  private guides = new THREE.Group();
  private selectables_: Selectable[] = [];
  private myr = 0;
  private gaiaExposure = { value: 1 };
  private readonly T_ORBIT = 1200; // Myr of integrated GC orbit
  private readonly ORBIT_DT = 1; // Myr per stored sample

  constructor(private labels: Labels) {}

  async load(progress?: (m: string) => void) {
    progress?.('Building the Milky Way model');
    this.buildModel();
    this.buildGlow();
    progress?.('Gaia DR3 neighbourhood');
    const [gaia, stars, clusters, masers, gcs] = await Promise.all([
      f32('gaia.bin'), json<StarsData>('stars.json'),
      json<{ clusters: [string, number, number, number, number, number, number, number][] }>('clusters.json'),
      json<{ masers: [string, string, number, number, number, string, number, number][] }>('masers.json'),
      json<{ gcs: [string, number, number, number, number, number, number, number][] }>('globulars.json'),
    ]);
    this.buildNeighbourhood(gaia, stars);
    this.buildClusters(clusters.clusters);
    this.buildMasers(masers.masers);
    progress?.('Integrating globular cluster orbits');
    this.buildGlobulars(gcs.gcs);
    this.buildGuides();
    this.buildToggles();
  }

  // ------------------------------------------------------------------------------------------ procedural model
  private buildModel() {
    const rand = mulberry32(20190131);
    const P: number[] = [], C: number[] = [], S: number[] = [], K: number[] = [], I: number[] = [];
    const Pd: number[] = [], Cd: number[] = [], Sd: number[] = [], Kd: number[] = [], Id: number[] = [];
    const col = new THREE.Color();
    const push = (x: number, y: number, z: number, kind: number, c: THREE.Color, size: number, inten: number, dust = false) => {
      const [R, phi] = polar(x, y);
      (dust ? Pd : P).push(R, phi, z);
      (dust ? Cd : C).push(c.r, c.g, c.b);
      (dust ? Sd : S).push(size);
      (dust ? Kd : K).push(kind);
      (dust ? Id : I).push(inten);
    };
    const laplace = (s: number) => (rand() < 0.5 ? -1 : 1) * -Math.log(1 - rand()) * s;
    const armXY = (c: number, pitch: number, beta: number, dR: number) => {
      const R = Math.exp(c - pitch * beta) * 1000 + dR;
      return [-R * Math.cos(beta), R * Math.sin(beta), R] as const;
    };
    const betaAt = (c: number, R: number) => (c - Math.log(R / 1000)) / PITCH;

    // 1. old thin + thick disk: smooth, differential rotation
    for (let n = 0; n < 190000; n++) {
      let R: number;
      do R = -2600 * Math.log(rand() * rand()); while (R > 17000);
      if (R < 1500 && rand() < 0.7) continue;
      const a = rand() * Math.PI * 2;
      const thick = rand() < 0.12;
      const flare = Math.exp(Math.max(0, R - 9000) / 7000);
      const z = laplace((thick ? 900 : 280) * flare);
      colorFromKelvin(4200 + rand() * 2200 + (rand() < 0.04 ? 3000 : 0), col);
      push(R * Math.cos(a), R * Math.sin(a), z, 0, col, 60 + rand() * 40, thick ? 0.16 : 0.28);
    }
    // 2. arms: old-star density wave + young OB stars + HII regions + dust lanes (all at pattern speed)
    const arms = ARMS.map((a) => ({ ...a, b0: betaAt(a.c, 15500), b1: betaAt(a.c, 3300) }));
    for (const arm of arms) {
      const span = arm.b1 - arm.b0;
      const nOld = Math.round(26000 * arm.old), nYoung = Math.round(36000 * arm.young);
      for (let n = 0; n < nOld; n++) {
        const b = arm.b0 + rand() * span;
        const [x, y, R] = armXY(arm.c, PITCH, b, gaussian(rand) * 420);
        colorFromKelvin(4600 + rand() * 1800, col);
        push(x, y, laplace(220), 1, col, 70 + rand() * 40, 0.42 * edgeFade(R));
      }
      for (let n = 0; n < nYoung; n++) {
        const b = arm.b0 + rand() * span;
        const [x, y, R] = armXY(arm.c, PITCH, b, gaussian(rand) * 210);
        colorFromKelvin(8000 + rand() * 20000, col);
        push(x, y, laplace(70), 1, col, 35 + rand() * 30, (0.6 + rand() * 0.8) * edgeFade(R));
      }
      for (let n = 0; n < 1000 * arm.young; n++) {
        const b = arm.b0 + rand() * span;
        const [x, y, R] = armXY(arm.c, PITCH, b, gaussian(rand) * 140);
        col.setRGB(1.0, 0.32 + rand() * 0.15, 0.5 + rand() * 0.2);
        const clump = 1 + Math.floor(rand() * 6);
        for (let k = 0; k < clump; k++) push(x + gaussian(rand) * 60, y + gaussian(rand) * 60, laplace(40), 1, col, 70 + rand() * 90, 1.4 * edgeFade(R));
      }
      // dust sits on the concave (inner) side of trailing arms
      for (let n = 0; n < 17000; n++) {
        const b = arm.b0 + rand() * span;
        const [x, y, R] = armXY(arm.c, PITCH, b, -260 + gaussian(rand) * 190);
        col.setRGB(0.05, 0.03, 0.02);
        push(x, y, laplace(55), 1, col, 180 + rand() * 180, 0.75 * edgeFade(R) * (R > 2500 ? 1 : 0), true);
      }
    }
    // Local (Orion) arm segment, fading out at its measured ends
    for (let n = 0; n < 16000; n++) {
      const b = (LOCAL_ARM.b0 + rand() * (LOCAL_ARM.b1 - LOCAL_ARM.b0)) * Math.PI / 180;
      const fade = Math.min(1, (b * 180 / Math.PI - LOCAL_ARM.b0) / 25, (LOCAL_ARM.b1 - b * 180 / Math.PI) / 25);
      const [x, y] = armXY(LOCAL_ARM.c, LOCAL_ARM.pitch, b, gaussian(rand) * 200);
      if (n % 5 === 0) { col.setRGB(0.05, 0.03, 0.02); push(x, y, laplace(50), 1, col, 150 + rand() * 120, 0.4 * fade, true); continue; }
      colorFromKelvin(7000 + rand() * 18000, col);
      push(x, y, laplace(80), 1, col, 35 + rand() * 25, (0.5 + rand() * 0.6) * fade);
    }
    // 3. bar/bulge (boxy, rotating at the bar pattern speed) + long thin bar + compact nuclear bulge
    const ca = Math.cos(BAR_ANGLE), sa = Math.sin(BAR_ANGLE);
    const bar = (n: number, a: number, b: number, c: number, size: number, inten: number, tmin: number, tspan: number) => {
      for (let k = 0; k < n; k++) {
        const u = gaussian(rand) * a, v = gaussian(rand) * b, w = gaussian(rand) * c;
        colorFromKelvin(tmin + rand() * tspan, col);
        push(-u * ca - v * sa, u * sa - v * ca, w, 2, col, size + rand() * size, inten);
      }
    };
    bar(60000, 1500, 600, 420, 45, 0.7, 3500, 1500);
    bar(20000, 3300, 330, 160, 45, 0.45, 3800, 1600);
    bar(20000, 280, 260, 220, 25, 1.1, 3400, 1200);
    // 4. sparse stellar halo
    for (let n = 0; n < 12000; n++) {
      const r = 1500 + -6000 * Math.log(rand());
      const th = Math.acos(2 * rand() - 1), ph = rand() * Math.PI * 2;
      colorFromKelvin(4200 + rand() * 1500, col);
      push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th) * 0.8, 0, col, 40, 0.35);
    }

    const makeGeom = (p: number[], c: number[], s: number[], k: number[], i: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
      g.setAttribute('size', new THREE.Float32BufferAttribute(s, 1));
      g.setAttribute('kind', new THREE.Float32BufferAttribute(k, 1));
      g.setAttribute('intensity', new THREE.Float32BufferAttribute(i, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      return g;
    };
    const vert = /* glsl */ `${V_PARS}
      ${ROT_GLSL}
      ${SPRITE_FN}
      attribute float size, kind, intensity; attribute vec3 color;
      uniform float uGain;
      varying vec3 vColor; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(rotated(position, kind), 1.0);
        gl_Position = projectionMatrix * mv;
        float fade; float d = -mv.z;
        float rawPx = size * uPxScale / max(d, 1e-6);
        gl_PointSize = spriteSize(size, d, 1.6, 48.0, fade);
        // these particles stand for whole star clouds: dissolve them once they get big on screen (camera inside the disk)
        vA = intensity * fade * uGain * smoothstep(120.0, 1600.0, d) * (1.0 - 0.7 * smoothstep(20.0, 48.0, rawPx));
        vColor = color;
        ${V_END}
      }`;
    this.modelStars = new THREE.Points(makeGeom(P, C, S, K, I), material({
      blending: THREE.AdditiveBlending,
      uniforms: { ...this.u, uGain: { value: 0.6 } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `${F_PARS} varying vec3 vColor; varying float vA;
        void main() { ${F_START} vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard;
          float a = exp(-r2 * 5.0) * vA; gl_FragColor = vec4(vColor * a, 1.0); }`,
    }));
    this.dust = new THREE.Points(makeGeom(Pd, Cd, Sd, Kd, Id), material({
      blending: THREE.NormalBlending,
      uniforms: { ...this.u, uGain: { value: 1 } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `${F_PARS} varying vec3 vColor; varying float vA;
        void main() { ${F_START} vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard;
          gl_FragColor = vec4(vColor, (1.0 - r2) * (1.0 - r2) * min(vA, 0.85)); }`,
    }));
    this.modelStars.frustumCulled = this.dust.frustumCulled = false;
    this.dust.renderOrder = 2;
    this.scene.add(this.modelStars, this.dust);
  }

  /** Smooth diffuse light of the unresolved disk + spiral pattern (same fit as the particles), drawn in the plane. */
  private buildGlow() {
    const armC = new THREE.Vector4(...ARMS.map((a) => a.c) as [number, number, number, number]);
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(44000, 44000).rotateX(-Math.PI / 2), material({
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { ...this.u, uArmC: { value: armC }, uPitch: { value: PITCH }, uBarAngle: { value: BAR_ANGLE } },
      vertexShader: /* glsl */ `${V_PARS} varying vec2 vXY; varying float vD;
        void main() { vXY = vec2(position.x, -position.z); vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z;
          gl_Position = projectionMatrix * mv; ${V_END} }`,
      fragmentShader: /* glsl */ `${F_PARS}
        uniform vec4 uArmC; uniform float uPitch, uBarAngle, uMyr, uOmegaP, uOmegaB;
        varying vec2 vXY; varying float vD;
        float armDist(float c, float R, float beta) {
          float ba = (c - log(R / 1000.0)) / uPitch;             // azimuth of the arm at this radius
          float d = mod(beta - ba + PI, 2.0 * PI) - PI;           // wrapped azimuth difference
          return abs(d) * R;
        }
        void main() {
          ${F_START}
          float R = length(vXY);
          float beta = atan(vXY.y, -vXY.x) - uOmegaP * uMyr;
          float disk = exp(-R / 3200.0) * smoothstep(21000.0, 12000.0, R);
          float arms = 0.0;
          for (int i = 0; i < 4; i++) { float d = armDist(uArmC[i], max(R, 1.0), beta); arms += exp(-d * d / (550.0 * 550.0)); }
          arms *= smoothstep(2600.0, 4200.0, R) * smoothstep(17000.0, 11000.0, R);
          // bar: rotate into the bar frame
          float ang = uBarAngle - uOmegaB * uMyr;
          vec2 bp = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * vec2(-vXY.x, vXY.y);
          float barG = exp(-pow(bp.x / 2400.0, 2.0) - pow(bp.y / 850.0, 2.0));
          float core = exp(-R * R / (600.0 * 600.0));
          vec3 col = vec3(1.0, 0.8, 0.58) * disk * 0.06 + vec3(0.55, 0.7, 1.0) * arms * 0.035 * (0.5 + disk * 3.0)
                   + vec3(1.0, 0.75, 0.45) * (barG * 0.1 + core * 0.3);
          col *= smoothstep(60.0, 1500.0, vD);                    // hide when inside the disk near the camera
          gl_FragColor = vec4(col, 1.0);
        }`,
    }));
    (this.glow.material as THREE.ShaderMaterial).fragmentShader = '#define PI 3.141592653589793\n' + (this.glow.material as THREE.ShaderMaterial).fragmentShader;
    this.glow.renderOrder = -1;
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture([[0, 'rgba(255,236,200,1)'], [0.15, 'rgba(255,200,140,0.45)'], [0.5, 'rgba(255,160,90,0.08)'], [1, 'rgba(0,0,0,0)']]),
      blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(0.75, 0.62, 0.5),
    }));
    core.scale.set(7000, 7000, 1);
    this.scene.add(this.glow, core);

    const sgr: Selectable = {
      id: 'sgra', name: 'Sagittarius A*', kind: 'black hole', layer: 'galaxy', radius: 200, position: (o) => o.set(0, 0, 0),
      info: () => ({ kicker: 'Supermassive black hole', title: 'Sagittarius A*', color: '#ffd9a0',
        rows: [['Mass', '≈ 4.3 million M☉'], ['Distance from Sun', `${(R0 * 3.2616 / 1000).toFixed(1)} kly (${(R0 / 1000).toFixed(2)} kpc)`]],
        body: 'Imaged by the Event Horizon Telescope in 2022. The galaxy (and this map) rotates around it.' }),
    };
    this.selectables_.push(sgr);
    this.labels.add({ text: 'Sgr A*', sub: 'galactic centre', cls: 'body', position: (o) => o.set(0, 0, 0), far: 90000, onClick: () => this.onPick?.(sgr) });
    // Arm name labels placed along each arm at R ≈ 10–12 kpc, rotating with the pattern
    const lab = (name: string, color: string, c: number, pitch: number, betaDeg: number) => {
      const b = betaDeg * Math.PI / 180, R = Math.exp(c - pitch * b) * 1000;
      const [Rr, phi] = polar(-R * Math.cos(b), R * Math.sin(b));
      const sel: Selectable = { id: 'arm:' + name, name, kind: 'spiral arm', layer: 'galaxy', radius: 3000, position: (o) => rotPos(Rr, phi, 0, 1, this.myr, o),
        info: () => ({ kicker: 'Spiral arm', title: name, color, rows: [['Pitch angle', `${(Math.atan(pitch) * 180 / Math.PI).toFixed(1)}° (fit to masers)`]],
          body: 'Arm geometry is a logarithmic spiral fitted to trigonometric parallaxes of star-forming regions (Reid et al. 2019). Beyond the measured segments it is extrapolated.' }) };
      this.selectables_.push(sel);
      this.labels.add({ text: name, cls: 'arm', color, position: (o) => sel.position(o), near: 6000, far: 140000, onClick: () => this.onPick?.(sel) });
    };
    lab(ARMS[0].name, ARMS[0].color, ARMS[0].c, PITCH, 60);
    lab(ARMS[1].name, ARMS[1].color, ARMS[1].c, PITCH, -150);
    lab(ARMS[2].name, ARMS[2].color, ARMS[2].c, PITCH, -40);
    lab(ARMS[3].name, ARMS[3].color, ARMS[3].c, PITCH, -330);
    lab(LOCAL_ARM.name, '#7dffcf', LOCAL_ARM.c, LOCAL_ARM.pitch, 40);
  }

  // ------------------------------------------------------------------------------------------ real data
  private buildNeighbourhood(gaia: Float32Array, stars: StarsData) {
    const n = gaia.length / 5;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), absm = new Float32Array(n);
    const c = new THREE.Color(), v = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      toThree(gaia[k * 5], gaia[k * 5 + 1], gaia[k * 5 + 2], v).toArray(pos, k * 3);
      colorFromKelvin(kelvinFromBpRp(gaia[k * 5 + 3]), c).toArray(col, k * 3);
      absm[k] = gaia[k * 5 + 4];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('absmag', new THREE.BufferAttribute(absm, 1));
    this.gaia = new THREE.Points(g, material({
      blending: THREE.AdditiveBlending,
      uniforms: { uExposure: this.gaiaExposure },
      vertexShader: /* glsl */ `${V_PARS}
        attribute float absmag; attribute vec3 color; uniform float uExposure;
        varying vec3 vColor; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = max(length(mv.xyz), 1e-4);
          float m = absmag + 5.0 * log(d / 10.0) / log(10.0);        // apparent magnitude from the camera
          float flux = pow(10.0, -0.4 * (m - 3.0)) * uExposure;
          float px = 2.2 * sqrt(flux) * 3.0;
          vA = clamp(px / 1.5, 0.0, 1.0); vA *= vA;
          vA = min(vA, 1.0) * min(1.0, flux * 4.0 + 0.2);
          vColor = color;
          gl_PointSize = clamp(px, 1.5, 14.0) * uPixelRatio;
          ${V_END}
        }`,
      fragmentShader: /* glsl */ `${F_PARS} varying vec3 vColor; varying float vA; ${STAR_FRAG_FN}
        void main() { ${F_START} if (vA < 0.003) discard; float a = starPsf(gl_PointCoord, 0.3) * vA; gl_FragColor = vec4(vColor * a * 1.5, 1.0); }`,
    }));
    this.gaia.frustumCulled = false;
    this.neighbourhood.add(this.gaia);

    // The Sun
    const sunPos = toThree(-R0, 0, Z_SUN);
    const sunMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color: '#ffd166', sizeAttenuation: false, depthTest: false, transparent: true }));
    sunMarker.scale.setScalar(0.022);
    sunMarker.position.copy(sunPos);
    sunMarker.renderOrder = 10;
    const sunGlowS = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture([[0, 'rgba(255,240,210,1)'], [0.2, 'rgba(255,220,160,0.4)'], [1, 'rgba(0,0,0,0)']], 64), blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false }));
    sunGlowS.scale.setScalar(0.012);
    sunGlowS.position.copy(sunPos);
    this.neighbourhood.add(sunMarker, sunGlowS);
    const world = new THREE.Vector3();
    this.anchor = {
      id: 'sun-galaxy', name: 'Sun', kind: 'star', layer: 'galaxy', radius: 0.5,
      position: (o) => o.copy(sunPos).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.neighbourhood.rotation.y),
      info: () => ({
        kicker: 'You are here', title: 'The Sun', color: '#ffd166',
        rows: [['Galactocentric radius', `${(R0 / 1000).toFixed(2)} kpc · ${(R0 * 3.2616 / 1000).toFixed(1)} kly`], ['Height above plane', `${Z_SUN} pc`],
          ['Orbital speed', `${Math.round(vc(R0))} km/s`], ['Galactic year', `${Math.round((2 * Math.PI) / OMEGA_SUN)} Myr`],
          ['Orbits completed since t=0', (this.myr * OMEGA_SUN / (2 * Math.PI)).toFixed(3)]],
        body: 'Surrounding points are ~600,000 real stars from ESA Gaia DR3 within 1 kpc (3,260 ly), coloured by their measured BP−RP colour. Zoom all the way in to drop into the Solar System.',
      }),
    };
    this.selectables_.push(this.anchor);
    this.labels.add({ text: 'Sun', sub: 'you are here', cls: 'here', color: '#ffd166', position: (o) => this.anchor.position(o), onClick: () => this.onPick?.(this.anchor) });

    // Named stars (HYG) — labels when close
    for (const s of stars.named) {
      if (s.mag > 3.2 && s.d > 12) continue;
      const p = toThree(s.g[0], s.g[1], s.g[2]);
      const sel: Selectable = {
        id: 'star:' + s.n, name: s.n, kind: 'star', layer: 'galaxy', radius: 0.5,
        position: (o) => o.copy(p).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.neighbourhood.rotation.y),
        info: () => ({ kicker: `Star · ${s.sp || 'spectral type n/a'}`, title: s.n, color: '#' + colorFromBV(s.ci).getHexString(),
          rows: [['Distance', `${s.d.toFixed(2)} pc · ${(s.d * 3.2616).toFixed(1)} ly`], ['Apparent magnitude', s.mag.toFixed(2)], ['Colour index B−V', s.ci.toFixed(2)]],
          link: { label: 'SIMBAD', url: `https://simbad.cds.unistra.fr/simbad/sim-id?Ident=${encodeURIComponent(s.n)}` } }),
      };
      this.selectables_.push(sel);
      this.labels.add({ text: s.n, cls: 'star', position: (o) => sel.position(o), far: Math.max(25, s.d * 2.5), onClick: () => this.onPick?.(sel) });
      void world;
    }
    this.scene.add(this.neighbourhood);
  }

  private rotatingPoints(p: number[], c: number[], s: number[], frag: string, kind = 0, minPx = 2.5, maxPx = 16) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(s, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const pts = new THREE.Points(g, material({
      blending: THREE.AdditiveBlending,
      uniforms: { ...this.u, uHighlight: { value: -1 } },
      vertexShader: /* glsl */ `${V_PARS} ${ROT_GLSL} ${SPRITE_FN}
        attribute float size; attribute vec3 color; uniform float uHighlight; varying vec3 vColor; varying float vA; varying float vRing;
        void main() {
          vec4 mv = modelViewMatrix * vec4(rotated(position, ${kind.toFixed(1)}), 1.0);
          gl_Position = projectionMatrix * mv;
          float fade; gl_PointSize = spriteSize(size, -mv.z, ${minPx.toFixed(1)}, ${maxPx.toFixed(1)}, fade);
          if (float(gl_VertexID) == uHighlight) gl_PointSize *= 2.5;
          vRing = smoothstep(7.0, 12.0, gl_PointSize / uPixelRatio);
          vA = 0.25 + 0.75 * fade; vColor = color; ${V_END}
        }`,
      fragmentShader: `${F_PARS} varying vec3 vColor; varying float vA; varying float vRing; ${frag}`,
    }));
    pts.frustumCulled = false;
    return pts;
  }

  private buildClusters(rows: [string, number, number, number, number, number, number, number][]) {
    const P: number[] = [], C: number[] = [], S: number[] = [];
    const c = new THREE.Color();
    for (const [name, x, y, z, age, members, dist, r50] of rows) {
      const [R, phi] = polar(x, y);
      this.clusterData.push({ name, R, phi, z, age, members, dist, r50 });
      P.push(R, phi, z);
      clusterColor(age, c);
      C.push(c.r, c.g, c.b);
      S.push(Math.max(1.5, r50 * 1.6) + Math.sqrt(members) * 0.12);
    }
    this.clusters = this.rotatingPoints(P, C, S, /* glsl */ `
      void main() { ${F_START} vec2 p = gl_PointCoord * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
        float ring = smoothstep(0.55, 0.75, r) * (1.0 - smoothstep(0.85, 1.0, r)); float core = exp(-r * r * 10.0);
        gl_FragColor = vec4(vColor * (ring * 0.45 * vRing + core * 0.6) * vA, 1.0); }`, 0, 2.2, 18);
    this.scene.add(this.clusters);
    const famous: Record<string, string> = {
      'Melotte 22': 'Pleiades (M45)', 'Melotte 25': 'Hyades', 'NGC 2632': 'Beehive (M44)', 'NGC 869': 'h Persei', 'NGC 884': 'χ Persei',
      'NGC 2682': 'M67', 'IC 2602': 'Southern Pleiades', 'NGC 3532': 'Wishing Well', 'NGC 6405': 'Butterfly (M6)', 'NGC 6475': 'Ptolemy (M7)',
      'NGC 2516': 'Southern Beehive', 'Melotte 111': 'Coma Star Cluster', 'NGC 7789': 'Caroline’s Rose', 'NGC 6611': 'Eagle Nebula (M16)',
    };
    const v = new THREE.Vector3();
    this.clusterData.forEach((cl, k) => {
      const alias = famous[cl.name];
      const sel: Selectable = {
        id: 'oc:' + cl.name, name: alias ? `${alias}` : cl.name, kind: 'open cluster', layer: 'galaxy', radius: Math.max(5, cl.r50 * 4), keywords: cl.name,
        position: (o) => rotPos(cl.R, cl.phi, cl.z, 0, this.myr, o),
        onSelect: () => ((this.clusters.material as THREE.ShaderMaterial).uniforms.uHighlight.value = k),
        onDeselect: () => ((this.clusters.material as THREE.ShaderMaterial).uniforms.uHighlight.value = -1),
        info: () => ({
          kicker: 'Open star cluster · Gaia DR3', title: alias ? `${alias}` : cl.name, color: '#' + clusterColor(cl.age, c).getHexString(),
          rows: [['Catalogue name', cl.name], ['Distance', `${Math.round(cl.dist).toLocaleString('en-US')} pc · ${Math.round(cl.dist * 3.2616).toLocaleString('en-US')} ly`],
            ['Age', fmtAge(cl.age)], ['Member stars (Gaia)', cl.members.toLocaleString('en-US')], ['Half-mass radius', `${cl.r50} pc`]],
          link: { label: 'Hunt & Reffert 2023', url: 'https://doi.org/10.1051/0004-6361/202346285' },
        }),
      };
      this.selectables_.push(sel);
      if (alias) this.labels.add({ text: alias, cls: 'cluster', position: (o) => sel.position(o), near: 1, far: 4000, visible: () => this.clusters.visible, onClick: () => this.onPick?.(sel) });
      void v;
    });
  }

  private buildMasers(rows: [string, string, number, number, number, string, number, number][]) {
    const P: number[] = [], C: number[] = [], S: number[] = [];
    const c = new THREE.Color();
    for (const [name, alias, x, y, z, arm, dist, err] of rows) {
      const [R, phi] = polar(x, y);
      this.maserData.push({ name, alias, R, phi, z, arm, dist, err });
      P.push(R, phi, z);
      c.set(MASER_ARM[arm]?.color || '#bbbbbb');
      C.push(c.r, c.g, c.b);
      S.push(90);
    }
    this.masers = this.rotatingPoints(P, C, S, /* glsl */ `
      void main() { ${F_START} vec2 p = abs(gl_PointCoord * 2.0 - 1.0); float d = p.x + p.y; if (d > 1.0) discard;
        float edge = smoothstep(0.6, 0.8, d) * (1.0 - smoothstep(0.9, 1.0, d));
        gl_FragColor = vec4(vColor * (edge + 0.35 * (1.0 - d)) * 1.4, 1.0); }`, 0, 5, 14);
    this.scene.add(this.masers);
    this.maserData.forEach((m, k) => {
      const armInfo = MASER_ARM[m.arm];
      const sel: Selectable = {
        id: 'maser:' + m.name, name: m.alias || m.name, kind: 'maser', layer: 'galaxy', radius: 80, keywords: `${m.name} ${armInfo?.label || m.arm} maser`,
        position: (o) => rotPos(m.R, m.phi, m.z, 0, this.myr, o),
        onSelect: () => ((this.masers.material as THREE.ShaderMaterial).uniforms.uHighlight.value = k),
        onDeselect: () => ((this.masers.material as THREE.ShaderMaterial).uniforms.uHighlight.value = -1),
        info: () => ({
          kicker: 'Star-forming region · maser parallax', title: m.alias || m.name, color: armInfo?.color,
          rows: [['Source', m.name], ['Spiral arm', armInfo?.label || m.arm], ['Distance', `${m.dist.toFixed(2)} kpc (±${Math.round(m.err * 100)} %)`]],
          body: 'Water and methanol masers in massive star-forming regions allow VLBI trigonometric parallaxes to 10 µas — the most direct way to map spiral arms from inside the disk.',
          link: { label: 'Reid et al. 2019', url: 'https://doi.org/10.3847/1538-4357/ab4a11' },
        }),
      };
      this.selectables_.push(sel);
    });
  }

  private buildGlobulars(rows: [string, number, number, number, number, number, number, number][]) {
    const steps = this.T_ORBIT / this.ORBIT_DT;
    const sub = 8, dt = this.ORBIT_DT / sub;
    const a = [0, 0, 0];
    for (const [name, x0, y0, z0, vx0, vy0, vz0, dist] of rows) {
      const orbit = new Float32Array((steps + 1) * 3);
      let x = x0, y = y0, z = z0, vx = vx0, vy = vy0, vz = vz0;
      let rperi = Infinity, rapo = 0;
      accel(x, y, z, a);
      for (let s = 0; s <= steps; s++) {
        orbit[s * 3] = x; orbit[s * 3 + 1] = y; orbit[s * 3 + 2] = z;
        const r = Math.hypot(x, y, z); rperi = Math.min(rperi, r); rapo = Math.max(rapo, r);
        for (let k = 0; k < sub; k++) { // kick-drift-kick leapfrog
          vx += 0.5 * dt * KMS * a[0]; vy += 0.5 * dt * KMS * a[1]; vz += 0.5 * dt * KMS * a[2];
          x += dt * KMS * vx; y += dt * KMS * vy; z += dt * KMS * vz;
          accel(x, y, z, a);
          vx += 0.5 * dt * KMS * a[0]; vy += 0.5 * dt * KMS * a[1]; vz += 0.5 * dt * KMS * a[2];
        }
      }
      this.gcData.push({ name, orbit, dist, rperi, rapo });
    }
    const n = this.gcData.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.gcs = new THREE.Points(g, material({
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `${V_PARS} ${SPRITE_FN} varying float vA;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          float fade; gl_PointSize = spriteSize(60.0, -mv.z, 4.0, 22.0, fade); vA = 0.5 + 0.5 * fade; ${V_END} }`,
      fragmentShader: /* glsl */ `${F_PARS} varying float vA;
        void main() { ${F_START} vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard;
          gl_FragColor = vec4(vec3(1.0, 0.85, 0.6) * (exp(-r2 * 6.0) + 0.25 * exp(-r2 * 1.5)) * vA * 1.4, 1.0); }`,
    }));
    this.gcs.frustumCulled = false;
    this.scene.add(this.gcs);

    const p = new THREE.Vector3();
    this.gcData.forEach((gc, k) => {
      const pts: number[] = [];
      for (let s = 0; s < gc.orbit.length / 3; s += 2) { toThree(gc.orbit[s * 3], gc.orbit[s * 3 + 1], gc.orbit[s * 3 + 2], p); pts.push(p.x, p.y, p.z); }
      const line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
        new THREE.LineBasicMaterial({ color: '#ffcf8a', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
      line.frustumCulled = false;
      this.gcOrbits.add(line);
      const famous: Record<string, string> = { 'NGC 5139': 'ω Centauri', 'NGC 104': '47 Tucanae', 'NGC 6205': 'M13 · Hercules Cluster', 'NGC 7078': 'M15', 'NGC 6121': 'M4', 'NGC 5272': 'M3', 'NGC 6656': 'M22' };
      const alias = famous[gc.name];
      const sel: Selectable = {
        id: 'gc:' + gc.name, name: alias || gc.name, kind: 'globular cluster', layer: 'galaxy', radius: 120, keywords: gc.name,
        position: (o) => this.gcPos(k, o),
        onSelect: () => { (line.material as THREE.LineBasicMaterial).opacity = 0.9; line.visible = true; },
        onDeselect: () => { (line.material as THREE.LineBasicMaterial).opacity = 0.12; line.visible = this.gcOrbits.visible; },
        info: () => ({
          kicker: 'Globular cluster · orbit integrated from Gaia EDR3 6D data', title: alias ? `${alias}` : gc.name, color: '#ffcf8a',
          rows: [['Catalogue name', gc.name], ['Distance from Sun (today)', `${gc.dist.toFixed(2)} kpc`], ['Galactocentric radius', `${(this.gcPos(k, new THREE.Vector3()).length() / 1000).toFixed(2)} kpc`],
            ['Pericentre → apocentre', `${(gc.rperi / 1000).toFixed(1)} → ${(gc.rapo / 1000).toFixed(1)} kpc`]],
          body: 'Orbit integrated in this app with a leapfrog scheme in a bulge + disk + NFW-halo potential normalised to 233 km/s at the Sun.',
          link: { label: 'Baumgardt catalogue', url: 'https://people.smp.uq.edu.au/HolgerBaumgardt/globular/' },
        }),
      };
      this.selectables_.push(sel);
      if (alias) this.labels.add({ text: alias, cls: 'cluster gc', position: (o) => sel.position(o), far: 60000, visible: () => this.gcs.visible, onClick: () => this.onPick?.(sel) });
    });
    this.gcOrbits.visible = false;
    this.scene.add(this.gcOrbits);
  }

  private gcPos(k: number, out: THREE.Vector3) {
    const o = this.gcData[k].orbit, n = o.length / 3;
    const f = ((this.myr % this.T_ORBIT) + this.T_ORBIT) % this.T_ORBIT / this.ORBIT_DT;
    const i = Math.min(Math.floor(f), n - 2), u = f - i;
    return toThree(o[i * 3] + (o[i * 3 + 3] - o[i * 3]) * u, o[i * 3 + 1] + (o[i * 3 + 4] - o[i * 3 + 1]) * u, o[i * 3 + 2] + (o[i * 3 + 5] - o[i * 3 + 2]) * u, out);
  }

  private buildGuides() {
    for (const kpc of [5, 10, 15, 20]) {
      const pts: number[] = [];
      for (let k = 0; k <= 256; k++) { const a = (k / 256) * Math.PI * 2; pts.push(Math.cos(a) * kpc * 1000, 0, Math.sin(a) * kpc * 1000); }
      this.guides.add(new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
        new THREE.LineBasicMaterial({ color: 0x3a5a8a, transparent: true, opacity: 0.16, depthWrite: false })));
      this.labels.add({ text: `${kpc} kpc`, sub: `${Math.round(kpc * 3.2616)}k ly`, cls: 'scale', position: (o) => o.set(0, 0, kpc * 1000), near: 4000, visible: () => this.guides.visible });
    }
    const pts: number[] = [];
    for (let k = 0; k <= 512; k++) { const a = (k / 512) * Math.PI * 2; pts.push(Math.cos(a) * R0, Z_SUN, Math.sin(a) * R0); }
    const sunOrbit = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
      new THREE.LineDashedMaterial({ color: 0xffd166, transparent: true, opacity: 0.3, dashSize: 300, gapSize: 250, depthWrite: false }));
    sunOrbit.computeLineDistances();
    this.guides.add(sunOrbit);
    this.scene.add(this.guides);
  }

  private buildToggles() {
    this.toggles = [
      { id: 'model', label: 'Galaxy model (fit to masers)', color: '#c8b8ff', value: true, set: (v) => { this.modelStars.visible = this.dust.visible = this.glow.visible = v; } },
      { id: 'gaia', label: 'Gaia DR3 stars (< 1 kpc)', color: '#ffe8c2', count: this.gaia.geometry.attributes.position.count, value: true, set: (v) => (this.gaia.visible = v) },
      { id: 'clusters', label: 'Open clusters (Gaia)', color: '#8ab4ff', count: this.clusterData.length, value: true, set: (v) => (this.clusters.visible = v) },
      { id: 'masers', label: 'Maser parallaxes (arms)', color: '#ff9f6b', count: this.maserData.length, value: true, set: (v) => (this.masers.visible = v) },
      { id: 'gcs', label: 'Globular clusters', color: '#ffcf8a', count: this.gcData.length, value: true, set: (v) => (this.gcs.visible = v) },
      { id: 'gcorbits', label: 'Globular cluster orbits', color: '#ffcf8a', value: false, set: (v) => (this.gcOrbits.visible = v) },
      { id: 'guides', label: 'Distance rings & Sun’s orbit', value: true, set: (v) => (this.guides.visible = v) },
    ];
  }

  // ------------------------------------------------------------------------------------------ frame
  update({ clock, camera }: FrameCtx) {
    this.myr = clock.myr;
    this.u.uMyr.value = clock.myr;
    this.neighbourhood.rotation.y = -OMEGA_SUN * clock.myr;
    const arr = this.gcs.geometry.attributes.position.array as Float32Array, v = new THREE.Vector3();
    for (let k = 0; k < this.gcData.length; k++) this.gcPos(k, v).toArray(arr, k * 3);
    this.gcs.geometry.attributes.position.needsUpdate = true;
    // Gaia exposure: brighter when looking at the neighbourhood from a distance so the bubble reads as a structure
    const dSun = camera.position.distanceTo(this.anchor.position(v));
    this.gaiaExposure.value = THREE.MathUtils.clamp(Math.pow(dSun / 30, 0.9), 1, 60);
  }

  pick(ray: THREE.Raycaster): Selectable | null {
    const v = new THREE.Vector3();
    let best: Selectable | null = null, bestAng = 0.012;
    for (const s of this.selectables_) {
      if (s.kind === 'spiral arm') continue;
      if ((s.kind === 'open cluster' && !this.clusters.visible) || (s.kind === 'maser' && !this.masers.visible) || (s.kind === 'globular cluster' && !this.gcs.visible)) continue;
      s.position(v);
      const dist = v.distanceTo(ray.ray.origin);
      const ang = ray.ray.distanceToPoint(v) / dist * (s.kind === 'star' && s.id !== 'sun-galaxy' ? 1.4 : 1);
      if (ang < bestAng) { bestAng = ang; best = s; }
    }
    return best;
  }

  selectables() {
    return this.selectables_;
  }

  home() {
    return { position: new THREE.Vector3(9000, 26000, 30000), target: new THREE.Vector3(-1500, 0, 0) };
  }

  flySpeed(pos: THREE.Vector3) {
    const d = Math.min(pos.distanceTo(this.anchor.position(new THREE.Vector3())), Math.max(pos.length() * 0.4, 1));
    return Math.max(0.02, d * 0.5);
  }
}

/** Cluster colour ≈ its main-sequence turn-off: young clusters are blue-white, old ones orange. */
function clusterColor(logAge: number, out: THREE.Color) {
  const t = THREE.MathUtils.clamp((logAge - 6.5) / 3.5, 0, 1);
  return colorFromKelvin(22000 * Math.pow(4200 / 22000, t), out);
}

function edgeFade(R: number) {
  return THREE.MathUtils.smoothstep(R, 2800, 4200) * (1 - THREE.MathUtils.smoothstep(R, 12500, 16500));
}
function fmtAge(logAge: number) {
  const yr = Math.pow(10, logAge);
  return yr >= 1e9 ? `${(yr / 1e9).toFixed(2)} Gyr` : `${Math.round(yr / 1e6).toLocaleString('en-US')} Myr`;
}
