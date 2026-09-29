import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';
import { gstime, json2satrec, sgp4, eciToGeodetic, type SatRec } from 'satellite.js';
import { AU_KM, toThree, dateFromJd, formatDistance } from '../core/astro';
import { material, V_PARS, V_END, F_PARS, F_START } from '../core/shaders';
import { json, texture, type SatellitesData, type MissionsData, type LaunchesData, type Launch, type MissionTrack } from '../core/data';
import { MISSIONS } from '../core/missions';
import { sampleTrack } from '../core/track';
import { sunGlow, ringTexture } from '../core/fx';
import type { Layer, Selectable, Toggle, FrameCtx, InfoCard } from '../core/types';
import type { Labels } from '../core/labels';
import type { Sky } from './sky';

const KM = 1 / 1000; // scene units are 1000 km
const RE = 6371 * KM;

interface Category { id: string; label: string; color: string; match: (name: string, mm: number, ecc: number) => boolean }
const CATEGORIES: Category[] = [
  { id: 'stations', label: 'Crewed stations', color: '#ffffff', match: (n) => /^(ISS|CSS|TIANHE|WENTIAN|MENGTIAN|ZARYA|POISK|NAUKA|PROGRESS|SOYUZ|CREW DRAGON|DRAGON|TIANZHOU|SHENZHOU|CYGNUS|HTV|STARLINER)\b/.test(n) },
  { id: 'starlink', label: 'Starlink', color: '#5b9dff', match: (n) => n.startsWith('STARLINK') },
  { id: 'oneweb', label: 'OneWeb', color: '#b18cff', match: (n) => n.startsWith('ONEWEB') },
  { id: 'kuiper', label: 'Amazon Leo (Kuiper)', color: '#ffae57', match: (n) => n.startsWith('KUIPER') || n.startsWith('AMAZON LEO') },
  { id: 'china', label: 'Guowang & Qianfan', color: '#3fd0d4', match: (n) => /^(GUOWANG|QIANFAN|G60)/.test(n) },
  { id: 'gnss', label: 'Navigation (GNSS)', color: '#4ff0a3', match: (n, mm) => /(NAVSTAR|GPS |GALILEO|GLONASS|BEIDOU|QZS|IRNSS|NAVIC)/.test(n) || (n.startsWith('COSMOS') && mm > 2 && mm < 2.3) },
  { id: 'geo', label: 'Geostationary', color: '#ffd65c', match: (_n, mm, e) => mm > 0.95 && mm < 1.05 && e < 0.05 },
  { id: 'science', label: 'Earth observation & science', color: '#ff6f91', match: (n) => /(NOAA|GOES|METEOSAT|METOP|HIMAWARI|FENGYUN|SENTINEL|LANDSAT|TERRA|AQUA|AURA|SUOMI|JPSS|HST|SWIFT|FERMI|NUSTAR|TESS|ICESAT|GRACE|CALIPSO|SMAP|OCO|WORLDVIEW|PLEIADES|SPOT |RADARSAT|COSMO-SKYMED|TANDEM|TERRASAR|SWOT|CRYOSAT|SMOS|GCOM|GPM|DMSP|FLOCK|LEMUR|SKYSAT|ICEYE|CAPELLA|GAOFEN|YAOGAN|KOMPSAT|EARTHCARE|PACE)/.test(n) },
  { id: 'rb', label: 'Rocket bodies', color: '#6b7a8f', match: (n) => /^(SL-|CZ-)|R\/B/.test(n) },
  { id: 'other', label: 'Other active', color: '#8ea2b7', match: () => true },
];
const RECENT_COLOR = '#ff5a36';

interface Sat {
  i: number; name: string; norad: number; intl: string; cat: Category; recent: boolean; mm: number; inc: number; ecc: number; epoch: string;
  omm: Record<string, string | number>;
}

export class EarthLayer implements Layer {
  id = 'earth' as const;
  label = 'Earth orbit';
  scene = new THREE.Scene();
  minDistance = RE * 1.02;
  maxDistance = 6000;
  speeds: [string, number][] = [['Live', 1], ['1 min/s', 60], ['10 min/s', 600], ['1 h/s', 3600]];
  toggles: Toggle[] = [];
  anchor!: Selectable;

  earth = new THREE.Group(); // rotates with GMST
  private earthMat!: THREE.ShaderMaterial;
  private cloudMat!: THREE.ShaderMaterial;
  private atmoMat!: THREE.ShaderMaterial;
  private clouds!: THREE.Mesh;
  private moon!: THREE.Mesh;
  private sunSprite!: THREE.Sprite;
  private sunLight = new THREE.DirectionalLight(0xffffff, 3);
  private sunDir = new THREE.Vector3(1, 0, 0);
  private moonPos = new THREE.Vector3();

  sats: Sat[] = [];
  private satPoints!: THREE.Points;
  private satGeom!: THREE.BufferGeometry;
  private satSize!: Float32Array;
  private catVisible: Record<string, boolean> = {};
  private highlightRecent = true;
  private worker!: Worker;
  private base: { jd: number; pos: Float32Array; vel: Float32Array } | null = null;
  private pending = false;
  private satSelectables: Selectable[] = [];
  private selectedSat = -1;
  private orbitLine!: THREE.Line;
  private orbitRec: SatRec | null = null;
  private orbitJd = 0;
  private marker!: THREE.Sprite;

  private deep: { id: string; track: MissionTrack; obj: THREE.Object3D; pos: THREE.Vector3; sel: Selectable; ok: boolean }[] = [];
  private deepGroup = new THREE.Group();
  private pads = new THREE.Group();
  private selectables_: Selectable[] = [];
  satsFetched = '';
  satsPartial = false;
  launches: Launch[] = [];

  constructor(private sky: Sky, private labels: Labels) {}

  async load(progress?: (m: string) => void) {
    progress?.('Earth textures');
    const [day, night, clouds, spec, moonTex] = await Promise.all([
      texture('earth_day.jpg'), texture('earth_night.jpg'), texture('earth_clouds.jpg', false), texture('earth_specular.jpg', false), texture('moon.jpg'),
    ]);
    clouds.wrapS = THREE.RepeatWrapping; // clouds drift in longitude via a UV offset
    clouds.needsUpdate = true;
    this.buildEarth(day, night, clouds, spec);
    this.buildMoonAndSun(moonTex);

    progress?.('Satellite catalogue (CelesTrak)');
    const [satData, missions, launches] = await Promise.all([
      json<SatellitesData>('satellites.json'),
      json<MissionsData>('missions.json').catch(() => null),
      json<LaunchesData>('launches.json').catch(() => null),
    ]);
    await this.buildSatellites(satData);
    if (missions) this.buildDeepSpace(missions);
    if (launches) this.buildLaunchPads(launches.launches);
    this.buildToggles();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.02), this.sunLight, this.sunLight.target);
  }

  // ------------------------------------------------------------------ Earth
  private buildEarth(day: THREE.Texture, night: THREE.Texture, clouds: THREE.Texture, spec: THREE.Texture) {
    const sun = { value: this.sunDir };
    const cloudOffset = { value: 0 };
    const geo = new THREE.SphereGeometry(RE, 160, 80);
    this.earthMat = material({
      transparent: false, depthWrite: true,
      uniforms: { uDay: { value: day }, uNight: { value: night }, uClouds: { value: clouds }, uSpec: { value: spec }, uSun: sun, uCloudOffset: cloudOffset },
      vertexShader: /* glsl */ `${V_PARS}
        varying vec2 vUv; varying vec3 vN; varying vec3 vW;
        void main() {
          vUv = uv; vN = normalize(mat3(modelMatrix) * normal);
          vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
          ${V_END}
        }`,
      fragmentShader: /* glsl */ `${F_PARS}
        uniform sampler2D uDay, uNight, uClouds, uSpec; uniform vec3 uSun; uniform float uCloudOffset;
        varying vec2 vUv; varying vec3 vN; varying vec3 vW;
        void main() {
          ${F_START}
          vec3 N = normalize(vN), V = normalize(cameraPosition - vW), L = normalize(uSun);
          float ndl = dot(N, L);
          float cl = texture2D(uClouds, vUv + vec2(uCloudOffset, 0.0)).r;
          vec3 day = texture2D(uDay, vUv).rgb * (1.0 - cl * 0.45);
          vec3 col = day * (smoothstep(-0.05, 0.7, ndl) * 0.95 + 0.008);
          // city lights on the night side, dimmed under clouds
          vec3 lights = texture2D(uNight, vUv).rgb;
          lights = pow(lights, vec3(1.4)) * vec3(1.0, 0.78, 0.5) * 3.2 * (1.0 - cl * 0.8);
          col += lights * (1.0 - smoothstep(-0.18, 0.06, ndl));
          // sun glint on oceans
          float sea = texture2D(uSpec, vUv).r;
          vec3 H = normalize(L + V);
          col += vec3(1.0, 0.86, 0.66) * pow(max(dot(N, H), 0.0), 70.0) * sea * 1.4 * smoothstep(0.0, 0.25, ndl);
          // warm terminator + blue limb haze (single-scattering look)
          col += vec3(0.5, 0.18, 0.04) * exp(-pow((ndl - 0.03) * 8.0, 2.0)) * 0.18;
          float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
          col += vec3(0.25, 0.5, 1.0) * fres * smoothstep(-0.25, 0.55, ndl) * 0.8;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const earthMesh = new THREE.Mesh(geo, this.earthMat);
    this.earth.add(earthMesh);

    this.cloudMat = material({
      uniforms: { uClouds: { value: clouds }, uSun: sun, uCloudOffset: cloudOffset },
      vertexShader: /* glsl */ `${V_PARS}
        varying vec2 vUv; varying vec3 vN;
        void main() { vUv = uv; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${V_END} }`,
      fragmentShader: /* glsl */ `${F_PARS}
        uniform sampler2D uClouds; uniform vec3 uSun; uniform float uCloudOffset;
        varying vec2 vUv; varying vec3 vN;
        void main() {
          ${F_START}
          float c = texture2D(uClouds, vUv + vec2(uCloudOffset, 0.0)).r;
          float ndl = dot(normalize(vN), normalize(uSun));
          float lit = smoothstep(-0.12, 0.5, ndl);
          vec3 col = mix(vec3(0.015, 0.02, 0.03), vec3(1.0, 0.98, 0.95) * 0.78, lit);
          col = mix(col, vec3(1.0, 0.55, 0.3), exp(-pow((ndl - 0.02) * 9.0, 2.0)) * 0.35 * lit);
          gl_FragColor = vec4(col, smoothstep(0.12, 0.95, c) * 0.88);
        }`,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.005, 160, 80), this.cloudMat);
    this.earth.add(this.clouds);

    // Atmosphere: back-face shell; brightness from the ray's closest approach to Earth's centre.
    this.atmoMat = material({
      side: THREE.BackSide, blending: THREE.AdditiveBlending,
      uniforms: { uSun: sun, uRe: { value: RE }, uH: { value: 0.07 } },
      vertexShader: /* glsl */ `${V_PARS}
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; ${V_END} }`,
      fragmentShader: /* glsl */ `${F_PARS}
        uniform vec3 uSun; uniform float uRe, uH;
        varying vec3 vW;
        void main() {
          ${F_START}
          vec3 D = normalize(vW - cameraPosition);
          float t = dot(-cameraPosition, D);
          vec3 P = cameraPosition + D * t;                  // closest approach (Earth at origin)
          float h = length(P) - uRe;
          if (h < 0.0) discard;
          float dens = exp(-h / uH);
          float sunSide = dot(normalize(P), normalize(uSun));
          float lit = smoothstep(-0.35, 0.35, sunSide);
          vec3 blue = vec3(0.30, 0.58, 1.0), dusk = vec3(1.0, 0.45, 0.2);
          vec3 col = mix(dusk, blue, smoothstep(-0.1, 0.45, sunSide)) * lit;
          gl_FragColor = vec4(col * dens * 1.25, 1.0);
        }`,
    });
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.06, 96, 48), this.atmoMat);
    this.scene.add(this.earth, atmo);
    this.labels.occluders.push({ center: new THREE.Vector3(), radius: RE });

    const self = this;
    this.anchor = {
      id: 'earth', name: 'Earth', kind: 'planet', layer: 'earth', radius: RE,
      position: (o) => o.set(0, 0, 0),
      info: () => ({
        kicker: 'Home planet', title: 'Earth', color: '#6fb6ff',
        rows: [
          ['Tracked active satellites', self.sats.length.toLocaleString('en-US')],
          ['Sub-solar point', self.subSolar()],
          ['Radius', '6,371 km'],
        ],
        body: 'Rotation uses Greenwich sidereal time and the terminator follows the real Sun direction, so day and night are correct for the displayed time.',
      }),
    };
    this.selectables_.push(this.anchor);
  }

  private subSolar() {
    const d = this.sunDir.clone().applyQuaternion(this.earth.quaternion.clone().invert());
    const lat = Math.asin(d.y) * 180 / Math.PI, lon = Math.atan2(-d.z, d.x) * 180 / Math.PI;
    return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
  }

  private buildMoonAndSun(moonTex: THREE.Texture) {
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1737.4 * KM, 96, 48), new THREE.MeshStandardMaterial({ map: moonTex, roughness: 1, metalness: 0 }));
    this.scene.add(this.moon);
    this.labels.occluders.push({ center: this.moonPos, radius: 1737.4 * KM });
    const moonSel: Selectable = {
      id: 'moon', name: 'Moon', kind: 'moon', layer: 'earth', radius: 1737.4 * KM,
      position: (o) => o.copy(this.moonPos),
      info: () => ({
        kicker: 'Natural satellite', title: 'Moon', color: '#d9d4c7',
        rows: [['Distance from Earth', formatDistance(this.moonPos.length() / KM)], ['Radius', '1,737 km'], ['Position', 'astronomy-engine (VSOP87 / ELP)']],
      }),
    };
    this.selectables_.push(moonSel);
    this.labels.add({ text: 'Moon', cls: 'body', position: (o) => o.copy(this.moonPos), near: 8, onClick: () => this.onPick?.(moonSel) });

    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunGlow(), blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(3, 2.8, 2.5) }));
    this.sunSprite.scale.setScalar(1392 * 18);
    this.scene.add(this.sunSprite);
  }

  // ------------------------------------------------------------------ Satellites
  private async buildSatellites(data: SatellitesData) {
    this.satsFetched = data.fetched;
    this.satsPartial = !!data.partial;
    const k = Object.fromEntries(data.keys.map((key, i) => [key, i]));
    this.sats = data.sats.map((r, i) => {
      const name = String(r[k.OBJECT_NAME]), mm = +r[k.MEAN_MOTION], ecc = +r[k.ECCENTRICITY];
      const omm: Record<string, string | number> = {};
      data.keys.forEach((key, j) => { if (key !== 'RECENT') omm[key] = r[j]; });
      return {
        i, name, norad: +r[k.NORAD_CAT_ID], intl: String(r[k.OBJECT_ID]), mm, ecc, inc: +r[k.INCLINATION], epoch: String(r[k.EPOCH]),
        recent: r[k.RECENT] === 1, cat: CATEGORIES.find((c) => c.match(name, mm, ecc))!, omm,
      };
    });
    const n = this.sats.length;
    CATEGORIES.forEach((c) => (this.catVisible[c.id] = true));
    this.satGeom = new THREE.BufferGeometry();
    this.satGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const col = new Float32Array(n * 3);
    this.satSize = new Float32Array(n);
    this.satGeom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.satGeom.setAttribute('size', new THREE.BufferAttribute(this.satSize, 1));
    this.satGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.refreshSatStyle();
    this.satPoints = new THREE.Points(this.satGeom, material({
      blending: THREE.NormalBlending, // stays visible in front of the bright dayside
      vertexShader: /* glsl */ `${V_PARS}
        attribute float size; attribute vec3 color; varying vec3 vColor; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          float px = size * clamp(40.0 / d, 0.55, 1.6);          // gently larger when close
          vA = size > 0.0 ? clamp(px / 1.2, 0.35, 1.0) : 0.0;
          vColor = color;
          gl_PointSize = max(px, 1.5) * uPixelRatio * step(0.001, size);
          ${V_END}
        }`,
      fragmentShader: /* glsl */ `${F_PARS}
        varying vec3 vColor; varying float vA;
        void main() {
          ${F_START}
          vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p);
          if (r2 > 1.0 || vA <= 0.0) discard;
          float a = exp(-r2 * 4.0) + 0.25 * exp(-r2 * 1.2);
          gl_FragColor = vec4(vColor * 1.25, clamp(a * vA * 1.3, 0.0, 1.0));
        }`,
      depthTest: true,
    }));
    this.satPoints.frustumCulled = false;
    this.scene.add(this.satPoints);

    this.worker = new Worker(new URL('./satWorker.ts', import.meta.url), { type: 'module' });
    await new Promise<void>((res) => {
      this.worker.onmessage = (e) => {
        if (e.data.type === 'ready') res();
        else if (e.data.type === 'positions') { this.base = e.data; this.pending = false; }
      };
      this.worker.postMessage({ type: 'init', records: this.sats.map((s) => s.omm) });
    });

    // orbit line + selection marker
    this.orbitLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.orbitLine.frustumCulled = false;
    this.orbitLine.visible = false;
    this.marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), depthTest: false, transparent: true, sizeAttenuation: false }));
    this.marker.scale.setScalar(0.035);
    this.marker.visible = false;
    this.marker.renderOrder = 10;
    this.scene.add(this.orbitLine, this.marker);

    this.satSelectables = this.sats.map((s) => this.satSelectable(s));
    // Always label the crewed stations
    for (const s of this.sats) {
      if (/^(ISS \(ZARYA\)|CSS \(TIANHE\))/.test(s.name)) {
        const sel = this.satSelectables[s.i];
        this.labels.add({ text: s.name.startsWith('ISS') ? 'ISS' : 'Tiangong', cls: 'station', color: '#ffffff', position: (o) => sel.position(o), far: 400, onClick: () => this.onPick?.(sel) });
      }
    }
  }

  private refreshSatStyle() {
    const col = this.satGeom.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color(), hot = new THREE.Color(RECENT_COLOR);
    for (const s of this.sats) {
      const recentHi = this.highlightRecent && s.recent;
      c.set(s.cat.color);
      if (recentHi) c.copy(hot);
      c.toArray(col.array, s.i * 3);
      const base = s.cat.id === 'stations' ? 4.2 : s.cat.id === 'starlink' ? 2.2 : 2.7;
      this.satSize[s.i] = this.catVisible[s.cat.id] ? (recentHi ? 3.4 : base) * (s.i === this.selectedSat ? 2.2 : 1) : 0;
    }
    col.needsUpdate = true;
    (this.satGeom.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
  }

  private satPos(i: number, jd: number, out: THREE.Vector3) {
    if (!this.base) return out.set(0, 0, 0);
    const dt = (jd - this.base.jd) * 86400;
    const p = this.base.pos, v = this.base.vel;
    return toThree((p[i * 3] + v[i * 3] * dt) * KM, (p[i * 3 + 1] + v[i * 3 + 1] * dt) * KM, (p[i * 3 + 2] + v[i * 3 + 2] * dt) * KM, out);
  }

  private currentJd = 0;
  private satSelectable(s: Sat): Selectable {
    const self = this;
    const v = new THREE.Vector3();
    return {
      id: 'sat:' + s.norad, name: s.name, kind: 'satellite', layer: 'earth', radius: 0.05,
      keywords: `${s.norad} ${s.intl} ${s.cat.label}`,
      position: (o) => self.satPos(s.i, self.currentJd, o),
      onSelect: () => self.selectSat(s.i),
      onDeselect: () => self.selectSat(-1),
      info(): InfoCard {
        self.satPos(s.i, self.currentJd, v);
        const r = v.length() / KM;
        const vel = self.base ? Math.hypot(self.base.vel[s.i * 3], self.base.vel[s.i * 3 + 1], self.base.vel[s.i * 3 + 2]) : 0;
        const perKm = 1440 / s.mm;
        const alt = r - 6371;
        const orbit = s.mm > 11.25 ? 'LEO' : s.mm > 0.95 && s.mm < 1.05 && s.ecc < 0.05 ? 'GEO' : s.ecc > 0.25 ? 'HEO' : 'MEO';
        let sub = '—';
        if (self.base && Number.isFinite(self.base.pos[s.i * 3])) {
          const eci = { x: v.x / KM, y: -v.z / KM, z: v.y / KM }; // three → TEME km
          const g = eciToGeodetic(eci as never, gstime(new Date(dateFromJd(self.currentJd))));
          const lat = g.latitude * 180 / Math.PI, lon = g.longitude * 180 / Math.PI;
          sub = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
        }
        const epochAge = (dateFromJd(self.currentJd) - Date.parse(s.epoch + 'Z')) / 864e5;
        return {
          kicker: s.recent ? `${s.cat.label} · launched in the last 30 days` : s.cat.label,
          title: s.name, color: s.recent && self.highlightRecent ? RECENT_COLOR : s.cat.color,
          rows: [
            ['Altitude', `${Math.round(alt).toLocaleString('en-US')} km`],
            ['Speed', `${vel.toFixed(2)} km/s  ·  ${Math.round(vel * 3600).toLocaleString('en-US')} km/h`],
            ['Orbit', `${orbit} · ${perKm < 200 ? perKm.toFixed(1) + ' min' : (perKm / 60).toFixed(2) + ' h'} period · ${s.inc.toFixed(1)}° incl.`],
            ['Ground point', sub],
            ['NORAD ID', String(s.norad)],
            ['Launch', `${s.intl.slice(0, 4)} · COSPAR ${s.intl}`],
            ['Elements', `${epochAge >= 0 ? epochAge.toFixed(1) + ' d old' : 'future epoch'} (SGP4)`],
          ],
          link: { label: 'CelesTrak SATCAT', url: `https://celestrak.org/satcat/table-satcat.php?CATNR=${s.norad}` },
        };
      },
    };
  }

  private selectSat(i: number) {
    this.selectedSat = i;
    this.refreshSatStyle();
    this.orbitRec = null;
    this.orbitLine.visible = i >= 0;
    this.marker.visible = i >= 0;
    if (i < 0) return;
    const s = this.sats[i];
    try { this.orbitRec = json2satrec(s.omm as never); } catch { this.orbitRec = null; }
    const color = new THREE.Color(s.recent && this.highlightRecent ? RECENT_COLOR : s.cat.color);
    (this.orbitLine.material as THREE.LineBasicMaterial).color = color;
    (this.marker.material as THREE.SpriteMaterial).color = color;
    this.orbitJd = 0;
  }

  private updateOrbitLine(jd: number) {
    const rec = this.orbitRec;
    if (!rec) return;
    const s = this.sats[this.selectedSat];
    const periodDays = 1 / s.mm;
    if (Math.abs(jd - this.orbitJd) < periodDays * 0.05) return;
    this.orbitJd = jd;
    const N = 360, pts: number[] = [], v = new THREE.Vector3();
    for (let k = 0; k <= N; k++) {
      const t = jd + (k / N) * periodDays;
      const pv = sgp4(rec, (t - rec.jdsatepoch) * 1440);
      if (!pv || !pv.position) continue;
      toThree(pv.position.x * KM, pv.position.y * KM, pv.position.z * KM, v);
      pts.push(v.x, v.y, v.z);
    }
    this.orbitLine.geometry.dispose();
    this.orbitLine.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }

  // ------------------------------------------------------------------ Deep space (L1/L2) + launch pads
  private buildDeepSpace(m: MissionsData) {
    for (const [id, track] of Object.entries(m.geo)) {
      const meta = MISSIONS[id];
      const color = new THREE.Color(meta?.color || '#fff');
      const pts: number[] = [];
      for (let k = 0; k < track.xyz.length; k += 3) {
        const v = toThree(track.xyz[k] * KM, track.xyz[k + 1] * KM, track.xyz[k + 2] * KM);
        pts.push(v.x, v.y, v.z);
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color, sizeAttenuation: false, depthWrite: false, transparent: true }));
      dot.scale.setScalar(0.018);
      const obj = new THREE.Group();
      obj.add(dot);
      this.deepGroup.add(line, obj);
      const entry = { id, track, obj, pos: obj.position, ok: true, sel: null as unknown as Selectable };
      entry.sel = {
        id: 'mission:' + id, name: meta?.short || track.name, kind: 'mission', layer: 'earth', radius: 5,
        keywords: track.name, position: (o) => o.copy(entry.pos),
        info: () => missionCard(id, track.name, [
          ['Distance from Earth', formatDistance(entry.pos.length() / KM)],
          ['Trajectory', 'JPL Horizons (geocentric)'],
        ]),
      };
      this.deep.push(entry);
      this.selectables_.push(entry.sel);
      this.labels.add({ text: meta?.short || track.name, color: meta?.color, cls: 'mission', position: (o) => o.copy(entry.pos), near: 40, visible: () => entry.ok && this.deepGroup.visible, onClick: () => this.onPick?.(entry.sel) });
    }
    this.scene.add(this.deepGroup);
  }

  private buildLaunchPads(launches: Launch[]) {
    this.launches = launches;
    const byPad = new Map<string, Launch[]>();
    for (const l of launches) {
      if (!Number.isFinite(l.lat) || Date.parse(l.net) < Date.now() - 864e5) continue;
      const key = `${l.lat.toFixed(2)},${l.lon.toFixed(2)}`;
      byPad.set(key, [...(byPad.get(key) || []), l]);
    }
    const tex = ringTexture();
    for (const list of byPad.values()) {
      const l = list[0];
      const lat = l.lat * Math.PI / 180, lon = l.lon * Math.PI / 180;
      const p = toThree(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)).multiplyScalar(RE * 1.002);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: '#ff5a36', sizeAttenuation: false, depthWrite: false, transparent: true }));
      s.scale.setScalar(0.014);
      s.position.copy(p);
      this.pads.add(s);
      const world = new THREE.Vector3();
      const sel: Selectable = {
        id: 'pad:' + l.pad, name: l.location, kind: 'launch', layer: 'earth', radius: 0.8,
        keywords: list.map((x) => x.name + ' ' + x.provider).join(' '),
        position: (o) => o.copy(s.getWorldPosition(world)),
        info: () => ({
          kicker: 'Upcoming launch' + (list.length > 1 ? `s · ${list.length} from this pad` : ''), title: l.name, color: '#ff5a36',
          rows: list.slice(0, 4).map((x) => [countdown(x.net), `${x.rocket} · ${x.provider}`] as [string, string]).concat([['Pad', `${l.pad}, ${l.location}`]]),
          body: l.mission || undefined,
          link: { label: 'Launch Library 2', url: 'https://thespacedevs.com/llapi' },
        }),
      };
      this.selectables_.push(sel);
      const next = list[0];
      this.labels.add({
        text: next.name.split('|').pop()!.trim(), sub: countdown(next.net), cls: 'launch', color: '#ff5a36',
        position: (o) => o.copy(s.getWorldPosition(world)), far: 60, visible: () => this.pads.visible, onClick: () => this.onPick?.(sel),
      });
    }
    this.earth.add(this.pads);
  }

  private buildToggles() {
    const counts: Record<string, number> = {};
    for (const s of this.sats) counts[s.cat.id] = (counts[s.cat.id] || 0) + 1;
    this.toggles = CATEGORIES.filter((c) => counts[c.id]).map((c) => ({
      id: c.id, label: c.label, color: c.color, count: counts[c.id], value: true,
      set: (v: boolean) => { this.catVisible[c.id] = v; this.refreshSatStyle(); },
    }));
    const recent = this.sats.filter((s) => s.recent).length;
    this.toggles.push(
      { id: 'recent', label: 'Launched in last 30 days', color: RECENT_COLOR, count: recent, value: true, set: (v) => { this.highlightRecent = v; this.refreshSatStyle(); } },
      { id: 'pads', label: 'Upcoming launch sites', color: '#ff5a36', value: true, set: (v) => (this.pads.visible = v) },
      { id: 'deep', label: 'L1 / L2 observatories', color: '#ffd60a', value: true, set: (v) => (this.deepGroup.visible = v) },
      { id: 'const', label: 'Constellation figures', value: false, set: (v) => (this.sky.lines.visible = v) },
    );
  }

  onPick?: (s: Selectable) => void;

  // ------------------------------------------------------------------ frame
  update({ clock, camera }: FrameCtx) {
    const jd = clock.jd;
    this.currentJd = jd;
    const date = clock.date;

    // Earth orientation + Sun/Moon (true-of-date equator to match SGP4/TEME)
    this.earth.rotation.y = gstime(date);
    const t = Astronomy.MakeTime(date);
    const rot = Astronomy.Rotation_EQJ_EQD(t);
    const sun = Astronomy.RotateVector(rot, Astronomy.GeoVector(Astronomy.Body.Sun, t, true));
    toThree(sun.x, sun.y, sun.z, this.sunDir).normalize();
    const sunDist = Math.hypot(sun.x, sun.y, sun.z) * AU_KM * KM;
    this.sunSprite.position.copy(this.sunDir).multiplyScalar(sunDist);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(100);
    const moon = Astronomy.RotateVector(rot, Astronomy.GeoMoon(t));
    toThree(moon.x * AU_KM * KM, moon.y * AU_KM * KM, moon.z * AU_KM * KM, this.moonPos);
    this.moon.position.copy(this.moonPos);
    this.moon.lookAt(0, 0, 0);
    this.moon.rotateY(-Math.PI / 2); // tidally locked: texture's lon 0 faces Earth
    (this.cloudMat.uniforms.uCloudOffset.value as number) = ((clock.ms / 864e5) * 0.004) % 1;

    // satellites
    if (!this.pending) {
      this.pending = true;
      this.worker.postMessage({ type: 'propagate', jd: jd + (clock.running ? (clock.rate * 0.03) / 86400 : 0) });
    }
    if (this.base) {
      const posAttr = this.satGeom.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array, p = this.base.pos, v = this.base.vel;
      const dt = (jd - this.base.jd) * 86400;
      for (let i = 0, n = this.sats.length; i < n; i++) {
        const x = p[i * 3];
        if (x !== x) { arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 0; continue; }
        arr[i * 3] = (x + v[i * 3] * dt) * KM;
        arr[i * 3 + 1] = (p[i * 3 + 2] + v[i * 3 + 2] * dt) * KM;
        arr[i * 3 + 2] = -(p[i * 3 + 1] + v[i * 3 + 1] * dt) * KM;
      }
      posAttr.needsUpdate = true;
    }
    if (this.selectedSat >= 0) {
      this.updateOrbitLine(jd);
      this.satPos(this.selectedSat, jd, this.marker.position);
    }

    for (const d of this.deep) {
      const out: [number, number, number] = [0, 0, 0];
      d.ok = sampleTrack(d.track, jd, out);
      d.obj.visible = d.ok;
      if (d.ok) toThree(out[0] * KM, out[1] * KM, out[2] * KM, d.pos);
    }
    // keep the sky visible but let Earth dominate when close
    const camDist = camera.position.length();
    const deepFade = THREE.MathUtils.smoothstep(camDist, 60, 600);
    this.deepGroup.children.forEach((c) => { if (c instanceof THREE.Line) (c.material as THREE.LineBasicMaterial).opacity = 0.35 * deepFade; });
    this.sky.setBrightness(THREE.MathUtils.smoothstep(camDist, RE * 1.2, RE * 4) * 0.6 + 0.4);
  }

  pick(ray: THREE.Raycaster, camera: THREE.PerspectiveCamera): Selectable | null {
    const camDist = camera.position.length();
    ray.params.Points = { threshold: Math.max(0.02, (camDist - RE) * 0.012) };
    const earthHit = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), RE), new THREE.Vector3());
    const earthT = earthHit ? earthHit.distanceTo(ray.ray.origin) : Infinity;
    let best: Selectable | null = null, bestScore = Infinity;
    for (const hit of ray.intersectObject(this.satPoints)) {
      const i = hit.index!;
      if (this.satSize[i] === 0 || hit.distance > earthT) continue;
      const score = hit.distanceToRay! / Math.max(hit.distance, 1e-6);
      if (score < bestScore) { bestScore = score; best = this.satSelectables[i]; }
    }
    if (best) return best;
    // pads / deep-space markers / Moon: screen-space proximity
    const v = new THREE.Vector3();
    for (const s of this.selectables_) {
      if (s.kind === 'planet') continue;
      if (s.kind === 'launch' && !this.pads.visible) continue;
      s.position(v);
      const dist = v.distanceTo(ray.ray.origin);
      if (dist > earthT && s.kind !== 'moon') continue;
      const ang = ray.ray.distanceToPoint(v) / dist;
      const lim = s.kind === 'moon' ? Math.max(0.012, (1737.4 * KM) / dist) : 0.012;
      if (ang < lim && ang < bestScore) { bestScore = ang; best = s; }
    }
    if (best) return best;
    return earthHit ? this.anchor : null;
  }

  selectables() {
    return [...this.selectables_, ...this.satSelectables];
  }

  home() {
    const side = this.sunDir.clone().multiplyScalar(0.7).add(new THREE.Vector3(0, 0.35, 0)).normalize();
    return { position: side.multiplyScalar(RE * 3.6), target: new THREE.Vector3() };
  }

  flySpeed(pos: THREE.Vector3) {
    return Math.max(0.05, (pos.length() - RE) * 0.6);
  }

  onEnter() {
    this.scene.add(this.sky.group);
    this.sky.setFrame(new THREE.Matrix3()); // equatorial
  }
}

export function countdown(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  const abs = Math.abs(ms), d = Math.floor(abs / 864e5), h = Math.floor((abs % 864e5) / 36e5), m = Math.floor((abs % 36e5) / 6e4);
  const s = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return ms >= 0 ? `T−${s}` : `T+${s}`;
}

export function missionCard(id: string, name: string, rows: [string, string][]): InfoCard {
  const m = MISSIONS[id];
  return {
    kicker: m ? `${m.agency} · launched ${m.launched}` : 'Spacecraft',
    title: m?.short || name, color: m?.color,
    rows, body: m?.about, link: m ? { label: 'Mission page', url: m.url } : undefined,
  };
}
