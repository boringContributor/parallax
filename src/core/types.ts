import type * as THREE from 'three';
import type { SimClock } from './clock';

export type LayerId = 'earth' | 'solar' | 'galaxy';

export interface InfoCard {
  kicker: string;
  title: string;
  color?: string;
  rows: [string, string][];
  body?: string;
  link?: { label: string; url: string };
}

export interface Selectable {
  id: string;
  name: string;
  kind: string;
  layer: LayerId;
  /** Current world position (layer units). */
  position(out: THREE.Vector3): THREE.Vector3;
  /** Rough size used to frame the camera. */
  radius: number;
  info(): InfoCard;
  onSelect?(): void;
  onDeselect?(): void;
  keywords?: string;
}

export interface Toggle {
  id: string;
  label: string;
  color?: string;
  count?: number;
  value: boolean;
  set(v: boolean): void;
}

export interface FrameCtx {
  clock: SimClock;
  dt: number;
  camera: THREE.PerspectiveCamera;
  selected: Selectable | null;
}

export interface Layer {
  id: LayerId;
  label: string;
  scene: THREE.Scene;
  /** Camera distance limits (from the orbit target). Zooming beyond max hands over to the next layer out. */
  minDistance: number;
  maxDistance: number;
  /** Time-speed presets offered in flow mode: [label, rate]. */
  speeds: [string, number][];
  toggles: Toggle[];
  load(onProgress?: (msg: string) => void): Promise<void>;
  update(ctx: FrameCtx): void;
  pick(ray: THREE.Raycaster, camera: THREE.PerspectiveCamera): Selectable | null;
  selectables(): Selectable[];
  /** Default camera placement. */
  home(): { position: THREE.Vector3; target: THREE.Vector3 };
  /** Base fly speed (units / s) for a camera at `pos`. */
  flySpeed(pos: THREE.Vector3): number;
  /** Anchor object when zooming in from the layer outside this one (Earth in solar, Sun in galaxy). */
  anchor?: Selectable;
  onEnter?(): void;
  onExit?(): void;
}
