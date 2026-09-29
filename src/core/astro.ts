import * as THREE from 'three';

export const D2R = Math.PI / 180;
export const AU_KM = 149597870.7;
export const OBLIQUITY = 23.4392911 * D2R;

/** Galactocentric frame (astropy convention): GC at origin, Sun at X=-R0, +Y toward l=90°, +Z toward NGP. Units: pc. */
export const R0 = 8122;
export const Z_SUN = 20.8;

/**
 * Every physical frame here is right-handed with Z = "north" (celestial pole, ecliptic pole or NGP).
 * three.js is Y-up, so (x, y, z) → (x, z, -y). This is a proper rotation, so handedness is preserved.
 */
export function toThree(x: number, y: number, z: number, out = new THREE.Vector3()) {
  return out.set(x, z, -y);
}
export function fromThree(v: THREE.Vector3): [number, number, number] {
  return [v.x, -v.z, v.y];
}

const P = new THREE.Matrix3().set(1, 0, 0, 0, 0, 1, 0, -1, 0);
const PT = P.clone().transpose();
/** Wrap a physical-frame rotation so it acts on three.js vectors. */
export function frameMatrixToThree(m: THREE.Matrix3) {
  return P.clone().multiply(m).multiply(PT);
}

/** ICRS equatorial → galactic (Hipparcos definition). */
export const EQ_TO_GAL = new THREE.Matrix3().set(
  -0.0548755604, -0.8734370902, -0.4838350155,
  0.4941094279, -0.44482963, 0.7469822445,
  -0.867666149, -0.1980763734, 0.4559837762,
);
const c = Math.cos(OBLIQUITY), s = Math.sin(OBLIQUITY);
export const ECL_TO_EQ = new THREE.Matrix3().set(1, 0, 0, 0, c, -s, 0, s, c);
export const EQ_TO_ECL = ECL_TO_EQ.clone().transpose();

export function radecToVec(raRad: number, decRad: number, out = new THREE.Vector3()) {
  const cd = Math.cos(decRad);
  return toThree(cd * Math.cos(raRad), cd * Math.sin(raRad), Math.sin(decRad), out);
}

export const jdFromDate = (ms: number) => ms / 864e5 + 2440587.5;
export const dateFromJd = (jd: number) => (jd - 2440587.5) * 864e5;

/** Approximate stellar colour from B−V (Ballesteros 2012 → blackbody). Returns linear RGB. */
export function colorFromBV(bv: number, out = new THREE.Color()) {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  return colorFromKelvin(t, out);
}
/** Gaia BP−RP → effective temperature (Mucciarelli & Bellazzini 2020, dwarfs). */
export function kelvinFromBpRp(bprp: number) {
  const x = Math.max(-0.4, Math.min(4, bprp));
  return 5040 / (0.4929 + 0.5092 * x - 0.0353 * x * x);
}
/** Blackbody-ish colour (Tanner Helland fit), desaturated a touch so stars read as stars, not LEDs. */
export function colorFromKelvin(kelvin: number, out = new THREE.Color()) {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const cl = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  out.setRGB(cl(r), cl(g), cl(b), THREE.SRGBColorSpace);
  const l = (out.r + out.g + out.b) / 3;
  return out.lerp(new THREE.Color(l, l, l), 0.12);
}

/** Deterministic PRNG so the procedural galaxy looks the same every visit. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussian(rand: () => number) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export function formatDistance(km: number) {
  if (km < 1e5) return `${Math.round(km).toLocaleString('en-US')} km`;
  if (km < 0.1 * AU_KM) return `${(km / 1e6).toFixed(2)} M km`;
  const au = km / AU_KM;
  if (au < 20000) return `${au < 10 ? au.toFixed(3) : au.toFixed(1)} AU`;
  const ly = km / 9.4607e12;
  return ly < 1000 ? `${ly.toFixed(1)} ly` : `${(ly / 1000).toFixed(2)} kly`;
}
