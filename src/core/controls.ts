import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Two camera models:
 *  - orbit: OrbitControls around a (possibly moving) target, used in Flow mode, with slow cinematic auto-rotation.
 *  - fly:   free flight. WASD/arrow keys move, R/F up/down, Q/E roll, drag to look, Shift = ×5, wheel = speed.
 */
export class CameraRig {
  readonly orbit: OrbitControls;
  mode: 'orbit' | 'fly' = 'orbit';
  flySpeedScale = 1;
  private keys = new Set<string>();
  private look = { dragging: false, x: 0, y: 0, dx: 0, dy: 0 };
  private vel = new THREE.Vector3();
  private rollVel = 0;

  constructor(private camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.06;
    this.orbit.rotateSpeed = 0.5;
    this.orbit.zoomSpeed = 1.6;
    this.orbit.autoRotateSpeed = 0.25;
    this.orbit.zoomToCursor = false;

    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'fly') return;
      this.look.dragging = true;
      this.look.x = e.clientX; this.look.y = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.look.dragging) return;
      this.look.dx += e.clientX - this.look.x; this.look.dy += e.clientY - this.look.y;
      this.look.x = e.clientX; this.look.y = e.clientY;
    });
    dom.addEventListener('pointerup', () => (this.look.dragging = false));
    dom.addEventListener('wheel', (e) => {
      if (this.mode !== 'fly') return;
      e.preventDefault();
      this.flySpeedScale = THREE.MathUtils.clamp(this.flySpeedScale * Math.exp(-e.deltaY * 0.0015), 0.02, 50);
    }, { passive: false });
  }

  setMode(mode: 'orbit' | 'fly') {
    this.mode = mode;
    this.orbit.enabled = mode === 'orbit';
    if (mode === 'orbit') {
      // re-seat the orbit target in front of the camera so the switch is seamless
      const dist = Math.max(this.camera.position.distanceTo(this.orbit.target), this.orbit.minDistance * 2);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.orbit.target.copy(this.camera.position).addScaledVector(fwd, dist);
      this.camera.up.set(0, 1, 0);
    }
    this.vel.set(0, 0, 0);
  }

  /** Move a followed target: shift camera + target together so moving objects (ISS, planets) stay framed. */
  follow(delta: THREE.Vector3) {
    this.camera.position.add(delta);
    this.orbit.target.add(delta);
  }

  update(dt: number, baseSpeed: number) {
    if (this.mode === 'orbit') {
      this.orbit.update(dt);
      return;
    }
    const k = this.keys;
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 5 : 1;
    const speed = baseSpeed * this.flySpeedScale * boost;
    const input = new THREE.Vector3(
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      (k.has('KeyR') || k.has('Space') ? 1 : 0) - (k.has('KeyF') || k.has('KeyC') ? 1 : 0),
      (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0),
    );
    if (input.lengthSq() > 0) input.normalize().multiplyScalar(speed).applyQuaternion(this.camera.quaternion);
    // critically damped velocity for smooth starts/stops
    this.vel.lerp(input, 1 - Math.exp(-dt * 6));
    this.camera.position.addScaledVector(this.vel, dt);

    const rollIn = (k.has('KeyQ') ? 1 : 0) - (k.has('KeyE') ? 1 : 0);
    this.rollVel += (rollIn * 1.2 - this.rollVel) * (1 - Math.exp(-dt * 6));
    const q = new THREE.Quaternion();
    const yaw = -this.look.dx * 0.0022, pitch = -this.look.dy * 0.0022;
    this.look.dx *= 0; this.look.dy *= 0;
    q.setFromEuler(new THREE.Euler(pitch, yaw, this.rollVel * dt, 'YXZ'));
    this.camera.quaternion.multiply(q).normalize();
  }
}
