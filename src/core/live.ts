import { json, type EventsData, type LaunchesData, type SatellitesData } from './data';

/*
 * Live feeds fetched straight from the browser (these APIs send CORS headers), falling back to the snapshot written by
 * scripts/fetch-data.mjs at build time. JPL (Horizons, SBDB) has no CORS, so missions/asteroids always use the snapshot.
 */

const SAT_KEYS = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'NORAD_CAT_ID', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];

async function getJson<T>(url: string, timeout = 10000): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`${r.status}`);
  // CelesTrak answers repeat downloads (<2 h) with a plain-text notice instead of JSON
  const text = await r.text();
  return JSON.parse(text) as T;
}

const memo = new Map<string, Promise<unknown>>();
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key) as Promise<T>;
}

export type Live<T> = T & { live: boolean };

export function loadSatellites(): Promise<Live<SatellitesData>> {
  return once('sats', async () => {
    try {
      const gp = (g: string) => getJson<Record<string, string | number>[]>(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`, 15000);
      const [active, recent] = await Promise.all([gp('active'), gp('last-30-days').catch(() => [])]);
      if (!Array.isArray(active) || active.length < 1000) throw new Error('unexpected CelesTrak response');
      const recentIds = new Set(recent.map((s) => s.NORAD_CAT_ID));
      return {
        live: true, fetched: new Date().toISOString(), source: 'CelesTrak GP (live)', keys: [...SAT_KEYS, 'RECENT'],
        sats: active.map((s) => [...SAT_KEYS.map((k) => s[k]), recentIds.has(s.NORAD_CAT_ID) ? 1 : 0]),
      };
    } catch (e) {
      console.info('Satellites: using build snapshot', e);
      const snap = await json<SatellitesData>('satellites.json').catch(() => null);
      return { ...(snap ?? { fetched: new Date().toISOString(), source: 'unavailable', keys: [...SAT_KEYS, 'RECENT'], sats: [] }), live: false };
    }
  });
}

export function loadLaunches(): Promise<Live<LaunchesData> | null> {
  return once('launches', async () => {
    try {
      const j = await getJson<{ results: Record<string, any>[] }>('https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=15&mode=normal');
      return {
        live: true, fetched: new Date().toISOString(),
        launches: j.results.map((l) => ({
          name: l.name, net: l.net, status: l.status?.abbrev, provider: l.launch_service_provider?.name,
          rocket: l.rocket?.configuration?.full_name, pad: l.pad?.name, location: l.pad?.location?.name,
          lat: +l.pad?.latitude, lon: +l.pad?.longitude, mission: l.mission?.description?.slice(0, 280) || null,
          orbit: l.mission?.orbit?.abbrev || null,
        })),
      };
    } catch {
      const snap = await json<LaunchesData>('launches.json').catch(() => null);
      return snap && { ...snap, live: false };
    }
  });
}

export function loadEvents(): Promise<EventsData | null> {
  return once('events', async () => {
    const snap = await json<EventsData>('events.json').catch(() => null);
    const day = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
    const key = import.meta.env.VITE_NASA_API_KEY || 'DEMO_KEY'; // free key: https://api.nasa.gov (DEMO_KEY is heavily rate-limited)
    const [flares, cmes] = await Promise.all([
      getJson<any[]>(`https://api.nasa.gov/DONKI/FLR?startDate=${day(-30)}&endDate=${day(0)}&api_key=${key}`).catch(() => null),
      getJson<any[]>(`https://api.nasa.gov/DONKI/CMEAnalysis?startDate=${day(-30)}&endDate=${day(0)}&mostAccurateOnly=true&api_key=${key}`).catch(() => null),
    ]);
    return {
      fetched: snap?.fetched ?? new Date().toISOString(),
      flares: flares ? flares.map((f) => ({ peak: f.peakTime, cls: f.classType, region: f.activeRegionNum })).reverse() : snap?.flares,
      cmes: cmes ? cmes.map((c) => ({ time: c.time21_5, speed: c.speed, type: c.type, halfAngle: c.halfAngle })).reverse() : snap?.cmes,
      neos: snap?.neos, // JPL close-approach API has no CORS → build snapshot
    };
  });
}
