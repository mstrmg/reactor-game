/**
 * Furnishing of the control room outside the horseshoe: 3D back-panel cabinets,
 * auxiliary panels, wall mimic board, shift supervisor's glass office, desks,
 * chairs, filing cabinets, printer, water cooler, coat rack, fire panel,
 * cable trays, HVAC duct, diffusers, conduits, posters, tiled operator area.
 * Everything static goes into the shared vertex-colored bucket (1 draw call);
 * only the glass, the tile floor and the supervisor screen are extra meshes.
 */
import * as THREE from 'three';
import type { PlantState } from '../sim/types';
import { PanelKit, PALETTE, RF, type MeterDef } from './panel';
import { ROOM, type Collider } from './room';
import { FONT, GeoBucket, MONO, Region, box, cyl, fitText, rbox, zcyl } from './util';

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
/** new matrix: translate + rotate (Y then X then Z) */
function T(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, new THREE.Vector3(1, 1, 1));
}

let seed = 1337;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const sphere = (r: number, ws = 12, hs = 8) => {
  const g = new THREE.SphereGeometry(r, ws, hs).toNonIndexed();
  g.deleteAttribute('uv');
  return g;
};

interface Ctx {
  kit: PanelKit;
  B: GeoBucket;
  addCol: (x: number, z: number, hx: number, hz: number, rot?: number) => void;
  glass: THREE.BufferGeometry[];
  deco: Deco;
}

/* ------------------------------------------------------------------ */
/* shared decorative artwork (drawn once into the static atlas)        */
/* ------------------------------------------------------------------ */
interface Deco {
  edge: Region;
  dials: Region[];
  esc: Region;
  needle: THREE.BufferGeometry;
}
function makeDeco(kit: PanelKit): Deco {
  const edgeDef: MeterDef = { title: '', unit: '%', min: 0, max: 100, ticks: [0, 25, 50, 75, 100], get: () => 0 };
  const edge = kit.allocStatic(80, 280);
  kit.drawEdgewise(kit.staticAtlas.ctx, edge, edgeDef);
  const defs: MeterDef[] = [
    { title: 'BUS VOLTAGE', unit: 'KV', min: 0, max: 5, get: () => 0 },
    { title: 'FEEDER AMPS', unit: 'A', min: 0, max: 1200, ticks: [0, 400, 800, 1200], get: () => 0 },
    { title: 'AREA RAD', unit: 'MR/HR', min: 0.1, max: 1e4, log: true, get: () => 0 },
    { title: 'FLOW', unit: 'GPM', min: 0, max: 5000, ticks: [0, 2500, 5000], get: () => 0 },
    { title: 'TEMPERATURE', unit: '°F', min: 0, max: 200, ticks: [0, 50, 100, 150, 200], get: () => 0 },
  ];
  const dials = defs.map((d) => {
    const r = kit.allocStatic(180, 180);
    kit.drawDial(kit.staticAtlas.ctx, r, d);
    return r;
  });
  const esc = kit.allocStatic(120, 120);
  {
    const c = kit.staticAtlas.ctx;
    c.fillStyle = '#141414';
    c.fillRect(esc.x, esc.y, esc.w, esc.h);
    c.fillStyle = '#efe9da';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `bold 20px ${FONT}`;
    c.fillText('OFF', esc.x + 30, esc.y + 34);
    c.fillText('ON', esc.x + 90, esc.y + 34);
    c.fillText('AUTO', esc.x + 60, esc.y + 18);
  }
  const needle = box(0.0026, 0.085, 0.002);
  needle.translate(0, 0.0425, 0);
  return { edge, dials, esc, needle };
}

/* ------------------------------------------------------------------ */
/* building blocks                                                     */
/* ------------------------------------------------------------------ */
/** a floor-standing 3D instrument cabinet; local +z is the front */
function cabinet(c: Ctx, x: number, z: number, ry: number, w: number, h: number, d: number, title: string, style = 0): void {
  const { B, kit, deco } = c;
  const F = T(x, 0, z, ry);
  const L = (lx: number, ly: number, lz: number, lry = 0, lrx = 0, lrz = 0) => T(lx, ly, lz, lry, lrx, lrz).premultiply(F);
  const panel = style === 1 ? 0xb9b4a2 : PALETTE.panel;
  const face = style === 1 ? 0xc9c4b2 : 0x9cc8b2;
  // body, recessed kick plate, top cap
  B.add(rbox(w - 0.012, h - 0.1, d, 0.02, 2), L(0, 0.1 + (h - 0.1) / 2, 0), panel);
  B.add(box(w - 0.1, 0.1, d - 0.14), L(0, 0.052, -0.02), 0x232120);
  B.add(rbox(w + 0.012, 0.05, d + 0.03, 0.02, 2), L(0, h + 0.024, 0), style === 1 ? 0x8c8778 : PALETTE.panelDark);
  const zf = d / 2;
  // instrument face plate
  const fy0 = 0.95;
  const fy1 = h - 0.07;
  B.add(rbox(w - 0.08, fy1 - fy0, 0.014, 0.006), L(0, (fy0 + fy1) / 2, zf + 0.007), face);
  const zp = zf + 0.014;
  // lower doors with louvers + handles
  const dw = (w - 0.1) / 2;
  for (const sx of [-1, 1]) {
    const cx = (sx * (w - 0.08)) / 4;
    B.add(rbox(dw - 0.01, 0.74, 0.014, 0.006), L(cx, 0.52, zf + 0.007), style === 1 ? 0xaea997 : 0x86b39e);
    for (let k = 0; k < 6; k++) B.add(box(dw - 0.12, 0.014, 0.012), L(cx, 0.24 + k * 0.032, zf + 0.018), 0x3a403c);
    B.add(rbox(0.022, 0.12, 0.028, 0.008), L(cx - sx * (dw / 2 - 0.06), 0.62, zf + 0.026), 0xaab0b4);
  }
  // nameplate
  kit.labelAt(L(0, h - 0.14, zp + 0.003), title, Math.min(w - 0.16, 0.12 + title.length * 0.042), 0.075, 'black', 900);
  // edgewise meter row
  const nEdge = Math.max(2, Math.floor((w - 0.16) / 0.1));
  const yA = h - 0.45;
  for (let i = 0; i < nEdge; i++) {
    const mx = -((nEdge - 1) * 0.1) / 2 + i * 0.1;
    B.add(rbox(0.07, 0.22, 0.036, 0.007), L(mx, yA, zp + 0.018), PALETTE.bezel, { ao: false });
    kit.quad(deco.edge, L(mx, yA, zp + 0.0365), 0.056, 0.196);
    B.add(box(0.03, 0.004, 0.003), L(mx + 0.008, yA + (rnd() - 0.5) * 0.14, zp + 0.039), 0x111111, { ao: false });
  }
  // round meters
  const nDial = Math.max(1, Math.floor((w - 0.16) / 0.21));
  const yB = h - 0.82;
  for (let i = 0; i < nDial; i++) {
    const mx = -((nDial - 1) * 0.21) / 2 + i * 0.21;
    B.add(rbox(0.17, 0.17, 0.032, 0.009), L(mx, yB, zp + 0.016), PALETTE.bezel, { ao: false });
    kit.quad(deco.dials[Math.floor(rnd() * deco.dials.length)], L(mx, yB, zp + 0.0325), 0.152, 0.152);
    B.add(deco.needle, L(mx, yB - 0.055, zp + 0.034, 0, 0, (rnd() - 0.5) * 1.4), 0x111111, { ao: false });
    B.add(zcyl(0.006, 0.006, 0.004, 8), L(mx, yB - 0.055, zp + 0.033), 0x111111, { ao: false });
  }
  // lamp row (instanced lamps; some lit)
  const nLamp = Math.max(3, Math.floor((w - 0.16) / 0.09));
  for (let i = 0; i < nLamp; i++) {
    const lx = -((nLamp - 1) * 0.09) / 2 + i * 0.09;
    const lit = rnd() < 0.35;
    const col = (['red', 'green', 'white', 'amber'] as const)[Math.floor(rnd() * 4)];
    kit.lampAt(L(lx, 1.33, zp), { title: '', color: col, get: () => lit });
    B.add(box(0.06, 0.016, 0.003), L(lx, 1.3, zp + 0.0015), 0x151515, { ao: false });
  }
  // switch row
  const nSw = Math.max(2, Math.floor((w - 0.16) / 0.15));
  for (let i = 0; i < nSw; i++) {
    const sx = -((nSw - 1) * 0.15) / 2 + i * 0.15;
    kit.quad(deco.esc, L(sx, 1.1, zp + 0.0015), 0.1, 0.1);
    B.add(zcyl(0.018, 0.02, 0.012, 14), L(sx, 1.085, zp), 0x0e0e0e, { ao: false });
    B.add(rbox(0.018, 0.07, 0.022, 0.007, 2), L(sx, 1.085, zp + 0.024, 0, 0, (Math.floor(rnd() * 3) - 1) * 0.785).multiply(T(0, 0.012, 0)), 0x161616, { ao: false });
  }
  // world collider
  const p = new THREE.Vector3(0, 0, 0).applyMatrix4(F);
  c.addCol(p.x, p.z, w / 2 + 0.01, d / 2 + 0.03, ry);
}

/** office/rolling chair; sits facing local -z */
function chair(B: GeoBucket, x: number, z: number, ry: number, color = 0x2c3440): void {
  const F = T(x, 0, z, ry);
  const L = (lx: number, ly: number, lz: number, lry = 0, lrx = 0) => T(lx, ly, lz, lry, lrx).premultiply(F);
  B.add(rbox(0.5, 0.08, 0.48, 0.032, 2), L(0, 0.48, 0), color);
  B.add(rbox(0.46, 0.52, 0.07, 0.03, 2), L(0, 0.88, 0.25, 0, -0.12), color);
  B.add(rbox(0.06, 0.3, 0.03, 0.01), L(0, 0.6, 0.24), 0x2a2a2a);
  for (const s of [-1, 1]) {
    B.add(rbox(0.055, 0.04, 0.28, 0.015), L(s * 0.27, 0.68, 0.0), 0x222222);
    B.add(rbox(0.03, 0.17, 0.03, 0.01), L(s * 0.27, 0.58, 0.06), 0x333333);
  }
  B.add(cyl(0.024, 0.024, 0.3, 16), L(0, 0.29, 0), 0x8a8f94);
  B.add(cyl(0.036, 0.036, 0.1, 16), L(0, 0.4, 0), 0x222222);
  B.add(cyl(0.05, 0.05, 0.05, 16), L(0, 0.09, 0), 0x222222);
  for (let k = 0; k < 5; k++) {
    const a = (k * Math.PI * 2) / 5 + 0.3;
    B.add(rbox(0.04, 0.03, 0.3, 0.012), L(Math.sin(a) * 0.15, 0.075, Math.cos(a) * 0.15, a), 0x222222);
    B.add(sphere(0.024, 8, 6), L(Math.sin(a) * 0.29, 0.025, Math.cos(a) * 0.29), 0x111111);
  }
}

/** desk with steel frame; front edge toward local -z */
function desk(c: Ctx, x: number, z: number, ry: number, w: number, d: number, top = 0x6b5a48, col = true): (lx: number, ly: number, lz: number, lry?: number) => THREE.Matrix4 {
  const { B } = c;
  const F = T(x, 0, z, ry);
  const L = (lx: number, ly: number, lz: number, lry = 0) => T(lx, ly, lz, lry).premultiply(F);
  B.add(rbox(w, 0.045, d, 0.012, 2), L(0, 0.752, 0), top);
  B.add(rbox(w - 0.04, 0.06, d - 0.04, 0.01), L(0, 0.7, 0), 0x3c3a38);
  B.add(rbox(w - 0.08, 0.6, 0.03, 0.01), L(0, 0.38, d / 2 - 0.05), 0x3c3a38);
  for (const s of [-1, 1]) B.add(rbox(0.04, 0.7, d - 0.06, 0.012), L(s * (w / 2 - 0.04), 0.35, 0), 0x3c3a38);
  // drawer pedestal
  const px = w / 2 - 0.3;
  B.add(rbox(0.44, 0.66, d - 0.08, 0.01), L(px, 0.35, 0), 0x55524c);
  for (let k = 0; k < 3; k++) {
    B.add(rbox(0.4, 0.2, 0.012, 0.005), L(px, 0.15 + k * 0.215, -d / 2 + 0.035), 0x605d56);
    B.add(rbox(0.14, 0.018, 0.025, 0.008), L(px, 0.2 + k * 0.215, -d / 2 + 0.025), 0xaab0b4);
  }
  if (col) {
    const p = new THREE.Vector3().applyMatrix4(F);
    c.addCol(p.x, p.z, w / 2 + 0.02, d / 2 + 0.02, ry);
  }
  return L;
}

function crtMonitor(B: GeoBucket, M: THREE.Matrix4, screen = 0x0e2a18): void {
  B.add(rbox(0.46, 0.4, 0.36, 0.04, 2), M.clone().multiply(T(0, 0.27, 0.04)), 0xb8b2a0);
  B.add(rbox(0.36, 0.28, 0.22, 0.03, 2), M.clone().multiply(T(0, 0.27, 0.22)), 0xa8a290);
  B.add(rbox(0.36, 0.28, 0.02, 0.02, 2), M.clone().multiply(T(0, 0.27, -0.145)), screen, { ao: false });
  B.add(rbox(0.26, 0.04, 0.24, 0.01), M.clone().multiply(T(0, 0.04, 0.05)), 0x8a8578);
  B.add(rbox(0.42, 0.03, 0.15, 0.008), M.clone().multiply(T(0, 0.015, -0.32)), 0xc9c3b0);
}

function binderRow(B: GeoBucket, M: THREE.Matrix4, n: number): void {
  const cols = [0x8a2a22, 0x1e3e7a, 0x2d6a3a, 0xc9a227, 0xe8e2d4, 0x555555, 0x1e3e7a];
  for (let i = 0; i < n; i++) {
    const w = 0.05 + rnd() * 0.03;
    B.add(rbox(w, 0.3, 0.26, 0.006, 1), M.clone().multiply(T(i * 0.07, 0.15, 0)), cols[Math.floor(rnd() * cols.length)]);
  }
}

function mug(B: GeoBucket, M: THREE.Matrix4, color: number): void {
  B.add(cyl(0.04, 0.036, 0.1, 20), M.clone().multiply(T(0, 0.05, 0)), color);
  const h = new THREE.TorusGeometry(0.03, 0.009, 8, 16).toNonIndexed();
  h.deleteAttribute('uv');
  B.add(h, M.clone().multiply(T(0.045, 0.055, 0)), color);
}

/* ------------------------------------------------------------------ */
export function furnish(kit: PanelKit, scene: THREE.Scene, colliders: Collider[]) {
  seed = 1337;
  const B = kit.shell;
  const R = ROOM;
  const addCol = (x: number, z: number, hx: number, hz: number, rot = 0) => colliders.push({ x, z, hx, hz, c: Math.cos(rot), s: Math.sin(rot) });
  const c: Ctx = { kit, B, addCol, glass: [], deco: makeDeco(kit) };

  /* ---------- tiled operator area inside the horseshoe ---------- */
  {
    const rf = (RF - 0.6) / Math.cos((9 * Math.PI) / 180); // vertex radius of the bench-front polygon
    const pts: [number, number][] = [];
    for (let k = 0; k <= 10; k++) {
      const th = ((-90 + 18 * k) * Math.PI) / 180;
      const r = k === 0 || k === 10 ? RF - 0.6 : rf;
      pts.push([r * Math.sin(th), -r * Math.cos(th)]);
    }
    for (let k = 1; k < 24; k++) {
      const th = ((90 + (180 * k) / 24) * Math.PI) / 180;
      pts.push([(RF - 0.6) * Math.sin(th), -(RF - 0.6) * Math.cos(th)]);
    }
    const pos: number[] = [];
    const uv: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      pos.push(0, 0.004, 0, b[0], 0.004, b[1], a[0], 0.004, a[1]);
      uv.push(0, 0, b[0] / 0.6, b[1] / 0.6, a[0] / 0.6, a[1] / 0.6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const mat = new THREE.MeshLambertMaterial({ map: tileTexture(), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const m = new THREE.Mesh(g, mat);
    m.name = 'tile-floor';
    m.matrixAutoUpdate = false;
    scene.add(m);
    // stainless reducer strip around the open (back) side
    const lathe = new THREE.LatheGeometry(
      [new THREE.Vector2(RF - 0.63, 0), new THREE.Vector2(RF - 0.615, 0.012), new THREE.Vector2(RF - 0.585, 0.012), new THREE.Vector2(RF - 0.57, 0)],
      48,
      -Math.PI / 2 + Math.PI,
      Math.PI,
    ).toNonIndexed();
    lathe.deleteAttribute('uv');
    // lathe phi: x = r sin(phi), z = r cos(phi) → we want z ≥ 0 (back side): phi in [-90°, 90°]
    lathe.rotateY(Math.PI);
    B.add(lathe, null, 0x9aa1a4, { ao: false });
  }

  /* ---------- auxiliary panels closing the horseshoe ends to the side walls ---------- */
  for (const side of [-1, 1]) {
    const x0 = RF + 0.55; // just outside the end board
    const x1 = -R.x0 - 0.02;
    const n = 2;
    const w = (x1 - x0) / n;
    for (let i = 0; i < n; i++) {
      const cx = side * (x0 + w * (i + 0.5));
      cabinet(c, cx, -0.48, 0, w, 2.3, 0.84, side < 0 ? ['AUX FEEDWATER', 'DIESEL GEN A/B'][i] : ['MAIN STEAM ISOL', 'CONDENSATE'][i], 0);
    }
  }

  /* ---------- back panel row (3D cabinets, facing -z) ---------- */
  const bpNames = ['RADIATION MONITORING', 'ELECTRICAL DISTRIBUTION', '4160V SWITCHGEAR', 'CTMT HVAC', 'COMPONENT COOLING', 'SERVICE WATER', 'FIRE PROTECTION'];
  const bpW = 1.6;
  for (let i = 0; i < bpNames.length; i++) {
    const x = -((bpNames.length - 1) * bpW) / 2 + i * bpW;
    cabinet(c, x, R.z1 - 0.47, Math.PI, bpW - 0.02, 2.3, 0.84, bpNames[i], i % 3 === 1 ? 1 : 0);
  }

  /* ---------- wall mimic board above the back panels ---------- */
  {
    const mw = 11.2;
    const mh = 0.6;
    const y = 2.76;
    const z = R.z1 - 0.03;
    B.add(rbox(mw + 0.12, mh + 0.1, 0.05, 0.02, 2), T(0, y, z), 0x2c3236);
    const F = T(0, y, z - 0.026, Math.PI);
    kit.staticDraw(F, mw, mh, 230, drawMimic);
    kit.labelAt(T(0, y + mh / 2 + 0.1, z - 0.02, Math.PI), 'UNIT 2 PLANT MIMIC', 1.8, 0.11, 'black', 600);
    // live lamps on the mimic (u,v in 0..1 of the drawing)
    const lamp = (u: number, v: number, color: 'red' | 'green' | 'white' | 'amber', get: (s: PlantState) => boolean) =>
      kit.lampAt(T(mw / 2 - u * mw, y + mh / 2 - v * mh, z - 0.027, Math.PI), { title: '', color, get: (s) => get(s) });
    for (let i = 0; i < 4; i++) lamp(0.16 + i * 0.045, 0.82, 'red', (s) => s.loops[i].rcpRunning);
    lamp(0.06, 0.2, 'red', (s) => s.reactorTripped);
    lamp(0.06, 0.32, 'green', (s) => !s.reactorTripped);
    lamp(0.6, 0.18, 'white', (s) => s.turbineLatched);
    lamp(0.79, 0.18, 'red', (s) => s.generatorBreakerClosed);
    lamp(0.79, 0.3, 'green', (s) => !s.generatorBreakerClosed);
    lamp(0.93, 0.18, 'green', (s) => s.offsitePower);
    lamp(0.5, 0.86, 'red', (s) => s.mainFeedPumpsRunning[0]);
    lamp(0.545, 0.86, 'red', (s) => s.mainFeedPumpsRunning[1]);
    lamp(0.66, 0.86, 'amber', (s) => s.auxFeedPumpsRunning.some(Boolean));
    lamp(0.25, 0.18, 'red', (s) => s.porvOpen);
    lamp(0.06, 0.6, 'amber', (s) => s.siActuated);
  }

  /* ---------- supervisor desk (center) ---------- */
  const deskZ = 2.6;
  const DL = desk(c, 0, deskZ, Math.PI, 2.4, 0.9);
  crtMonitor(B, DL(-0.4, 0.775, 0.1));
  B.add(rbox(0.22, 0.07, 0.2, 0.02, 2), DL(0.35, 0.81, -0.15, 0.2), 0xcfc6a8); // phone
  B.add(rbox(0.22, 0.045, 0.06, 0.02, 2), DL(0.35, 0.865, -0.2, 0.2), 0xbfb698);
  binderRow(B, DL(-1.05, 0.775, 0.25), 5);
  mug(B, DL(0.7, 0.775, -0.2), 0xe8e2d4);
  B.add(rbox(0.3, 0.012, 0.22, 0.004), DL(0.05, 0.78, -0.2, -0.1), 0xf2f0e8); // logbook
  B.add(rbox(0.3, 0.01, 0.22, 0.004), DL(0.05, 0.773, -0.2, -0.1), 0x1e3e7a);
  chair(B, -0.2, deskZ + 0.85, 0);
  // alarm printer on its stand beside the desk
  {
    const L = (x: number, y: number, z: number, ry = 0) => T(1.85 + x, y, deskZ + z, ry);
    B.add(rbox(0.7, 0.7, 0.55, 0.015), L(0, 0.35, 0), 0x55524c);
    B.add(rbox(0.6, 0.22, 0.45, 0.03, 2), L(0, 0.81, 0), 0xc9c3b0);
    B.add(rbox(0.5, 0.05, 0.2, 0.01), L(0, 0.94, 0.08), 0x2a2a2a);
    B.add(rbox(0.42, 0.3, 0.006, 0.002), L(0, 1.05, 0.1, 0), 0xf4f1e8); // paper going up
    B.add(rbox(0.42, 0.006, 0.4, 0.002), L(0, 0.705, -0.45), 0xf4f1e8); // paper spill on floor stand
    kit.labelAt(L(0, 0.81, -0.231), 'ALARM TYPER', 0.25, 0.04, 'black', 900);
    addCol(1.85, deskZ, 0.37, 0.3);
  }
  // trash can
  B.add(cyl(0.15, 0.13, 0.36, 20), T(-1.45, 0.18, deskZ - 0.2), 0x4a4a46);

  /* ---------- shift technical advisor console (back right) ---------- */
  {
    const L = desk(c, 4.6, 5.0, Math.PI, 1.8, 0.85, 0x7a6a56);
    crtMonitor(B, L(-0.35, 0.775, 0.12));
    crtMonitor(B, L(0.4, 0.775, 0.12, -0.25), 0x24200c);
    binderRow(B, L(0.62, 0.775, -0.25, 1.4), 3);
    mug(B, L(0.1, 0.775, -0.25), 0x2d6a3a);
    chair(B, 4.5, 5.85, 0.2);
    kit.labelAt(T(4.6, 0.55, 5.0 - 0.393, Math.PI), 'SHIFT TECHNICAL ADVISOR', 0.6, 0.06, 'black', 800);
  }

  /* ---------- work control table (back left of center) ---------- */
  {
    const L = desk(c, -3.6, 5.2, 0, 2.0, 1.0, 0x8a7a62);
    binderRow(B, L(-0.8, 0.775, 0.3), 6);
    B.add(rbox(0.6, 0.008, 0.45, 0.003), L(0.1, 0.778, -0.05, 0.2), 0xd8e2ec); // drawing (P&ID)
    B.add(rbox(0.21, 0.01, 0.3, 0.003), L(0.6, 0.779, -0.1, -0.3), 0xf2f0e8);
    mug(B, L(0.75, 0.775, 0.25), 0x8a2a22);
    chair(B, -4.1, 4.45, Math.PI + 0.3);
    chair(B, -3.0, 4.4, Math.PI - 0.2);
    chair(B, -3.4, 6.1, 0.1);
  }

  /* ---------- horseshoe operator chairs ---------- */
  chair(B, -1.4, -5.7, 0.2);
  chair(B, 1.2, -5.6, -0.3);
  chair(B, -4.4, -3.8, 1.0);
  chair(B, 4.6, -3.6, -1.1);

  /* ---------- shift supervisor's glass office (back left corner) ---------- */
  {
    const zf = 4.4; // front wall line
    const xs = -6.6; // side wall line
    const doorA = -7.85;
    const doorB = -6.9;
    const wall = (x0: number, x1: number, z0: number, z1: number) => {
      // solid lower wall, glass band, solid header
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const lx = Math.abs(x1 - x0) + 0.1;
      const lz = Math.abs(z1 - z0) + 0.1;
      B.add(rbox(lx, 0.95, lz, 0.015), T(cx, 0.475, cz), 0xc8c0aa);
      B.add(rbox(lx + 0.02, 0.06, lz + 0.02, 0.015), T(cx, 0.975, cz), 0x5a5148);
      B.add(box(lx, 3.5 - 2.3, lz), T(cx, 2.3 + (3.5 - 2.3) / 2, cz), 0xd8d0bc);
      B.add(rbox(lx + 0.02, 0.06, lz + 0.02, 0.015), T(cx, 2.3, cz), 0x5a5148);
      const len = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
      const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
      const nm = Math.max(1, Math.round(len / 1.1));
      for (let k = 0; k <= nm; k++) {
        const t = k / nm;
        const mx = alongX ? x0 + (x1 - x0) * t : cx;
        const mz = alongX ? cz : z0 + (z1 - z0) * t;
        B.add(rbox(0.06, 1.32, 0.08, 0.012), T(mx, 1.64, mz), 0x4a4540);
      }
      const g = new THREE.PlaneGeometry(len, 1.3);
      g.applyMatrix4(T(cx, 1.64, cz, alongX ? 0 : Math.PI / 2));
      g.deleteAttribute('uv');
      c.glass.push(g);
      const lxh = alongX ? Math.abs(x1 - x0) / 2 + 0.05 : 0.08;
      const lzh = alongX ? 0.08 : Math.abs(z1 - z0) / 2 + 0.05;
      addCol(cx, cz, lxh, lzh);
    };
    wall(R.x0, doorA, zf, zf);
    wall(doorB, xs, zf, zf);
    wall(xs, xs, zf, R.z1);
    // header over door
    B.add(box(Math.abs(doorB - doorA) + 0.02, 3.5 - 2.2, 0.1), T((doorA + doorB) / 2, 2.2 + (3.5 - 2.2) / 2, zf), 0xd8d0bc);
    B.add(rbox(0.06, 2.2, 0.12, 0.01), T(doorA + 0.03, 1.1, zf), 0x4a4540);
    B.add(rbox(0.06, 2.2, 0.12, 0.01), T(doorB - 0.03, 1.1, zf), 0x4a4540);
    kit.labelAt(T((doorA + doorB) / 2, 2.32, zf - 0.052, Math.PI), 'SHIFT SUPERVISOR', 0.8, 0.09, 'black', 700);
    kit.labelAt(T((doorA + doorB) / 2, 2.32, zf + 0.052, 0), 'SHIFT SUPERVISOR', 0.8, 0.09, 'black', 700);
    // office furniture
    const L = desk(c, -8.6, 7.5, 0, 1.8, 0.85, 0x6b5a48);
    crtMonitor(B, L(0.3, 0.775, 0.1));
    binderRow(B, L(-0.8, 0.775, 0.25), 4);
    mug(B, L(-0.2, 0.775, -0.2), 0x1e3e7a);
    chair(B, -8.6, 6.65, Math.PI);
    chair(B, -9.4, 5.4, 2.2, 0x5a3a2a);
    for (let i = 0; i < 2; i++) {
      const fx = -10.18;
      const fz = 5.0 + i * 0.5;
      filingCabinet(c, fx, fz, Math.PI / 2);
    }
    // potted plant
    B.add(cyl(0.16, 0.12, 0.32, 20), T(-7.0, 0.16, 8.2), 0x8a5a3a);
    for (let k = 0; k < 9; k++) {
      const a = k * 0.7;
      const leaf = new THREE.ConeGeometry(0.07, 0.55, 6).toNonIndexed();
      leaf.deleteAttribute('uv');
      B.add(leaf, T(-7.0 + Math.sin(a) * 0.08, 0.55 + (k % 3) * 0.06, 8.2 + Math.cos(a) * 0.08, a, 0.35, 0), 0x3d7a3a);
    }
    addCol(-7.0, 8.2, 0.2, 0.2);
    // wall clock/calendar poster inside
    kit.staticDraw(T(R.x0 + 0.015, 1.7, 6.6, Math.PI / 2), 0.9, 1.1, 300, (ctx, r) => poster(ctx, r, 'SHIFT SCHEDULE', ['A  DAYS   JONES', 'B  SWING  OKAFOR', 'C  NIGHTS KOWALSKI', 'D  RELIEF MARTINEZ', 'E  TRAINING', '', 'OUTAGE 2R14: 41 DAYS']));
    const gm = BGU.mergeGeometries(c.glass, false)!;
    for (const g of c.glass) g.dispose();
    const glass = new THREE.Mesh(gm, new THREE.MeshLambertMaterial({ color: 0xa8ccd0, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
    glass.name = 'office-glass';
    glass.matrixAutoUpdate = false;
    glass.renderOrder = 2;
    scene.add(glass);
  }

  /* ---------- left wall: bookshelf, whiteboard, poster ---------- */
  {
    const x = R.x0 + 0.24;
    const z = 1.6;
    // open shelving unit: back, sides, top, shelves (books visible)
    B.add(box(0.03, 1.92, 2.2), T(x - 0.205, 0.96, z), 0x4a3c2c);
    for (const sz of [-1, 1]) B.add(rbox(0.44, 1.92, 0.035, 0.008), T(x, 0.96, z + sz * 1.0825), 0x6b5a48);
    B.add(rbox(0.46, 0.04, 2.22, 0.01), T(x, 1.94, z), 0x6b5a48);
    B.add(box(0.44, 0.08, 2.15), T(x, 0.04, z), 0x3a3028);
    for (let shelf = 0; shelf < 4; shelf++) {
      const y = 0.1 + shelf * 0.45;
      B.add(box(0.42, 0.025, 2.13), T(x + 0.005, y, z), 0x5a4a38);
      let zz = z - 1.03;
      while (zz < z + 0.95) {
        const w = 0.045 + rnd() * 0.035;
        const cols = [0x8a2a22, 0x1e3e7a, 0x2d6a3a, 0xc9a227, 0xe8e2d4, 0x555555];
        const bh = 0.3 + rnd() * 0.06;
        B.add(rbox(0.28, bh, w - 0.005, 0.006, 1), T(x - 0.03, y + 0.0125 + bh / 2, zz + w / 2), cols[Math.floor(rnd() * cols.length)]);
        zz += w;
      }
    }
    kit.labelAt(T(x + 0.225, 2.04, z, Math.PI / 2), 'EMERGENCY OPERATING PROCEDURES', 1.6, 0.11, 'red', 600);
    addCol(x, z, 0.25, 1.12);
    // whiteboard
    const wz = 3.6;
    B.add(rbox(0.04, 1.06, 1.46, 0.012), T(R.x0 + 0.02, 1.6, wz), 0x9a9a9a);
    kit.staticDraw(T(R.x0 + 0.042, 1.6, wz, Math.PI / 2), 1.4, 1.0, 380, (ctx, r) => whiteboard(ctx, r));
    B.add(rbox(0.07, 0.03, 1.2, 0.01), T(R.x0 + 0.05, 1.08, wz), 0x9a9a9a);
    // EAL poster between shelf and front-left
    B.add(rbox(0.03, 1.0, 0.8, 0.008), T(R.x0 + 0.015, 1.75, 0.0), 0x2a2a2a);
    kit.staticDraw(T(R.x0 + 0.032, 1.75, 0.0, Math.PI / 2), 0.74, 0.94, 300, (ctx, r) => poster(ctx, r, 'EMERGENCY ACTION LEVELS', ['UNUSUAL EVENT', 'ALERT', 'SITE AREA EMERGENCY', 'GENERAL EMERGENCY', '', 'NOTIFY STATE WITHIN 15 MIN', 'NRC ENS WITHIN 1 HR']));
    // extinguisher
    B.add(cyl(0.08, 0.08, 0.5, 20), T(R.x0 + 0.13, 0.62, -0.95), 0xb81e14);
    B.add(rbox(0.05, 0.08, 0.05, 0.01), T(R.x0 + 0.13, 0.92, -0.95), 0x222222);
  }

  /* ---------- right wall: filing cabinets, fire panel, door, cooler, coat rack ---------- */
  {
    const X = R.x1;
    for (let i = 0; i < 4; i++) filingCabinet(c, X - 0.32, 0.55 + i * 0.48, -Math.PI / 2);
    B.add(rbox(0.3, 0.08, 0.3, 0.01), T(X - 0.3, 1.36, 0.8), 0x9a2a1e); // stuff on top
    binderRow(B, T(X - 0.32, 1.32, 1.3, Math.PI / 2), 5);
    // fire alarm panel
    B.add(rbox(0.12, 0.8, 0.6, 0.02, 2), T(X - 0.06, 1.5, 3.3), 0xa01c14);
    kit.staticDraw(T(X - 0.121, 1.55, 3.3, -Math.PI / 2), 0.5, 0.62, 400, (ctx, r) => firePanel(ctx, r));
    for (let k = 0; k < 4; k++) kit.lampAt(T(X - 0.121, 1.3, 3.12 + k * 0.12, -Math.PI / 2), { title: '', color: k === 0 ? 'green' : 'amber', get: (s) => (k === 0 ? true : k === 1 ? s.containmentPressure > 3 : false) });
    // door
    const dz = 5.0;
    B.add(rbox(0.12, 2.28, 1.2, 0.02), T(X - 0.04, 1.14, dz), 0x3a3a38);
    B.add(rbox(0.07, 2.12, 1.0, 0.01), T(X - 0.07, 1.06, dz), 0x6e4e32);
    B.add(rbox(0.03, 0.6, 0.2, 0.01), T(X - 0.11, 1.55, dz + 0.2), 0x1a2228, { ao: false });
    B.add(rbox(0.06, 0.04, 0.16, 0.015), T(X - 0.13, 1.0, dz - 0.38), 0xb8b8b8, { ao: false });
    B.add(rbox(0.04, 0.05, 0.4, 0.015), T(X - 0.12, 1.0, dz - 0.15), 0xb8b8b8, { ao: false }); // push bar
    kit.labelAt(T(X - 0.111, 1.3, dz + 0.2, -Math.PI / 2), 'AUTHORIZED\nPERSONNEL ONLY', 0.22, 0.08, 'yellow', 800);
    // extinguisher
    B.add(cyl(0.08, 0.08, 0.5, 20), T(X - 0.14, 0.62, dz + 0.95), 0xb81e14);
    B.add(rbox(0.05, 0.08, 0.05, 0.01), T(X - 0.14, 0.92, dz + 0.95), 0x222222);
    // water cooler
    {
      const cx = X - 0.3;
      const cz = 6.5;
      B.add(rbox(0.36, 1.0, 0.36, 0.03, 2), T(cx, 0.5, cz), 0xd8d4c8);
      B.add(rbox(0.3, 0.08, 0.06, 0.02), T(cx - 0.17, 0.85, cz), 0x9aa1a4);
      const bottle = new THREE.CylinderGeometry(0.14, 0.14, 0.42, 24).toNonIndexed();
      bottle.deleteAttribute('uv');
      B.add(bottle, T(cx, 1.22, cz), 0x6aa8d8);
      B.add(cyl(0.05, 0.13, 0.08, 24), T(cx, 1.03, cz), 0x6aa8d8);
      addCol(cx, cz, 0.22, 0.22);
    }
    // coat rack
    {
      const cx = X - 0.35;
      const cz = 7.7;
      B.add(cyl(0.02, 0.02, 1.75, 12), T(cx, 0.9, cz), 0x4a3a2a);
      B.add(cyl(0.2, 0.22, 0.04, 20), T(cx, 0.02, cz), 0x4a3a2a);
      for (let k = 0; k < 4; k++) B.add(cyl(0.012, 0.012, 0.18, 8), T(cx + Math.sin(k * 1.57) * 0.06, 1.72, cz + Math.cos(k * 1.57) * 0.06, k * 1.57, 0.9), 0x4a3a2a);
      B.add(rbox(0.36, 0.7, 0.16, 0.06, 2), T(cx - 0.08, 1.35, cz, 0.3), 0x2a3a5a); // coat
      B.add(rbox(0.28, 0.5, 0.1, 0.04, 2), T(cx + 0.06, 1.45, cz + 0.1, -0.6), 0x8a7a50); // jacket
      B.add(cyl(0.12, 0.13, 0.12, 20), T(cx, 1.86, cz), 0xe8e2d4); // hard hat
      B.add(cyl(0.16, 0.16, 0.012, 20), T(cx, 1.8, cz), 0xe8e2d4);
      addCol(cx, cz, 0.22, 0.22);
    }
    // posters above filing cabinets
    B.add(rbox(0.03, 0.8, 1.1, 0.008), T(X - 0.015, 2.25, 1.3), 0x2a2a2a);
    kit.staticDraw(T(X - 0.032, 2.25, 1.3, -Math.PI / 2), 1.04, 0.74, 280, (ctx, r) => poster(ctx, r, 'TECH SPEC LCO STATUS', ['3.4.1 RCS DNB    MET', '3.1.4 ROD GROUP  MET', '3.5.1 ACCUMS     MET', '3.8.1 AC SOURCES MET', '3.7.5 AFW        MET']));
  }

  /* ---------- ceiling services: cable trays, duct, diffusers, detectors ---------- */
  {
    const tray = (x0: number, z0: number, x1: number, z1: number) => {
      const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
      const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const ry = alongX ? 0 : Math.PI / 2;
      const L = (lx: number, ly: number, lz: number) => T(lx, ly, lz).premultiply(T(cx, 0, cz, ry));
      B.add(box(len, 0.012, 0.45), L(0, 3.1, 0), 0x8a9094);
      B.add(box(len, 0.1, 0.012), L(0, 3.15, 0.22), 0x8a9094);
      B.add(box(len, 0.1, 0.012), L(0, 3.15, -0.22), 0x8a9094);
      const cols = [0x222222, 0x1a1a1a, 0x5a1a14, 0x1e2a4a, 0x333333];
      for (let k = 0; k < 6; k++) {
        const g = new THREE.CylinderGeometry(0.022, 0.022, len, 10).toNonIndexed();
        g.deleteAttribute('uv');
        g.rotateZ(Math.PI / 2);
        B.add(g, L(0, 3.13 + (k % 2) * 0.04, -0.15 + k * 0.06), cols[k % cols.length], { ao: false });
      }
      for (let t = -len / 2 + 0.6; t < len / 2; t += 1.8) {
        B.add(cyl(0.008, 0.008, 0.4, 8), L(t, 3.3, 0.24), 0x777777);
        B.add(cyl(0.008, 0.008, 0.4, 8), L(t, 3.3, -0.24), 0x777777);
        B.add(box(0.04, 0.03, 0.52), L(t, 3.09, 0), 0x666666);
      }
    };
    tray(R.x0, 0, R.x1, 0);
    tray(9.7, R.z0, 9.7, R.z1);
    tray(-9.7, R.z0, -9.7, 4.3);
    // HVAC duct along the back wall
    B.add(rbox(R.x1 - R.x0, 0.36, 0.5, 0.03, 2), T(0, 3.3, R.z1 - 0.3), 0xb0b4b6);
    for (let x = R.x0 + 1; x < R.x1; x += 2) B.add(box(0.05, 0.38, 0.52), T(x, 3.3, R.z1 - 0.3), 0x8a8f92);
    for (let x = -8; x <= 8; x += 4) {
      B.add(rbox(0.5, 0.012, 0.12, 0.004), T(x, 3.115, R.z1 - 0.3), 0x6a6f72); // register
    }
    // ceiling diffusers
    const diff = (x: number, z: number) => {
      B.add(box(0.6, 0.02, 0.6), T(x, 3.49, z), 0xc8c6be, { ao: false });
      for (let k = 0; k < 3; k++) {
        const s = 0.5 - k * 0.13;
        B.add(box(s, 0.02, 0.02), T(x, 3.47 - k * 0.006, z + s / 2), 0xb0aea6, { ao: false });
        B.add(box(s, 0.02, 0.02), T(x, 3.47 - k * 0.006, z - s / 2), 0xb0aea6, { ao: false });
        B.add(box(0.02, 0.02, s), T(x + s / 2, 3.47 - k * 0.006, z), 0xb0aea6, { ao: false });
        B.add(box(0.02, 0.02, s), T(x - s / 2, 3.47 - k * 0.006, z), 0xb0aea6, { ao: false });
      }
      B.add(box(0.12, 0.03, 0.12), T(x, 3.46, z), 0x8a8880, { ao: false });
    };
    for (const [x, z] of [[-4.8, -4.8], [4.8, -4.8], [0, -2.4], [-7.2, 2.4], [7.2, 2.4], [0, 4.8], [-4.8, 7.2], [4.8, 7.2], [0, -7.2]]) diff(x, z);
    // smoke detectors + sprinklers + PA speakers
    for (let x = -7.2; x <= 7.2; x += 4.8)
      for (let z = -7.2; z <= 7.2; z += 4.8) {
        B.add(cyl(0.065, 0.07, 0.035, 24), T(x + 1.2, 3.482, z + 1.2), 0xeeeae0, { ao: false });
        B.add(cyl(0.012, 0.012, 0.05, 10), T(x - 1.2, 3.47, z + 1.2), 0xb8a060, { ao: false });
        B.add(cyl(0.03, 0.01, 0.015, 12), T(x - 1.2, 3.44, z + 1.2), 0xb8a060, { ao: false });
      }
    for (const [x, z] of [[-6, -1.2 + 2.4], [6, 1.2], [0, 6.0]]) {
      B.add(cyl(0.2, 0.2, 0.02, 32), T(x, 3.49, z), 0xd8d4c8, { ao: false });
      for (let k = 1; k <= 4; k++) {
        const g = new THREE.TorusGeometry(0.04 * k, 0.006, 4, 32).toNonIndexed();
        g.deleteAttribute('uv');
        g.rotateX(Math.PI / 2);
        B.add(g, T(x, 3.478, z), 0x9a968c, { ao: false });
      }
    }
    // conduits up the walls + junction boxes
    const conduit = (x: number, z: number) => {
      B.add(cyl(0.025, 0.025, 3.5, 12), T(x, 1.75, z), 0x9aa1a4);
      B.add(rbox(0.16, 0.2, 0.1, 0.01), T(x, 2.4, z), 0x8a9094);
    };
    conduit(R.x0 + 0.06, -8.9);
    conduit(R.x0 + 0.06, -8.6);
    conduit(R.x1 - 0.06, -8.9);
    conduit(R.x1 - 0.06, 8.2);
    conduit(R.x0 + 0.06, 3.0);
    for (const sx of [R.x0 + 0.05, R.x1 - 0.05]) {
      const g = new THREE.CylinderGeometry(0.03, 0.03, R.z1 - R.z0, 12).toNonIndexed();
      g.deleteAttribute('uv');
      g.rotateX(Math.PI / 2);
      B.add(g, T(sx, 3.02, (R.z0 + R.z1) / 2), 0x9aa1a4);
    }
    // pipe run along the front wall above the boards (behind/above horseshoe)
    for (let k = 0; k < 3; k++) {
      const g = new THREE.CylinderGeometry(0.04 - k * 0.008, 0.04 - k * 0.008, R.x1 - R.x0, 14).toNonIndexed();
      g.deleteAttribute('uv');
      g.rotateZ(Math.PI / 2);
      B.add(g, T(0, 3.1 + k * 0.11, R.z0 + 0.12), [0x3a6a8a, 0xb8a060, 0x9aa1a4][k]);
    }
  }

  return {
    supervisorScreen(tex: THREE.Texture): THREE.Mesh {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.255), new THREE.MeshBasicMaterial({ map: tex }));
      (m.material as THREE.MeshBasicMaterial).color.setScalar(1.15);
      m.matrixAutoUpdate = false;
      m.matrix.copy(DL(-0.4, 0.775 + 0.27, 0.1 - 0.158, Math.PI));
      m.name = 'supervisor-screen';
      scene.add(m);
      return m;
    },
  };
}

function filingCabinet(c: Ctx, x: number, z: number, ry: number): void {
  const { B } = c;
  const F = T(x, 0, z, ry);
  const L = (lx: number, ly: number, lz: number) => T(lx, ly, lz).premultiply(F);
  B.add(rbox(0.46, 1.32, 0.62, 0.012), L(0, 0.66, 0), 0x8a8e90);
  for (let k = 0; k < 4; k++) {
    B.add(rbox(0.42, 0.29, 0.015, 0.006), L(0, 0.2 + k * 0.315, 0.31), 0x9a9ea0);
    B.add(rbox(0.12, 0.022, 0.03, 0.009), L(0, 0.28 + k * 0.315, 0.325), 0xc8ccd0);
    B.add(rbox(0.07, 0.035, 0.004, 0.002), L(0, 0.32 + k * 0.315, 0.318), 0xf2f0e8);
  }
  const p = new THREE.Vector3().applyMatrix4(F);
  c.addCol(p.x, p.z, 0.25, 0.33, ry);
}

/* ------------------------------------------------------------------ */
/* canvas artwork                                                      */
/* ------------------------------------------------------------------ */
function tileTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const x = cv.getContext('2d')!;
  const cols = ['#b9b3a2', '#a39d8c'];
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++) {
      x.fillStyle = cols[(i + j) % 2];
      x.fillRect(i * 128, j * 128, 128, 128);
    }
  let s = 77;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 2500; k++) {
    x.fillStyle = `rgba(${r() < 0.5 ? '90,80,70' : '255,255,250'},${0.12 + r() * 0.2})`;
    x.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
  }
  x.strokeStyle = 'rgba(60,55,50,0.35)';
  x.lineWidth = 2;
  for (let k = 0; k <= 2; k++) {
    x.beginPath();
    x.moveTo(k * 128, 0);
    x.lineTo(k * 128, 256);
    x.moveTo(0, k * 128);
    x.lineTo(256, k * 128);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function drawMimic(ctx: CanvasRenderingContext2D, r: Region): void {
  const { x, y, w, h } = r;
  const X = (u: number) => x + u * w;
  const Y = (v: number) => y + v * h;
  ctx.fillStyle = '#d8d4c4';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
  const line = (pts: number[], col: string, lw = 9) => {
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(X(pts[0]), Y(pts[1]));
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(X(pts[i]), Y(pts[i + 1]));
    ctx.stroke();
  };
  const label = (t: string, u: number, v: number, size = 22, col = '#1a1a1a') => {
    ctx.fillStyle = col;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${size}px ${FONT}`;
    ctx.fillText(t, X(u), Y(v));
  };
  // reactor vessel
  ctx.fillStyle = '#6c7a86';
  ctx.beginPath();
  ctx.roundRect(X(0.1), Y(0.18), 0.04 * w, 0.62 * h, 18);
  ctx.fill();
  label('RX', 0.12, 0.5, 20, '#f0f0f0');
  // RCS loops: hot leg red, cold leg blue to 4 SGs
  for (let i = 0; i < 4; i++) {
    const u = 0.16 + i * 0.045;
    line([0.14, 0.3, u, 0.3, u, 0.25], '#c0281c', 7);
    line([u, 0.7, 0.14, 0.7], '#2850b0', 7);
    ctx.fillStyle = '#e8e4d8';
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(X(u - 0.012), Y(0.22), 0.024 * w, 0.5 * h, 10);
    ctx.fill();
    ctx.stroke();
    label(`SG${i + 1}`, u, 0.47, 15);
  }
  label('RCP', 0.23, 0.93, 16);
  // pressurizer
  ctx.fillStyle = '#e8e4d8';
  ctx.beginPath();
  ctx.roundRect(X(0.23), Y(0.05), 0.022 * w, 0.18 * h, 8);
  ctx.fill();
  ctx.stroke();
  label('PZR', 0.27, 0.1, 15);
  // main steam to turbine (green)
  line([0.34, 0.12, 0.62, 0.12], '#1e7a3a', 10);
  for (let i = 0; i < 4; i++) line([0.16 + i * 0.045, 0.22, 0.16 + i * 0.045, 0.12, 0.34, 0.12], '#1e7a3a', 6);
  label('MAIN STEAM', 0.45, 0.06, 18);
  // turbine
  ctx.fillStyle = '#7a8a7a';
  ctx.beginPath();
  ctx.moveTo(X(0.62), Y(0.1));
  ctx.lineTo(X(0.74), Y(0.02 + 0.03));
  ctx.lineTo(X(0.74), Y(0.45));
  ctx.lineTo(X(0.62), Y(0.32));
  ctx.closePath();
  ctx.fill();
  label('HP / LP TURBINE', 0.68, 0.52, 18);
  // generator + switchyard
  ctx.fillStyle = '#8a6a4a';
  ctx.fillRect(X(0.76), Y(0.1), 0.06 * w, 0.3 * h);
  label('GEN', 0.79, 0.25, 20, '#f0f0f0');
  line([0.82, 0.25, 0.92, 0.25], '#8a1a14', 6);
  label('345 KV', 0.92, 0.45, 18);
  // condenser + feed train (blue/cyan)
  ctx.fillStyle = '#9ab0c0';
  ctx.fillRect(X(0.63), Y(0.6), 0.1 * w, 0.18 * h);
  label('CONDENSER', 0.68, 0.69, 16);
  line([0.68, 0.45, 0.68, 0.6], '#1e7a3a', 6);
  line([0.63, 0.86, 0.5, 0.86, 0.38, 0.86, 0.38, 0.7, 0.34, 0.7], '#2aa0c0', 8);
  label('FEEDWATER', 0.44, 0.94, 16);
  label('AFW', 0.66, 0.94, 16);
  line([0.66, 0.9, 0.66, 0.86], '#d08a1a', 5);
  // trip/si legends
  label('TRIP', 0.06, 0.12, 15);
  label('SI', 0.06, 0.52, 15);
  label('PORV', 0.25, 0.26, 13);
  label('LATCH', 0.6, 0.27, 13);
  label('BKR', 0.79, 0.4, 13);
  label('GRID', 0.93, 0.08, 15);
  ctx.font = `${16}px ${MONO}`;
}

function poster(ctx: CanvasRenderingContext2D, r: Region, title: string, lines: string[]): void {
  const { x, y, w, h } = r;
  ctx.fillStyle = '#f2efe4';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1e3e7a';
  ctx.fillRect(x, y, w, h * 0.16);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, title, x + w / 2, y + h * 0.08, w * 0.9, Math.round(h * 0.08), 'bold');
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1a1a1a';
  const lh = (h * 0.78) / Math.max(6, lines.length);
  for (let i = 0; i < lines.length; i++) fitText(ctx, lines[i], x + w * 0.06, y + h * 0.22 + lh * (i + 0.5), w * 0.88, Math.round(lh * 0.6), 'bold', MONO);
}

function whiteboard(ctx: CanvasRenderingContext2D, r: Region): void {
  const { x, y, w, h } = r;
  ctx.fillStyle = '#f6f6f2';
  ctx.fillRect(x, y, w, h);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const rows: [string, string][] = [
    ['PLANT STATUS', '#1a3a9a'],
    ['MODE 1  100% RTP', '#1a1a1a'],
    ['BORON 1050 PPM (DAY)', '#1a1a1a'],
    ['RCS LEAKAGE 0.08 GPM', '#1a1a1a'],
    ['OOS: CCW PUMP 1B (PM)', '#b02020'],
    ['SURV: AFW 2 MONTHLY 1400', '#1a1a1a'],
    ['DO NOT DILUTE > 50 GPM!!', '#b02020'],
  ];
  for (let i = 0; i < rows.length; i++) {
    ctx.fillStyle = rows[i][1];
    ctx.font = `${i === 0 ? 'bold ' : ''}${Math.round(h * (i === 0 ? 0.1 : 0.075))}px "Comic Sans MS","Segoe Print",${FONT}`;
    ctx.fillText(rows[i][0], x + w * 0.05, y + h * (0.1 + i * 0.125));
  }
}

function firePanel(ctx: CanvasRenderingContext2D, r: Region): void {
  const { x, y, w, h } = r;
  ctx.fillStyle = '#b4241a';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#f4f1e6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, 'FIRE ALARM', x + w / 2, y + h * 0.12, w * 0.9, Math.round(h * 0.11), 'bold');
  fitText(ctx, 'CONTROL PANEL', x + w / 2, y + h * 0.24, w * 0.9, Math.round(h * 0.07), 'bold');
  ctx.fillStyle = '#101010';
  ctx.fillRect(x + w * 0.1, y + h * 0.34, w * 0.8, h * 0.18);
  ctx.fillStyle = '#4dff7a';
  ctx.font = `bold ${Math.round(h * 0.06)}px ${MONO}`;
  ctx.fillText('SYSTEM NORMAL', x + w / 2, y + h * 0.43);
}

import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
