import * as THREE from 'three';

const base = import.meta.env.BASE_URL + 'data/';

export async function json<T>(name: string): Promise<T> {
  const r = await fetch(base + name);
  if (!r.ok) throw new Error(`${name}: ${r.status} — run "npm run data"`);
  return r.json();
}
export async function f32(name: string): Promise<Float32Array> {
  const r = await fetch(base + name);
  if (!r.ok) throw new Error(`${name}: ${r.status} — run "npm run data"`);
  return new Float32Array(await r.arrayBuffer());
}

const loader = new THREE.TextureLoader();
const cache = new Map<string, Promise<THREE.Texture>>();
export function texture(name: string, srgb = true) {
  if (!cache.has(name)) {
    cache.set(name, loader.loadAsync(import.meta.env.BASE_URL + 'textures/' + name).then((t) => {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    }));
  }
  return cache.get(name)!;
}

export interface SatellitesData {
  fetched: string;
  source: string;
  partial?: boolean;
  keys: string[];
  sats: (string | number)[][];
}
export interface MissionTrack { name: string; jd0: number; step: number; xyz: number[] }
export interface MissionsData { fetched: string; helio: Record<string, MissionTrack>; geo: Record<string, MissionTrack> }
export interface Launch {
  name: string; net: string; status: string; provider: string; rocket: string; pad: string; location: string;
  lat: number; lon: number; mission: string | null; orbit: string | null;
}
export interface LaunchesData { fetched: string; launches: Launch[] }
export interface EventsData {
  fetched: string;
  flares?: { peak: string; cls: string; region: number | null }[];
  cmes?: { time: string; speed: number; type: string; halfAngle: number }[];
  neos?: { name: string; date: string; distAU: number; vRel: number; h: number; diameter: number | null }[];
}
export interface StarsData {
  sky: [number, number, number, number][];
  named: { n: string; ra: number; dec: number; mag: number; d: number; sp: string; ci: number; g: [number, number, number] }[];
}
