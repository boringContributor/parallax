import { animate, stagger } from 'animejs';
import type { InfoCard, Layer, LayerId, Selectable, Toggle } from '../core/types';
import type { EventsData, LaunchesData } from '../core/data';
import { countdown } from '../layers/earth';
import type { Mode } from '../core/clock';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface HudHandlers {
  layer(id: LayerId): void;
  mode(m: Mode): void;
  speed(rate: number): void;
  now(): void;
  select(s: Selectable): void;
  deselect(): void;
  follow(on: boolean): void;
  drill(): void;
  search(q: string): Selectable[];
}

const LAYER_META: Record<LayerId, { scale: string; icon: string }> = {
  earth: { scale: '10⁴ km', icon: '<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-25 12 12)"/>' },
  solar: { scale: '10¹⁰ km', icon: '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10"/>' },
  galaxy: { scale: '10¹⁸ km', icon: '<path d="M12 12c3-4 8-2 8 1s-4 6-8 5M12 12c-3 4-8 2-8-1s4-6 8-5"/><circle cx="12" cy="12" r="1.5"/>' },
};

export class Hud {
  private h: HudHandlers;
  private followOn = true;
  private current: Selectable | null = null;

  constructor(h: HudHandlers) {
    this.h = h;
    document.body.insertAdjacentHTML('beforeend', TEMPLATE);
    $('#mode').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b) h.mode(b.dataset.mode as Mode);
    });
    $('#now').addEventListener('click', () => h.now());
    $('#info .close').addEventListener('click', () => h.deselect());
    $('#info .follow').addEventListener('click', () => {
      this.followOn = !this.followOn;
      $('#info .follow').classList.toggle('on', this.followOn);
      h.follow(this.followOn);
    });
    $('#info .drill').addEventListener('click', () => h.drill());
    $('#panel-toggle').addEventListener('click', () => document.body.classList.toggle('panel-collapsed'));
    $('#sources-btn').addEventListener('click', () => $('#sources').classList.add('open'));
    $('#sources').addEventListener('click', (e) => { if (e.target === $('#sources') || (e.target as HTMLElement).closest('.x')) $('#sources').classList.remove('open'); });
    this.setupSearch();
  }

  setLayers(layers: { id: LayerId; label: string; ready: boolean }[], active: LayerId) {
    const nav = $('#layers');
    nav.innerHTML = layers.map((l) => `
      <button data-id="${l.id}" class="${l.id === active ? 'on' : ''}" ${l.ready ? '' : 'disabled'}>
        <svg viewBox="0 0 24 24">${LAYER_META[l.id].icon}</svg><span class="n">${l.label}</span><span class="sc">${LAYER_META[l.id].scale}</span>
      </button>`).join('');
    nav.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.h.layer(b.dataset.id as LayerId)));
  }

  setMode(m: Mode) {
    document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.mode === m));
    document.body.dataset.mode = m;
    $('#hint').innerHTML = m === 'flow'
      ? '<b>Flow</b> · time runs · drag to orbit · scroll to zoom (zoom far out to change scale) · click anything'
      : '<b>Fly</b> · time frozen · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>R</kbd>/<kbd>F</kbd> up/down · <kbd>Q</kbd>/<kbd>E</kbd> roll · drag to look · <kbd>Shift</kbd> boost · scroll = speed';
  }

  setSpeeds(speeds: [string, number][], active: number, running: boolean) {
    const el = $('#speeds');
    el.innerHTML = speeds.map(([label, r]) => `<button data-r="${r}" class="${running && r === active ? 'on' : ''}">${label}</button>`).join('');
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.h.speed(+b.dataset.r!)));
  }

  setTime(main: string, sub: string, live: boolean) {
    $('#clock .t').textContent = main;
    $('#clock .d').textContent = sub;
    $('#now').classList.toggle('live', live);
  }

  setToggles(title: string, toggles: Toggle[]) {
    const el = $('#toggles');
    el.innerHTML = `<h3>${title}</h3>` + toggles.map((t, i) => `
      <label class="tg ${t.value ? 'on' : ''}" data-i="${i}" style="--c:${t.color || '#8ea2b7'}">
        <span class="sw"></span><span class="l">${esc(t.label)}</span>${t.count !== undefined ? `<span class="c">${t.count.toLocaleString('en-US')}</span>` : ''}
      </label>`).join('');
    el.querySelectorAll('.tg').forEach((node) => node.addEventListener('click', (e) => {
      e.preventDefault();
      const t = toggles[+(node as HTMLElement).dataset.i!];
      t.value = !t.value;
      t.set(t.value);
      node.classList.toggle('on', t.value);
    }));
  }

  setFeed(html: string) {
    const el = $('#feed');
    el.innerHTML = html;
    el.querySelectorAll<HTMLElement>('[data-sel]').forEach((row) => row.addEventListener('click', () => {
      const hit = this.h.search(row.dataset.sel!)[0];
      if (hit) this.h.select(hit);
    }));
    animate(el.querySelectorAll('.card'), { opacity: [0, 1], translateY: [8, 0], delay: stagger(60), duration: 500, ease: 'outCubic' });
  }

  showInfo(s: Selectable | null, card?: InfoCard, drillLabel?: string) {
    const el = $('#info');
    this.current = s;
    if (!s || !card) {
      if (el.classList.contains('open')) animate(el, { opacity: [1, 0], translateX: [0, 24], duration: 260, ease: 'inCubic', onComplete: () => el.classList.remove('open') });
      return;
    }
    const wasOpen = el.classList.contains('open');
    el.classList.add('open');
    el.style.setProperty('--c', card.color || '#9fb8ff');
    $('.drill', el).style.display = drillLabel ? '' : 'none';
    if (drillLabel) $('.drill', el).textContent = drillLabel;
    this.renderCard(card);
    if (!wasOpen) animate(el, { opacity: [0, 1], translateX: [24, 0], duration: 420, ease: 'outCubic' });
    animate(el.querySelectorAll('.rows > div'), { opacity: [0, 1], translateX: [8, 0], delay: stagger(35), duration: 380, ease: 'outCubic' });
  }

  /** Re-render values in place (called a few times per second for moving objects). */
  refreshInfo(card: InfoCard) {
    if (this.current) this.renderCard(card);
  }

  private renderCard(card: InfoCard) {
    const el = $('#info');
    $('.kicker', el).textContent = card.kicker;
    $('.title', el).textContent = card.title;
    const rows = $('.rows', el);
    const html = card.rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    if (rows.children.length === card.rows.length) {
      card.rows.forEach(([k, v], i) => {
        const r = rows.children[i];
        r.children[0].textContent = k;
        r.children[1].textContent = v;
      });
    } else rows.innerHTML = html;
    $('.body', el).textContent = card.body || '';
    $('.body', el).style.display = card.body ? '' : 'none';
    const link = $<HTMLAnchorElement>('.link', el);
    link.style.display = card.link ? '' : 'none';
    if (card.link) { link.href = card.link.url; link.textContent = card.link.label + ' ↗'; }
  }

  setFollow(on: boolean) {
    this.followOn = on;
    $('#info .follow').classList.toggle('on', on);
  }

  tooltip(text: string | null, x = 0, y = 0) {
    const t = $('#tooltip');
    if (!text) { t.classList.remove('on'); return; }
    t.textContent = text;
    t.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
    t.classList.add('on');
  }

  loading(msg: string | null, pct?: number) {
    const l = $('#loader');
    if (msg === null) {
      animate(l, { opacity: [1, 0], duration: 900, ease: 'inOutQuad', onComplete: () => l.remove() });
      return;
    }
    $('.msg', l).textContent = msg;
    if (pct !== undefined) $<HTMLElement>('.bar i', l).style.width = `${pct}%`;
  }

  intro() {
    animate('.hud-in', { opacity: [0, 1], translateY: [-10, 0], delay: stagger(90, { start: 300 }), duration: 900, ease: 'outExpo' });
  }

  /** Full-screen warp flash for scale changes. */
  warp(onMid: () => void) {
    const w = $('#warp');
    animate(w, {
      opacity: [0, 1], scale: [1.4, 1], duration: 420, ease: 'inQuad',
      onComplete: () => {
        onMid();
        animate(w, { opacity: [1, 0], scale: [1, 0.9], duration: 900, ease: 'outCubic' });
      },
    });
  }

  toast(text: string) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    $('#toasts').appendChild(t);
    animate(t, { opacity: [0, 1], translateY: [10, 0], duration: 400, ease: 'outCubic' });
    setTimeout(() => animate(t, { opacity: 0, duration: 600, onComplete: () => t.remove() }), 3800);
  }

  private setupSearch() {
    const input = $<HTMLInputElement>('#search input');
    const list = $('#search .results');
    let results: Selectable[] = [];
    let idx = 0;
    const render = () => {
      list.innerHTML = results.map((r, i) => `<li class="${i === idx ? 'on' : ''}" data-i="${i}"><b>${esc(r.name)}</b><span>${esc(r.kind)} · ${r.layer === 'earth' ? 'Earth orbit' : r.layer === 'solar' ? 'Solar System' : 'Milky Way'}</span></li>`).join('');
      list.classList.toggle('open', results.length > 0);
      list.querySelectorAll('li').forEach((li) => li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(+li.dataset.i!); }));
    };
    const choose = (i: number) => {
      const r = results[i];
      if (!r) return;
      this.h.select(r);
      input.value = '';
      results = [];
      render();
      input.blur();
    };
    input.addEventListener('input', () => { results = input.value.trim().length >= 2 ? this.h.search(input.value) : []; idx = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, results.length - 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); render(); e.preventDefault(); }
      else if (e.key === 'Enter') choose(idx);
      else if (e.key === 'Escape') { input.value = ''; results = []; render(); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(() => list.classList.remove('open'), 120));
    addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
    });
  }
}

// ------------------------------------------------------------------------------------------ feed builders
export function earthFeed(l: LaunchesData | null, ev: EventsData | null, satCount: number, fetched: string, partial: boolean) {
  const launches = (l?.launches || []).filter((x) => Date.parse(x.net) > Date.now() - 3 * 36e5).slice(0, 5);
  const strongest = (ev?.flares || []).reduce<string | null>((best, f) => (!best || cls(f.cls) > cls(best) ? f.cls : best), null);
  const fastCme = (ev?.cmes || []).reduce((m, c) => Math.max(m, c.speed || 0), 0);
  return `
    <div class="card stat"><div class="big" data-count="${satCount}">${satCount.toLocaleString('en-US')}</div>
      <div class="lbl">active satellites propagated live with SGP4${partial ? ' <em>(partial catalogue — full set on next refresh)</em>' : ''}</div>
      <div class="src">CelesTrak · ${timeAgo(fetched)}</div></div>
    ${launches.length ? `<div class="card"><h4>Next launches</h4>${launches.map((x) => `
      <div class="row" data-sel="${esc(x.name)}"><span class="cd">${countdown(x.net)}</span><span class="nm">${esc(x.name.split('|').pop()!.trim())}<small>${esc(x.rocket || '')} · ${esc(x.location?.split(',').slice(-1)[0]?.trim() || '')}</small></span></div>`).join('')}
      <div class="src">Launch Library 2 · The Space Devs</div></div>` : ''}
    ${ev?.flares ? `<div class="card"><h4>Space weather · last 30 days</h4>
      <div class="kv"><span>Solar flares</span><b>${ev.flares.length}</b></div>
      <div class="kv"><span>Strongest flare</span><b class="flare">${strongest || '—'}</b></div>
      <div class="kv"><span>Coronal mass ejections</span><b>${ev.cmes?.length ?? '—'}</b></div>
      ${fastCme ? `<div class="kv"><span>Fastest CME</span><b>${Math.round(fastCme).toLocaleString('en-US')} km/s</b></div>` : ''}
      <div class="src">NASA DONKI</div></div>` : ''}`;
}

export function solarFeed(ev: EventsData | null, missions: { name: string; color: string; sub: string }[]) {
  const neos = (ev?.neos || []).filter((n) => Date.parse(n.date.replace(' ', 'T') + 'Z') > Date.now() - 864e5).slice(0, 5);
  return `
    <div class="card"><h4>Active deep-space missions</h4>${missions.map((m) => `
      <div class="row" data-sel="${esc(m.name)}"><span class="dot" style="--c:${m.color}"></span><span class="nm">${esc(m.name)}<small>${esc(m.sub)}</small></span></div>`).join('')}
      <div class="src">Trajectories · JPL Horizons</div></div>
    ${neos.length ? `<div class="card"><h4>Upcoming asteroid flybys</h4>${neos.map((n) => `
      <div class="row"><span class="cd">${(n.distAU * 389.17).toFixed(1)} LD</span><span class="nm">${esc(n.name.replace(/^\((.*)\)$/, '$1'))}<small>${n.date.slice(0, 11)} · ${n.vRel.toFixed(1)} km/s${n.diameter ? ` · ${(n.diameter * 1000).toFixed(0)} m` : ` · H ${n.h.toFixed(1)}`}</small></span></div>`).join('')}
      <div class="src">JPL close-approach data · LD = lunar distance</div></div>` : ''}`;
}

export function galaxyFeed() {
  return `
    <div class="card"><h4>What you are looking at</h4>
      <p>The disk, bar and spiral pattern are a <b>model</b>: the arms are a log-spiral fitted to 132 maser parallaxes, the bar uses the measured 27° angle. Everything with a marker is <b>measured</b>:</p>
      <div class="kv"><span>◆ Masers (VLBI parallax)</span><b>Reid+ 2019</b></div>
      <div class="kv"><span>◎ Open clusters</span><b>Gaia DR3</b></div>
      <div class="kv"><span>● Globular clusters</span><b>Gaia EDR3</b></div>
      <div class="kv"><span>· Stars &lt; 1 kpc</span><b>Gaia DR3</b></div>
      <p class="muted">In Flow mode arms turn at the pattern speed (28 km/s/kpc), the bar faster (39), stars follow the rotation curve and globular clusters their integrated orbits.</p>
    </div>`;
}

function cls(c: string) {
  const s = { A: 0, B: 1, C: 2, M: 3, X: 4 }[c[0]] ?? 0;
  return s * 100 + parseFloat(c.slice(1) || '0');
}
function timeAgo(iso: string) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 6e4);
  return m < 60 ? `updated ${m} min ago` : m < 2880 ? `updated ${Math.round(m / 60)} h ago` : `updated ${Math.round(m / 1440)} d ago`;
}

export function layerFeedTitle(l: Layer) {
  return l.id === 'earth' ? 'In orbit right now' : l.id === 'solar' ? 'Across the Solar System' : 'Layers';
}

const TEMPLATE = /* html */ `
<div id="loader"><div class="ring"></div><div class="name">Parallax</div><div class="msg">Loading…</div><div class="bar"><i></i></div></div>
<div id="warp"></div>
<header id="top" class="hud-in">
  <div class="brand"><span class="logo"></span><div><b>Parallax</b><small>live, from open data</small></div></div>
  <nav id="layers"></nav>
</header>
<div id="timebar" class="hud-in">
  <div id="mode" class="seg"><button data-mode="flow">Flow</button><button data-mode="fly">Fly</button></div>
  <div id="clock"><div class="t">—</div><div class="d"></div></div>
  <div id="speeds"></div>
  <button id="now" title="Back to live time">Now</button>
</div>
<aside id="panel" class="hud-in">
  <button id="panel-toggle" title="Toggle panel">⟨</button>
  <div class="scroll"><div id="feed"></div><div id="toggles"></div></div>
</aside>
<aside id="info">
  <div class="head"><div class="kicker"></div><button class="close" title="Close">✕</button></div>
  <div class="title"></div>
  <div class="rows"></div>
  <p class="body"></p>
  <div class="actions"><button class="follow on">Follow</button><button class="drill">Enter</button><a class="link" target="_blank" rel="noopener"></a></div>
</aside>
<div id="search" class="hud-in"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg><input placeholder="Search satellites, missions, planets, stars, clusters…  ( / )" spellcheck="false" /><ul class="results"></ul></div>
<div id="hint" class="hud-in"></div>
<button id="sources-btn" class="hud-in">Data sources</button>
<div id="tooltip"></div>
<div id="toasts"></div>
<div id="sources"><div class="box"><button class="x">✕</button><h2>Open data inside</h2>
  <ul>
    <li><b>Satellites</b> — CelesTrak GP/OMM elements, propagated with SGP4 (satellite.js)</li>
    <li><b>Spacecraft trajectories</b> — NASA/JPL Horizons API</li>
    <li><b>Planets, Sun & Moon</b> — astronomy-engine (VSOP87 / ELP), MIT</li>
    <li><b>Asteroids</b> — JPL Small-Body Database (orbital elements, Keplerian propagation on the GPU)</li>
    <li><b>Upcoming launches</b> — Launch Library 2, The Space Devs</li>
    <li><b>Space weather & asteroid flybys</b> — NASA DONKI · JPL SBDB close-approach API</li>
    <li><b>Stars</b> — ESA Gaia DR3 (≈600k stars within 1 kpc) · HYG v4.1 (CC BY-SA)</li>
    <li><b>Open clusters</b> — Hunt & Reffert 2023, A&A 673, A114 (via VizieR)</li>
    <li><b>Spiral-arm masers</b> — Reid et al. 2019, ApJ 885, 131 (via VizieR)</li>
    <li><b>Globular clusters</b> — Baumgardt et al., Gaia EDR3 orbits catalogue</li>
    <li><b>Constellations</b> — d3-celestial (BSD)</li>
    <li><b>Textures</b> — Solar System Scope (CC BY 4.0) · ESO/S. Brunier Milky Way panorama (CC BY 4.0) · NASA (three.js examples)</li>
  </ul>
  <p class="muted">Planet sizes in the Solar System view and the Sun marker are exaggerated for visibility. Distances and positions are real.</p>
</div></div>
`;
