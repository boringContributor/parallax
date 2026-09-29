#!/usr/bin/env node
// Snapshots open space data into public/data and public/textures.
// Live feeds (satellites, missions, launches, space weather) refresh when older than 2h
// (CelesTrak only updates every 2h and blocks re-downloads). Catalogs & textures are fetched once.
// Usage: node scripts/fetch-data.mjs [--force] [--only=name,name]
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'public/data');
const TEX = path.join(ROOT, 'public/textures');
const FORCE = process.argv.includes('--force');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const LIVE_MAX_AGE = 2 * 3600 * 1000;
const NASA_KEY = process.env.NASA_API_KEY || process.env.VITE_NASA_API_KEY || 'DEMO_KEY';
const UA = { 'User-Agent': 'space-viz/0.1 (open data visualisation)' };

const log = (...a) => console.log('  ·', ...a);

async function fresh(file, maxAge) {
  if (FORCE || !existsSync(file)) return false;
  if (maxAge === Infinity) return true;
  return Date.now() - (await stat(file)).mtimeMs < maxAge;
}

async function get(url, { type = 'text', retries = 2, timeout = 180000 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return type === 'json' ? res.json() : type === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
    } catch (e) {
      if (i >= retries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
}

const tap = (base, query) =>
  `${base}?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(query)}`;
const VIZIER = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';
const GAIA = 'https://gea.esac.esa.int/tap-server/tap/sync';

// ---------- coordinate helpers (all galactocentric output uses astropy's convention:
// GC at origin, Sun at X = -8122 pc, Z = +20.8 pc, +Y toward l = 90°) ----------
const R0 = 8122, ZSUN = 20.8;
const D2R = Math.PI / 180;
const EQ2GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
];
function radecToGalacto(raDeg, decDeg, distPc) {
  const ra = raDeg * D2R, dec = decDeg * D2R;
  const e = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const g = EQ2GAL.map((r) => r[0] * e[0] + r[1] * e[1] + r[2] * e[2]);
  // heliocentric galactic (x→GC, y→l=90, z→NGP), then shift by Sun position (small tilt ignored)
  return [g[0] * distPc - R0, g[1] * distPc, g[2] * distPc + ZSUN];
}

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

// ------------------------------------------------------------------------------------------
const jobs = {
  // ---------------- LIVE ----------------
  async satellites() {
    const out = path.join(DATA, 'satellites.json');
    // CelesTrak allows one download per group every 2 h, so even a partial file counts as fresh for that long
    const partial = existsSync(out) && JSON.parse(await readFile(out, 'utf8')).partial;
    if (await fresh(out, LIVE_MAX_AGE)) return log(`satellites: cached${partial ? ' (partial — full catalogue retried after 2 h)' : ''}`);
    const gp = async (group) => {
      const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`, { headers: UA });
      const t = await res.text();
      if (!t.trim().startsWith('[')) throw new Error(t.trim().replace(/\s+/g, ' ').slice(0, 120));
      return JSON.parse(t);
    };
    let list, isPartial = false;
    try { list = await gp('active'); } catch (e) {
      if (existsSync(out) && !partial) return log('satellites: CelesTrak →', e.message, '→ keeping cache');
      // CelesTrak allows one download per group per 2h. Assemble a partial catalogue from smaller groups.
      log('satellites: "active" unavailable (' + e.message + ') → merging smaller groups');
      const byId = new Map();
      for (const g of ['stations', 'visual', 'gnss', 'geo', 'weather', 'science', 'oneweb', 'kuiper', 'starlink', 'iridium-NEXT', 'planet', 'last-30-days']) {
        try { for (const s of await gp(g)) byId.set(s.NORAD_CAT_ID, s); } catch (err) { log(`  group ${g}: ${err.message.slice(0, 60)}`); }
      }
      list = [...byId.values()];
      isPartial = true;
      if (!list.length) throw new Error('no CelesTrak group available right now — try again after the next 2h update');
    }
    let recent = [];
    try { recent = (await gp('last-30-days')).map((s) => s.NORAD_CAT_ID); } catch {}
    const recentSet = new Set(recent);
    const keys = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
      'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'NORAD_CAT_ID', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
    const sats = list.map((s) => [...keys.map((k) => s[k]), recentSet.has(s.NORAD_CAT_ID) ? 1 : 0]);
    await writeFile(out, JSON.stringify({ fetched: new Date().toISOString(), source: 'CelesTrak GP', partial: isPartial, keys: [...keys, 'RECENT'], sats }));
    log(`satellites: ${sats.length}${isPartial ? ' (partial)' : ''} active, ${recent.length} launched in last 30 days`);
  },

  async missions() {
    const out = path.join(DATA, 'missions.json');
    if (await fresh(out, LIVE_MAX_AGE * 12)) return log('missions: cached');
    const now = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const add = (days) => new Date(now.getTime() + days * 864e5);
    // Heliocentric ecliptic J2000 trajectories (AU) for the deep-space fleet
    const helio = [
      [-31, 'Voyager 1'], [-32, 'Voyager 2'], [-98, 'New Horizons'], [-96, 'Parker Solar Probe'],
      [-61, 'Juno'], [-159, 'Europa Clipper'], [-28, 'JUICE'], [-121, 'BepiColombo'], [-255, 'Psyche'],
      [-49, 'Lucy'], [-91, 'Hera'], [-144, 'Solar Orbiter'], [-64, 'OSIRIS-APEX'], [-37, 'Hayabusa2'],
      [-234, 'STEREO-A'], [-74, 'Mars Reconnaissance Orbiter'], [-62, 'Emirates Mars Mission'],
      [-170, 'James Webb Space Telescope'], [-680, 'Euclid'], [-21, 'SOHO'],
    ];
    // Geocentric (km, equatorial J2000) for the Lagrange-point observatories
    const geo = [[-170, 'James Webb Space Telescope'], [-680, 'Euclid'], [-21, 'SOHO']];
    async function horizons(id, center, start, stop, step, plane) {
      const p = new URLSearchParams({
        format: 'json', COMMAND: `'${id}'`, EPHEM_TYPE: 'VECTORS', CENTER: `'${center}'`,
        START_TIME: `'${start}'`, STOP_TIME: `'${stop}'`, STEP_SIZE: `'${step}'`, VEC_TABLE: '1',
        CSV_FORMAT: 'YES', OBJ_DATA: 'NO', OUT_UNITS: center === '500@10' ? 'AU-D' : 'KM-S', REF_PLANE: plane,
      });
      const j = await get('https://ssd.jpl.nasa.gov/api/horizons.api?' + p, { type: 'json' });
      const r = j.result || '';
      const a = r.indexOf('$$SOE'), b = r.indexOf('$$EOE');
      if (a < 0) throw new Error(r.trim().split('\n').slice(-2).join(' ').slice(0, 160));
      return r.slice(a + 5, b).trim().split('\n').map((l) => {
        const c = l.split(',').map((s) => s.trim());
        return [+c[0], +c[2], +c[3], +c[4]];
      });
    }
    // Horizons rejects ranges outside a craft's ephemeris → read the coverage bound from the error and retry
    const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const hDate = (s) => { const m = s.match(/(\d{4})-([A-Z]{3})-(\d{2})/); return m && new Date(Date.UTC(+m[1], MON[m[2]], +m[3])); };
    async function horizonsFit(id, center, back, fwd, step, plane) {
      let start = add(-back), stop = add(fwd);
      for (let i = 0; i < 4; i++) {
        try { return await horizons(id, center, iso(start), iso(stop), step, plane); } catch (e) {
          const after = e.message.match(/after A\.D\. (\S+)/), prior = e.message.match(/prior to A\.D\. (\S+)/);
          if (after) stop = new Date(hDate(after[1]).getTime() - 864e5);
          else if (prior) start = new Date(hDate(prior[1]).getTime() + 2 * 864e5);
          else throw e;
          if (stop <= start) throw e;
        }
      }
      throw new Error('no coverage');
    }
    const result = { fetched: now.toISOString(), source: 'JPL Horizons', helio: {}, geo: {} };
    for (const [id, name] of helio) {
      try {
        const rows = await horizonsFit(id, '500@10', 730, 400, '2d', 'ECLIPTIC');
        result.helio[id] = { name, jd0: rows[0][0], step: rows[1][0] - rows[0][0], xyz: rows.flatMap((r) => r.slice(1).map((v) => round(v, 5))) };
        log(`missions: ${name} (${rows.length} samples)`);
      } catch (e) { log(`missions: ${name} skipped — ${e.message}`); }
    }
    for (const [id, name] of geo) {
      try {
        const rows = await horizonsFit(id, '500@399', 120, 120, '12h', 'FRAME');
        result.geo[id] = { name, jd0: rows[0][0], step: rows[1][0] - rows[0][0], xyz: rows.flatMap((r) => r.slice(1).map((v) => Math.round(v))) };
        log(`missions: ${name} geocentric (${rows.length} samples)`);
      } catch (e) { log(`missions: ${name} geocentric skipped — ${e.message}`); }
    }
    await writeFile(out, JSON.stringify(result));
  },

  async launches() {
    const out = path.join(DATA, 'launches.json');
    if (await fresh(out, LIVE_MAX_AGE)) return log('launches: cached');
    let j;
    for (const host of ['ll.thespacedevs.com', 'lldev.thespacedevs.com']) {
      try { j = await get(`https://${host}/2.3.0/launches/upcoming/?limit=15&mode=normal`, { type: 'json', timeout: 30000, retries: 0 }); break; } catch (e) { log('launches:', host, e.message); }
    }
    if (!j) return;
    const launches = j.results.map((l) => ({
      name: l.name, net: l.net, status: l.status?.abbrev, provider: l.launch_service_provider?.name,
      rocket: l.rocket?.configuration?.full_name, pad: l.pad?.name, location: l.pad?.location?.name,
      lat: +l.pad?.latitude, lon: +l.pad?.longitude, mission: l.mission?.description?.slice(0, 280) || null,
      orbit: l.mission?.orbit?.abbrev || null,
    }));
    await writeFile(out, JSON.stringify({ fetched: new Date().toISOString(), source: 'Launch Library 2 (The Space Devs)', launches }));
    log(`launches: ${launches.length} upcoming`);
  },

  async events() {
    const out = path.join(DATA, 'events.json');
    if (await fresh(out, LIVE_MAX_AGE)) return log('events: cached');
    const d = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
    const res = { fetched: new Date().toISOString() };
    try {
      const flares = await get(`https://api.nasa.gov/DONKI/FLR?startDate=${d(-30)}&endDate=${d(0)}&api_key=${NASA_KEY}`, { type: 'json' });
      res.flares = flares.map((f) => ({ peak: f.peakTime, cls: f.classType, region: f.activeRegionNum })).reverse();
    } catch (e) { log('events: flares', e.message); }
    try {
      const cme = await get(`https://api.nasa.gov/DONKI/CMEAnalysis?startDate=${d(-30)}&endDate=${d(0)}&mostAccurateOnly=true&api_key=${NASA_KEY}`, { type: 'json' });
      res.cmes = cme.map((c) => ({ time: c.time21_5, speed: c.speed, type: c.type, halfAngle: c.halfAngle })).reverse();
    } catch (e) { log('events: cme', e.message); }
    try {
      const cad = await get(`https://ssd-api.jpl.nasa.gov/cad.api?dist-max=0.05&date-min=${d(-3)}&date-max=${d(60)}&sort=date&diameter=true&fullname=true`, { type: 'json' });
      const f = cad.fields;
      res.neos = (cad.data || []).map((r) => {
        const o = Object.fromEntries(f.map((k, i) => [k, r[i]]));
        return { name: o.fullname.trim(), date: o.cd, distAU: +o.dist, vRel: +o.v_rel, h: +o.h, diameter: o.diameter ? +o.diameter : null };
      });
    } catch (e) { log('events: neos', e.message); }
    await writeFile(out, JSON.stringify(res));
    log(`events: ${res.flares?.length ?? 0} flares, ${res.cmes?.length ?? 0} CMEs, ${res.neos?.length ?? 0} NEO close approaches`);
  },

  // ---------------- CATALOGS ----------------
  async gaia() {
    const out = path.join(DATA, 'gaia.bin');
    if (await fresh(out, Infinity)) return log('gaia: cached');
    log('gaia: querying DR3 (stars within 1 kpc, G < 10.5)… this takes a minute');
    const q = `SELECT ra, dec, parallax, phot_g_mean_mag, bp_rp FROM gaiadr3.gaia_source
      WHERE parallax > 1 AND parallax_over_error > 10 AND phot_g_mean_mag < 10.5 AND bp_rp IS NOT NULL`;
    const rows = parseCSV(await get(tap(GAIA, q), { timeout: 900000 }));
    const buf = new Float32Array(rows.length * 5);
    rows.forEach((r, i) => {
      const plx = +r.parallax, d = 1000 / plx;
      const [x, y, z] = radecToGalacto(+r.ra, +r.dec, d);
      buf.set([x, y, z, +r.bp_rp, +r.phot_g_mean_mag + 5 * Math.log10(plx / 100)], i * 5);
    });
    await writeFile(out, Buffer.from(buf.buffer));
    log(`gaia: ${rows.length} stars`);
  },

  async hyg() {
    const out = path.join(DATA, 'stars.json');
    if (await fresh(out, Infinity)) return log('hyg: cached');
    const rows = parseCSV(await get('https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv'));
    // Sky layer: every naked-eye-ish star (mag < 7) as [ra(h), dec, mag, ci]
    const sky = rows.filter((r) => +r.mag < 7 && r.proper !== 'Sol').map((r) => [round(+r.ra, 4), round(+r.dec, 3), round(+r.mag, 2), round(+r.ci || 0.6, 2)]);
    // Named stars for labels (sky + galaxy neighbourhood)
    const named = rows.filter((r) => r.proper && r.proper !== 'Sol' && +r.dist < 5000).map((r) => {
      const [x, y, z] = radecToGalacto(+r.ra * 15, +r.dec, +r.dist);
      return { n: r.proper, ra: round(+r.ra, 4), dec: round(+r.dec, 3), mag: round(+r.mag, 2), d: round(+r.dist, 1), sp: r.spect, ci: round(+r.ci || 0.6, 2), g: [round(x), round(y), round(z)] };
    });
    await writeFile(out, JSON.stringify({ source: 'HYG v4.1 (astronexus)', sky, named }));
    log(`hyg: ${sky.length} sky stars, ${named.length} named`);
  },

  async constellations() {
    const out = path.join(DATA, 'constellations.json');
    if (await fresh(out, Infinity)) return log('constellations: cached');
    const j = await get('https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json', { type: 'json' });
    const lines = j.features.flatMap((f) => f.geometry.coordinates.map((l) => l.map(([lon, lat]) => [round(lon, 3), round(lat, 3)])));
    await writeFile(out, JSON.stringify(lines));
    log(`constellations: ${lines.length} polylines`);
  },

  async clusters() {
    const out = path.join(DATA, 'clusters.json');
    if (await fresh(out, Infinity)) return log('clusters: cached');
    const rows = parseCSV(await get(tap(VIZIER, 'SELECT Name, Type, N, X, Y, Z, dist50, logAge50, r50pc FROM "J/A+A/673/A114/clusters" WHERE Type = \'o\'')));
    const clusters = rows.filter((r) => r.X && r.logAge50).map((r) => [r.Name.replace(/_/g, ' '), round(+r.X), round(+r.Y), round(+r.Z), round(+r.logAge50, 2), +r.N, round(+r.dist50), round(+r.r50pc || 1, 1)]);
    await writeFile(out, JSON.stringify({ source: 'Hunt & Reffert 2023, A&A 673, A114 (Gaia DR3)', keys: ['name', 'x', 'y', 'z', 'logAge', 'members', 'dist', 'r50'], clusters }));
    log(`clusters: ${clusters.length} open clusters`);
  },

  async masers() {
    const out = path.join(DATA, 'masers.json');
    if (await fresh(out, Infinity)) return log('masers: cached');
    const rows = parseCSV(await get(tap(VIZIER, 'SELECT Name, OName, RAJ2000, DEJ2000, plx, e_plx, Arm FROM "J/ApJ/885/131/table1"')));
    const masers = rows.filter((r) => +r.plx > 0).map((r) => {
      const [x, y, z] = radecToGalacto(+r.RAJ2000, +r.DEJ2000, 1000 / +r.plx);
      return [r.Name.trim(), (r.OName || '').trim(), round(x), round(y), round(z), r.Arm.trim(), round(1 / +r.plx, 2), round(+r.e_plx / +r.plx, 2)];
    });
    await writeFile(out, JSON.stringify({ source: 'Reid et al. 2019, ApJ 885, 131', keys: ['name', 'alias', 'x', 'y', 'z', 'arm', 'distKpc', 'relErr'], masers }));
    log(`masers: ${masers.length} parallax-measured star-forming regions`);
  },

  async globulars() {
    const out = path.join(DATA, 'globulars.json');
    if (await fresh(out, Infinity)) return log('globulars: cached');
    const txt = await get('https://people.smp.uq.edu.au/HolgerBaumgardt/globular/orbits_table.txt');
    // Baumgardt frame: +X from GC toward the Sun → flip X (and U) into the astropy convention (kpc → pc)
    const gcs = txt.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 27).map((c) => [
      c[0].replace(/_/g, ' '), round(-c[15] * 1000), round(+c[17] * 1000), round(+c[19] * 1000), -c[21], +c[23], +c[25], +c[5],
    ]);
    await writeFile(out, JSON.stringify({ source: 'Baumgardt et al. (Gaia EDR3 orbits)', keys: ['name', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'distSunKpc'], gcs }));
    log(`globulars: ${gcs.length} globular clusters with 6D phase space`);
  },

  async asteroids() {
    const out = path.join(DATA, 'asteroids.bin');
    if (await fresh(out, Infinity)) return log('asteroids: cached');
    const q = (cdata, extra = '') => get('https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=full_name,a,e,i,om,w,ma,epoch,H,neo,pha,class&sb-kind=a&limit=100000'
      + extra + '&sb-cdata=' + encodeURIComponent(JSON.stringify(cdata)), { type: 'json', timeout: 600000 });
    const bright = await q({ AND: ['H|LT|15.5'] });
    const neos = await q({ AND: ['H|LT|22'] }, '&sb-group=neo');
    const CLASSES = ['MBA', 'IMB', 'OMB', 'MCA', 'TJN', 'TNO', 'CEN', 'APO', 'AMO', 'ATE', 'IEO', 'AST'];
    const seen = new Set(), rows = [], names = [];
    for (const r of [...bright.data, ...neos.data]) {
      const [name, a, e, i, om, w, ma, epoch, H, neo, pha, cls] = r;
      if (seen.has(name) || !(+a > 0) || +e >= 1) continue;
      seen.add(name);
      const flags = (neo === 'Y' ? 1 : 0) | (pha === 'Y' ? 2 : 0);
      rows.push([+a, +e, +i, +om, +w, +ma, +epoch - 2451545.0, +H, Math.max(0, CLASSES.indexOf(cls)) + 16 * flags]);
      if (+H < 8 || (pha === 'Y' && +H < 19.5)) names.push([rows.length - 1, name.trim()]);
    }
    const buf = new Float32Array(rows.length * 9);
    rows.forEach((r, k) => buf.set(r, k * 9));
    await writeFile(out, Buffer.from(buf.buffer));
    await writeFile(path.join(DATA, 'asteroids-meta.json'), JSON.stringify({ source: 'JPL Small-Body Database', classes: CLASSES, names }));
    log(`asteroids: ${rows.length} orbits (${neos.data.length} NEOs), ${names.length} named`);
  },

  // ---------------- TEXTURES ----------------
  async textures() {
    const ssc = 'https://www.solarsystemscope.com/textures/download/';
    const three = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/';
    const list = [
      ['earth_day.jpg', ssc + '8k_earth_daymap.jpg', 4096], ['earth_night.jpg', ssc + '8k_earth_nightmap.jpg', 4096],
      ['earth_clouds.jpg', ssc + '8k_earth_clouds.jpg', 4096], ['earth_specular.jpg', three + 'earth_specular_2048.jpg'],
      ['earth_normal.jpg', three + 'earth_normal_2048.jpg'], ['moon.jpg', ssc + '2k_moon.jpg'], ['sun.jpg', ssc + '2k_sun.jpg'],
      ['mercury.jpg', ssc + '2k_mercury.jpg'], ['venus.jpg', ssc + '2k_venus_atmosphere.jpg'], ['mars.jpg', ssc + '2k_mars.jpg'],
      ['jupiter.jpg', ssc + '2k_jupiter.jpg'], ['saturn.jpg', ssc + '2k_saturn.jpg'], ['saturn_ring.png', ssc + '2k_saturn_ring_alpha.png'],
      ['uranus.jpg', ssc + '2k_uranus.jpg'], ['neptune.jpg', ssc + '2k_neptune.jpg'],
      ['milkyway.jpg', 'https://cdn.eso.org/images/large/eso0932a.jpg', 4096],
    ];
    await mkdir(TEX, { recursive: true });
    for (const [name, url, maxW] of list) {
      const file = path.join(TEX, name);
      if (await fresh(file, Infinity)) continue;
      await writeFile(file, await get(url, { type: 'buffer' }));
      if (maxW && process.platform === 'darwin') { try { execFileSync('sips', ['-Z', String(maxW), file], { stdio: 'ignore' }); } catch {} }
      log('texture:', name);
    }
    log('textures: ok');
  },
};

await mkdir(DATA, { recursive: true });
console.log('Fetching open space data…');
const names = ONLY.length ? ONLY : Object.keys(jobs);
await Promise.all(names.map(async (n) => { try { await jobs[n](); } catch (e) { console.error(`  ✗ ${n}: ${e.message}`); } }));
await writeFile(path.join(DATA, 'manifest.json'), JSON.stringify({ updated: new Date().toISOString() }));
console.log('done.');
