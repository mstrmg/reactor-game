/**
 * Telephones that call the colleague in the reactor building:
 *  - a beige console phone set into the REACTOR CONTROL bench (easy to find from spawn), with a liftable handset
 *  - the existing phone on the shift supervisor's desk
 * Activating either emits 'phone-pickup' (the UI runs the call dialogue) and 'control-used'.
 */
import * as THREE from 'three';
import { bus } from '../core/bus';
import { PanelKit, Section, surfaceFrame, type Interactable } from './panel';
import { cyl, rbox, zcyl } from './util';

export interface Phone {
  handset: THREE.Mesh;
  /** lift the handset (call in progress) or hang up */
  setLifted(on: boolean): void;
  update(dt: number): void;
}

const BEIGE = 0xd8cfb0;

export function buildPhones(kit: PanelKit, S4: Section, onPickup: () => void): Phone {
  const B = kit.shell;
  const F = surfaceFrame(S4, 'b', 0.68, 0.16, 0);
  const L = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)).premultiply(F);
  // body (frame +z = bench normal, +y = up-slope)
  B.add(rbox(0.22, 0.18, 0.05, 0.018, 2), L(0, 0, 0.025), BEIGE, { ao: false });
  B.add(rbox(0.2, 0.08, 0.03, 0.012, 2), L(0, 0.045, 0.06), 0xcdc4a4, { ao: false }); // cradle hump
  for (const sx of [-1, 1]) B.add(rbox(0.035, 0.05, 0.02, 0.008), L(sx * 0.075, 0.045, 0.08), 0xbdb494, { ao: false }); // hook prongs
  // keypad 3x4
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++) B.add(rbox(0.026, 0.016, 0.008, 0.003), L(-0.035 + c * 0.035, -0.02 - r * 0.02, 0.052), r === 3 && c !== 1 ? 0x9a2a1e : 0x2b2b2b, { ao: false });
  B.add(rbox(0.04, 0.05, 0.006, 0.003), L(0.08, -0.045, 0.051), 0x9a2a1e, { ao: false }); // "hold" key
  // coiled cord (static loops on the side)
  for (let k = 0; k < 7; k++) B.add(cyl(0.009, 0.009, 0.004, 8), L(-0.12 - k * 0.012, 0.01, 0.03, 0, 0, Math.PI / 2), 0x2b2b2b, { ao: false });
  kit.labelAt(L(0, -0.112, 0.004), 'REACTOR BLDG  EXT 2214', 0.22, 0.026, 'black');

  // handset (own mesh so it can lift)
  const hg = new THREE.BufferGeometry();
  {
    const parts = [rbox(0.2, 0.034, 0.03, 0.012, 2).clone()];
    for (const sx of [-1, 1]) {
      const cup = zcyl(0.026, 0.024, 0.03, 16).clone();
      cup.rotateX(Math.PI);
      cup.translate(sx * 0.085, 0, 0.0);
      parts.push(cup);
    }
    const merged = mergeSimple(parts);
    hg.copy(merged);
  }
  const handset = new THREE.Mesh(hg, new THREE.MeshLambertMaterial({ color: 0xe0d6b6 }));
  handset.name = 'phone-handset';
  handset.matrixAutoUpdate = false;
  const rest = L(0, 0.045, 0.095);
  const up = L(-0.06, 0.12, 0.3, 0.5, 0.2, -0.5);
  handset.matrix.copy(rest);
  let lifted = 0;
  let target = 0;
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _p2 = new THREE.Vector3();
  const _q2 = new THREE.Quaternion();
  rest.decompose(_p, _q, _s);
  const restP = _p.clone();
  const restQ = _q.clone();
  up.decompose(_p2, _q2, _s);
  const upP = _p2.clone();
  const upQ = _q2.clone();

  const press = () => {
    bus.emit('control-used', { id: 'PHONE', kind: 'button' });
    onPickup();
    bus.emit('phone-pickup');
  };
  const reg = (frame: THREE.Matrix4, half: [number, number, number], id: string, label: string) => {
    const it: Interactable = {
      id,
      label,
      kind: 'button',
      inv: frame.clone().invert(),
      half: new THREE.Vector3(...half),
      center: new THREE.Vector3().setFromMatrixPosition(frame),
      detail: () => (target > 0 ? 'call in progress' : 'ring the colleague on the reactor refueling bridge   [LMB / F: pick up]'),
      primary: press,
    };
    kit.interactables.push(it);
  };
  reg(L(0, 0, 0.05), [0.13, 0.11, 0.08], 'PHONE', 'TELEPHONE — REACTOR BLDG EXT 2214');
  // supervisor desk phone (desk at (0, 0, 2.6) rotated π; phone at local (0.35, 0.81, -0.15), yaw 0.2)
  const desk = new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, 0, 2.6).multiply(new THREE.Matrix4().makeRotationY(0.2).setPosition(0.35, 0.84, -0.15));
  reg(desk, [0.14, 0.08, 0.13], 'PHONE_SUPERVISOR', 'TELEPHONE — REACTOR BLDG EXT 2214');

  return {
    handset,
    setLifted(on) {
      target = on ? 1 : 0;
    },
    update(dt) {
      if (Math.abs(target - lifted) < 1e-3) return;
      lifted += (target - lifted) * (1 - Math.exp(-8 * dt));
      if (Math.abs(target - lifted) < 1e-3) lifted = target;
      _p.lerpVectors(restP, upP, lifted);
      _q.slerpQuaternions(restQ, upQ, lifted);
      _s.set(1, 1, 1);
      handset.matrix.compose(_p, _q, _s);
      handset.matrixWorldNeedsUpdate = true;
    },
  };
}

function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const a = p.getAttribute('position') as THREE.BufferAttribute;
    const b = p.getAttribute('normal') as THREE.BufferAttribute;
    pos.set(a.array as Float32Array, o * 3);
    nor.set(b.array as Float32Array, o * 3);
    o += a.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}
