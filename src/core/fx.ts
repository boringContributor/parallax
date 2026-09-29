import * as THREE from 'three';

/** Radial glow texture generated on a canvas (no external asset). */
export function glowTexture(stops: [number, string][], size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const sunGlow = () =>
  glowTexture([
    [0, 'rgba(255,255,255,1)'], [0.06, 'rgba(255,250,235,1)'], [0.12, 'rgba(255,220,160,0.55)'],
    [0.3, 'rgba(255,170,90,0.14)'], [0.6, 'rgba(255,140,60,0.03)'], [1, 'rgba(0,0,0,0)'],
  ]);

export const softDisc = () =>
  glowTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']], 64);

export function ringTexture() {
  const size = 128, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'white';
  g.lineWidth = 7;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
