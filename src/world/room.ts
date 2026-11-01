/**
 * Room shell + props: walls, carpet, acoustic ceiling with troffers, door,
 * interior window, supervisor desk, back panels, chairs, binders, clock, beacon.
 */
import * as THREE from 'three';
import type { PlantState } from '../sim/types';
import { PanelKit, Section, HALF_W, RF } from './panel';
import { DEG, FONT, GeoBucket, box, cyl, fitText, plane, zcyl } from './util';
import { furnish } from './props';

export const ROOM = { x0: -10.5, x1: 10.5, z0: -9.4, z1: 8.6, h: 3.5 };

export interface Collider {
  x: number;
  z: number;
  hx: number;
  hz: number;
  c: number; // cos(rot)
  s: number; // sin(rot)
}

export interface RoomResult {
  troffers: THREE.Mesh;
  trofferMat: THREE.MeshBasicMaterial;
  floor: THREE.Mesh;
  ceiling: THREE.Mesh;
  colliders: Collider[];
  beacon: THREE.Group;
  beaconLamp: THREE.MeshBasicMaterial;
  beaconBeams: THREE.Mesh;
  exitSign: THREE.Mesh;
  supervisorScreen: THREE.Mesh;
  /** flat pseudo-sections of the working auxiliary cabinets (left inner, left outer, right inner, right outer) */
  workPanels: Section[];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
function M(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  return _m.compose(_p, _q, _s);
}

function carpetTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = '#3d4552';
  x.fillRect(0, 0, 256, 256);
  const img = x.getImageData(0, 0, 256, 256);
  let seed = 1234;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 30;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n * 1.1;
  }
  x.putImageData(img, 0, 0);
  // subtle carpet tile seams (0.6 m tiles → texture covers 1.2 m: 2 tiles)
  x.strokeStyle = 'rgba(0,0,0,0.25)';
  x.lineWidth = 2;
  x.strokeRect(0, 0, 128, 128);
  x.strokeRect(128, 128, 128, 128);
  x.strokeRect(128, 0, 128, 128);
  x.strokeRect(0, 128, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function ceilingTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = '#d9d6cc';
  x.fillRect(0, 0, 256, 256);
  let seed = 99;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2600; i++) {
    x.fillStyle = `rgba(90,85,75,${0.15 + rnd() * 0.25})`;
    x.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }
  x.fillStyle = '#9d9a90';
  x.fillRect(0, 0, 256, 4);
  x.fillRect(0, 0, 4, 256);
  x.fillRect(0, 126, 256, 4);
  x.fillRect(126, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function trofferTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const x = c.getContext('2d')!;
  x.fillStyle = '#8e8c86';
  x.fillRect(0, 0, 64, 128);
  const g = x.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, '#d8d6cf');
  g.addColorStop(0.5, '#ffffff');
  g.addColorStop(1, '#d8d6cf');
  x.fillStyle = g;
  x.fillRect(5, 5, 54, 118);
  x.fillStyle = 'rgba(160,160,160,0.35)';
  for (let i = 8; i < 124; i += 6) x.fillRect(5, i, 54, 1);
  for (let i = 8; i < 60; i += 6) x.fillRect(i, 5, 1, 118);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildRoom(kit: PanelKit, scene: THREE.Scene, sections: Section[], extraTex: THREE.Texture): RoomResult {
  const B: GeoBucket = kit.shell;
  const R = ROOM;
  const W = R.x1 - R.x0;
  const D = R.z1 - R.z0;
  const cx = (R.x0 + R.x1) / 2;
  const cz = (R.z0 + R.z1) / 2;
  const colliders: Collider[] = [];
  const addCol = (x: number, z: number, hx: number, hz: number, rot = 0) => colliders.push({ x, z, hx, hz, c: Math.cos(rot), s: Math.sin(rot) });

  /* ---------- floor & ceiling (own textured materials) ---------- */
  const floorGeo = new THREE.PlaneGeometry(W, D);
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.translate(cx, 0, cz);
  const uv = floorGeo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (W / 1.2), uv.getY(i) * (D / 1.2));
  const floor = new THREE.Mesh(floorGeo, new THREE.MeshLambertMaterial({ map: carpetTexture() }));
  floor.name = 'floor';
  floor.matrixAutoUpdate = false;
  scene.add(floor);

  const ceilGeo = new THREE.PlaneGeometry(W, D);
  ceilGeo.rotateX(Math.PI / 2);
  ceilGeo.translate(cx, R.h, cz);
  const cuv = ceilGeo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < cuv.count; i++) cuv.setXY(i, cuv.getX(i) * (W / 1.2), cuv.getY(i) * (D / 1.2));
  const ceiling = new THREE.Mesh(ceilGeo, new THREE.MeshLambertMaterial({ map: ceilingTexture(), emissive: 0x2a2924 }));
  ceiling.name = 'ceiling';
  ceiling.matrixAutoUpdate = false;
  scene.add(ceiling);

  /* ---------- walls (subdivided for vertical AO gradient) ---------- */
  const wallUpper = 0xd8d0bc;
  const wallLower = 0x8c8577;
  const wall = (x: number, z: number, len: number, ry: number) => {
    // lower wainscot
    B.add(plane(len, 1.0, 1, 3), M(x, 0.5, z, ry), wallLower);
    B.add(plane(len, R.h - 1.0, 1, 6), M(x, 1.0 + (R.h - 1.0) / 2, z, ry), wallUpper);
    // chair rail + baseboard
    const nx = Math.sin(ry);
    const nz = Math.cos(ry);
    B.add(box(len, 0.06, 0.03), M(x + nx * 0.015, 1.0, z + nz * 0.015, ry), 0x5a5148);
    B.add(box(len, 0.12, 0.02), M(x + nx * 0.01, 0.06, z + nz * 0.01, ry), 0x25221f);
  };
  wall(cx, R.z0, W, 0); // front wall (behind boards), faces +z
  wall(cx, R.z1, W, Math.PI); // back wall
  wall(R.x0, cz, D, Math.PI / 2); // left wall, faces +x
  wall(R.x1, cz, D, -Math.PI / 2); // right wall

  /* ---------- troffers ---------- */
  const tGeos: THREE.BufferGeometry[] = [];
  for (let x = -8.4; x <= 8.5; x += 2.4) {
    for (let z = -8.4; z <= 7.6; z += 2.4) {
      const g = new THREE.PlaneGeometry(0.58, 1.18);
      g.rotateX(Math.PI / 2);
      g.translate(x, R.h - 0.022, z);
      tGeos.push(g);
      B.add(box(0.66, 0.02, 1.26), M(x, R.h - 0.009, z), 0xbdbab0, { ao: false });
    }
  }
  const { mergeGeometries } = BGU;
  const tg = mergeGeometries(tGeos, false)!;
  const trofferMat = new THREE.MeshBasicMaterial({ map: trofferTexture() });
  trofferMat.color.setRGB(1.22, 1.2, 1.12);
  const troffers = new THREE.Mesh(tg, trofferMat);
  troffers.name = 'troffers';
  troffers.matrixAutoUpdate = false;
  scene.add(troffers);

  /* ---------- board colliders + end caps + floor plinth ---------- */
  for (const s of sections) {
    const midZ = 0.08;
    const p = new THREE.Vector3(0, 0, midZ).applyMatrix4(s.matrix);
    addCol(p.x, p.z, HALF_W * 1.02, 0.62, -s.theta);
  }
  // end caps (side panels) of the horseshoe
  for (const s of [sections[0], sections[sections.length - 1]]) {
    const side = s === sections[0] ? -1 : 1;
    const g = box(0.04, 2.46, 1.16);
    const loc = new THREE.Matrix4().makeTranslation(side * (HALF_W * ((RF - 0.08) / RF) + 0.02), 1.23, 0.08);
    B.add(g, loc, 0x6d9a86, { post: s.matrix });
  }

  /* ---------- front wall: clock, unit sign, safety sign ---------- */
  const clockFrame = new THREE.Matrix4().makeTranslation(0, 2.95, R.z0 + 0.02);
  B.add(zcyl(0.32, 0.32, 0.06, 40), clockFrame, 0x1c1c1c, { ao: false });
  kit.dialFree(new THREE.Matrix4().makeTranslation(0, 0, 0.03).premultiply(clockFrame), 0.56, drawClockFace, [
    { get: (s: PlantState) => -((((s.t ?? 0) / 3600 + 6) % 12) / 12) * Math.PI * 2, len: 0.15, wid: 0.016, color: 0x111111 },
    { get: (s: PlantState) => -((((s.t ?? 0) / 60) % 60) / 60) * Math.PI * 2, len: 0.22, wid: 0.01, color: 0x111111 },
    { get: (s: PlantState) => -((Math.floor(s.t ?? 0) % 60) / 60) * Math.PI * 2, len: 0.24, wid: 0.004, color: 0xc01818 },
  ]);
  kit.labelAt(new THREE.Matrix4().makeTranslation(-3.2, 2.95, R.z0 + 0.02), 'UNIT 2  MAIN CONTROL ROOM', 3.0, 0.32, 'black', 400);
  kit.labelAt(new THREE.Matrix4().makeTranslation(3.2, 2.95, R.z0 + 0.02), 'THINK SAFETY · CONSERVATIVE DECISIONS', 3.0, 0.24, 'white', 400);

  /* ---------- furniture, cabinets, office, props (props.ts) ---------- */
  const furn = furnish(kit, scene, colliders);
  const supScreen = furn.supervisorScreen(extraTex);
  // second mug on the reactor control bench
  {
    const s4 = sections[4];
    const m = new THREE.Matrix4().makeTranslation(0.85, 0.88, 0.66).premultiply(s4.matrix);
    B.add(cyl(0.04, 0.036, 0.1, 14), new THREE.Matrix4().makeTranslation(0, 0.05, 0).premultiply(m), 0x9a2a1e);
    B.add(new THREE.TorusGeometry(0.03, 0.009, 6, 12).toNonIndexed().deleteAttribute('uv'), new THREE.Matrix4().makeTranslation(0.045, 0.055, 0).premultiply(m), 0x9a2a1e);
  }
  // procedures clipboard on NIS bench edge (flat on armrest top)
  {
    const s5 = sections[5];
    const m = new THREE.Matrix4().makeRotationY(0.15).setPosition(-0.85, 0.868, 0.64).premultiply(s5.matrix);
    B.add(box(0.23, 0.01, 0.31), m, 0x7a5a3a);
    const paper = new THREE.Matrix4().makeTranslation(0, 0.007, 0.01).premultiply(m);
    B.add(box(0.21, 0.004, 0.27), paper, 0xf2f0e8);
    B.add(box(0.1, 0.012, 0.03), new THREE.Matrix4().makeTranslation(0, 0.012, -0.13).premultiply(m), 0xb8b8b8);
    const lab = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, 0.0108, 0.02).premultiply(m);
    kit.labelAt(lab, 'GOP-102\nREACTOR STARTUP\n1. VERIFY SDM\n2. WITHDRAW SA,SB\n3. ESTABLISH CRIT', 0.19, 0.18, 'white', 900);
  }

  const exitTex = (() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 96;
    const g = c.getContext('2d')!;
    g.fillStyle = '#101010';
    g.fillRect(0, 0, 256, 96);
    g.fillStyle = '#ff3a2a';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitText(g, 'EXIT', 128, 50, 220, 74, 'bold', FONT);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(0.4267, 0.16), new THREE.MeshBasicMaterial({ map: exitTex }));
  (exitSign.material as THREE.MeshBasicMaterial).color.setScalar(1.6);
  exitSign.matrixAutoUpdate = false;
  exitSign.matrix.copy(M(R.x1 - 0.06, 2.45, 5.0, -Math.PI / 2));
  scene.add(exitSign);

  /* ---------- beacon on top of center board ---------- */
  const beacon = new THREE.Group();
  beacon.position.set(0, 2.47, -RF + 0.1);
  B.add(cyl(0.07, 0.08, 0.06, 16), M(0, 2.49, -RF + 0.1), 0x222222, { ao: false });
  const beaconLamp = new THREE.MeshBasicMaterial({ color: 0x2a0806, transparent: true, opacity: 0.95 });
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.16, 16), beaconLamp);
  dome.position.y = 0.1;
  beacon.add(dome);
  const beamGeo = new THREE.PlaneGeometry(3.2, 0.7);
  beamGeo.translate(1.6, 0, 0);
  const beamTex = (() => {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 32;
    const g = c.getContext('2d')!;
    const gr = g.createLinearGradient(0, 0, 128, 0);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 32);
    const gv = g.createLinearGradient(0, 0, 0, 32);
    gv.addColorStop(0, 'rgba(0,0,0,1)');
    gv.addColorStop(0.5, 'rgba(0,0,0,0)');
    gv.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = gv;
    g.fillRect(0, 0, 128, 32);
    return new THREE.CanvasTexture(c);
  })();
  const beamMat = new THREE.MeshBasicMaterial({ map: beamTex, color: 0xff3010, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const beams = new THREE.Mesh(beamGeo, beamMat);
  const b2 = beamGeo.clone();
  b2.rotateY(Math.PI);
  const beamsAll = new THREE.Mesh(BGU.mergeGeometries([beamGeo, b2])!, beamMat);
  beamsAll.position.y = 0.1;
  beamsAll.visible = false;
  beacon.add(beamsAll);
  void beams;
  scene.add(beacon);

  void DEG;
  return { troffers, trofferMat, floor, ceiling, colliders, beacon, beaconLamp, beaconBeams: beamsAll, exitSign, supervisorScreen: supScreen, workPanels: furn.workPanels };
}

function drawClockFace(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }): void {
  const { x, y, w, h } = r;
  ctx.fillStyle = '#1c1c1c';
  ctx.fillRect(x, y, w, h);
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.fillStyle = '#f4f1e6';
  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.48, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const l = i % 5 === 0 ? 0.07 : 0.025;
    ctx.lineWidth = i % 5 === 0 ? 5 : 2;
    ctx.strokeStyle = '#111';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * w * 0.45, cy + Math.sin(a) * w * 0.45);
    ctx.lineTo(cx + Math.cos(a) * w * (0.45 - l), cy + Math.sin(a) * w * (0.45 - l));
    ctx.stroke();
    if (i % 5 === 0) {
      ctx.font = `bold ${Math.round(w * 0.08)}px ${FONT}`;
      ctx.fillText(String(i / 5 || 12), cx + Math.cos(a) * w * 0.33, cy + Math.sin(a) * w * 0.33);
    }
  }
  ctx.font = `bold ${Math.round(w * 0.04)}px ${FONT}`;
  ctx.fillText('PLANT TIME', cx, cy + w * 0.17);
}

import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
