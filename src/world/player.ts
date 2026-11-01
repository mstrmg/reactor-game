/**
 * First-person controller: pointer-lock mouse look, WASD with collision,
 * crosshair raycast against interactable OBBs, mouse/keyboard actions, focus zoom.
 */
import * as THREE from 'three';
import type { ReactorSimApi } from '../sim/types';
import { bus } from '../core/bus';
import type { Interactable } from './panel';
import { ROOM, type Collider } from './room';

const EYE = 1.65;
const RADIUS = 0.3;
const REACH = 3.2;
/** radius of the bench front line (RF - 0.67) minus the player radius */
const INNER_R = 7.4 - 0.68 - RADIUS;
const BASE_FOV = 70;
const FOCUS_FOV = 26;

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class Player {
  pos = new THREE.Vector3(-0.35, 0, -5.55);
  yaw = 0;
  pitch = -0.12;
  locked = false;
  focus = false;
  freeInput = false; // debug: accept input without pointer lock
  private keys = new Set<string>();
  private bob = 0;
  private bobAmt = 0;
  target: Interactable | null = null;
  private targetT = 0;
  private hoverIt: Interactable | null = null;
  private hoverSub = -1;
  private hoverTimer = 0;
  private held: { it: Interactable; button: number; repeatT: number } | null = null;
  private fov = BASE_FOV;
  private sens = 0.0022;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private canvas: HTMLCanvasElement,
    private sim: ReactorSimApi,
    private interactables: Interactable[],
    private colliders: Collider[],
  ) {
    document.addEventListener('pointerlockchange', () => {
      const l = document.pointerLockElement === this.canvas;
      if (l === this.locked) return;
      this.locked = l;
      if (!l) {
        this.releaseAll();
      }
      bus.emit('pointer-lock', l);
      if (!l) {
        // losing the lock (Esc) pauses the game; the UI shows the pause menu
        try {
          if (!this.sim.controls.paused) bus.emit('pause-changed', true);
        } catch {
          /* ignore */
        }
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const k = this.sens * (this.fov / BASE_FOV);
      this.yaw -= e.movementX * k;
      this.pitch -= e.movementY * k;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.active()) return;
      e.preventDefault();
      this.actDown(e.button === 2 ? 2 : e.button === 0 ? 0 : -1);
    });
    document.addEventListener('mouseup', (e) => {
      if (this.held && this.held.button === (e.button === 2 ? 2 : 0)) this.actUp();
    });
    document.addEventListener('contextmenu', (e) => {
      if (this.locked || e.target === this.canvas) e.preventDefault();
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.active() || !this.target?.wheel) return;
        const d = e.deltaY < 0 ? 1 : -1;
        this.target.wheel(d, e.shiftKey);
        this.hoverTimer = 0;
      },
      { passive: true },
    );
    window.addEventListener('keydown', (e) => {
      if (!this.active()) return;
      if (e.repeat) {
        return;
      }
      this.keys.add(e.code);
      if (e.code === 'KeyE') this.actDown(0);
      else if (e.code === 'KeyR') this.actDown(2);
      else if (e.code === 'KeyF' || e.code === 'KeyQ') this.focus = !this.focus;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if ((e.code === 'KeyE' && this.held?.button === 0) || (e.code === 'KeyR' && this.held?.button === 2)) this.actUp();
    });
    window.addEventListener('blur', () => this.releaseAll());
    this.canvas.addEventListener('click', () => {
      try {
        if (!this.locked && !this.sim.controls.paused) this.lock();
      } catch {
        /* ignore */
      }
    });
  }

  active(): boolean {
    return this.locked || this.freeInput;
  }

  lock(): void {
    try {
      const p = (this.canvas.requestPointerLock as any)({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function')
        p.catch(() => {
          try {
            const p2 = this.canvas.requestPointerLock() as any;
            if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
          } catch {
            /* ignore */
          }
        });
    } catch {
      /* ignore */
    }
  }
  unlock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.releaseAll();
  }

  private releaseAll(): void {
    this.keys.clear();
    if (this.held) this.actUp();
  }

  private actDown(button: number): void {
    const it = this.target;
    if (!it || button < 0) return;
    if (it.kind === 'lever') {
      it.holdStart?.(button === 0 ? 1 : -1);
      this.held = { it, button, repeatT: 0 };
    } else if (it.kind === 'knob') {
      (button === 0 ? it.primary : it.secondary)?.();
      this.held = { it, button, repeatT: 0.4 };
    } else {
      (button === 0 ? it.primary : it.secondary ?? (it.kind === 'button' ? undefined : undefined))?.();
    }
    this.hoverTimer = 0;
  }
  private actUp(): void {
    if (!this.held) return;
    this.held.it.holdEnd?.();
    this.held = null;
  }

  update(dt: number): void {
    // ----- movement -----
    const act = this.active();
    let fx = 0;
    let fz = 0;
    if (act) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fz -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fz += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) fx -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) fx += 1;
    }
    const moving = fx !== 0 || fz !== 0;
    if (moving) {
      const len = Math.hypot(fx, fz);
      const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4.2 : 2.1;
      const s = Math.sin(this.yaw);
      const c = Math.cos(this.yaw);
      const dx = ((fx * c + fz * s) / len) * speed * dt;
      const dz = ((-fx * s + fz * c) / len) * speed * dt;
      this.pos.x += dx;
      this.pos.z += dz;
      this.collide();
      this.bob += dt * speed * 3.2;
      this.bobAmt = Math.min(1, this.bobAmt + dt * 4);
    } else {
      this.bobAmt = Math.max(0, this.bobAmt - dt * 4);
    }
    // ----- held controls (knob auto-repeat) -----
    if (this.held && this.held.it.kind === 'knob') {
      this.held.repeatT -= dt;
      if (this.held.repeatT <= 0) {
        this.held.repeatT = 0.06;
        (this.held.button === 0 ? this.held.it.primary : this.held.it.secondary)?.();
      }
    }
    // ----- camera -----
    const tf = this.focus ? FOCUS_FOV : BASE_FOV;
    this.fov += (tf - this.fov) * (1 - Math.exp(-10 * dt));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    const by = Math.sin(this.bob) * 0.022 * this.bobAmt;
    const bx = Math.cos(this.bob * 0.5) * 0.012 * this.bobAmt;
    this.camera.position.set(this.pos.x + Math.cos(this.yaw) * bx, EYE + by, this.pos.z - Math.sin(this.yaw) * bx);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
    // ----- pick -----
    this.pick();
  }

  private collide(): void {
    for (let iter = 0; iter < 3; iter++) {
      for (const c of this.colliders) {
        const dx = this.pos.x - c.x;
        const dz = this.pos.z - c.z;
        // to local (rotation by -rot)
        const lx = dx * c.c - dz * c.s;
        const lz = dx * c.s + dz * c.c;
        const px = Math.max(-c.hx, Math.min(c.hx, lx));
        const pz = Math.max(-c.hz, Math.min(c.hz, lz));
        let ox = lx - px;
        let oz = lz - pz;
        const d2 = ox * ox + oz * oz;
        if (d2 >= RADIUS * RADIUS) continue;
        let nlx: number;
        let nlz: number;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          nlx = px + (ox / d) * RADIUS;
          nlz = pz + (oz / d) * RADIUS;
        } else {
          // inside: push out along the shallowest axis
          const ex = c.hx - Math.abs(lx);
          const ez = c.hz - Math.abs(lz);
          if (ex < ez) {
            nlx = Math.sign(lx || 1) * (c.hx + RADIUS);
            nlz = lz;
          } else {
            nlx = lx;
            nlz = Math.sign(lz || 1) * (c.hz + RADIUS);
          }
        }
        void ox;
        void oz;
        // back to world (rotation by +rot)
        this.pos.x = c.x + nlx * c.c + nlz * c.s;
        this.pos.z = c.z - nlx * c.s + nlz * c.c;
      }
    }
    // never behind the horseshoe: in the front half of the room stay inside the bench line
    if (this.pos.z < 0.05) {
      const r = Math.hypot(this.pos.x, this.pos.z);
      if (r > INNER_R) {
        this.pos.x *= INNER_R / r;
        this.pos.z *= INNER_R / r;
      }
    }
    this.pos.x = Math.max(ROOM.x0 + RADIUS, Math.min(ROOM.x1 - RADIUS, this.pos.x));
    this.pos.z = Math.max(ROOM.z0 + RADIUS, Math.min(ROOM.z1 - RADIUS, this.pos.z));
  }

  private pick(): void {
    this.camera.getWorldDirection(_fwd);
    let best: Interactable | null = null;
    let bestT = REACH;
    const cp = this.camera.position;
    for (let i = 0; i < this.interactables.length; i++) {
      const it = this.interactables[i];
      // cheap reject: distance from camera to center
      const dcx = it.center.x - cp.x;
      const dcy = it.center.y - cp.y;
      const dcz = it.center.z - cp.z;
      if (dcx * dcx + dcy * dcy + dcz * dcz > (REACH + 1.4) * (REACH + 1.4)) continue;
      _o.copy(cp).applyMatrix4(it.inv);
      _d.copy(_fwd).transformDirection(it.inv);
      const t = slab(_o, _d, it.half);
      if (t < 0) continue;
      const tt = it.kind === 'info' ? t + 0.03 : t;
      if (tt < bestT) {
        bestT = tt;
        best = it;
        this.targetT = t;
      }
    }
    if (this.held && best !== this.held.it && this.held.it.kind !== 'lever') {
      // moving off a knob cancels repeat
      this.actUp();
    }
    this.target = best;
    this.hoverTimer -= 1 / 60;
    let sub = -1;
    if (best?.sub) {
      _o.copy(cp).applyMatrix4(best.inv);
      _d.copy(_fwd).transformDirection(best.inv);
      const hx = _o.x + _d.x * this.targetT;
      const hy = _o.y + _d.y * this.targetT;
      sub = Math.floor((hx + 5) * 25) * 1000 + Math.floor((hy + 5) * 40);
    }
    if (best !== this.hoverIt || sub !== this.hoverSub || this.hoverTimer <= 0) {
      this.hoverTimer = 0.2;
      if (!best) {
        if (this.hoverIt) bus.emit('hover', null);
      } else {
        let label = best.label;
        let detail = '';
        try {
          if (best.sub) {
            const r = best.sub(_o.x + _d.x * this.targetT, _o.y + _d.y * this.targetT);
            if (r) {
              label = r.label;
              detail = r.detail;
            }
          } else detail = best.detail(this.sim.state, this.sim.controls);
        } catch {
          detail = '';
        }
        bus.emit('hover', { id: best.id, label, detail });
      }
      this.hoverIt = best;
      this.hoverSub = sub;
    }
  }
}

/** ray vs. axis-aligned box centered at origin with half extents h. Returns t or -1. */
function slab(o: THREE.Vector3, d: THREE.Vector3, h: THREE.Vector3): number {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
    const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
    const ha = a === 0 ? h.x : a === 1 ? h.y : h.z;
    if (Math.abs(da) < 1e-9) {
      if (oa < -ha || oa > ha) return -1;
      continue;
    }
    let t1 = (-ha - oa) / da;
    let t2 = (ha - oa) / da;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  return tmin >= 0 ? tmin : 0;
}
