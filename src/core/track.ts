import type { MissionTrack } from './data';

/** Catmull-Rom interpolation of an evenly-sampled Horizons track. Returns false outside the ephemeris window. */
export function sampleTrack(t: MissionTrack, jd: number, out: [number, number, number]) {
  const n = t.xyz.length / 3;
  const f = (jd - t.jd0) / t.step;
  if (f < 0 || f > n - 1) return false;
  const i = Math.min(Math.floor(f), n - 2), u = f - i;
  const i0 = Math.max(i - 1, 0), i2 = i + 1, i3 = Math.min(i + 2, n - 1);
  const u2 = u * u, u3 = u2 * u;
  for (let k = 0; k < 3; k++) {
    const p0 = t.xyz[i0 * 3 + k], p1 = t.xyz[i * 3 + k], p2 = t.xyz[i2 * 3 + k], p3 = t.xyz[i3 * 3 + k];
    out[k] = 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  }
  return true;
}

export function trackRange(t: MissionTrack) {
  return [t.jd0, t.jd0 + (t.xyz.length / 3 - 1) * t.step] as const;
}
