# Parallax

A live 3D universe in the browser, built from open data. It shows what is in orbit right now, where the active deep-space missions are, the planets and 110k asteroids, and the Milky Way around us.

Three scales, one continuous zoom: **Earth orbit → Solar System → Milky Way**. Zoom past the edge of one scale and it hands over to the next.

```bash
npm install
npm run dev      # fetches/refreshes open data into public/, then starts Vite
```

`npm run data` refreshes the data on its own. Live feeds refresh when they are more than 2 h old. Catalogues and textures are downloaded once. Use `--force` to re-download everything, or `--only=satellites,missions` for specific feeds.

## Modes

| | Flow | Fly |
|---|---|---|
| Time | runs (live, or time-lapse presets per scale) | frozen |
| Camera | orbit + slow cinematic drift; follows the selected object | free flight: `WASD` move, `R`/`F` up/down, `Q`/`E` roll, drag to look, `Shift` boost, wheel = speed |

`Tab` toggles the mode, `1`/`2`/`3` jump between scales, `/` opens search and `Esc` deselects. Double-click Earth or the Sun to dive into its scale.

## What is real

| Layer | Data | Source |
|---|---|---|
| Satellites | ~14k active objects, SGP4-propagated in a Web Worker in real time | [CelesTrak GP/OMM](https://celestrak.org/NORAD/documentation/gp-data-formats.php) |
| Earth | rotation from Greenwich sidereal time; terminator from the true Sun direction | satellite.js, astronomy-engine |
| Upcoming launches | pads on the globe with countdowns | [Launch Library 2](https://thespacedevs.com/llapi) |
| Space weather | flares and CMEs from the last 30 days | [NASA DONKI](https://api.nasa.gov/) |
| Missions | 20 active spacecraft (Voyagers, New Horizons, Parker, JUICE, Europa Clipper, BepiColombo, Psyche, Lucy, Hera, JWST, Euclid, SOHO…) | [JPL Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) |
| Planets, Moon | VSOP87 / ELP ephemerides | [astronomy-engine](https://github.com/cosinekitty/astronomy) |
| Asteroids | 111k orbits (main belt, Trojans, TNOs, 11.6k NEOs); Kepler's equation solved per vertex on the GPU | [JPL SBDB](https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html) |
| Asteroid flybys | close approaches within 0.05 AU over the next 60 days | [JPL CAD API](https://ssd-api.jpl.nasa.gov/doc/cad.html) |
| Stars near the Sun | ~600k Gaia DR3 stars within 1 kpc, colour from BP−RP, brightness from absolute magnitude | [ESA Gaia TAP](https://gea.esac.esa.int/archive/) |
| Named stars and the sky | HYG v4.1 | [astronexus/HYG-Database](https://github.com/astronexus/HYG-Database) |
| Open clusters | 6.8k clusters with ages and distances | Hunt & Reffert 2023, A&A 673, A114 |
| Spiral-arm tracers | 199 VLBI maser parallaxes | Reid et al. 2019, ApJ 885, 131 |
| Globular clusters | 165 clusters with 6D phase space; orbits integrated in-app (leapfrog, bulge + disk + NFW halo) | [Baumgardt catalogue](https://people.smp.uq.edu.au/HolgerBaumgardt/globular/) |
| Backdrop | Milky Way panorama mapped via the exact galactic↔equatorial rotation | ESO/S. Brunier (CC BY 4.0) |

**What is modelled:** the Milky Way disk, bar and dust are procedural. The spiral arms are a global log-spiral fit (pitch 9.42°, rms 8 % in R) to the 132 arm-tagged masers. The bar uses the measured 27° angle. In Flow mode:

- the arms turn at the spiral pattern speed (28 km/s/kpc)
- the bar turns at its own, faster pattern speed (39 km/s/kpc)
- disk stars follow the rotation curve

Planet sizes in the Solar System view are exaggerated for visibility. Distances and positions are not.

## Layout

```
scripts/fetch-data.mjs   open-data snapshot → public/data, public/textures
src/main.ts              renderer, bloom, layer handoffs, anime.js camera flights, picking
src/layers/earth.ts      Earth shader, satellites (+ satWorker.ts), Moon, L1/L2 observatories, launch pads
src/layers/solar.ts      Sun, planets, orbits, spacecraft tracks, GPU asteroids
src/layers/galaxy.ts     Milky Way model, Gaia neighbourhood, clusters, masers, GC orbits
src/layers/sky.ts        background sky (panorama, HYG stars, constellations)
src/ui/hud.ts            HUD, search, info card, feeds
```

CelesTrak only allows one download per group every 2 hours. If `active` is blocked, the fetch script builds a partial catalogue from smaller groups and retries the full one on the next run.
