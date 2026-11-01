/**
 * World utilities: geometry buckets (static merge), canvas atlases,
 * safe value access and formatting. No per-frame allocations here.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const DEG = Math.PI / 180;
const _c = new THREE.Color();
const _v = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* geometry primitives (non-indexed, position + normal only)            */
/* ------------------------------------------------------------------ */
function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  if (n !== g) g.dispose();
  n.deleteAttribute('uv');
  return n;
}
export const box = (w: number, h: number, d: number) => strip(new THREE.BoxGeometry(w, h, d));
/** rounded/bevelled box (cached per size) */
const _rcache = new Map<string, THREE.BufferGeometry>();
export function rbox(w: number, h: number, d: number, r = 0.012, seg = 1): THREE.BufferGeometry {
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const k = `${w.toFixed(4)},${h.toFixed(4)},${d.toFixed(4)},${rr.toFixed(4)},${seg}`;
  let g = _rcache.get(k);
  if (!g) {
    g = strip(new RoundedBoxGeometry(w, h, d, seg, Math.max(1e-4, rr)));
    _rcache.set(k, g);
  }
  return g;
}
export const cyl = (rt: number, rb: number, h: number, seg = 20) =>
  strip(new THREE.CylinderGeometry(rt, rb, h, seg));
/** cylinder whose axis is +z (faces the viewer when placed on a panel), base at z=0 */
export function zcyl(rt: number, rb: number, h: number, seg = 24): THREE.BufferGeometry {
  const g = cyl(rt, rb, h, seg);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, h / 2);
  return g;
}
export const plane = (w: number, h: number, sx = 1, sy = 1) => strip(new THREE.PlaneGeometry(w, h, sx, sy));

/** cheap baked "ambient occlusion": darken near floor, slight darkening near ceiling */
export function aoAt(y: number): number {
  const floor = 0.5 + 0.5 * THREE.MathUtils.smoothstep(y, 0.0, 0.55);
  const ceil = 1 - 0.18 * THREE.MathUtils.smoothstep(y, 3.0, 3.6);
  return floor * ceil;
}

export type Warp = ((p: THREE.Vector3) => void) | null;

/** Collects static geometry with baked vertex colors, merged into one mesh. */
export class GeoBucket {
  parts: THREE.BufferGeometry[] = [];
  add(
    src: THREE.BufferGeometry,
    m: THREE.Matrix4 | null,
    color: THREE.ColorRepresentation,
    opts: { ao?: boolean; warp?: Warp; post?: THREE.Matrix4; shade?: number } = {},
  ): void {
    const g = src.clone();
    if (m) g.applyMatrix4(m);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    if (opts.warp) {
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i);
        opts.warp(_v);
        pos.setXYZ(i, _v.x, _v.y, _v.z);
      }
    }
    if (opts.post) g.applyMatrix4(opts.post);
    _c.set(color);
    const shade = opts.shade ?? 1;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const f = (opts.ao === false ? 1 : aoAt(pos.getY(i))) * shade;
      col[i * 3] = _c.r * f;
      col[i * 3 + 1] = _c.g * f;
      col[i * 3 + 2] = _c.b * f;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(g);
  }
  build(material: THREE.Material): THREE.Mesh {
    const merged = this.parts.length ? mergeGeometries(this.parts, false)! : new THREE.BufferGeometry();
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

/* ------------------------------------------------------------------ */
/* Canvas atlas with a simple shelf packer                              */
/* ------------------------------------------------------------------ */
export interface Region {
  page?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  u1: number;
  v0: number; // bottom
  v1: number; // top
}

export class CanvasAtlas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  private cy = 0;
  overflow = false;
  constructor(
    public W: number,
    public H: number,
    private pad = 3,
    bg = '#000',
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.fillStyle = bg;
    this.ctx.fillRect(0, 0, W, H);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
  }
  private shelves: { y: number; h: number; x: number }[] = [];
  alloc(w: number, h: number): Region {
    w = Math.ceil(w);
    h = Math.ceil(h);
    const p = this.pad;
    const W2 = w + p * 2;
    const H2 = h + p * 2;
    let shelf = this.shelves.find((sh) => sh.h >= H2 && sh.h <= H2 * 1.5 + 4 && sh.x + W2 <= this.W);
    if (!shelf) {
      if (this.cy + H2 > this.H) {
        if (!this.overflow) console.warn('[world] atlas overflow', this.W, this.H, 'req', w, h);
        this.overflow = true;
        this.cy = 0;
      }
      shelf = { y: this.cy, h: H2, x: 0 };
      this.shelves.push(shelf);
      this.cy += H2;
    }
    const x = shelf.x + p;
    const y = shelf.y + p;
    shelf.x += W2;
    return {
      x,
      y,
      w,
      h,
      u0: x / this.W,
      u1: (x + w) / this.W,
      v1: 1 - y / this.H,
      v0: 1 - (y + h) / this.H,
    };
  }
  canFit(w: number, h: number): boolean {
    const W2 = Math.ceil(w) + this.pad * 2;
    const H2 = Math.ceil(h) + this.pad * 2;
    return this.shelves.some((sh) => sh.h >= H2 && sh.h <= H2 * 1.5 + 4 && sh.x + W2 <= this.W) || this.cy + H2 <= this.H;
  }
  /** fraction of atlas height used */
  usage(): number {
    return this.cy / this.H;
  }
}

/** Textured quads merged into one mesh (labels, dial faces, readout screens). */
export class QuadBucket {
  private parts: THREE.BufferGeometry[] = [];
  private base = new THREE.PlaneGeometry(1, 1);
  add(r: Region, w: number, h: number, m: THREE.Matrix4, color?: THREE.ColorRepresentation): void {
    const g = this.base.clone();
    g.scale(w, h, 1);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
    }
    g.applyMatrix4(m);
    _c.set(color ?? 0xffffff);
    const col = new Float32Array(uv.count * 3);
    for (let i = 0; i < uv.count; i++) {
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(g);
  }
  get count(): number {
    return this.parts.length;
  }
  build(material: THREE.Material): THREE.Mesh {
    const merged = this.parts.length ? mergeGeometries(this.parts, false)! : new THREE.BufferGeometry();
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

/* ------------------------------------------------------------------ */
/* Safe value access + formatting                                      */
/* ------------------------------------------------------------------ */
export function safeNum<S>(fn: (s: S) => number, s: S): number {
  try {
    const v = fn(s);
    return typeof v === 'number' ? v : NaN;
  } catch {
    return NaN;
  }
}
export function safeBool<S>(fn: (s: S) => boolean, s: S): boolean {
  try {
    return !!fn(s);
  } catch {
    return false;
  }
}
export function fmt(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return v === Infinity ? ' INF' : v === -Infinity ? '-INF' : '----';
  return v.toFixed(digits);
}
export function fmtExp(v: number, digits = 2): string {
  if (!Number.isFinite(v) || v <= 0) return v === 0 ? '0.00E+00' : '----';
  const e = Math.floor(Math.log10(v));
  const m = v / Math.pow(10, e);
  return `${m.toFixed(digits)}E${e >= 0 ? '+' : '-'}${String(Math.abs(e)).padStart(2, '0')}`;
}

export const FONT = '"DejaVu Sans Condensed","Arial Narrow","Roboto Condensed",Arial,Helvetica,sans-serif';
export const MONO = '"DejaVu Sans Mono","Consolas","Courier New",monospace';

/** Fit text into width by shrinking font size. */
export function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  size: number,
  weight = 'bold',
  family = FONT,
): void {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  let w = ctx.measureText(text).width;
  if (w > maxW && w > 0) {
    s = Math.max(6, Math.floor((s * maxW) / w));
    ctx.font = `${weight} ${s}px ${family}`;
  }
  ctx.fillText(text, x, y);
}

/** Split a label into up to n lines of roughly balanced length. */
export function wrapWords(text: string, maxLines: number, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  while (lines.length > maxLines) {
    const last = lines.pop()!;
    lines[lines.length - 1] += ' ' + last;
  }
  return lines;
}
