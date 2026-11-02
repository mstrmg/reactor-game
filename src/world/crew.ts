/**
 * The operating crew in the control room: Marge (SRO), Theo (RO) and Priya (BOP).
 *
 * Stylised low-poly people built from capsules and spheres. All three share ONE SkinnedMesh
 * (one draw call): every vertex is rigidly bound to a single bone, so the animation is plain
 * rigid-part posing (breathing, glances, walk cycle, reaching for a board, sipping coffee).
 *
 * Bus: 'crew-activity' / 'crew-say' (ui -> world) drive them; activating one with LMB / F emits
 * 'crew-clicked'. Each member has a moving circle-ish collider (shared with the player's collider
 * list) and a moving interactable box (shared with the player's pick list).
 */
import * as THREE from 'three';
import { bus, type CrewId } from '../core/bus';
import type { PlantState } from '../sim/types';
import type { Interactable, Section } from './panel';
import type { Collider } from './room';
import { rbox } from './util';

type Activity = 'idle' | 'walking' | 'operating' | 'talking';
type InRoom = Exclude<CrewId, 'FIELD'>;

interface Spec {
  id: InRoom;
  name: string;
  title: string;
  shirt: number;
  trousers: number;
  tie: number | null;
  hair: number;
  hairStyle: 'bob' | 'short' | 'ponytail';
  skin: number;
  glasses: boolean;
  mug: number | null;
  home: [number, number];
  homeFace: [number, number]; // facing direction at home (x, z)
  lateral: number; // sideways offset when standing at a board (so two people never overlap)
}

const polar = (deg: number, r: number): [number, number] => [r * Math.sin((deg * Math.PI) / 180), -r * Math.cos((deg * Math.PI) / 180)];
const outward = (deg: number): [number, number] => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)];

const SPECS: Spec[] = [
  {
    id: 'SRO',
    name: 'Marge',
    title: 'Shift Supervisor',
    shirt: 0xe9edf1,
    trousers: 0x2c3038,
    tie: 0x1f2f58,
    hair: 0x9d978c,
    hairStyle: 'bob',
    skin: 0xe2b99b,
    glasses: false,
    mug: 0xe8e2d4,
    home: [0.55, 3.55],
    homeFace: [0, -1],
    lateral: -0.42,
  },
  {
    id: 'RO',
    name: 'Theo',
    title: 'Reactor Operator',
    shirt: 0x9fc4e6,
    trousers: 0x27324a,
    tie: 0x7a2032,
    hair: 0x3b2a1e,
    hairStyle: 'short',
    skin: 0xc99a7a,
    glasses: true,
    mug: null,
    home: polar(12, 5.25),
    homeFace: outward(9),
    lateral: 0,
  },
  {
    id: 'BOP',
    name: 'Priya',
    title: 'Balance-of-Plant Operator',
    shirt: 0x2f8c86,
    trousers: 0x2a2a31,
    tie: null,
    hair: 0x1d1511,
    hairStyle: 'ponytail',
    skin: 0xa87454,
    glasses: false,
    mug: null,
    home: polar(66, 5.4),
    homeFace: outward(70),
    lateral: 0.42,
  },
];

/* bone indices inside one member */
const B_ROOT = 0;
const B_HIPS = 1;
const B_SPINE = 2;
const B_HEAD = 3;
const B_SHL = 4;
const B_ELL = 5;
const B_SHR = 6;
const B_ELR = 7;
const B_LEGL = 8;
const B_KNL = 9;
const B_LEGR = 10;
const B_KNR = 11;
const B_MUG = 12;
const NB = 13;

const WALK_SPEED = 1.15;
const ARC_R = 5.3;
const DEG = Math.PI / 180;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const angDiff = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const damp = (cur: number, tgt: number, k: number, dt: number) => cur + (tgt - cur) * (1 - Math.exp(-k * dt));

interface Member {
  spec: Spec;
  bones: THREE.Bone[];
  pos: THREE.Vector2;
  yaw: number;
  path: THREE.Vector2[];
  board: string | null; // where they are going / standing (null = home)
  face: THREE.Vector2; // facing direction when standing still
  activity: Activity;
  arrived: boolean;
  phase: number; // walk cycle
  speed: number;
  talkUntil: number;
  lookT: number; // time until next idle glance
  look: THREE.Vector3; // current look target (world)
  lookMode: 'ahead' | 'side' | 'player';
  headYaw: number;
  headPitch: number;
  sipT: number;
  reach: number; // 0..1 operating blend
  walkBlend: number;
  col: Collider;
  it: Interactable;
  blocked: number;
}

export interface Crew {
  mesh: THREE.SkinnedMesh;
  update(dt: number, s: PlantState | undefined, cam: THREE.Vector3, player: THREE.Vector3): void;
  /** debug/test snapshot */
  info(): { id: string; x: number; z: number; board: string | null; arrived: boolean; activity: string; path: number }[];
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */
class SkinBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  private c = new THREE.Color();
  add(src: THREE.BufferGeometry, m: THREE.Matrix4, color: number, bone: number) {
    const g = (src.index ? src.toNonIndexed() : src.clone()).applyMatrix4(m);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    this.c.set(color);
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nor.push(n.getX(i), n.getY(i), n.getZ(i));
      this.col.push(this.c.r, this.c.g, this.c.b);
      this.idx.push(bone);
    }
    g.dispose();
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.idx.length;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = this.idx[i];
      sw[i * 4] = 1;
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    return g;
  }
}

const T = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

/** one person in bind pose at the origin, facing +z; returns the bone list (B_* order) */
function buildPerson(sb: SkinBuilder, spec: Spec, base: number): THREE.Bone[] {
  const capsule = (r: number, len: number, seg = 10) => new THREE.CapsuleGeometry(r, len, 3, seg);
  const sphere = (r: number, w = 12, h = 8) => new THREE.SphereGeometry(r, w, h);
  const add = (g: THREE.BufferGeometry, m: THREE.Matrix4, c: number, b: number) => sb.add(g, m, c, base + b);
  const skin = spec.skin;
  const dark = new THREE.Color(skin).multiplyScalar(0.82).getHex();

  // legs (thigh → leg bone, shin + shoe → knee bone)
  for (const sx of [-1, 1]) {
    const leg = sx < 0 ? B_LEGL : B_LEGR;
    const knee = sx < 0 ? B_KNL : B_KNR;
    add(capsule(0.074, 0.3), T(sx * 0.098, 0.705, 0), spec.trousers, leg);
    add(capsule(0.062, 0.31), T(sx * 0.098, 0.285, 0), spec.trousers, knee);
    add(rbox(0.105, 0.075, 0.26, 0.03, 2), T(sx * 0.098, 0.04, 0.035), 0x23201d, knee);
  }
  // pelvis + belt
  add(capsule(0.15, 0.12, 12), T(0, 0.93, 0, 0, 0, Math.PI / 2, 1, 1.05, 0.75), spec.trousers, B_HIPS);
  add(new THREE.CylinderGeometry(0.176, 0.176, 0.04, 16, 1, true), T(0, 0.985, 0, 0, 0, 0, 1, 1, 0.73), 0x2a2018, B_HIPS);
  // torso
  add(capsule(0.17, 0.27, 14), T(0, 1.24, 0, 0, 0, 0, 1.13, 1, 0.72), spec.shirt, B_SPINE);
  if (spec.tie !== null) {
    add(new THREE.BoxGeometry(0.052, 0.3, 0.016), T(0, 1.33, 0.124), spec.tie, B_SPINE);
    add(new THREE.BoxGeometry(0.045, 0.04, 0.022), T(0, 1.49, 0.118), spec.tie, B_SPINE);
    add(new THREE.BoxGeometry(0.15, 0.035, 0.03), T(0, 1.52, 0.1), 0xf2f2ee, B_SPINE); // collar
  } else {
    // lanyard
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.012, 0.2, 0.01), T(sx * 0.045, 1.44, 0.12, 0, 0, -sx * 0.25), 0xb0262a, B_SPINE);
  }
  // ID badge (white card with a coloured band)
  add(rbox(0.056, 0.076, 0.008, 0.004), T(spec.tie !== null ? 0.088 : 0, spec.tie !== null ? 1.38 : 1.33, 0.125), 0xf4f4f0, B_SPINE);
  add(new THREE.BoxGeometry(0.058, 0.018, 0.01), T(spec.tie !== null ? 0.088 : 0, spec.tie !== null ? 1.405 : 1.355, 0.126), 0x2c5aa8, B_SPINE);
  // neck
  add(new THREE.CylinderGeometry(0.048, 0.054, 0.1, 10), T(0, 1.565, 0), skin, B_SPINE);
  // head (pivot at the neck: head bone at y 1.56)
  add(sphere(0.12, 16, 12), T(0, 1.69, 0, 0, 0, 0, 1, 1.1, 1), skin, B_HEAD);
  add(sphere(0.022, 8, 6), T(0, 1.68, 0.118), dark, B_HEAD); // nose
  for (const sx of [-1, 1]) {
    add(sphere(0.014, 8, 6), T(sx * 0.042, 1.705, 0.106), 0x1e1a18, B_HEAD); // eyes
    add(sphere(0.026, 8, 6), T(sx * 0.118, 1.69, 0, 0, 0, 0, 0.6, 1, 1), skin, B_HEAD); // ears
  }
  add(new THREE.BoxGeometry(0.05, 0.008, 0.01), T(0, 1.635, 0.112), 0x8a4a40, B_HEAD); // mouth
  if (spec.glasses) {
    for (const sx of [-1, 1]) add(new THREE.TorusGeometry(0.026, 0.0045, 4, 14), T(sx * 0.044, 1.705, 0.124), 0x1c1c1c, B_HEAD);
    add(new THREE.BoxGeometry(0.03, 0.006, 0.006), T(0, 1.712, 0.126), 0x1c1c1c, B_HEAD);
  }
  // hair
  const cap = (r: number, th: number, tilt: number, y: number, z: number) =>
    add(new THREE.SphereGeometry(r, 16, 10, 0, Math.PI * 2, 0, Math.PI * th), T(0, y, z, -tilt, 0, 0, 1, 1.1, 1.02), spec.hair, B_HEAD);
  if (spec.hairStyle === 'bob') {
    cap(0.134, 0.62, 0.78, 1.7, -0.012);
    add(capsule(0.05, 0.06, 8), T(0, 1.79, -0.09, 0.6, 0, Math.PI / 2, 1, 1.4, 1), spec.hair, B_HEAD); // swept top
  } else if (spec.hairStyle === 'short') {
    cap(0.128, 0.46, 0.5, 1.705, -0.008);
  } else {
    cap(0.13, 0.52, 0.62, 1.705, -0.01);
    add(sphere(0.045, 10, 8), T(0, 1.73, -0.13), spec.hair, B_HEAD); // bun/tie
    add(capsule(0.034, 0.17, 8), T(0, 1.6, -0.155, 0.25, 0, 0), spec.hair, B_HEAD); // ponytail
  }
  // arms (upper arm → shoulder bone, forearm + hand → elbow bone)
  for (const sx of [-1, 1]) {
    const sh = sx < 0 ? B_SHL : B_SHR;
    const el = sx < 0 ? B_ELL : B_ELR;
    add(capsule(0.053, 0.2), T(sx * 0.215, 1.31, 0), spec.shirt, sh);
    add(capsule(0.046, 0.17), T(sx * 0.215, 1.05, 0), spec.shirt, el);
    add(sphere(0.047, 10, 8), T(sx * 0.215, 0.895, 0.008, 0, 0, 0, 0.8, 1.15, 1), skin, el);
  }
  if (spec.mug !== null) {
    // coffee mug in the left hand (own bone so it stays upright while sipping)
    add(new THREE.CylinderGeometry(0.038, 0.035, 0.095, 12), T(-0.215, 0.89, 0.06), spec.mug, B_MUG);
    add(new THREE.TorusGeometry(0.025, 0.007, 4, 10), T(-0.215 + 0.04, 0.89, 0.06, 0, Math.PI / 2, 0), spec.mug, B_MUG);
    add(new THREE.CylinderGeometry(0.032, 0.032, 0.004, 12), T(-0.215, 0.935, 0.06), 0x3a2414, B_MUG);
  }

  // bones (bind pose; positions relative to the parent)
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < NB; i++) bones.push(new THREE.Bone());
  const at = (b: number, parent: number, x: number, y: number, z: number) => {
    bones[b].position.set(x, y, z);
    if (parent >= 0) bones[parent].add(bones[b]);
  };
  at(B_ROOT, -1, 0, 0, 0);
  at(B_HIPS, B_ROOT, 0, 0.93, 0);
  at(B_SPINE, B_HIPS, 0, 0.07, 0); // y 1.0
  at(B_HEAD, B_SPINE, 0, 0.56, 0); // y 1.56
  at(B_SHL, B_SPINE, -0.215, 0.46, 0); // y 1.46
  at(B_ELL, B_SHL, 0, -0.28, 0); // y 1.18
  at(B_SHR, B_SPINE, 0.215, 0.46, 0);
  at(B_ELR, B_SHR, 0, -0.28, 0);
  at(B_LEGL, B_HIPS, -0.098, -0.01, 0); // y 0.92
  at(B_KNL, B_LEGL, 0, -0.43, 0); // y 0.49
  at(B_LEGR, B_HIPS, 0.098, -0.01, 0);
  at(B_KNR, B_LEGR, 0, -0.43, 0);
  at(B_MUG, B_ELL, 0, -0.29, 0.06); // y 0.89
  bones.forEach((b, i) => (b.name = `${spec.id}-${i}`));
  return bones;
}

/* ------------------------------------------------------------------ */
/* crew                                                                */
/* ------------------------------------------------------------------ */
export function buildCrew(scene: THREE.Scene, boards: Section[], colliders: Collider[], interactables: Interactable[]): Crew {
  const sb = new SkinBuilder();
  const all: THREE.Bone[] = [];
  const members: Member[] = [];
  SPECS.forEach((spec, k) => {
    const bones = buildPerson(sb, spec, k * NB);
    all.push(...bones);
    const col: Collider = { x: spec.home[0], z: spec.home[1], hx: 0.2, hz: 0.2, c: 1, s: 0 };
    colliders.push(col);
    const m: Member = {
      spec,
      bones,
      pos: new THREE.Vector2(...spec.home),
      yaw: Math.atan2(spec.homeFace[0], spec.homeFace[1]),
      path: [],
      board: null,
      face: new THREE.Vector2(...spec.homeFace),
      activity: 'idle',
      arrived: true,
      phase: 0,
      speed: 0,
      talkUntil: 0,
      lookT: 1 + k * 1.7,
      look: new THREE.Vector3(),
      lookMode: 'ahead',
      headYaw: 0,
      headPitch: 0,
      sipT: 6 + k * 3,
      reach: 0,
      walkBlend: 0,
      col,
      it: null as unknown as Interactable,
      blocked: 0,
    };
    m.it = {
      id: `CREW_${spec.id}`,
      label: `${spec.name} — ${spec.title}`,
      kind: 'button',
      inv: new THREE.Matrix4(),
      half: new THREE.Vector3(0.27, 0.9, 0.22),
      center: new THREE.Vector3(),
      detail: () => `${describe(m)}   [LMB / F: give orders]`,
      primary: () => bus.emit('crew-clicked', { member: spec.id }),
    };
    interactables.push(m.it);
    members.push(m);
  });
  const geo = sb.build();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.name = 'crew';
  mesh.frustumCulled = false;
  for (const m of members) mesh.add(m.bones[B_ROOT]);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(all);
  mesh.bind(skeleton, mesh.matrixWorld);
  scene.add(mesh);

  /* ---------- board lookup ---------- */
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const findBoard = (name: string): Section | null => {
    const n = norm(name);
    let hit = boards.find((b) => norm(b.name) === n);
    if (!hit) hit = boards.find((b) => norm(b.name).includes(n) || n.includes(norm(b.name)));
    if (!hit) {
      const first = n.split(' ')[0];
      hit = boards.find((b) => norm(b.name).split(' ')[0] === first);
    }
    return hit ?? null;
  };
  const _v3 = new THREE.Vector3();
  /** standing point + facing direction in front of a board */
  const standAt = (sec: Section, lateral: number): { p: THREE.Vector2; f: THREE.Vector2 } => {
    const flat = sec.index >= 100; // auxiliary work cabinets: flat face, no bench
    _v3.set(lateral * (flat ? 0.6 : 1), 0, flat ? 0.58 : 0.98).applyMatrix4(sec.matrix);
    const p = new THREE.Vector2(_v3.x, _v3.z);
    _v3.set(0, 0, 1).transformDirection(sec.matrix);
    const f = new THREE.Vector2(-_v3.x, -_v3.z).normalize();
    return { p, f };
  };

  /* ---------- path planning ---------- */
  type Region = 'desk' | 'wingL' | 'wingR' | 'shoe';
  const region = (p: THREE.Vector2): Region => (p.y > 1.5 && Math.abs(p.x) < 2.6 ? 'desk' : Math.abs(p.x) > 6.6 && p.y > -0.7 ? (p.x < 0 ? 'wingL' : 'wingR') : 'shoe');
  const V = (x: number, z: number) => new THREE.Vector2(x, z);
  const DESK_OUT = [V(-1.8, 3.4), V(-1.8, 1.8), V(-0.9, 0.8)]; // from behind the supervisor desk out to the open floor
  const wingOut = (s: number) => [V(s * 7.3, 1.05), V(s * 5.9, 0.7)];
  const phiOf = (p: THREE.Vector2) => Math.atan2(p.x, -p.y);
  const shoePath = (a: THREE.Vector2, b: THREE.Vector2, out: THREE.Vector2[]) => {
    const ra = a.length();
    const rb = b.length();
    const pa = phiOf(a);
    const pb = phiOf(b);
    const d = angDiff(pa, pb);
    if (ra > 3.4 && rb > 3.4 && Math.abs(d) > 20 * DEG) {
      const n = Math.ceil(Math.abs(d) / (14 * DEG));
      for (let i = 0; i <= n; i++) {
        const ph = pa + (d * i) / n;
        out.push(V(ARC_R * Math.sin(ph), -ARC_R * Math.cos(ph)));
      }
    }
    out.push(b.clone());
  };
  const plan = (from: THREE.Vector2, to: THREE.Vector2): THREE.Vector2[] => {
    const out: THREE.Vector2[] = [];
    const ra = region(from);
    const rb = region(to);
    let cur = from;
    if (ra === 'desk' && rb !== 'desk') {
      out.push(...DESK_OUT.map((v) => v.clone()));
      cur = DESK_OUT[DESK_OUT.length - 1];
    } else if ((ra === 'wingL' || ra === 'wingR') && ra !== rb) {
      const w = wingOut(ra === 'wingL' ? -1 : 1);
      out.push(...w.map((v) => v.clone()));
      cur = w[w.length - 1];
    }
    if (rb === 'desk' && ra !== 'desk') {
      const back = DESK_OUT.slice().reverse();
      shoePath(cur, back[0], out);
      out.push(...back.slice(1).map((v) => v.clone()), to.clone());
    } else if ((rb === 'wingL' || rb === 'wingR') && ra !== rb) {
      const back = wingOut(rb === 'wingL' ? -1 : 1).reverse();
      shoePath(cur, back[0], out);
      out.push(...back.slice(1).map((v) => v.clone()), to.clone());
    } else if (ra === rb && ra !== 'shoe') out.push(to.clone());
    else shoePath(cur, to, out);
    return out;
  };

  const sendTo = (m: Member, board: string | null) => {
    let p: THREE.Vector2;
    let f: THREE.Vector2;
    if (board) {
      const sec = findBoard(board);
      if (!sec) {
        board = null;
        p = V(...m.spec.home);
        f = V(...m.spec.homeFace);
      } else ({ p, f } = standAt(sec, m.spec.lateral));
    } else {
      p = V(...m.spec.home);
      f = V(...m.spec.homeFace);
    }
    m.board = board;
    m.face.copy(f);
    if (p.distanceTo(m.pos) < 0.12) {
      m.path = [];
      m.arrived = true;
      return;
    }
    m.path = plan(m.pos, p);
    m.arrived = false;
  };

  bus.on('crew-activity', (e) => {
    const m = members.find((x) => x.spec.id === e.member);
    if (!m) return; // FIELD is out in the plant
    m.activity = e.state;
    if (e.state === 'talking' && !e.board) {
      m.talkUntil = Math.max(m.talkUntil, performance.now() + 4000);
      return;
    }
    if ((e.board ?? null) !== m.board || (!m.arrived && !m.path.length)) sendTo(m, e.board ?? null);
  });
  bus.on('crew-say', (e) => {
    const m = members.find((x) => x.spec.id === e.member);
    if (!m) return;
    m.talkUntil = performance.now() + clamp((e.text?.length ?? 20) * 65, 1600, 7000);
    m.lookT = 0;
  });

  function describe(m: Member): string {
    if (!m.arrived) return m.board ? `walking to ${m.board.toLowerCase()}` : 'heading back';
    if (m.activity === 'operating' && m.board) return `working at ${m.board.toLowerCase()}`;
    if (performance.now() < m.talkUntil || m.activity === 'talking') return 'talking';
    return m.board ? `standing by ${m.board.toLowerCase()}` : 'standing by';
  }

  /* ---------- per frame ---------- */
  let time = 0;
  const _steer = new THREE.Vector2();
  const _d = new THREE.Vector2();
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _one = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);

  function update(dt: number, s: PlantState | undefined, cam: THREE.Vector3, player: THREE.Vector3) {
    if (dt <= 0) return;
    time += dt;
    const now = performance.now();
    void s;
    for (let k = 0; k < members.length; k++) {
      const m = members[k];
      const b = m.bones;
      /* --- locomotion --- */
      let moving = false;
      if (m.path.length) {
        const tgt = m.path[0];
        _d.subVectors(tgt, m.pos);
        const dist = _d.length();
        const last = m.path.length === 1;
        if (dist < (last ? 0.05 : 0.22)) {
          m.path.shift();
          if (!m.path.length) m.arrived = true;
        } else {
          _steer.copy(_d).divideScalar(dist);
          // keep clear of the player: steer round, slow / wait if they're right in the way
          const px = m.pos.x - player.x;
          const pz = m.pos.y - player.z;
          const pd = Math.hypot(px, pz);
          let slow = 1;
          if (pd < 1.1 && pd > 1e-3) {
            const sx = _steer.x;
            const sz = _steer.y;
            const ahead = -(px * sx + pz * sz) / pd; // >0: the player is in front of us
            const w = (1.1 - pd) * 2.2;
            _steer.x += (px / pd) * w * 0.6;
            _steer.y += (pz / pd) * w * 0.6;
            if (ahead > 0) {
              // sidestep on the side away from the player
              const side = Math.sign(-sz * px + sx * pz) || 1;
              _steer.x += -sz * side * w * ahead;
              _steer.y += sx * side * w * ahead;
            }
            if (ahead > 0.3 && pd < 0.7) slow = clamp((pd - 0.45) / 0.25, 0, 1);
          }
          // and clear of each other
          for (let j = 0; j < members.length; j++) {
            if (j === k) continue;
            const o = members[j];
            const ox = m.pos.x - o.pos.x;
            const oz = m.pos.y - o.pos.y;
            const od = Math.hypot(ox, oz);
            if (od < 0.7 && od > 1e-3) {
              _steer.x += (ox / od) * (0.7 - od) * 1.5;
              _steer.y += (oz / od) * (0.7 - od) * 1.5;
            }
          }
          const sl = _steer.length() || 1;
          _steer.divideScalar(sl);
          const v = WALK_SPEED * slow * Math.min(1, dist / 0.35 + 0.35);
          m.speed = damp(m.speed, v, 6, dt);
          m.blocked = slow < 0.3 ? m.blocked + dt : 0;
          m.pos.x += _steer.x * m.speed * dt;
          m.pos.y += _steer.y * m.speed * dt;
          m.yaw += angDiff(m.yaw, Math.atan2(_steer.x, _steer.y)) * (1 - Math.exp(-8 * dt));
          moving = m.speed > 0.05;
        }
      }
      if (!moving) {
        m.speed = damp(m.speed, 0, 8, dt);
        if (m.arrived) m.yaw += angDiff(m.yaw, Math.atan2(m.face.x, m.face.y)) * (1 - Math.exp(-4 * dt));
      }
      // never walk into the boards
      if (m.pos.y < 0.05) {
        const r = m.pos.length();
        if (r > 6.5) m.pos.multiplyScalar(6.5 / r);
      }
      m.phase += m.speed * dt * 5.2;
      m.walkBlend = damp(m.walkBlend, moving ? 1 : 0, 6, dt);

      /* --- look target --- */
      const talking = now < m.talkUntil || (m.activity === 'talking' && m.arrived);
      const pdist = Math.hypot(player.x - m.pos.x, player.z - m.pos.y);
      m.lookT -= dt;
      if (talking) m.lookMode = 'player';
      else if (m.lookT <= 0) {
        m.lookT = 2.5 + rand() * 4.5;
        const r = rand();
        m.lookMode = r < 0.2 && pdist < 7 ? 'player' : r < 0.45 && !moving ? 'side' : 'ahead';
        if (m.lookMode === 'side') m.look.set(rand() * 2 - 1, 0.4 + rand() * 0.6, 0); // stash yaw/pitch offsets
      }
      let ty = 0;
      let tp = 0;
      if (m.lookMode === 'player') {
        const dx = cam.x - m.pos.x;
        const dz = cam.z - m.pos.y;
        ty = angDiff(m.yaw, Math.atan2(dx, dz));
        tp = -Math.atan2(cam.y - 1.65, Math.hypot(dx, dz));
        if (Math.abs(ty) > 1.5) ty = Math.sign(ty) * 1.0; // can't see behind: just turn as far as the neck goes
      } else if (m.lookMode === 'side') {
        ty = m.look.x * 0.9;
        tp = (m.look.y - 0.7) * 0.4;
      } else {
        tp = m.arrived && !moving ? 0.12 : 0.05; // reading the board / watching the floor
      }
      m.headYaw = damp(m.headYaw, clamp(ty, -1.1, 1.1), 5, dt);
      m.headPitch = damp(m.headPitch, clamp(tp, -0.45, 0.5), 5, dt);

      /* --- operating blend --- */
      const op = m.activity === 'operating' && m.arrived && !!m.board && !talking;
      m.reach = damp(m.reach, op ? 1 : 0, 4, dt);

      /* --- pose --- */
      const wb = m.walkBlend;
      const ph = m.phase;
      const sw = Math.sin(ph);
      const breathe = Math.sin(time * 1.4 + k * 2.1);
      const bob = Math.abs(Math.cos(ph)) * 0.035 * wb + (talking ? Math.abs(Math.sin(time * 7.5)) * 0.008 : 0);
      b[B_ROOT].position.set(m.pos.x, 0, m.pos.y);
      b[B_ROOT].rotation.set(0, m.yaw, 0);
      b[B_HIPS].position.y = 0.93 - 0.02 * wb + bob;
      b[B_HIPS].rotation.set(0, sw * 0.08 * wb, 0);
      b[B_SPINE].rotation.set(0.04 * wb + 0.012 * breathe + 0.2 * m.reach, -sw * 0.12 * wb, 0);
      b[B_HEAD].rotation.set(m.headPitch + (talking ? Math.sin(time * 6.3) * 0.05 : 0) - 0.1 * m.reach, m.headYaw, 0, 'YXZ');
      // legs
      const thL = -sw * 0.48 * wb;
      b[B_LEGL].rotation.set(thL, 0, 0);
      b[B_LEGR].rotation.set(-thL, 0, 0);
      b[B_KNL].rotation.set(Math.max(0, Math.sin(ph + 1.4)) * 0.7 * wb, 0, 0);
      b[B_KNR].rotation.set(Math.max(0, Math.sin(ph + 1.4 + Math.PI)) * 0.7 * wb, 0, 0);
      // arms: swing, rest a little away from the body, reach when operating, gesture when talking
      const armSw = sw * 0.38 * wb;
      let lx = armSw;
      let lel = -0.12 - 0.15 * wb;
      let rx = -armSw;
      let rel = -0.12 - 0.15 * wb;
      let rz = 0;
      if (talking && !moving && m.reach < 0.5) {
        rx = -0.35 + Math.sin(time * 2.3) * 0.12;
        rel = -0.9 + Math.sin(time * 3.1 + 1) * 0.25;
      }
      // right arm reaches out to the board, small pressing motion
      rx = rx * (1 - m.reach) + (-1.08 + Math.sin(time * 2.6) * 0.06) * m.reach;
      rel = rel * (1 - m.reach) + (-0.32 + Math.max(0, Math.sin(time * 5.2)) * 0.12) * m.reach;
      rz = -0.1 * m.reach;
      // Marge sips her coffee every so often when she is standing still
      let sip = 0;
      if (m.spec.mug !== null) {
        m.sipT -= dt;
        if (m.sipT < 0) {
          if (moving || m.reach > 0.1 || talking) m.sipT = 2;
          else if (m.sipT < -3.2) m.sipT = 9 + rand() * 8;
        }
        if (m.sipT < 0 && m.sipT > -3.2) sip = Math.sin((-m.sipT / 3.2) * Math.PI);
        sip = Math.min(1, sip * 1.6);
        lx = lx * (1 - sip) - 0.9 * sip;
        lel = lel * (1 - sip) - 2.25 * sip - 0.55 * (1 - sip) * (1 - wb); // holds the mug at waist height otherwise
        b[B_HEAD].rotation.x -= 0.25 * sip;
      }
      b[B_SHL].rotation.set(lx, 0, -0.07 - 0.12 * sip);
      b[B_ELL].rotation.set(lel, 0, 0);
      b[B_SHR].rotation.set(rx, 0, 0.07 + rz);
      b[B_ELR].rotation.set(rel, 0, 0);
      // keep the mug upright
      b[B_MUG].rotation.set(-(lx + lel + b[B_SPINE].rotation.x), 0, 0);

      /* --- collider + interactable --- */
      m.col.x = m.pos.x;
      m.col.z = m.pos.y;
      _p.set(m.pos.x, 0.9, m.pos.y);
      _q.setFromAxisAngle(_up, m.yaw);
      _m4.compose(_p, _q, _one);
      m.it.inv.copy(_m4).invert();
      m.it.center.copy(_p);
    }
    mesh.updateMatrixWorld(true);
  }

  // initial pose
  update(1 / 60, undefined, new THREE.Vector3(0, 1.65, -3), new THREE.Vector3(0, 0, -3));
  const info = () =>
    members.map((m) => ({ id: m.spec.id, x: +m.pos.x.toFixed(2), z: +m.pos.y.toFixed(2), board: m.board, arrived: m.arrived, activity: m.activity, path: m.path.length }));
  return { mesh, update, info };
}
