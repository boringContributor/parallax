import { jdFromDate } from './astro';

export type Mode = 'flow' | 'fly';

/** Simulation time. Earth/solar layers use `ms` (real calendar time); the galaxy uses `myr` (Myr from now). */
export class SimClock {
  ms = Date.now();
  rate = 1; // simulated seconds per real second
  myr = 0;
  myrRate = 2; // Myr per real second in the galaxy
  running = true;

  get jd() {
    return jdFromDate(this.ms);
  }
  get date() {
    return new Date(this.ms);
  }
  get isLive() {
    return this.running && this.rate === 1 && Math.abs(this.ms - Date.now()) < 5000;
  }

  tick(dt: number) {
    if (!this.running) return;
    this.ms += dt * 1000 * this.rate;
    this.myr += dt * this.myrRate;
  }

  now() {
    this.ms = Date.now();
    this.rate = 1;
    this.myr = 0;
  }
}
