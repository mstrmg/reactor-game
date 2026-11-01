/**
 * Room shell + props: walls, carpet, acoustic ceiling with troffers, door,
 * interior window, supervisor desk, back panels, chairs, binders, clock, beacon.
 */
import * as THREE from 'three';
import type { PlantState } from '../sim/types';
import { PanelKit, Section, HALF_W, RF } from './panel';
import { DEG, FONT, GeoBucket, box, cyl, fitText, plane, zcyl } from './util';

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

  /* ---------- back panel row (along back wall, facing -z) ---------- */
  const bpNames = ['RADIATION MONITORING', 'ELECTRICAL DISTRIBUTION', '4160V BUS', 'CTMT HVAC', 'COMPONENT COOLING', 'SERVICE WATER', 'FIRE PROTECTION'];
  const bpW = 1.6;
  const n = bpNames.length;
  const x0 = -((n - 1) * bpW) / 2;
  const bpRegion = drawBackPanelFace(kit);
  for (let i = 0; i < n; i++) {
    const x = x0 + i * bpW;
    const z = R.z1 - 0.45;
    B.add(box(bpW - 0.02, 2.3, 0.8), M(x, 1.15, z), 0x8fbfa8);
    B.add(box(bpW - 0.02, 0.1, 0.8), M(x, 0.05, z), 0x2a2826);
    // face texture (rotated to face -z)
    const f = new THREE.Matrix4().makeRotationY(Math.PI).setPosition(x, 1.3, z - 0.402);
    kit.staticQuads.add(bpRegion, bpW - 0.16, 1.6, f);
    kit.labelAt(new THREE.Matrix4().makeRotationY(Math.PI).setPosition(x, 2.2, z - 0.403), bpNames[i], bpW - 0.3, 0.09, 'black', 600);
    addCol(x, z, bpW / 2, 0.42);
  }

  /* ---------- supervisor desk ---------- */
  const deskZ = 2.6;
  B.add(box(2.4, 0.05, 0.9), M(0, 0.76, deskZ), 0x6b5a48);
  B.add(box(2.36, 0.68, 0.04), M(0, 0.4, deskZ + 0.42), 0x3c3a38);
  B.add(box(0.04, 0.74, 0.86), M(-1.17, 0.37, deskZ), 0x3c3a38);
  B.add(box(0.04, 0.74, 0.86), M(1.17, 0.37, deskZ), 0x3c3a38);
  B.add(box(0.45, 0.7, 0.8), M(0.85, 0.37, deskZ), 0x55524c); // drawer pedestal
  for (let k = 0; k < 3; k++) B.add(box(0.36, 0.005, 0.01), M(0.85, 0.22 + k * 0.22, deskZ - 0.405), 0x999999);
  addCol(0, deskZ, 1.22, 0.47);
  // supervisor monitor (mirrors CRT-B)
  B.add(box(0.5, 0.42, 0.42), M(-0.4, 1.0, deskZ + 0.1, Math.PI), 0x3a3c3a);
  B.add(box(0.3, 0.03, 0.3), M(-0.4, 0.795, deskZ + 0.1), 0x2a2c2a);
  const supScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.3), new THREE.MeshBasicMaterial({ map: extraTex }));
  (supScreen.material as THREE.MeshBasicMaterial).color.setScalar(1.15);
  supScreen.matrixAutoUpdate = false;
  supScreen.matrix.copy(M(-0.4, 1.0, deskZ - 0.115, Math.PI));
  supScreen.name = 'supervisor-screen';
  scene.add(supScreen);
  // phone
  B.add(box(0.22, 0.07, 0.2), M(0.35, 0.82, deskZ - 0.15, 0.2), 0xcfc6a8);
  B.add(box(0.22, 0.04, 0.06), M(0.35, 0.875, deskZ - 0.2, 0.2), 0xbfb698);
  B.add(box(0.03, 0.09, 0.012), M(0.35, 0.95, deskZ - 0.35, 0.2), 0x222222, { ao: false }); // cord-ish
  // binders on desk
  const binderCols = [0x8a2a22, 0x1e3e7a, 0x2d6a3a, 0xc9a227, 0x1e3e7a];
  binderCols.forEach((c, i) => B.add(box(0.06, 0.3, 0.26), M(-1.0 + i * 0.065, 0.93, deskZ + 0.25), c));
  // mug
  B.add(cyl(0.04, 0.036, 0.1, 14), M(0.7, 0.835, deskZ - 0.2), 0xe8e2d4);
  B.add(new THREE.TorusGeometry(0.03, 0.009, 6, 12).toNonIndexed().deleteAttribute('uv'), M(0.745, 0.84, deskZ - 0.2, 0), 0xe8e2d4);
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
    const lab = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, 0.0095, 0.02).premultiply(m);
    kit.labelAt(lab, 'GOP-102\nREACTOR STARTUP\n1. VERIFY SDM\n2. WITHDRAW SA,SB\n3. ESTABLISH CRIT', 0.19, 0.18, 'white', 900);
  }

  /* ---------- chairs ---------- */
  const chair = (x: number, z: number, ry: number) => {
    B.add(box(0.5, 0.08, 0.48), M(x, 0.48, z, ry), 0x2c3440);
    const bx = x + Math.sin(ry) * 0.24;
    const bz = z + Math.cos(ry) * 0.24;
    B.add(box(0.46, 0.5, 0.07), M(bx, 0.82, bz, ry), 0x2c3440);
    B.add(cyl(0.025, 0.025, 0.4, 8), M(x, 0.26, z), 0x777777);
    for (let k = 0; k < 5; k++) {
      const a = ry + (k * Math.PI * 2) / 5;
      B.add(box(0.035, 0.03, 0.3), M(x + Math.sin(a) * 0.15, 0.06, z + Math.cos(a) * 0.15, a), 0x222222);
    }
  };
  chair(-1.4, -5.7, 0.2);
  chair(1.2, -5.6, -0.3);
  chair(-4.4, -3.8, 1.0);
  chair(0.2, deskZ + 0.95, 0);

  /* ---------- procedures bookshelf (left wall) ---------- */
  {
    const x = R.x0 + 0.25;
    const z = -1.5;
    B.add(box(0.45, 1.9, 2.2), M(x, 0.95, z), 0x6b5a48);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let shelf = 0; shelf < 4; shelf++) {
      const y = 0.32 + shelf * 0.44;
      B.add(box(0.42, 0.36, 2.1), M(x + 0.02, y + 0.2, z), 0x2a241e); // cavity shadow
      let zz = z - 1.0;
      while (zz < z + 0.95) {
        const w = 0.05 + rnd() * 0.04;
        const cols = [0x8a2a22, 0x1e3e7a, 0x2d6a3a, 0xc9a227, 0xe8e2d4, 0x555555];
        B.add(box(0.28, 0.3 + rnd() * 0.04, w - 0.005), M(x + 0.08, y + 0.17, zz + w / 2), cols[Math.floor(rnd() * cols.length)]);
        zz += w;
      }
    }
    kit.labelAt(new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(x + 0.235, 2.02, z), 'EMERGENCY OPERATING PROCEDURES', 1.6, 0.12, 'red', 500);
    addCol(x, z, 0.25, 1.12);
  }

  /* ---------- interior window with blinds (left wall) ---------- */
  {
    const x = R.x0 + 0.03;
    const z = 4.6;
    B.add(box(0.08, 1.32, 2.62), M(x, 1.6, z), 0x5a5148);
    B.add(box(0.02, 1.2, 2.5), M(x + 0.02, 1.6, z), 0x1a2228, { ao: false });
    for (let k = 0; k < 22; k++) B.add(box(0.06, 0.008, 2.46), M(x + 0.05, 1.04 + k * 0.054, z, 0, 0, 0.5), 0xcfcab8, { ao: false });
  }

  /* ---------- door (right wall) + exit sign + extinguisher ---------- */
  {
    const x = R.x1 - 0.03;
    const z = 5.0;
    B.add(box(0.1, 2.25, 1.15), M(x, 1.125, z), 0x3a3a38);
    B.add(box(0.06, 2.12, 1.0), M(x - 0.03, 1.06, z), 0x6e4e32);
    B.add(box(0.03, 0.6, 0.18), M(x - 0.06, 1.55, z + 0.2), 0x1a2228, { ao: false });
    B.add(box(0.06, 0.04, 0.16), M(x - 0.08, 1.0, z - 0.38), 0xb8b8b8, { ao: false });
    B.add(box(0.06, 0.2, 0.06), M(x - 0.04, 0.45, z + 0.95), 0xa01c14);
    B.add(cyl(0.08, 0.08, 0.5, 12), M(x - 0.12, 0.62, z + 0.95), 0xb81e14);
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
  const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.16), new THREE.MeshBasicMaterial({ map: exitTex }));
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
  return { troffers, trofferMat, floor, ceiling, colliders, beacon, beaconLamp, beaconBeams: beamsAll, exitSign, supervisorScreen: supScreen };
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

function drawBackPanelFace(kit: PanelKit) {
  const r = kit.staticAtlas.alloc(560, 640);
  const c = kit.staticAtlas.ctx;
  const { x, y, w, h } = r;
  c.fillStyle = '#8fbfa8';
  c.fillRect(x, y, w, h);
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // row of edgewise meters
  for (let i = 0; i < 8; i++) {
    const mx = x + 20 + i * 66;
    c.fillStyle = '#1b1c1e';
    c.fillRect(mx, y + 30, 46, 150);
    c.fillStyle = '#f1ecdc';
    c.fillRect(mx + 5, y + 36, 36, 138);
    c.fillStyle = '#111';
    for (let k = 0; k < 6; k++) c.fillRect(mx + 22, y + 46 + k * 24, 14, 2);
    c.fillRect(mx + 8, y + 50 + rnd() * 110, 28, 3);
    c.fillStyle = '#151515';
    c.fillRect(mx - 2, y + 186, 50, 16);
  }
  // lamp matrix
  for (let r2 = 0; r2 < 3; r2++)
    for (let i = 0; i < 10; i++) {
      const lx = x + 40 + i * 52;
      const ly = y + 250 + r2 * 60;
      c.fillStyle = '#111';
      c.beginPath();
      c.arc(lx, ly, 13, 0, Math.PI * 2);
      c.fill();
      const on = rnd() < 0.3;
      c.fillStyle = on ? (rnd() < 0.5 ? '#ff6050' : '#70f090') : rnd() < 0.5 ? '#4a1a16' : '#1a3a20';
      c.beginPath();
      c.arc(lx, ly, 9, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#151515';
      c.fillRect(lx - 22, ly + 17, 44, 10);
    }
  // switches
  for (let i = 0; i < 6; i++) {
    const sx = x + 60 + i * 86;
    const sy = y + 500;
    c.fillStyle = '#141414';
    c.fillRect(sx - 34, sy - 40, 68, 80);
    c.fillStyle = '#ddd';
    c.fillRect(sx - 4, sy - 28, 8, 40);
    c.fillStyle = '#efe9da';
    c.font = `bold 11px ${FONT}`;
    c.textAlign = 'center';
    c.fillText('OFF   ON', sx, sy - 31);
  }
  // recorder
  c.fillStyle = '#2b2e30';
  c.fillRect(x + 360, y + 560, 170, 70);
  c.fillStyle = '#f3efe2';
  c.fillRect(x + 370, y + 568, 150, 54);
  c.strokeStyle = '#c0281c';
  c.beginPath();
  c.moveTo(x + 370, y + 600);
  for (let i = 0; i < 150; i += 5) c.lineTo(x + 370 + i, y + 590 + rnd() * 20);
  c.stroke();
  return r;
}

import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
