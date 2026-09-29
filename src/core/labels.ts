import * as THREE from 'three';

export interface LabelSpec {
  text: string;
  sub?: string;
  color?: string;
  cls?: string;
  position: (out: THREE.Vector3) => THREE.Vector3;
  /** Visible when camera distance lies in [near, far] (world units). */
  near?: number;
  far?: number;
  visible?: () => boolean;
  onClick?: () => void;
}

interface Label extends LabelSpec {
  el: HTMLDivElement;
  shown: boolean;
}

const v = new THREE.Vector3();
const toCam = new THREE.Vector3();

/** Lightweight DOM labels, one set per layer, with sphere occlusion (so labels hide behind Earth). */
export class Labels {
  readonly root: HTMLDivElement;
  private items: Label[] = [];
  occluders: { center: THREE.Vector3; radius: number }[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'labels';
    parent.appendChild(this.root);
  }

  add(spec: LabelSpec) {
    const el = document.createElement('div');
    el.className = 'label ' + (spec.cls || '');
    if (spec.color) el.style.setProperty('--c', spec.color);
    el.innerHTML = `<span class="dot"></span><span class="t">${spec.text}</span>${spec.sub ? `<span class="s">${spec.sub}</span>` : ''}`;
    if (spec.onClick) {
      el.classList.add('clickable');
      el.addEventListener('click', (e) => { e.stopPropagation(); spec.onClick!(); });
    }
    this.root.appendChild(el);
    const item: Label = { ...spec, el, shown: false };
    this.items.push(item);
    return item;
  }

  setActive(on: boolean) {
    this.root.style.display = on ? '' : 'none';
  }

  update(camera: THREE.PerspectiveCamera, w: number, h: number) {
    const boxes: number[] = []; // placed label rects (x0, y0, x1, y1) for decluttering
    for (const it of this.items) {
      let show = !it.visible || it.visible();
      if (show) {
        it.position(v);
        const dist = v.distanceTo(camera.position);
        if ((it.near !== undefined && dist < it.near) || (it.far !== undefined && dist > it.far)) show = false;
        if (show) show = !this.occluded(camera.position, v, dist);
        if (show) {
          v.project(camera);
          show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
          if (show) {
            const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
            const bw = (it.text.length + (it.sub?.length ?? 0)) * 6.4 + 16;
            for (let b = 0; b < boxes.length; b += 4) {
              if (x < boxes[b + 2] && x + bw > boxes[b] && y - 8 < boxes[b + 3] && y + 8 > boxes[b + 1]) { show = false; break; }
            }
            if (show) {
              boxes.push(x, y - 8, x + bw, y + 8);
              it.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
            }
          }
        }
      }
      if (show !== it.shown) {
        it.shown = show;
        it.el.classList.toggle('on', show);
      }
    }
  }

  private occluded(cam: THREE.Vector3, p: THREE.Vector3, dist: number) {
    for (const o of this.occluders) {
      toCam.subVectors(p, cam).divideScalar(dist); // unit ray dir cam → p
      const oc = v.clone().copy(o.center).sub(cam);
      const t = oc.dot(toCam);
      if (t <= 0 || t >= dist) continue;
      const d2 = oc.lengthSq() - t * t;
      if (d2 < o.radius * o.radius * 0.98) return true;
    }
    return false;
  }
}
