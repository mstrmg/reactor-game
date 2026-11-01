/**
 * Panel kit: builds benchboard sections and every instrument/control on them.
 * Static parts go into merged buckets; moving parts are InstancedMeshes;
 * digital readouts share one throttled canvas texture.
 */
import * as THREE from 'three';
import type { PlantControls, PlantState, ReactorSimApi } from '../sim/types';
import { bus } from '../core/bus';
import {
  CanvasAtlas,
  DEG,
  FONT,
  GeoBucket,
  MONO,
  QuadBucket,
  Region,
  box,
  rbox,
  fitText,
  safeBool,
  safeNum,
  zcyl,
} from './util';

/* ------------------------------------------------------------------ */
/* Board geometry constants                                            */
/* ------------------------------------------------------------------ */
export const N_SECTIONS = 10;
export const SEC_STEP = 18 * DEG;
export const RF = 7.4; // radius of the vertical instrument face
export const HALF_W = RF * Math.tan(SEC_STEP / 2); // ≈1.172
export const BENCH_BACK_Y = 1.1;
export const BENCH_FRONT_Z = 0.6;
export const BENCH_SLOPE = Math.atan(0.4); // 21.8°
export const BENCH_LEN = BENCH_FRONT_Z / Math.cos(BENCH_SLOPE);
export const BOARD_TOP = 2.46;

export const PALETTE = {
  panel: 0x8fbfa8, // sea-foam
  panelDark: 0x6d9a86,
  bench: 0x9ccab4,
  lower: 0xc8c2ae, // beige
  kick: 0x2a2826,
  arm: 0x1d1f21,
  annHousing: 0x34393b,
  fascia: 0x243246,
  trim: 0x4f6e62,
  bezel: 0x1b1c1e,
  steel: 0x9aa1a4,
};

export interface Section {
  index: number;
  name: string;
  theta: number;
  matrix: THREE.Matrix4;
  warp: (p: THREE.Vector3) => void;
}

export type Surf = 'v' | 'b';

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _col = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);

export function makeSection(index: number, name: string): Section {
  const theta = -((N_SECTIONS - 1) / 2) * SEC_STEP + index * SEC_STEP;
  const matrix = new THREE.Matrix4()
    .makeRotationY(-theta)
    .setPosition(RF * Math.sin(theta), 0, -RF * Math.cos(theta));
  const warp = (p: THREE.Vector3) => {
    p.x *= (RF - p.z) / RF;
  };
  return { index, name, theta, matrix, warp };
}

/** World matrix of a point on a section surface. +z = surface normal, +y = "up" on the surface. */
export function surfaceFrame(sec: Section, surf: Surf, u: number, v: number, lift = 0, out = new THREE.Matrix4()): THREE.Matrix4 {
  if (surf === 'v') {
    _p.set(u, v, lift);
    sec.warp(_p);
    out.makeTranslation(_p.x, _p.y, _p.z);
  } else {
    const d = BENCH_LEN - v; // v is measured up-slope from the front edge
    const z = d * Math.cos(BENCH_SLOPE);
    const y = BENCH_BACK_Y - d * Math.sin(BENCH_SLOPE);
    const nb = new THREE.Vector3(0, Math.cos(BENCH_SLOPE), Math.sin(BENCH_SLOPE));
    _p.set(u, y, z);
    sec.warp(_p);
    _p.addScaledVector(nb, lift);
    out.makeRotationX(-(Math.PI / 2 - BENCH_SLOPE)).setPosition(_p);
  }
  return out.premultiply(sec.matrix);
}

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */
export type Getter<T> = (s: PlantState) => T;
export type Zone = [number, number, string];

export interface MeterDef {
  title: string;
  unit: string;
  min: number;
  max: number;
  log?: boolean;
  get: Getter<number>;
  /** optional second (red) needle e.g. program/setpoint */
  get2?: Getter<number>;
  ticks?: number[]; // major tick values (labels)
  minor?: number; // minor ticks between majors
  zones?: Zone[];
  fmt?: (v: number) => string;
  size?: number;
  tickFmt?: (v: number) => string;
}

export interface LampDef {
  title: string;
  color: 'red' | 'green' | 'amber' | 'white' | 'blue';
  get: Getter<boolean>;
  flash?: boolean;
  hover?: string;
}

export interface ReadoutDef {
  title: string;
  get: Getter<string>;
  color?: 'red' | 'green' | 'amber';
  w?: number;
  h?: number;
  unit?: string;
}

export interface SwitchDef {
  id: string;
  title: string;
  positions: string[];
  get: (c: PlantControls) => number;
  set: (c: PlantControls, i: number) => void;
  angles?: number[]; // degrees clockwise from up
  red?: boolean;
  size?: number;
}

export interface KnobDef {
  id: string;
  title: string;
  min: number;
  max: number;
  step: number;
  coarse: number;
  get: (c: PlantControls) => number;
  set: (c: PlantControls, v: number) => void;
  fmt: (v: number) => string;
  ticks?: string[];
}

export interface ButtonDef {
  id: string;
  title: string;
  press?: string; // ButtonId to emit
  action?: () => void;
  color: number;
  mushroom?: boolean;
  guard?: boolean;
  lamp?: Getter<boolean>;
  lampColor?: LampDef['color'];
  /** longer name for the crosshair tooltip */
  hover?: string;
}

/* ------------------------------------------------------------------ */
/* Interactables                                                       */
/* ------------------------------------------------------------------ */
export interface Interactable {
  id: string;
  label: string;
  kind: 'button' | 'switch' | 'knob' | 'lever' | 'info';
  inv: THREE.Matrix4;
  half: THREE.Vector3;
  center: THREE.Vector3;
  detail: (s: PlantState, c: PlantControls) => string;
  primary?: () => void;
  secondary?: () => void;
  wheel?: (dir: number, coarse: boolean) => void;
  holdStart?: (dir: number) => void;
  holdEnd?: () => void;
  repeat?: boolean; // auto-repeat while held (knobs)
  /** for multi-cell items (annunciator) — returns label for local hit point */
  sub?: (lx: number, ly: number) => { label: string; detail: string } | null;
}

/* ------------------------------------------------------------------ */
/* Instanced pools                                                     */
/* ------------------------------------------------------------------ */
interface NeedleInst {
  base: THREE.Matrix4;
  kind: 'rot' | 'slide' | 'free';
  map: (v: number) => number; // value -> angle (rad) or offset (m)
  get: Getter<number>;
  len: number;
  wid: number;
  cur: number;
  init: boolean;
  rate: number;
  dirty: boolean;
}
interface LampInst {
  get: Getter<boolean>;
  on: THREE.Color;
  off: THREE.Color;
  flash: boolean;
  last: number;
}
interface HandleInst {
  base: THREE.Matrix4;
  scale: number;
  angle: number;
  target: () => number; // radians
}
interface ButtonInst {
  base: THREE.Matrix4;
  scale: THREE.Vector3;
  t: number; // press animation 0..1
}

const LAMP_COLORS: Record<LampDef['color'], [number, number, number]> = {
  red: [3.2, 0.25, 0.15],
  green: [0.35, 2.6, 0.5],
  amber: [3.0, 1.5, 0.15],
  white: [2.4, 2.3, 2.0],
  blue: [0.3, 0.7, 3.0],
};

function lampOff(c: LampDef['color']): THREE.Color {
  const [r, g, b] = LAMP_COLORS[c];
  return new THREE.Color(0.035 + r * 0.035, 0.035 + g * 0.035, 0.035 + b * 0.035);
}

/* ------------------------------------------------------------------ */
/* The kit                                                             */
/* ------------------------------------------------------------------ */
export class PanelKit {
  shell = new GeoBucket();
  /** static artwork lives on one or more atlas pages (one draw call each) */
  pages: { atlas: CanvasAtlas; quads: QuadBucket }[] = [{ atlas: new CanvasAtlas(4096, 4096, 4, '#202020'), quads: new QuadBucket() }];
  get staticAtlas(): CanvasAtlas {
    return this.pages[this.pages.length - 1].atlas;
  }
  /** allocate on the current page, opening a new page when full */
  allocStatic(w: number, h: number): Region {
    if (!this.staticAtlas.canFit(w, h)) this.pages.push({ atlas: new CanvasAtlas(4096, 4096, 4, '#202020'), quads: new QuadBucket() });
    const r = this.staticAtlas.alloc(w, h);
    r.page = this.pages.length - 1;
    return r;
  }
  staticQuads = {
    add: (r: Region, w: number, h: number, m: THREE.Matrix4, color?: THREE.ColorRepresentation) => this.pages[r.page ?? 0].quads.add(r, w, h, m, color),
  };
  readAtlas = new CanvasAtlas(1024, 1024, 2, '#050302');
  readQuads = new QuadBucket();
  interactables: Interactable[] = [];

  private needles: NeedleInst[] = [];
  private lamps: LampInst[] = [];
  private handles: HandleInst[] = [];
  private knobs: HandleInst[] = [];
  private buttons: ButtonInst[] = [];
  private buttonColors: number[] = [];
  private handleColors: number[] = [];
  private buttonIndex = new Map<string, number>();
  private readouts: { r: Region; get: Getter<string>; color: string; last: string }[] = [];
  private customReadouts: { r: Region; draw: (ctx: CanvasRenderingContext2D, r: Region, s: PlantState) => void; key?: (s: PlantState) => number; last: number }[] = [];

  needleMesh!: THREE.InstancedMesh;
  lampMesh!: THREE.InstancedMesh;
  handleMesh!: THREE.InstancedMesh;
  knobMesh!: THREE.InstancedMesh;
  buttonMesh!: THREE.InstancedMesh;
  readTimer = 0;

  constructor(public sim: ReactorSimApi) {}

  /* ---------------- board shell ---------------- */
  buildSectionShell(sec: Section): void {
    const P = PALETTE;
    const W = HALF_W * 2;
    const warp = sec.warp;
    const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, color: number, rx = 0) => {
      _m.makeRotationX(rx).setPosition(x, y, z);
      this.shell.add(g, _m, color, { warp, post: sec.matrix });
    };
    // kick plate & lower cabinet
    add(box(W, 0.1, 0.5), 0, 0.05, 0.25, P.kick);
    add(rbox(W, 0.74, 0.62, 0.012), 0, 0.1 + 0.37, 0.29, P.lower);
    // horizontal trim line on lower front
    add(box(W, 0.02, 0.01), 0, 0.62, 0.605, P.trim);
    // arm rest at bench front
    add(rbox(W, 0.056, 0.11, 0.026, 4), 0, 0.84, 0.62, P.arm);
    // bench slab (sloped)
    const benchCenterZ = BENCH_FRONT_Z / 2;
    const benchCenterY = BENCH_BACK_Y - 0.4 * benchCenterZ - 0.016;
    add(rbox(W, 0.032, BENCH_LEN + 0.01, 0.008), 0, benchCenterY, benchCenterZ, P.bench, BENCH_SLOPE);
    // back cabinet block below bench + vertical panel body
    add(box(W, 1.0, 0.5), 0, 0.6, -0.25, P.lower, 0);
    add(rbox(W, BOARD_TOP - 1.08, 0.5, 0.012), 0, 1.08 + (BOARD_TOP - 1.08) / 2, -0.25, P.panel);
    // inset vertical face plate (very thin, slightly lighter so seams read)
    add(box(W - 0.03, 0.84, 0.004), 0, 1.1 + 0.42, -0.0012, P.panel, 0);
    // vertical seam trims at section edges
    add(rbox(0.024, 0.86, 0.014, 0.005), -HALF_W + 0.012, 1.1 + 0.43, 0.004, P.trim);
    add(rbox(0.024, 0.86, 0.014, 0.005), HALF_W - 0.012, 1.1 + 0.43, 0.004, P.trim);
    // annunciator housing
    add(rbox(W, 0.37, 0.14, 0.018, 2), 0, 2.125, 0.07, P.annHousing);
    // top hood + placard fascia
    add(rbox(W, 0.06, 0.7, 0.02, 2), 0, BOARD_TOP - 0.03, -0.12, P.panelDark);
    add(rbox(W, 0.13, 0.04, 0.012, 2), 0, BOARD_TOP - 0.035, 0.22, P.fascia);
    // underside light strip of hood (lit by the room anyway)
    add(box(W, 0.012, 0.09), 0, BOARD_TOP - 0.1, 0.18, 0xd9d4c4);
  }

  /** raised rim around a face (4 bevelled strips) */
  bezelLip(frame: THREE.Matrix4, fw: number, fh: number, z: number, t: number, color: number): void {
    const d = 0.006;
    const strips: [number, number, number, number][] = [
      [0, fh / 2 + t / 2, fw + 2 * t, t],
      [0, -fh / 2 - t / 2, fw + 2 * t, t],
      [-fw / 2 - t / 2, 0, t, fh],
      [fw / 2 + t / 2, 0, t, fh],
    ];
    for (const [x, y, w, h] of strips) {
      this.shell.add(box(w, h, d), _m.makeTranslation(x, y, z + d / 2).premultiply(frame), color, { ao: false });
    }
  }

  placard(sec: Section, text: string): void {
    // big section name on hood fascia
    const w = HALF_W * 2 - 0.2;
    const h = 0.1;
    const r = this.allocStatic(Math.round(w * 640), Math.round(h * 640));
    const ctx = this.staticAtlas.ctx;
    ctx.fillStyle = '#16202e';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = '#c9c1a3';
    ctx.lineWidth = 3;
    ctx.strokeRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
    ctx.fillStyle = '#f4ecd2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, text, r.x + r.w / 2, r.y + r.h / 2 + 2, r.w - 40, Math.round(r.h * 0.68), 'bold');
    _m.makeTranslation(0, BOARD_TOP - 0.035, 0.241).premultiply(sec.matrix);
    this.staticQuads.add(r, w, h, _m);
  }

  /* ---------------- labels ---------------- */
  /** custom static artwork drawn into the atlas, mapped onto a w×h plane (aspect preserved) */
  staticDraw(frame: THREE.Matrix4, w: number, h: number, pxPerM: number, draw: (ctx: CanvasRenderingContext2D, r: Region) => void): Region {
    const r = this.allocStatic(Math.max(8, Math.round(w * pxPerM)), Math.max(8, Math.round(h * pxPerM)));
    draw(this.staticAtlas.ctx, r);
    this.staticQuads.add(r, w, h, frame);
    return r;
  }
  /** re-use an existing atlas region on another plane */
  quad(r: Region, frame: THREE.Matrix4, w: number, h: number): void {
    this.staticQuads.add(r, w, h, frame);
  }

  /** engraved lamacoid label at an arbitrary frame */
  labelAt(frame: THREE.Matrix4, text: string, w: number, h: number, style: 'black' | 'white' | 'red' | 'yellow' = 'black', pxPerM = 1500): void {
    const pw = Math.max(16, Math.round(w * pxPerM));
    const ph = Math.max(10, Math.round(h * pxPerM));
    const r = this.allocStatic(pw, ph);
    const ctx = this.staticAtlas.ctx;
    const bg = { black: '#151515', white: '#ece8dc', red: '#8d1c16', yellow: '#e2b62a' }[style];
    const fg = { black: '#f2efe6', white: '#141414', red: '#fff4ec', yellow: '#151515' }[style];
    ctx.fillStyle = bg;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = text.split('\n');
    const lh = r.h / lines.length;
    for (let i = 0; i < lines.length; i++) {
      fitText(ctx, lines[i], r.x + r.w / 2, r.y + lh * (i + 0.5) + 1, r.w - 6, Math.floor(lh * 0.78), 'bold');
    }
    this.staticQuads.add(r, w, h, frame);
  }

  label(sec: Section, surf: Surf, u: number, v: number, text: string, w: number, h = 0.02, style: 'black' | 'white' | 'red' | 'yellow' = 'black'): void {
    this.labelAt(surfaceFrame(sec, surf, u, v, 0.004), text, w, h, style);
  }

  /** a painted group outline (thin black lines) — implemented as 4 thin label-color boxes */
  groupBox(sec: Section, surf: Surf, u0: number, v0: number, u1: number, v1: number, title?: string): void {
    const t = 0.004;
    const cx = (u0 + u1) / 2;
    const cy = (v0 + v1) / 2;
    const w = Math.abs(u1 - u0);
    const h = Math.abs(v1 - v0);
    const fr = (u: number, v: number, gw: number, gh: number) => {
      surfaceFrame(sec, surf, u, v, 0.0035, _m2);
      this.shell.add(box(gw, gh, 0.002), _m2, 0x22302a, { ao: false });
    };
    fr(cx, v0, w, t);
    fr(cx, v1, w, t);
    fr(u0, cy, t, h);
    fr(u1, cy, t, h);
    if (title) {
      const top = Math.max(v0, v1);
      this.label(sec, surf, cx, top, title, Math.min(w * 0.7, 0.08 + title.length * 0.012), 0.022, 'white');
    }
  }

  /* ---------------- interaction registry ---------------- */
  private register(frame: THREE.Matrix4, half: [number, number, number], it: Omit<Interactable, 'inv' | 'half' | 'center'>): Interactable {
    const full: Interactable = {
      ...it,
      label: it.label.replace(/\n/g, ' '),
      inv: frame.clone().invert(),
      half: new THREE.Vector3(...half),
      center: new THREE.Vector3().setFromMatrixPosition(frame),
    };
    this.interactables.push(full);
    return full;
  }

  /* ---------------- analog meters ---------------- */
  mapT(def: MeterDef, v: number): number {
    let t: number;
    if (def.log) {
      const lv = Math.log10(Math.max(v, def.min * 0.5));
      t = (lv - Math.log10(def.min)) / (Math.log10(def.max) - Math.log10(def.min));
    } else t = (v - def.min) / (def.max - def.min);
    if (!Number.isFinite(t)) t = 0;
    return Math.min(1.03, Math.max(-0.03, t));
  }

  private ticksOf(def: MeterDef): number[] {
    if (def.ticks) return def.ticks;
    if (def.log) {
      const out: number[] = [];
      for (let e = Math.round(Math.log10(def.min)); e <= Math.round(Math.log10(def.max)); e++) out.push(Math.pow(10, e));
      return out;
    }
    const out: number[] = [];
    const n = 5;
    for (let i = 0; i <= n; i++) out.push(def.min + ((def.max - def.min) * i) / n);
    return out;
  }

  private tickLabel(def: MeterDef, v: number): string {
    if (def.tickFmt) return def.tickFmt(v);
    if (def.log) {
      const e = Math.round(Math.log10(v));
      return e === 0 ? '1' : e === 1 ? '10' : `1E${e}`;
    }
    return Math.abs(v) >= 1000 && v % 1000 === 0 ? `${v / 1000}k` : String(Math.round(v * 100) / 100);
  }

  /** square switchboard meter with 90° arc */
  meter(sec: Section, surf: Surf, u: number, v: number, def: MeterDef): void {
    const S = def.size ?? 0.15;
    const frame = surfaceFrame(sec, surf, u, v, 0);
    // bezel
    this.shell.add(rbox(S, S, 0.03, 0.008), _m.makeTranslation(0, 0, 0.015).premultiply(frame), PALETTE.bezel, { ao: false });
    this.bezelLip(frame, S * 0.9, S * 0.9, 0.03, 0.006, 0x2a2b2d);
    // face
    const fw = S * 0.9;
    const fh = S * 0.9;
    const px = Math.round(fw * 1250);
    const r = this.allocStatic(px, px);
    this.drawDial(this.staticAtlas.ctx, r, def);
    _m.makeTranslation(0, 0, 0.0305).premultiply(frame);
    this.staticQuads.add(r, fw, fh, _m);
    // needle(s)
    const pivotY = (0.5 - 0.86) * fh;
    const base = new THREE.Matrix4().makeTranslation(0, pivotY, 0.033).premultiply(frame);
    const len = fw * 0.62;
    const map = (x: number) => (45 - 90 * this.mapT(def, x)) * DEG;
    if (def.get2) this.needles.push(this.mkNeedle(base, 'rot', map, def.get2, len * 0.9, 0.0035, 0xc81e1e));
    this.needles.push(this.mkNeedle(base, 'rot', map, def.get, len, 0.0022, 0x111111));
    // pivot cap
    this.shell.add(zcyl(0.006, 0.006, 0.004, 16), _m.makeTranslation(0, pivotY, 0.031).premultiply(frame), 0x111111, { ao: false });
    this.registerInfo(frame, [S / 2, S / 2, 0.04], def.title, (s) => this.fmtMeter(def, s));
  }

  /** vertical edgewise meter (narrow), title label underneath */
  vmeter(sec: Section, surf: Surf, u: number, v: number, def: MeterDef, labelText?: string): void {
    const W = 0.062;
    const H = 0.2;
    const frame = surfaceFrame(sec, surf, u, v, 0);
    this.shell.add(rbox(W, H, 0.035, 0.007), _m.makeTranslation(0, 0, 0.0175).premultiply(frame), PALETTE.bezel, { ao: false });
    this.bezelLip(frame, W * 0.82, H * 0.9, 0.035, 0.004, 0x2a2b2d);
    const fw = W * 0.82;
    const fh = H * 0.9;
    const r = this.allocStatic(Math.round(fw * 1450), Math.round(fh * 1450));
    this.drawEdgewise(this.staticAtlas.ctx, r, def);
    _m.makeTranslation(0, 0, 0.0355).premultiply(frame);
    this.staticQuads.add(r, fw, fh, _m);
    const ty = 0.12;
    const by = 0.93;
    const base = new THREE.Matrix4().makeTranslation(fw * 0.12, 0, 0.037).premultiply(frame);
    const map = (x: number) => (0.5 - by) * fh + this.mapT(def, x) * (by - ty) * fh;
    if (def.get2) this.needles.push(this.mkNeedle(base, 'slide', map, def.get2, fw * 0.3, 0.004, 0xc81e1e));
    this.needles.push(this.mkNeedle(base, 'slide', map, def.get, fw * 0.55, 0.0028, 0x111111));
    if (labelText !== undefined) this.label(sec, surf, u, v - H / 2 - 0.016, labelText, W + 0.006, 0.022);
    this.registerInfo(frame, [W / 2, H / 2, 0.04], def.title, (s) => this.fmtMeter(def, s));
  }

  /** free-rotating needle with custom face (synchroscope, clock) */
  dialFree(frame: THREE.Matrix4, size: number, drawFace: (ctx: CanvasRenderingContext2D, r: Region) => void, hands: { get: Getter<number>; len: number; wid: number; color: number }[]): void {
    const px = Math.round(size * 1300);
    const r = this.allocStatic(px, px);
    drawFace(this.staticAtlas.ctx, r);
    _m.makeTranslation(0, 0, 0.0305).premultiply(frame);
    this.staticQuads.add(r, size, size, _m);
    const base = new THREE.Matrix4().makeTranslation(0, 0, 0.033).premultiply(frame);
    for (const h of hands) {
      const n = this.mkNeedle(base, 'free', (x) => x, h.get, h.len, h.wid, h.color);
      n.rate = 1000;
      this.needles.push(n);
    }
  }

  private mkNeedle(base: THREE.Matrix4, kind: NeedleInst['kind'], map: (v: number) => number, get: Getter<number>, len: number, wid: number, color: number): NeedleInst {
    const n: NeedleInst = { base, kind, map, get, len, wid, cur: 0, init: false, rate: 6, dirty: true };
    (n as any).color = color;
    return n;
  }

  fmtMeter(def: MeterDef, s: PlantState): string {
    const v = safeNum(def.get, s);
    const f = def.fmt ?? ((x: number) => (def.log ? x.toExponential(2) : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1)));
    let out = Number.isFinite(v) ? `${f(v)} ${def.unit}` : '----';
    if (def.get2) {
      const v2 = safeNum(def.get2, s);
      if (Number.isFinite(v2)) out += `  (red: ${f(v2)})`;
    }
    return out;
  }

  drawDial(ctx: CanvasRenderingContext2D, r: Region, def: MeterDef): void {
    const { x, y, w, h } = r;
    ctx.fillStyle = '#f1ecdc';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#2b2b2b';
    ctx.lineWidth = Math.max(2, w * 0.012);
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
    const cx = x + w / 2;
    const cy = y + h * 0.86;
    const R = w * 0.62;
    const ang = (t: number) => (-90 + -45 + 90 * t) * DEG; // canvas angle (0 = +x, clockwise)
    // zones
    for (const [a, b, col] of def.zones ?? []) {
      ctx.strokeStyle = col;
      ctx.lineWidth = w * 0.05;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.93, ang(this.mapT(def, a)), ang(this.mapT(def, b)));
      ctx.stroke();
    }
    // arc
    ctx.strokeStyle = '#151515';
    ctx.lineWidth = Math.max(1.5, w * 0.008);
    ctx.beginPath();
    ctx.arc(cx, cy, R, ang(0), ang(1));
    ctx.stroke();
    const ticks = this.ticksOf(def);
    const minor = def.minor ?? (def.log ? 0 : 4);
    ctx.fillStyle = '#151515';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tick = (t: number, len: number, lw: number) => {
      const a = ang(t);
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.lineTo(cx + Math.cos(a) * (R - len), cy + Math.sin(a) * (R - len));
      ctx.stroke();
    };
    for (let i = 0; i < ticks.length; i++) {
      const t = this.mapT(def, ticks[i]);
      tick(t, w * 0.07, Math.max(1.5, w * 0.012));
      const a = ang(t);
      ctx.font = `bold ${Math.round(w * 0.075)}px ${FONT}`;
      ctx.fillText(this.tickLabel(def, ticks[i]), cx + Math.cos(a) * (R - w * 0.14), cy + Math.sin(a) * (R - w * 0.14));
      if (i < ticks.length - 1) {
        if (def.log) {
          for (let k = 2; k <= 9; k++) tick(this.mapT(def, ticks[i] * k), w * 0.03, 1);
        } else {
          const t1 = this.mapT(def, ticks[i + 1]);
          for (let k = 1; k <= minor; k++) tick(t + ((t1 - t) * k) / (minor + 1), w * 0.035, 1);
        }
      }
    }
    // title + unit
    ctx.fillStyle = '#111';
    fitText(ctx, def.title, cx, y + h * 0.1, w * 0.9, Math.round(w * 0.085), 'bold');
    ctx.font = `${Math.round(w * 0.07)}px ${FONT}`;
    ctx.fillText(def.unit, cx, y + h * 0.62);
  }

  drawEdgewise(ctx: CanvasRenderingContext2D, r: Region, def: MeterDef): void {
    const { x, y, w, h } = r;
    ctx.fillStyle = '#f1ecdc';
    ctx.fillRect(x, y, w, h);
    const ty = y + h * 0.12;
    const by = y + h * 0.93;
    const yAt = (t: number) => by - t * (by - ty);
    for (const [a, b, col] of def.zones ?? []) {
      ctx.fillStyle = col;
      const ya = yAt(this.mapT(def, a));
      const yb = yAt(this.mapT(def, b));
      ctx.fillRect(x + w * 0.5, Math.min(ya, yb), w * 0.14, Math.abs(ya - yb));
    }
    ctx.strokeStyle = '#151515';
    ctx.fillStyle = '#151515';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.66, ty);
    ctx.lineTo(x + w * 0.66, by);
    ctx.stroke();
    const ticks = this.ticksOf(def);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < ticks.length; i++) {
      const t = this.mapT(def, ticks[i]);
      const yy = yAt(t);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.66, yy);
      ctx.lineTo(x + w * 0.46, yy);
      ctx.stroke();
      ctx.font = `bold ${Math.round(w * 0.2)}px ${FONT}`;
      ctx.fillText(this.tickLabel(def, ticks[i]), x + w * 0.44, yy);
      if (i < ticks.length - 1) {
        const t1 = this.mapT(def, ticks[i + 1]);
        const minor = def.log ? 0 : def.minor ?? 4;
        for (let k = 1; k <= minor; k++) {
          const yk = yAt(t + ((t1 - t) * k) / (minor + 1));
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + w * 0.66, yk);
          ctx.lineTo(x + w * 0.56, yk);
          ctx.stroke();
        }
      }
    }
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(w * 0.19)}px ${FONT}`;
    ctx.fillText(def.unit, x + w / 2, y + h * 0.05);
  }

  private registerInfo(frame: THREE.Matrix4, half: [number, number, number], label: string, detail: (s: PlantState) => string): void {
    this.register(frame, half, { id: 'info:' + label.replace(/\n/g, ' '), label, kind: 'info', detail: (s) => detail(s) });
  }

  /* ---------------- lamps ---------------- */
  lamp(sec: Section, surf: Surf, u: number, v: number, def: LampDef, labelBelow = true): void {
    const frame = surfaceFrame(sec, surf, u, v, 0);
    this.lampAt(frame, def);
    if (labelBelow) this.label(sec, surf, u, v - 0.032, def.title, 0.075, 0.03);
    this.registerInfo(frame, [0.02, 0.02, 0.03], def.hover ?? def.title, (s) => (safeBool(def.get, s) ? 'LIT' : 'dark'));
  }

  lampAt(frame: THREE.Matrix4, def: LampDef): number {
    this.shell.add(zcyl(0.016, 0.017, 0.008, 12), frame, 0x111111, { ao: false });
    const idx = this.lamps.length;
    const [r, g, b] = LAMP_COLORS[def.color];
    this.lamps.push({ get: def.get, on: new THREE.Color(r, g, b), off: lampOff(def.color), flash: !!def.flash, last: -1 });
    (this.lamps[idx] as any).frame = frame.clone();
    return idx;
  }

  /* ---------------- readouts ---------------- */
  readout(sec: Section, surf: Surf, u: number, v: number, def: ReadoutDef): void {
    const w = def.w ?? 0.12;
    const h = def.h ?? 0.042;
    const frame = surfaceFrame(sec, surf, u, v, 0);
    this.shell.add(rbox(w + 0.016, h + 0.014, 0.02, 0.005), _m.makeTranslation(0, 0, 0.01).premultiply(frame), PALETTE.bezel, { ao: false });
    this.bezelLip(frame, w, h, 0.02, 0.003, 0x303234);
    const r = this.readAtlas.alloc(Math.round(w * 1300), Math.round(h * 1300));
    _m.makeTranslation(0, 0, 0.0205).premultiply(frame);
    this.readQuads.add(r, w, h, _m);
    const col = { red: '#ff4a1c', green: '#4dff7a', amber: '#ffb020' }[def.color ?? 'red'];
    this.readouts.push({ r, get: def.get, color: col, last: '\u0000' });
    this.label(sec, surf, u, v + h / 2 + 0.019, def.title, w + 0.014, 0.022);
    this.registerInfo(frame, [w / 2 + 0.007, h / 2 + 0.006, 0.03], def.title, (s) => {
      try {
        return def.get(s).trim() + (def.unit ? ' ' + def.unit : '');
      } catch {
        return '----';
      }
    });
  }

  /** custom-drawn dynamic region (rod bars, etc.) */
  customReadout(frame: THREE.Matrix4, w: number, h: number, px: number, draw: (ctx: CanvasRenderingContext2D, r: Region, s: PlantState) => void, key?: (s: PlantState) => number): Region {
    const r = this.readAtlas.alloc(Math.round(w * px), Math.round(h * px));
    this.readQuads.add(r, w, h, frame);
    this.customReadouts.push({ r, draw, key, last: NaN });
    return r;
  }

  /* ---------------- switches / knobs / lever ---------------- */
  private escutcheon(frame: THREE.Matrix4, title: string, positions: string[], angles: number[], size: number, red = false): void {
    const px = Math.round(size * 1300);
    const r = this.allocStatic(px, px);
    const ctx = this.staticAtlas.ctx;
    const { x, y, w, h } = r;
    ctx.fillStyle = '#141414';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = red ? '#b5332a' : '#5a5a5a';
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
    ctx.fillStyle = '#efe9da';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, title, x + w / 2, y + h * 0.1, w * 0.94, Math.round(h * 0.13), 'bold');
    const cx = x + w / 2;
    const cy = y + h * 0.68;
    const R = w * 0.33;
    for (let i = 0; i < positions.length; i++) {
      const a = (angles[i] - 90) * DEG;
      fitText(ctx, positions[i], cx + Math.cos(a) * R * 1.05, cy + Math.sin(a) * R * 0.95, w * 0.34, Math.round(h * 0.12), 'bold');
      ctx.strokeStyle = '#efe9da';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * w * 0.16, cy + Math.sin(a) * w * 0.16);
      ctx.lineTo(cx + Math.cos(a) * w * 0.21, cy + Math.sin(a) * w * 0.21);
      ctx.stroke();
    }
    _m.makeTranslation(0, 0, 0.003).premultiply(frame);
    this.staticQuads.add(r, size, size, _m);
  }

  switch(sec: Section, surf: Surf, u: number, v: number, def: SwitchDef): void {
    const n = def.positions.length;
    const angles =
      def.angles ??
      (n === 2 ? [-45, 45] : n === 3 ? [-45, 0, 45] : n === 4 ? [-60, -20, 20, 60] : Array.from({ length: n }, (_, i) => -90 + (180 * i) / (n - 1)));
    const size = def.size ?? 0.14;
    const frame = surfaceFrame(sec, surf, u, v, 0);
    this.escutcheon(frame, def.title, def.positions, angles, size, def.red);
    const pivot = new THREE.Matrix4().makeTranslation(0, -size * 0.18, 0.004).premultiply(frame);
    this.shell.add(zcyl(0.022, 0.024, 0.012, 16), pivot, 0x0e0e0e, { ao: false });
    const sim = this.sim;
    const get = () => {
      try {
        return Math.max(0, Math.min(n - 1, def.get(sim.controls)));
      } catch {
        return 0;
      }
    };
    const h: HandleInst = { base: new THREE.Matrix4().makeTranslation(0, 0, 0.012).premultiply(pivot), scale: def.size ? def.size / 0.12 : 1, angle: 0, target: () => -angles[get()] * DEG };
    this.handles.push(h);
    h.scale = (def.size ?? 0.14) / 0.12;
    this.handleColors.push(def.red ? 0x9a1f17 : 0x161616);
    const step = (d: number) => {
      const i = get();
      const j = Math.max(0, Math.min(n - 1, i + d));
      if (j !== i) {
        def.set(sim.controls, j);
        bus.emit('control-used', { id: def.id, kind: 'switch' });
      }
    };
    this.register(pivot, [size * 0.45, size * 0.5, 0.06], {
      id: def.id,
      label: def.title,
      kind: 'switch',
      detail: () => `${def.positions[get()]}   [LMB ▶ / RMB ◀]`,
      primary: () => step(1),
      secondary: () => step(-1),
      wheel: (d) => step(d),
    });
  }

  knob(sec: Section, surf: Surf, u: number, v: number, def: KnobDef): void {
    const size = 0.14;
    const frame = surfaceFrame(sec, surf, u, v, 0);
    const ticks = def.ticks ?? [def.fmt(def.min), def.fmt(def.max)];
    // escutcheon with dial ticks
    const px = Math.round(size * 1300);
    const r = this.allocStatic(px, px);
    const ctx = this.staticAtlas.ctx;
    ctx.fillStyle = '#141414';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#efe9da';
    ctx.strokeStyle = '#efe9da';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, def.title, r.x + r.w / 2, r.y + r.h * 0.1, r.w * 0.94, Math.round(r.h * 0.13), 'bold');
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h * 0.68;
    for (let i = 0; i <= 10; i++) {
      const a = (-135 + 27 * i - 90) * DEG;
      ctx.lineWidth = i % 5 === 0 ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r.w * 0.2, cy + Math.sin(a) * r.w * 0.2);
      ctx.lineTo(cx + Math.cos(a) * r.w * (i % 5 === 0 ? 0.27 : 0.24), cy + Math.sin(a) * r.w * (i % 5 === 0 ? 0.27 : 0.24));
      ctx.stroke();
    }
    for (let i = 0; i < ticks.length; i++) {
      const a = (-135 + (270 * i) / Math.max(1, ticks.length - 1) - 90) * DEG;
      fitText(ctx, ticks[i], cx + Math.cos(a) * r.w * 0.37, cy + Math.sin(a) * r.w * 0.34, r.w * 0.3, Math.round(r.h * 0.11), 'bold');
    }
    _m.makeTranslation(0, 0, 0.003).premultiply(frame);
    this.staticQuads.add(r, size, size, _m);
    const pivot = new THREE.Matrix4().makeTranslation(0, -size * 0.18, 0.004).premultiply(frame);
    const sim = this.sim;
    const get = () => {
      try {
        const v = def.get(sim.controls);
        return Number.isFinite(v) ? v : def.min;
      } catch {
        return def.min;
      }
    };
    this.knobs.push({ base: pivot, scale: 1, angle: 0, target: () => -(-135 + 270 * ((get() - def.min) / (def.max - def.min))) * DEG });
    const adj = (d: number, coarse: boolean) => {
      const v0 = get();
      const v1 = Math.max(def.min, Math.min(def.max, Math.round((v0 + d * (coarse ? def.coarse : def.step)) / def.step) * def.step));
      if (v1 !== v0) {
        def.set(sim.controls, v1);
        bus.emit('control-used', { id: def.id, kind: 'knob' });
      }
    };
    this.register(pivot, [0.035, 0.035, 0.05], {
      id: def.id,
      label: def.title,
      kind: 'knob',
      detail: () => `${def.fmt(get())}   [wheel / LMB+ RMB−, Shift = coarse]`,
      primary: () => adj(1, false),
      secondary: () => adj(-1, false),
      wheel: (d, c) => adj(d, c),
      repeat: true,
    });
  }

  /** rod motion lever: spring return IN / HOLD / OUT */
  lever(sec: Section, surf: Surf, u: number, v: number): void {
    const size = 0.18;
    const frame = surfaceFrame(sec, surf, u, v, 0);
    const angles = [-50, 0, 50];
    this.escutcheon(frame, 'ROD MOTION', ['IN', 'HOLD', 'OUT'], angles, size, true);
    const pivot = new THREE.Matrix4().makeTranslation(0, -size * 0.18, 0.004).premultiply(frame);
    this.shell.add(zcyl(0.03, 0.032, 0.014, 18), pivot, 0x0e0e0e, { ao: false });
    const sim = this.sim;
    const get = () => {
      try {
        return sim.controls.rodMotion ?? 0;
      } catch {
        return 0;
      }
    };
    this.handles.push({ base: new THREE.Matrix4().makeTranslation(0, 0, 0.014).premultiply(pivot), scale: 1.3, angle: 0, target: () => -get() * 50 * DEG });
    this.handleColors.push(0x8a1a12);
    this.register(pivot, [0.06, 0.07, 0.07], {
      id: 'ROD_MOTION',
      label: 'ROD MOTION LEVER',
      kind: 'lever',
      detail: (s, c) => {
        const m = c.rodMotion === 1 ? 'OUT' : c.rodMotion === -1 ? 'IN' : 'HOLD';
        const mode = c.rodMode === 'auto' ? ' (rods in AUTO)' : '';
        return `${m}${mode}   [hold LMB = withdraw · hold RMB = insert]`;
      },
      holdStart: (dir) => {
        sim.controls.rodMotion = dir > 0 ? 1 : -1;
        bus.emit('control-used', { id: 'ROD_MOTION', kind: 'lever' });
      },
      holdEnd: () => {
        if (sim.controls.rodMotion !== 0) {
          sim.controls.rodMotion = 0;
          bus.emit('control-used', { id: 'ROD_MOTION', kind: 'lever' });
        }
      },
    });
  }

  /* ---------------- buttons ---------------- */
  button(sec: Section, surf: Surf, u: number, v: number, def: ButtonDef): void {
    const frame = surfaceFrame(sec, surf, u, v, 0);
    const mush = !!def.mushroom;
    const R = mush ? 0.034 : 0.019;
    // collar
    this.shell.add(zcyl(R + 0.008, R + 0.01, 0.012, 20), frame, 0x121212, { ao: false });
    if (def.guard) {
      // yellow/black guard ring + two posts
      this.shell.add(zcyl(R + 0.026, R + 0.028, 0.006, 24), frame, 0xd8a41c, { ao: false });
      _m.makeTranslation(-(R + 0.022), 0, 0.03).premultiply(frame);
      this.shell.add(box(0.008, 0.012, 0.06), _m, 0xd8a41c, { ao: false });
      _m.makeTranslation(R + 0.022, 0, 0.03).premultiply(frame);
      this.shell.add(box(0.008, 0.012, 0.06), _m, 0xd8a41c, { ao: false });
      _m.makeTranslation(0, 0, 0.061).premultiply(frame);
      this.shell.add(box(2 * (R + 0.026), 0.012, 0.006), _m, 0xd8a41c, { ao: false });
    }
    const idx = this.buttons.length;
    const base = new THREE.Matrix4().makeTranslation(0, 0, 0.012).premultiply(frame);
    this.buttons.push({ base, scale: new THREE.Vector3(mush ? 1.8 : 1, mush ? 1.8 : 1, mush ? 1.3 : 1), t: 0 });
    this.buttonColors.push(def.color);
    this.buttonIndex.set(def.id, idx);
    const labelV = v + R + 0.026 + (def.guard ? 0.02 : 0);
    this.label(sec, surf, u, labelV, def.title, Math.max(0.085, R * 2 + 0.03), mush ? 0.032 : 0.028, def.mushroom ? 'red' : 'black');
    if (def.lamp) {
      const lf = surfaceFrame(sec, surf, u + R + 0.03, v + 0.0, 0);
      this.lampAt(lf, { title: def.title, color: def.lampColor ?? 'red', get: def.lamp });
    }
    const press = () => {
      this.buttons[idx].t = 1;
      bus.emit('control-used', { id: def.id, kind: 'button' });
      if (def.press) bus.emit('press', def.press as any);
      def.action?.();
    };
    this.register(frame, [R + 0.012, R + 0.012, 0.07], {
      id: def.id,
      label: def.hover ?? def.title,
      kind: 'button',
      detail: (s) => {
        const l = def.lamp ? (safeBool(def.lamp, s) ? 'indicating ON   ' : 'indicating off   ') : '';
        return `${l}[LMB / F: press]`;
      },
      primary: press,
    });
  }

  /* ---------------- build meshes ---------------- */
  finalize(scene: THREE.Scene, shellMat: THREE.Material): { staticAtlasMat: THREE.MeshLambertMaterial; readMat: THREE.MeshBasicMaterial } {
    const shell = this.shell.build(shellMat);
    shell.name = 'boards-shell';
    scene.add(shell);

    // crop each static atlas page to its used height (saves GPU memory) and remap v
    let staticAtlasMat!: THREE.MeshLambertMaterial;
    this.pages.forEach((pg, pi) => {
      const A = pg.atlas;
      const usedH = Math.min(A.H, Math.max(256, Math.ceil((A.usage() * A.H) / 256) * 256));
      const crop = document.createElement('canvas');
      crop.width = A.W;
      crop.height = usedH;
      crop.getContext('2d')!.drawImage(A.canvas, 0, 0);
      const tex = new THREE.CanvasTexture(crop);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      A.tex.dispose();
      const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
      if (pi === 0) staticAtlasMat = mat;
      const labels = pg.quads.build(mat);
      const uvA = labels.geometry.getAttribute('uv') as THREE.BufferAttribute;
      const k = A.H / usedH;
      for (let i = 0; i < uvA.count; i++) uvA.setY(i, 1 - (1 - uvA.getY(i)) * k);
      A.canvas.width = A.canvas.height = 1; // free the big canvas
      labels.name = 'labels-' + pi;
      scene.add(labels);
    });

    this.readAtlas.tex.anisotropy = 4;
    this.readAtlas.tex.generateMipmaps = false;
    this.readAtlas.tex.minFilter = THREE.LinearFilter;
    const readMat = new THREE.MeshBasicMaterial({ map: this.readAtlas.tex, vertexColors: true, toneMapped: true });
    readMat.color.setScalar(1.35);
    const reads = this.readQuads.build(readMat);
    reads.name = 'readouts';
    scene.add(reads);

    // needles
    const needleGeo = new THREE.BoxGeometry(1, 1, 0.0016);
    needleGeo.translate(0, 0.5, 0);
    this.needleMesh = new THREE.InstancedMesh(needleGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, this.needles.length));
    for (let i = 0; i < this.needles.length; i++) {
      this.needleMesh.setColorAt(i, _col.set((this.needles[i] as any).color));
      this.needleMesh.setMatrixAt(i, this.needles[i].base);
    }
    this.finishInst(this.needleMesh, 'needles');
    scene.add(this.needleMesh);

    // lamps
    const lampGeo = latheZ([[0, 0.006], [0.0125, 0.006], [0.0125, 0.016], [0.011, 0.02], [0.007, 0.0235], [0, 0.0245]], 18);
    this.lampMesh = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, this.lamps.length));
    for (let i = 0; i < this.lamps.length; i++) {
      this.lampMesh.setMatrixAt(i, (this.lamps[i] as any).frame);
      this.lampMesh.setColorAt(i, this.lamps[i].off);
    }
    this.finishInst(this.lampMesh, 'lamps');
    scene.add(this.lampMesh);

    // switch handles (pistol grip with white index stripe)
    const hg = buildHandleGeo();
    const handleMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    handleMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace(
        '#include <color_vertex>',
        `vColor = vec4(1.0);
#ifdef USE_INSTANCING_COLOR
  vColor.rgb = mix(instanceColor.rgb, vec3(0.85), step(1.5, color.x));
#else
  vColor.rgb = min(color.rgb, vec3(1.0));
#endif`,
      );
    };
    this.handleMesh = new THREE.InstancedMesh(hg, handleMat, Math.max(1, this.handles.length));
    for (let i = 0; i < this.handles.length; i++) this.handleMesh.setColorAt(i, _col.set(this.handleColors[i]));
    this.finishInst(this.handleMesh, 'switch-handles');
    scene.add(this.handleMesh);

    const kg = buildKnobGeo();
    this.knobMesh = new THREE.InstancedMesh(kg, handleMat, Math.max(1, this.knobs.length));
    for (let i = 0; i < this.knobs.length; i++) this.knobMesh.setColorAt(i, _col.set(0x1a1a1a));
    this.finishInst(this.knobMesh, 'knobs');
    scene.add(this.knobMesh);

    const bg = latheZ([[0, 0], [0.019, 0], [0.019, 0.004], [0.0178, 0.006], [0.0178, 0.017], [0.0165, 0.0195], [0.012, 0.021], [0, 0.0215]], 32);
    this.buttonMesh = new THREE.InstancedMesh(bg, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, this.buttons.length));
    for (let i = 0; i < this.buttons.length; i++) this.buttonMesh.setColorAt(i, _col.set(this.buttonColors[i]));
    this.finishInst(this.buttonMesh, 'buttons');
    scene.add(this.buttonMesh);

    // initial pose for everything
    this.updateHandles(1, true);
    this.updateButtons(1, true);
    return { staticAtlasMat, readMat };
  }

  private finishInst(m: THREE.InstancedMesh, name: string) {
    m.name = name;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.instanceMatrix.needsUpdate = true;
    m.frustumCulled = false; // instances span the room; bounding sphere would be stale
    m.matrixAutoUpdate = false;
  }

  /* ---------------- per-frame ---------------- */
  update(s: PlantState, dt: number, time: number, powerOK: boolean): void {
    this.updateNeedles(s, dt);
    this.updateLamps(s, time, powerOK);
    this.updateHandles(dt, false);
    this.updateButtons(dt, false);
    this.readTimer -= dt;
    if (this.readTimer <= 0) {
      this.readTimer = 1 / 8;
      this.updateReadouts(s);
    }
  }

  private updateNeedles(s: PlantState, dt: number): void {
    let any = false;
    for (let i = 0; i < this.needles.length; i++) {
      const n = this.needles[i];
      let v = safeNum(n.get, s);
      if (!Number.isFinite(v)) v = n.kind === 'free' ? n.cur : -1e9;
      let tgt = n.map(v);
      if (!Number.isFinite(tgt)) tgt = n.cur;
      if (!n.init) {
        n.cur = tgt;
        n.init = true;
        n.dirty = true;
      } else {
        const k = 1 - Math.exp(-n.rate * dt);
        const nv = n.kind === 'free' ? tgt : n.cur + (tgt - n.cur) * k;
        if (Math.abs(nv - n.cur) > 1e-5) {
          n.cur = nv;
          n.dirty = true;
        }
      }
      if (!n.dirty) continue;
      n.dirty = false;
      any = true;
      if (n.kind === 'slide') {
        _m.makeScale(n.len, n.wid, 1);
        _m.setPosition(-n.len / 2, n.cur - n.wid / 2, 0);
      } else {
        _q.setFromAxisAngle(Z, n.cur);
        _s.set(n.wid, n.len, 1);
        _p.set(0, 0, 0);
        _m.compose(_p, _q, _s);
      }
      _m.premultiply(n.base);
      this.needleMesh.setMatrixAt(i, _m);
    }
    if (any) this.needleMesh.instanceMatrix.needsUpdate = true;
  }

  private updateLamps(s: PlantState, time: number, powerOK: boolean): void {
    let any = false;
    const flashOn = Math.floor(time * 3) % 2 === 0;
    for (let i = 0; i < this.lamps.length; i++) {
      const L = this.lamps[i];
      let on = powerOK && safeBool(L.get, s);
      if (on && L.flash && !flashOn) on = false;
      const st = on ? 1 : 0;
      if (st !== L.last) {
        L.last = st;
        this.lampMesh.setColorAt(i, on ? L.on : L.off);
        any = true;
      }
    }
    if (any) this.lampMesh.instanceColor!.needsUpdate = true;
  }

  private updateHandles(dt: number, force: boolean): void {
    const k = force ? 1 : 1 - Math.exp(-18 * dt);
    let any = false;
    for (let pass = 0; pass < 2; pass++) {
      const list = pass === 0 ? this.handles : this.knobs;
      const mesh = pass === 0 ? this.handleMesh : this.knobMesh;
      let dirty = false;
      for (let i = 0; i < list.length; i++) {
        const h = list[i];
        const tgt = h.target();
        if (!force && Math.abs(tgt - h.angle) < 1e-4) continue;
        h.angle += (tgt - h.angle) * k;
        _q.setFromAxisAngle(Z, h.angle);
        _s.setScalar(h.scale);
        _p.set(0, 0, 0);
        _m.compose(_p, _q, _s).premultiply(h.base);
        mesh.setMatrixAt(i, _m);
        dirty = true;
      }
      if (dirty) {
        mesh.instanceMatrix.needsUpdate = true;
        any = true;
      }
    }
    void any;
  }

  private updateButtons(dt: number, force: boolean): void {
    let dirty = false;
    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i];
      if (!force && b.t <= 0) continue;
      b.t = Math.max(0, b.t - dt * 6);
      const depth = Math.sin(Math.min(1, b.t) * Math.PI) * 0.009;
      _m.makeScale(b.scale.x, b.scale.y, b.scale.z);
      _m.setPosition(0, 0, -depth);
      _m.premultiply(b.base);
      this.buttonMesh.setMatrixAt(i, _m);
      dirty = true;
    }
    if (dirty) this.buttonMesh.instanceMatrix.needsUpdate = true;
  }

  private updateReadouts(s: PlantState): void {
    const ctx = this.readAtlas.ctx;
    let changed = false;
    for (let i = 0; i < this.readouts.length; i++) {
      const R = this.readouts[i];
      let txt: string;
      try {
        txt = R.get(s);
      } catch {
        txt = '----';
      }
      if (txt === R.last) continue;
      R.last = txt;
      changed = true;
      const { x, y, w, h } = R.r;
      ctx.fillStyle = '#0a0503';
      ctx.fillRect(x, y, w, h);
      // faint "8888" ghost segments
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const size = Math.round(h * 0.78);
      ctx.font = `bold ${size}px ${MONO}`;
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillText('8'.repeat(Math.max(1, txt.length)), x + w - 6, y + h / 2 + 1);
      ctx.fillStyle = R.color;
      fitText(ctx, txt, x + w - 6, y + h / 2 + 1, w - 10, size, 'bold', MONO);
    }
    for (let i = 0; i < this.customReadouts.length; i++) {
      const c = this.customReadouts[i];
      if (c.key) {
        const k = safeNum(c.key, s);
        if (k === c.last) continue;
        c.last = k;
      }
      try {
        c.draw(ctx, c.r, s);
      } catch {
        /* ignore */
      }
      changed = true;
    }
    if (changed) this.readAtlas.tex.needsUpdate = true;
  }
}

/** lathe profile [[r, z]...] revolved around +z (faces the viewer on a panel) */
function latheZ(profile: [number, number][], seg: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), seg);
  g.rotateX(Math.PI / 2);
  const n = g.index ? g.toNonIndexed() : g;
  n.deleteAttribute('uv');
  return n;
}

function setVC(g: THREE.BufferGeometry, v: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(v), 3));
  return g;
}

/** vertex color 1 = take instance color, 2 = always white (index stripes) */
function buildHandleGeo(): THREE.BufferGeometry {
  const hub = setVC(zcyl(0.016, 0.017, 0.016, 14), 1);
  const grip = rbox(0.02, 0.085, 0.024, 0.007, 2).clone();
  grip.translate(0, 0.012, 0.028);
  setVC(grip, 1);
  const stripe = box(0.005, 0.03, 0.002);
  stripe.translate(0, 0.036, 0.0405);
  setVC(stripe, 2);
  return mergeAll([hub, grip, stripe]);
}

function buildKnobGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = latheZ([[0, 0], [0.025, 0.006], [0.0235, 0.022], [0.021, 0.026], [0, 0.027]], 32);
  const skirt = latheZ([[0, 0], [0.031, 0], [0.031, 0.004], [0.026, 0.007], [0, 0.007]], 32);
  const notch = box(0.004, 0.018, 0.003);
  notch.translate(0, 0.011, 0.0275);
  const setC = (g: THREE.BufferGeometry, v: number) => {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3).fill(v);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  parts.push(setC(body, 1), setC(skirt, 1), setC(notch, 2));
  return mergeAll(parts);
}

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return g;
}
void _e;
