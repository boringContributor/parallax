import { json2satrec, sgp4, type SatRec } from 'satellite.js';

// SGP4 for the whole catalogue off the main thread. The main thread asks for a Julian date; we answer with TEME
// positions (km) and velocities (km/s) that it extrapolates linearly until the next batch arrives.
let recs: (SatRec | null)[] = [];
const ctx = self as unknown as { postMessage(msg: unknown, transfer?: Transferable[]): void };

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    recs = msg.records.map((r: Record<string, string | number>) => {
      try { return json2satrec(r as never); } catch { return null; }
    });
    ctx.postMessage({ type: 'ready', count: recs.length });
  } else if (msg.type === 'propagate') {
    const jd: number = msg.jd;
    const n = recs.length;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const rec = recs[i];
      const pv = rec ? sgp4(rec, (jd - rec.jdsatepoch) * 1440) : null;
      if (pv && pv.position && Number.isFinite(pv.position.x)) {
        pos[i * 3] = pv.position.x; pos[i * 3 + 1] = pv.position.y; pos[i * 3 + 2] = pv.position.z;
        vel[i * 3] = pv.velocity.x; vel[i * 3 + 1] = pv.velocity.y; vel[i * 3 + 2] = pv.velocity.z;
      } else {
        pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = NaN; // decayed / invalid → hidden
      }
    }
    ctx.postMessage({ type: 'positions', jd, pos, vel }, [pos.buffer, vel.buffer]);
  }
};
