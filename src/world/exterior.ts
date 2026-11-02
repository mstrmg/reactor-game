/**
 * Exterior "news helicopter" view of the plant site ('view-mode' 'outside').
 * Lazily built on first use and cached. Coordinates in metres: containment at the origin,
 * ground at y = 0, north = -z, east = +x. A lake lies to the south.
 *
 * Reflects the live state: time of day (grid.hourOfDay), steam wisps in normal operation,
 * relief-valve steam after a trip, and the aftermath of each catastrophe kind (cracked or
 * breached dome, torn turbine-hall roof with fire, steam/smoke plumes that drift with the wind
 * and scale with the release rate, emergency vehicles with flashing lights).
 */
import * as THREE from 'three';
import type { PlantState } from '../sim/types';
import { GeoBucket, box, cyl } from './util';

const DEG = Math.PI / 180;
/** direction (from the dome centre) of the containment-failure breach: faces the helicopter's start position */
const BREACH = new THREE.Vector3(-0.55, 0.62, -0.56).normalize();
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const M = (x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1));

/* ------------------------------------------------------------------ */
/* terrain                                                             */
/* ------------------------------------------------------------------ */
const shoreZ = (x: number) => 330 + 45 * Math.sin(x * 0.0035 + 0.5);
function siteMask(x: number, z: number): number {
  const dx = Math.max(0, Math.abs(x - 30) - 290);
  const dz = Math.max(0, Math.abs(z - 30) - 260);
  return 1 - smoothstep(0, 140, Math.hypot(dx, dz));
}
function height(x: number, z: number): number {
  let h = 14 * Math.sin(x * 0.0042 + 0.7) * Math.cos(z * 0.0037 - 0.3) + 7 * Math.sin(x * 0.011 + z * 0.008) + 3 * Math.sin(x * 0.027 - z * 0.019) + 6;
  h += Math.max(0, -z - 380) * 0.07; // hills rise to the north
  h *= 1 - siteMask(x, z);
  const sz = shoreZ(x);
  h = h + (-7 - h) * smoothstep(sz - 35, sz + 45, z);
  // the access road to the west is cut into the hillside
  if (x < -240) h *= 1 - 0.85 * (1 - smoothstep(10, 40, Math.abs(z - 130)));
  return h;
}

/* ------------------------------------------------------------------ */
/* particles (sprites with per-particle size / alpha / shade)          */
/* ------------------------------------------------------------------ */
const PUFF_VS = /* glsl */ `
uniform float uScale;
attribute float aSize;
attribute float aAlpha;
attribute float aShade;
varying float vA;
varying float vS;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(1.0, -mv.z), 0.0, 512.0);
  vA = aAlpha;
  vS = aShade;
}`;
const PUFF_FS = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColA;
uniform vec3 uColB;
varying float vA;
varying float vS;
void main() {
  float t = texture2D(uMap, gl_PointCoord).a;
  float a = t * vA;
  if (a < 0.003) discard;
  gl_FragColor = vec4(mix(uColB, uColA, vS), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

class Puffs {
  readonly n: number;
  readonly points: THREE.Points;
  readonly mat: THREE.ShaderMaterial;
  private pos: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private amax: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private shade: Float32Array;
  private next = 0;
  private buoy: number;
  active = 0;
  constructor(n: number, tex: THREE.Texture, colA: number, colB: number, additive: boolean, buoy: number) {
    this.n = n;
    this.buoy = buoy;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n).fill(1);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.amax = new Float32Array(n);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.shade = new Float32Array(n);
    for (let i = 0; i < n; i++) this.age[i] = 2; // dead (age > life)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aShade', new THREE.BufferAttribute(this.shade, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex }, uColA: { value: new THREE.Color(colA) }, uColB: { value: new THREE.Color(colB) }, uScale: { value: 500 } },
      vertexShader: PUFF_VS,
      fragmentShader: PUFF_FS,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, a: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.amax[i] = a;
    this.shade[i] = 0.55 + Math.random() * 0.45;
  }
  update(dt: number, wx: number, wz: number) {
    let act = 0;
    const p = this.pos;
    const v = this.vel;
    for (let i = 0; i < this.n; i++) {
      const L = this.life[i];
      let ag = this.age[i];
      if (ag >= L) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      ag += dt;
      this.age[i] = ag;
      act++;
      const u = ag < L ? ag / L : 1; // clamp: pow(1-u) below must not see a negative base (NaN → bloom blackout)
      // buoyant rise slows; horizontal velocity relaxes toward the wind (stronger aloft)
      const aloft = 0.6 + Math.min(1.2, p[i * 3 + 1] / 120);
      v[i * 3] += (wx * aloft - v[i * 3]) * Math.min(1, dt * 0.35);
      v[i * 3 + 2] += (wz * aloft - v[i * 3 + 2]) * Math.min(1, dt * 0.35);
      v[i * 3 + 1] += (this.buoy - v[i * 3 + 1]) * Math.min(1, dt * 0.25);
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(u);
      this.alpha[i] = this.amax[i] * Math.min(1, ag / Math.min(2, L * 0.15)) * Math.pow(1 - u, 1.3);
    }
    this.active = act;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
}

function softDot(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** box between two points (for lattice towers) */
function beam(B: GeoBucket, a: THREE.Vector3, b: THREE.Vector3, w: number, color: number) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  B.add(box(w, len, w), m, color, { ao: false });
}

/* ------------------------------------------------------------------ */
export class ExteriorView {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 16 / 9, 2, 5000);
  private time = 0;
  private orbit = -2.4; // radians; starts south-west of the plant, over the lake shore
  private hemi = new THREE.HemisphereLight(0xcfe0f0, 0x4a5a3a, 0.9);
  private sun = new THREE.DirectionalLight(0xfff1d8, 2.0);
  private fog = new THREE.FogExp2(0xb9d4ea, 0.00042);
  private sky!: THREE.Mesh;
  private skyCols!: Float32Array;
  private skyY!: Float32Array;
  private sunDisk!: THREE.Mesh;
  private sunMat!: THREE.MeshBasicMaterial;
  private water!: THREE.Mesh;
  private waterMat!: THREE.MeshLambertMaterial;
  private domes: THREE.Mesh[] = []; // 0 intact, 1 cracked (top blown), 2 breached (side hole)
  private roofs: THREE.Mesh[] = []; // 0 intact, 1 torn
  private steam!: Puffs;
  private smoke!: Puffs;
  private fire!: Puffs;
  private fireLight = new THREE.PointLight(0xff7a2a, 0, 0, 2);
  private nightLights!: THREE.Points;
  private nightMat!: THREE.PointsMaterial;
  private ems!: THREE.InstancedMesh;
  private emsLights!: THREE.Points;
  private emsCol!: Float32Array;
  private rubble!: THREE.InstancedMesh;
  private beacons!: THREE.Points;
  private beaconMat!: THREE.PointsMaterial;
  private lastHour = -99;
  private lastKind: string | null = 'init';
  private emitAcc = new Float32Array(8);
  private catT = 0; // seconds since the catastrophe was first seen
  private wind = new THREE.Vector3(1, 0, 0);
  private _c1 = new THREE.Color();
  private _c2 = new THREE.Color();
  private _v = new THREE.Vector3();
  private heightPx = 540;

  constructor() {
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0xb9d4ea);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.fireLight);
    this.fireLight.position.set(118, 46, 6);
    this.buildSky();
    this.buildTerrain();
    this.buildPlant();
    this.buildTrees();
    this.buildLines();
    this.buildCars();
    this.buildDynamic();
    this.scene.traverse((o) => {
      if (o !== this.camera) o.matrixAutoUpdate = false;
      o.updateMatrix();
    });
    this.scene.updateMatrixWorld(true);
  }

  /* ================================================================ */
  private buildSky() {
    const g = new THREE.SphereGeometry(2400, 32, 16);
    const n = g.getAttribute('position').count;
    this.skyCols = new Float32Array(n * 3);
    this.skyY = new Float32Array(n);
    for (let i = 0; i < n; i++) this.skyY[i] = g.getAttribute('position').getY(i) / 2400;
    g.setAttribute('color', new THREE.BufferAttribute(this.skyCols, 3));
    this.sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.sunMat = new THREE.MeshBasicMaterial({ color: 0xfff4d8, fog: false, toneMapped: false });
    this.sunDisk = new THREE.Mesh(new THREE.SphereGeometry(40, 16, 8), this.sunMat);
    this.sunDisk.renderOrder = -9;
    this.scene.add(this.sunDisk);
  }

  private buildTerrain() {
    const S = 4200;
    const N = 140;
    const g = new THREE.PlaneGeometry(S, S, N, N);
    g.rotateX(-Math.PI / 2);
    g.deleteAttribute('uv');
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(p.count * 3);
    const c = new THREE.Color();
    const grass = new THREE.Color(0x5d7f3e);
    const grass2 = new THREE.Color(0x748f45);
    const forest = new THREE.Color(0x3d5a2e);
    const sand = new THREE.Color(0xb6a67c);
    const pad = new THREE.Color(0xa29f93);
    const mowed = new THREE.Color(0x7d9a4c);
    for (let i = 0; i < p.count; i++) {
      // denser near the plant: warp the grid toward the centre
      let x = p.getX(i);
      let z = p.getZ(i);
      const r = Math.hypot(x, z);
      const k = r > 1 ? Math.pow(r / (S / 2), 1.6) * (S / 2) / r : 1;
      x *= k;
      z *= k;
      const h = height(x, z);
      p.setXYZ(i, x, h, z);
      const m = siteMask(x, z);
      const n = 0.5 + 0.5 * Math.sin(x * 0.013) * Math.cos(z * 0.017);
      c.copy(grass).lerp(grass2, n).lerp(forest, smoothstep(10, 30, h) * 0.6);
      const sz = shoreZ(x);
      c.lerp(sand, smoothstep(sz - 45, sz - 10, z) * (1 - smoothstep(sz + 20, sz + 40, z)));
      // mowed grass inside the site, concrete/gravel only around the power block
      c.lerp(mowed, smoothstep(0.6, 0.95, m) * 0.7);
      const core = Math.max(Math.abs(x - 40) / 190, Math.abs(z - 5) / 105);
      c.lerp(pad, 1 - smoothstep(0.85, 1.0, core));
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const t = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    t.name = 'terrain';
    this.scene.add(t);
    // lake
    const wg = new THREE.PlaneGeometry(4200, 2200);
    wg.rotateX(-Math.PI / 2);
    wg.translate(0, -1.2, 1300);
    this.waterMat = new THREE.MeshLambertMaterial({ color: 0x3e6f8e });
    this.water = new THREE.Mesh(wg, this.waterMat);
    this.scene.add(this.water);
  }

  private buildPlant() {
    const B = new GeoBucket();
    const add = (g: THREE.BufferGeometry, m: THREE.Matrix4 | null, c: number) => B.add(g, m, c, { ao: false });
    const bx = (w: number, h: number, d: number, x: number, z: number, c: number, y0 = 0, ry = 0) => add(box(w, h, d), M(x, y0 + h / 2, z, ry), c);
    const CONC = 0xd6d1c6;
    const STEEL = 0x8b939a;

    // roads, pads, parking
    bx(560, 0.3, 14, 20, 130, 0x3d3f42, -0.1); // site road (east-west)
    bx(14, 0.3, 330, -100, -30, 0x3d3f42, -0.1);
    bx(380, 0.3, 12, 60, -90, 0x3d3f42, -0.1);
    bx(12, 0.3, 230, 215, 15, 0x3d3f42, -0.1);
    bx(95, 0.3, 80, -160, 130, 0x2e3033, -0.08); // parking lot
    for (let i = 0; i < 18; i++) for (const zr of [104, 156]) bx(0.25, 0.32, 5.5, -202 + i * 5, zr, 0xe8e8e0, -0.08);
    for (let i = 0; i < 18; i++) bx(0.25, 0.32, 5.5, -202 + i * 5, 130, 0xe8e8e0, -0.08);
    // access road out to the west, following the ground
    {
      const pos: number[] = [];
      for (let x = -1800; x < -240; x += 20) {
        const x2 = x + 20;
        const a = [x, height(x, 124) + 0.4, 124];
        const b = [x, height(x, 136) + 0.4, 136];
        const c2 = [x2, height(x2, 124) + 0.4, 124];
        const d = [x2, height(x2, 136) + 0.4, 136];
        pos.push(...a, ...b, ...c2, ...c2, ...b, ...d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      add(g, null, 0x3d3f42);
    }

    // containment cylinder (+ buttresses, ring, equipment hatch) — the dome is a separate mesh
    add(cyl(21, 21, 46, 56), M(0, 23, 0), CONC);
    add(cyl(21.4, 21.4, 1.2, 56), M(0, 45.6, 0), 0xc4bfb3);
    for (let k = 0; k < 3; k++) {
      const a = (k * 120 + 30) * DEG;
      add(box(3.2, 46, 2.2), M(Math.sin(a) * 21.3, 23, Math.cos(a) * 21.3, a), 0xcdc8bc);
    }
    add(cyl(4.2, 4.2, 1.2, 24), M(0, 9, 21.2, 0, Math.PI / 2), 0x8a8a84);
    // main steam valve house between containment and turbine hall
    bx(18, 28, 26, 32, 0, 0xc9c0ab);
    add(box(4, 3, 4), M(30, 29.5, 4), STEEL); // relief valve vent stacks
    add(cyl(0.9, 0.9, 6, 10), M(34, 31, -5), STEEL);
    add(cyl(0.9, 0.9, 6, 10), M(34, 31, 5), STEEL);
    // auxiliary building + HVAC + vent stack
    bx(60, 30, 52, -52, 0, 0xcfc6b2);
    bx(61, 1.5, 53, -52, 0, 0xb9b09c, 30);
    for (let i = 0; i < 4; i++) bx(6, 3, 5, -72 + i * 13, -12, 0x9aa0a4, 31.5);
    add(cyl(2.0, 2.4, 78, 16), M(-74, 39, -30), 0xd8d8d2);
    add(cyl(2.05, 2.05, 5, 16), M(-74, 72, -30), 0xc0392b);
    add(cyl(2.05, 2.05, 5, 16), M(-74, 62, -30), 0xc0392b);
    add(cyl(3.2, 3.2, 0.6, 16), M(-74, 75, -30), STEEL);
    // fuel handling building
    bx(36, 26, 30, -24, 42, 0xc9c0ab);
    // turbine hall walls (roof is separate), heater bay, window band
    bx(125, 36, 48, 112, 0, 0x8fa1b0);
    bx(126, 3, 48.6, 112, 0, 0x54606a, 26);
    bx(125, 20, 12, 112, -30, 0x9aa9b6);
    bx(126, 1, 12.4, 112, -30, 0x6e7378, 20);
    // main transformers + radiators beside the turbine hall
    for (let i = 0; i < 3; i++) {
      bx(9, 8, 7, 92 + i * 16, -48, 0x50565b);
      bx(9.5, 6, 2, 92 + i * 16, -52.5, 0x62686d);
      add(cyl(0.5, 0.5, 5, 8), M(90 + i * 16, 10, -46), 0x8b5a2b);
    }
    // condensate storage tank, refueling water storage tank, diesel generator building
    add(cyl(9, 9, 14, 28), M(60, 7, -62), 0xdedad2);
    add(cyl(10, 10, 16, 28), M(-18, 8, -92), 0xdedad2);
    bx(42, 11, 16, -20, -60, 0xbcb3a0);
    for (const x of [-32, -8]) add(cyl(0.8, 0.8, 8, 10), M(x, 15, -60), 0x4a4a48);
    // admin building, warehouse, security building at the gate
    bx(52, 18, 30, -160, 55, 0xc8c3b8);
    for (let k = 0; k < 4; k++) bx(52.4, 1.6, 30.4, -160, 55, 0x3e4a56, 3 + k * 4);
    bx(46, 14, 36, -190, -70, 0xb5a98e);
    bx(12, 5, 9, -250, 112, 0xc8c3b8);
    // intake structure on the lake shore + discharge canal with a warm-water outfall
    const sz = shoreZ(60);
    bx(44, 8, 22, 60, sz - 12, 0xbdb7a8, -1);
    for (let i = 0; i < 4; i++) add(cyl(1.6, 1.6, 4, 12), M(46 + i * 9, 9, sz - 14), 0x2f5a8a);
    const szd = shoreZ(160);
    bx(18, 0.4, szd - 30, 160, (30 + szd) / 2, 0xa8a49a, -0.2);
    bx(14, 0.3, szd - 30, 160, (30 + szd) / 2, 0x4c7f94, 0.05);
    {
      const disk = new THREE.CircleGeometry(38, 24).toNonIndexed();
      disk.deleteAttribute('uv');
      disk.rotateX(-Math.PI / 2);
      add(disk, M(160, -1.05, szd + 25), 0x6d9db0);
    }
    // switchyard: gravel pad, gantries, breakers
    bx(130, 0.4, 100, 235, -165, 0xa49e92, -0.1);
    for (let i = 0; i < 6; i++) {
      const x = 185 + i * 20;
      for (const z of [-205, -125]) {
        beam(B, new THREE.Vector3(x - 6, 0, z), new THREE.Vector3(x - 6, 18, z), 0.7, STEEL);
        beam(B, new THREE.Vector3(x + 6, 0, z), new THREE.Vector3(x + 6, 18, z), 0.7, STEEL);
        beam(B, new THREE.Vector3(x - 6, 18, z), new THREE.Vector3(x + 6, 18, z), 0.7, STEEL);
      }
      for (let j = 0; j < 4; j++) bx(2.2, 4, 2.2, x, -185 + j * 14, 0x6c7378);
    }
    // perimeter fence posts (wires are in the line mesh)
    const fence = this.fencePath();
    for (let i = 0; i < fence.length; i++) {
      const a = fence[i];
      const b = fence[(i + 1) % fence.length];
      const n = Math.ceil(a.distanceTo(b) / 12);
      for (let k = 0; k < n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n;
        const z = a.y + ((b.y - a.y) * k) / n;
        add(box(0.3, 3.2, 0.3), M(x, 1.6, z), 0x8a8f92);
      }
    }
    // transmission towers
    for (const t of this.towers()) this.tower(B, t.p, t.ry);

    const plant = B.build(new THREE.MeshLambertMaterial({ vertexColors: true }));
    plant.name = 'site-static';
    this.scene.add(plant);

    // dome variants
    const domeMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.domes.push(new THREE.Mesh(this.dome(null, 0), domeMat));
    this.domes.push(new THREE.Mesh(this.dome(new THREE.Vector3(0.12, 1, 0.08).normalize(), 0.36, 0.55), domeMat));
    this.domes.push(new THREE.Mesh(this.dome(BREACH, 0.62, 0.8, true), domeMat));
    this.domes.forEach((d, i) => {
      d.visible = i === 0;
      this.scene.add(d);
    });
    // turbine hall roof variants
    const roofMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    for (const torn of [false, true]) {
      const R = new GeoBucket();
      const ra = (g: THREE.BufferGeometry, m: THREE.Matrix4, c: number) => R.add(g, m, c, { ao: false });
      if (!torn) ra(box(126, 1.4, 49), M(112, 36.7, 0), 0x6e7378);
      else {
        // roof with a ragged hole over the turbine deck, bent panels
        const x0 = 49.5;
        const x1 = 174.5;
        const hx0 = 98;
        const hx1 = 132;
        ra(box(hx0 - x0, 1.4, 49), M((x0 + hx0) / 2, 36.7, 0), 0x6e7378);
        ra(box(x1 - hx1, 1.4, 49), M((x1 + hx1) / 2, 36.7, 0), 0x6e7378);
        ra(box(hx1 - hx0, 1.4, 14), M((hx0 + hx1) / 2, 36.7, -17.5), 0x6e7378);
        for (let k = 0; k < 7; k++) {
          const x = hx0 + 3 + k * 4.6;
          ra(box(4.2, 0.5, 9), M(x, 39 + (k % 3) * 1.8, -6 + (k % 2) * 4, 0.3 * (k - 3), 0.5 + 0.25 * (k % 3), 0.2 * (k % 2 ? 1 : -1)), k % 2 ? 0x3c3f42 : 0x585c60);
        }
        // scorched wall streaks
        for (let k = 0; k < 5; k++) ra(box(6, 14, 0.4), M(hx0 + 4 + k * 7, 29, 24.3), 0x2a2622);
      }
      // roof ventilators (steam wisp emitters in normal operation)
      for (let k = 0; k < 4; k++) if (!torn || k === 0 || k === 3) ra(box(4, 3, 4), M(60 + k * 34, 38.9, 6), 0x9aa0a4);
      const mesh = R.build(roofMat);
      mesh.visible = !torn;
      this.roofs.push(mesh);
      this.scene.add(mesh);
    }
  }

  private fencePath(): THREE.Vector2[] {
    return [new THREE.Vector2(-262, -232), new THREE.Vector2(318, -232), new THREE.Vector2(318, 292), new THREE.Vector2(-262, 292)];
  }

  private towers(): { p: THREE.Vector3; ry: number }[] {
    const out: { p: THREE.Vector3; ry: number }[] = [];
    for (let i = 0; i < 9; i++) {
      const x = 230 + i * 12;
      const z = -260 - i * 150;
      out.push({ p: new THREE.Vector3(x, height(x, z), z), ry: 0 });
    }
    for (let i = 0; i < 9; i++) {
      const x = 360 + i * 160;
      const z = -150 - i * 18;
      out.push({ p: new THREE.Vector3(x, height(x, z), z), ry: Math.PI / 2 });
    }
    return out;
  }

  /** lattice transmission tower; ry = 0: the line runs along z */
  private tower(B: GeoBucket, base: THREE.Vector3, ry: number) {
    const C = 0x9aa1a6;
    const H = 46;
    const rot = new THREE.Matrix4().makeRotationY(ry).setPosition(base);
    const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(rot);
    const w0 = 4.5;
    const w1 = 1.2;
    const at = (y: number) => w0 + (w1 - w0) * (y / H);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) beam(B, P(sx * w0, 0, sz * w0), P(sx * w1, H, sz * w1), 0.45, C);
    for (const y0 of [0, 12, 24, 34]) {
      const y1 = Math.min(H, y0 + (y0 < 24 ? 12 : 10));
      const a0 = at(y0);
      const a1 = at(y1);
      for (const s of [-1, 1]) {
        beam(B, P(-a0, y0, s * a0), P(a1, y1, s * a1), 0.25, C);
        beam(B, P(s * a0, y0, -a0), P(s * a1, y1, a1), 0.25, C);
      }
    }
    for (const y of [30, 38]) beam(B, P(-10, y, 0), P(10, y, 0), 0.6, C);
    beam(B, P(0, H, 0), P(0, H + 3, 0), 0.4, C);
  }

  private buildTrees() {
    const pts: THREE.Vector3[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let tries = 0; tries < 9000 && pts.length < 800; tries++) {
      const a = rnd() * Math.PI * 2;
      const r = 280 + Math.pow(rnd(), 0.9) * 1500;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      if (siteMask(x, z) > 0.6 || (Math.abs(x - 28) < 305 && Math.abs(z - 30) < 275)) continue;
      if (z > shoreZ(x) - 50) continue;
      if (x < -200 && Math.abs(z - 130) < 30) continue;
      if (Math.abs(x - 270) < 40 && z < -200) continue; // line corridors
      if (Math.abs(z + 160) < 45 && x > 300) continue;
      // clumps
      if (Math.sin(x * 0.01) * Math.cos(z * 0.012) < -0.25) continue;
      pts.push(new THREE.Vector3(x, height(x, z), z));
    }
    const fol = new THREE.ConeGeometry(5, 15, 7);
    fol.translate(0, 11, 0);
    const trunk = new THREE.CylinderGeometry(0.7, 0.9, 5, 6);
    trunk.translate(0, 2.5, 0);
    const fm = new THREE.InstancedMesh(fol, new THREE.MeshLambertMaterial({ color: 0xffffff }), pts.length);
    const tm = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: 0x5a4430 }), pts.length);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    pts.forEach((p, i) => {
      const s = 0.7 + rnd() * 0.8;
      m.makeScale(s, s * (0.8 + rnd() * 0.5), s).setPosition(p);
      fm.setMatrixAt(i, m);
      tm.setMatrixAt(i, m);
      c.setHSL(0.26 + rnd() * 0.07, 0.35 + rnd() * 0.2, 0.2 + rnd() * 0.1);
      fm.setColorAt(i, c);
    });
    fm.computeBoundingSphere();
    tm.computeBoundingSphere();
    this.scene.add(fm, tm);
  }

  private buildLines() {
    const pos: number[] = [];
    const col: number[] = [];
    const seg = (a: THREE.Vector3, b: THREE.Vector3, sag: number, c: number) => {
      const cc = new THREE.Color(c);
      const n = 10;
      let px = a.x;
      let py = a.y;
      let pz = a.z;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const y = a.y + (b.y - a.y) * t - 4 * sag * t * (1 - t);
        pos.push(px, py, pz, x, y, z);
        col.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
        px = x;
        py = y;
        pz = z;
      }
    };
    const t = this.towers();
    const arms = (tw: { p: THREE.Vector3; ry: number }) => {
      const out: THREE.Vector3[] = [];
      for (const [x, y] of [[-9.5, 30], [9.5, 30], [-9.5, 38], [9.5, 38], [0, 49]] as const)
        out.push(new THREE.Vector3(x, y - 1.5, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), tw.ry).add(tw.p));
      return out;
    };
    const lineSets = [t.slice(0, 9), t.slice(9)];
    const gantries = [new THREE.Vector3(235, 17, -205), new THREE.Vector3(290, 17, -165)];
    lineSets.forEach((set, li) => {
      const A0 = arms(set[0]);
      for (let k = 0; k < 5; k++) seg(gantries[li].clone().add(new THREE.Vector3((k - 2) * 3, k === 4 ? 2 : 0, 0)), A0[k], 3, 0x2a2c2e);
      for (let i = 0; i + 1 < set.length; i++) {
        const a = arms(set[i]);
        const b = arms(set[i + 1]);
        for (let k = 0; k < 5; k++) seg(a[k], b[k], k === 4 ? 4 : 7, 0x2a2c2e);
      }
    });
    // transformers → switchyard
    for (let i = 0; i < 3; i++) seg(new THREE.Vector3(92 + i * 16, 11, -48), new THREE.Vector3(185, 17, -125 + i * 3), 5, 0x2a2c2e);
    // fence wires
    const f = this.fencePath();
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      for (const y of [1.2, 2.4, 3.1]) seg(new THREE.Vector3(a.x, y, a.y), new THREE.Vector3(b.x, y, b.y), 0, 0x6e7275);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    lines.name = 'wires';
    this.scene.add(lines);
  }

  private buildCars() {
    const car = new GeoBucket();
    car.add(box(4.4, 1.0, 1.9), M(0, 0.75, 0), 0xffffff, { ao: false });
    car.add(box(2.4, 0.75, 1.7), M(-0.2, 1.6, 0), 0xcfd6dc, { ao: false });
    const geo = car.build(new THREE.MeshBasicMaterial()).geometry;
    const n = 64;
    const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), n);
    const palette = [0xb8bcc0, 0x2a2d33, 0x8a1e1e, 0xe8e8e4, 0x1e3a6a, 0x5a5f63, 0x7a6a4a];
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const mm = new THREE.Matrix4();
    const c = new THREE.Color();
    let k = 0;
    for (const zr of [111, 149]) {
      for (let i = 0; i < 18 && k < n; i++) {
        if (rnd() < 0.15) continue;
        mm.makeRotationY(Math.PI / 2 + (rnd() - 0.5) * 0.06).setPosition(-200 + i * 5, 0, zr + (rnd() - 0.5) * 0.5);
        m.setMatrixAt(k, mm);
        m.setColorAt(k, c.set(palette[Math.floor(rnd() * palette.length)]));
        k++;
      }
    }
    m.count = k;
    m.computeBoundingSphere();
    this.scene.add(m);
  }

  private buildDynamic() {
    const tex = softDot();
    this.steam = new Puffs(900, tex, 0xf5f7f9, 0xb9c0c6, false, 2.0);
    this.smoke = new Puffs(700, tex, 0x5d554c, 0x2a2521, false, 3.0);
    this.fire = new Puffs(240, tex, 0xffd27a, 0xff3d0c, true, 6.0);
    this.scene.add(this.steam.points, this.smoke.points, this.fire.points);
    // building / security lights at night
    {
      const pos: number[] = [];
      const col: number[] = [];
      const L = (x: number, y: number, z: number, c = 0xffd9a0) => {
        const cc = new THREE.Color(c);
        pos.push(x, y, z);
        col.push(cc.r, cc.g, cc.b);
      };
      const f = this.fencePath();
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = f[(i + 1) % f.length];
        const n = Math.ceil(a.distanceTo(b) / 45);
        for (let k = 0; k < n; k++) L(a.x + ((b.x - a.x) * k) / n, 6, a.y + ((b.y - a.y) * k) / n, 0xfff0d0);
      }
      for (let i = 0; i < 6; i++) L(-200 + i * 18, 8, 130);
      for (let i = 0; i < 12; i++) L(52 + i * 10, 30, 24.6, 0xe8f0ff);
      for (let i = 0; i < 6; i++) L(-80 + i * 10, 24, 26.4);
      for (let i = 0; i < 8; i++) L(-182 + i * 6, 10, 70.4, 0xfff8e0);
      for (const [x, z] of [[-24, 57], [32, 13], [-52, 26], [112, -36], [60, -71], [235, -165]]) L(x, 12, z);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      this.nightMat = new THREE.PointsMaterial({ size: 5, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false });
      this.nightLights = new THREE.Points(g, this.nightMat);
      this.nightLights.frustumCulled = false;
      this.scene.add(this.nightLights);
    }
    // aircraft warning lights (stack + dome)
    {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-74, 79, -30, 0, 68.5, 0], 3));
      this.beaconMat = new THREE.PointsMaterial({ color: 0xff2a1a, size: 6, map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      this.beacons = new THREE.Points(g, this.beaconMat);
      this.beacons.frustumCulled = false;
      this.scene.add(this.beacons);
    }
    // emergency vehicles + flashing lights
    {
      const vb = new GeoBucket();
      vb.add(box(8, 3, 2.6), M(0, 1.8, 0), 0xffffff, { ao: false });
      vb.add(box(2.4, 2.4, 2.5), M(4.6, 1.5, 0), 0xffffff, { ao: false });
      const geo = vb.build(new THREE.MeshBasicMaterial()).geometry;
      const spots: [number, number, number, number][] = [
        [-30, 80, 0.3, 0xb41e1e],
        [-12, 84, 0.1, 0xb41e1e],
        [8, 78, -0.2, 0xeeeeee],
        [70, 60, 1.4, 0xb41e1e],
        [88, 64, 1.6, 0xeeeeee],
        [-100, 100, 0, 0x1e2e5a],
        [-108, 112, 0.2, 0x1e2e5a],
        [-100, 124, 1.57, 0xb41e1e],
        [140, 40, 0.9, 0xb41e1e],
        [-60, -95, 0.4, 0xeeeeee],
        [-230, 130, 0, 0x1e2e5a],
        [-245, 136, 0.1, 0x1e2e5a],
      ];
      this.ems = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), spots.length);
      const mm = new THREE.Matrix4();
      const c = new THREE.Color();
      const lp: number[] = [];
      spots.forEach(([x, z, ry, col], i) => {
        mm.makeRotationY(ry).setPosition(x, 0, z);
        this.ems.setMatrixAt(i, mm);
        this.ems.setColorAt(i, c.set(col));
        for (const s of [-1, 1]) {
          const v = new THREE.Vector3(2.6, 3.6, s * 0.9).applyMatrix4(mm);
          lp.push(v.x, v.y, v.z);
        }
      });
      this.ems.computeBoundingSphere();
      this.ems.visible = false;
      this.scene.add(this.ems);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      this.emsCol = new Float32Array(lp.length);
      g.setAttribute('color', new THREE.BufferAttribute(this.emsCol, 3).setUsage(THREE.DynamicDrawUsage));
      this.emsLights = new THREE.Points(g, new THREE.PointsMaterial({ size: 7, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      this.emsLights.frustumCulled = false;
      this.emsLights.visible = false;
      this.scene.add(this.emsLights);
    }
    // rubble (placed when a catastrophe kind is first seen)
    this.rubble = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1.6, 0), new THREE.MeshLambertMaterial({ color: 0x7a746a }), 90);
    this.rubble.visible = false;
    this.scene.add(this.rubble);
  }

  /**
   * Containment dome (hemisphere on the cylinder) with an optional jagged hole + soot.
   * Built as outer + inner shell so the wall has thickness where it is broken.
   */
  private dome(hole: THREE.Vector3 | null, ang: number, soot = 0, crackWall = false): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const base = new THREE.Color(0xd9d5cc);
    const black = new THREE.Color(0x24201c);
    const inner = new THREE.Color(0x5a544c);
    const c = new THREE.Color();
    const n = new THREE.Vector3();
    for (const [r, isIn] of [[21.2, false], [19.9, true]] as const) {
      const g = new THREE.SphereGeometry(r, 56, 20, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
      g.deleteAttribute('uv');
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      const keep: number[] = [];
      const col: number[] = [];
      const nor = g.getAttribute('normal') as THREE.BufferAttribute;
      const nk: number[] = [];
      for (let t = 0; t < p.count; t += 3) {
        n.set(0, 0, 0);
        for (let k = 0; k < 3; k++) n.x += p.getX(t + k) / 3, n.y += p.getY(t + k) / 3, n.z += p.getZ(t + k) / 3;
        n.normalize();
        let a = 0;
        if (hole) {
          a = Math.acos(Math.max(-1, Math.min(1, n.dot(hole))));
          const az = Math.atan2(n.x, n.z);
          const jag = 0.07 * Math.sin(az * 9 + 1) + 0.05 * Math.sin(n.y * 23) + 0.04 * Math.sin(az * 23);
          if (a < ang + jag) continue;
        }
        for (let k = 0; k < 3; k++) {
          const i = t + k;
          keep.push(p.getX(i), p.getY(i) + 46, p.getZ(i));
          nk.push(nor.getX(i), nor.getY(i), nor.getZ(i));
          if (isIn) c.copy(inner);
          else {
            c.copy(base);
            if (hole) {
              const s = (1 - smoothstep(ang, ang + 0.75, a)) * soot;
              // radial cracks
              const az = Math.atan2(n.x, n.z);
              const crack = Math.pow(Math.abs(Math.sin(az * 5 + Math.sin(n.y * 9) * 0.6)), 40) * (1 - smoothstep(ang, ang + 1.1, a)) * soot;
              c.lerp(black, Math.min(1, s + crack));
            }
          }
          col.push(c.r, c.g, c.b);
        }
      }
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
      out.setAttribute('normal', new THREE.Float32BufferAttribute(nk, 3));
      out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      parts.push(out);
      if (!hole) break; // intact dome: no inner shell needed
    }
    if (crackWall) {
      // scorched cracks running down the cylinder under the breach
      const B = new GeoBucket();
      const dir = Math.atan2(hole!.x, hole!.z);
      for (let k = 0; k < 6; k++) {
        const a = dir + (k - 2.5) * 0.09;
        B.add(box(0.8, 10 + (k % 3) * 7, 0.5), M(Math.sin(a) * 21.15, 40 - (k % 3) * 4, Math.cos(a) * 21.15, a, 0, (k - 2.5) * 0.12), 0x2a2622, { ao: false });
      }
      B.add(box(16, 9, 0.6), M(Math.sin(dir) * 21.0, 44, Math.cos(dir) * 21.0, dir), 0x1c1a18, { ao: false });
      const m = B.build(new THREE.MeshBasicMaterial());
      parts.push(m.geometry);
    }
    const merged = mergeSimple(parts);
    merged.computeBoundingSphere();
    return merged;
  }

  /* ================================================================ */
  setEnabled(_on: boolean) {
    void _on;
  }
  resize(aspect: number, heightPx: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.heightPx = heightPx;
  }

  update(dt: number, s: PlantState | undefined) {
    this.time += dt;
    const t = this.time;
    const cat = s?.catastrophe?.kind ?? null;
    const rel = s?.release;

    /* ---- time of day ---- */
    const hour = s?.grid?.hourOfDay ?? (7 + (s?.t ?? 0) / 3600) % 24;
    if (Math.abs(hour - this.lastHour) > 0.02) {
      this.lastHour = hour;
      this.applyTimeOfDay(hour);
    }

    /* ---- wind ---- */
    const wFrom = (rel?.windFromDeg ?? 235) * DEG;
    const wSpd = Math.max(0.5, rel?.windSpeedMps ?? 4);
    this.wind.set(-Math.sin(wFrom) * wSpd, 0, Math.cos(wFrom) * wSpd);

    /* ---- catastrophe kind → damaged geometry, rubble, vehicles ---- */
    if (cat !== this.lastKind) {
      this.lastKind = cat;
      this.catT = 0;
      const domeIdx = cat === 'steam-explosion' || cat === 'vessel-rupture' ? 1 : cat === 'containment-failure' ? 2 : 0;
      this.domes.forEach((d, i) => (d.visible = i === domeIdx));
      const torn = cat === 'turbine-missile';
      this.roofs[0].visible = !torn;
      this.roofs[1].visible = torn;
      this.placeRubble(cat);
      // the helicopter arrives after the event: let the plumes develop first
      for (let i = 0; i < (cat ? 160 : 60); i++) {
        if (cat) this.catT += 0.25;
        this.particles(0.25, s);
      }
    }
    if (cat) this.catT += dt;
    const damaged = !!cat || (s?.coreStatus ?? 'ok') !== 'ok';
    const emergency = damaged || (rel && rel.emergencyClass !== 'none' && rel.emergencyClass !== 'unusual-event') || false;
    this.ems.visible = emergency;
    this.emsLights.visible = emergency;
    if (emergency) {
      const n = this.emsCol.length / 3;
      for (let i = 0; i < n; i++) {
        // left lamp red, right lamp blue, alternating
        const on = Math.sin(t * 9 + (i >> 1) * 1.7 + (i & 1) * Math.PI) > 0.2 ? 1 : 0.04;
        const blue = (i & 1) === 1;
        this.emsCol[i * 3] = (blue ? 0.15 : 1) * on;
        this.emsCol[i * 3 + 1] = (blue ? 0.3 : 0.1) * on;
        this.emsCol[i * 3 + 2] = (blue ? 1 : 0.08) * on;
      }
      this.emsLights.geometry.attributes.color.needsUpdate = true;
    }
    this.beaconMat.opacity = Math.sin(t * 3.2) > 0.3 ? 1 : 0.08;

    this.particles(dt, s);
    const scale = this.heightPx / (2 * Math.tan((this.camera.fov * DEG) / 2));
    this.steam.mat.uniforms.uScale.value = scale;
    this.smoke.mat.uniforms.uScale.value = scale;
    this.fire.mat.uniforms.uScale.value = scale;
    // haze thickens with a big release
    this.fog.density = 0.00042 + (cat ? 0.0001 : 0) + 0.00012 * (rel ? clamp01(Math.log10(1 + Math.max(0, rel.rateCiPerS)) / 5) : 0);

    /* ---- helicopter camera: slow orbit, handheld noise ---- */
    this.orbit += dt * 0.011;
    const R = 430 + 35 * Math.sin(t * 0.05);
    const alt = 140 + 12 * Math.sin(t * 0.037);
    const cx = 35;
    const cz = 10;
    this.camera.position.set(cx + Math.sin(this.orbit) * R, alt, cz + Math.cos(this.orbit) * R);
    const n1 = Math.sin(t * 0.9) * 0.6 + Math.sin(t * 2.3 + 1) * 0.25 + Math.sin(t * 5.1) * 0.08;
    const n2 = Math.sin(t * 0.7 + 2) * 0.5 + Math.sin(t * 1.9) * 0.3 + Math.sin(t * 4.7 + 3) * 0.08;
    this.camera.position.x += n1;
    this.camera.position.y += n2 * 0.6;
    this._v.set(cx + n2 * 2.2, 22 + (cat ? 14 : 0) + n1 * 1.5, cz + n1 * 2.2);
    this.camera.lookAt(this._v);
    this.camera.rotateZ(Math.sin(t * 0.4) * 0.01 + n1 * 0.002);
    this.camera.updateMatrixWorld();
    this.sky.position.copy(this.camera.position);
    this.sky.updateMatrix();
    this.sky.updateMatrixWorld();
    this.sunDisk.position.copy(this.sun.position).normalize().multiplyScalar(2000).add(this.camera.position);
    this.sunDisk.updateMatrix();
    this.sunDisk.updateMatrixWorld();
  }

  /** emitters + particle integration (also used to pre-warm plumes) */
  private particles(dt: number, s: PlantState | undefined) {
    const cat = s?.catastrophe?.kind ?? null;
    const rel = s?.release;
    const relDensity = rel ? clamp01(Math.log10(1 + Math.max(0, rel.rateCiPerS)) / 5) : 0;
    const running = !!s && !s.reactorTripped && (s.neutronPower ?? 0) > 0.02;
    const tripped = !!s?.reactorTripped && !cat;
    const W = this.wind;
    // normal operation: small wisps from the turbine hall roof ventilators
    if (!cat) this.emit(0, running ? 1.6 : 0.5, dt, (k) => {
      const x = 60 + (k % 4) * 34;
      this.steam.emit(x + rnd(1), 41, 6 + rnd(1), W.x * 0.3, 2.5, W.z * 0.3, 12, 4, 18, 0.32);
    });
    // after a trip: relief-valve steam from the main steam valve house
    if (tripped && (s?.t ?? 0) > 0) this.emit(1, 5, dt, () => this.steam.emit(32 + rnd(3), 33, rnd(5), W.x * 0.3, 9 + rnd(3), W.z * 0.3, 14, 5, 26, 0.5));
    // radioactive release through the plant vent stack (leaks / filtered vents / meltdown)
    const ventRel = rel && (rel.pathway === 'vent' || rel.pathway === 'containment-leak' || rel.pathway === 'direct') ? relDensity : 0;
    const melt = cat === 'meltdown' ? 1 : 0;
    const ventAmt = Math.max(ventRel, melt * Math.max(0.55, relDensity));
    if (ventAmt > 0.02) {
      this.emit(2, 10 * ventAmt, dt, () => this.steam.emit(-74 + rnd(1), 79, -30 + rnd(1), W.x * 0.5, 6, W.z * 0.5, 35, 6, 60, 0.35 + 0.35 * ventAmt));
      if (melt) {
        this.emit(3, 5 * ventAmt, dt, () => this.smoke.emit(-74 + rnd(1), 80, -30 + rnd(1), W.x * 0.5, 5, W.z * 0.5, 40, 6, 55, 0.3 + 0.3 * ventAmt));
        // containment purge vents on the auxiliary building roof
        this.emit(4, 4, dt, () => this.steam.emit(-60 + rnd(8), 33, -10 + rnd(8), W.x * 0.4, 4, W.z * 0.4, 20, 5, 30, 0.35));
      }
    }
    // steam explosion / vessel rupture: huge initial burst, then a sustained white plume from the blown dome top
    if (cat === 'steam-explosion' || cat === 'vessel-rupture') {
      const burst = Math.max(0, 1 - this.catT / 12);
      const amt = Math.max(0.45, relDensity);
      this.emit(5, 14 * amt + 60 * burst, dt, () =>
        this.steam.emit(rnd(9), 64 + rnd(3), rnd(9), W.x * 0.4 + rnd(4) * burst, 12 + 25 * burst + rnd(4), W.z * 0.4 + rnd(4) * burst, 45, 10 + 15 * burst, 85 + 40 * burst, 0.55 + 0.3 * burst),
      );
      this.emit(6, 3 * amt, dt, () => this.smoke.emit(rnd(6), 62, rnd(6), W.x * 0.4, 8, W.z * 0.4, 40, 8, 60, 0.35));
    }
    // containment failure: dark smoke + steam pouring out of the breach, drifting with the wind
    if (cat === 'containment-failure') {
      const amt = Math.max(0.7, relDensity);
      const hx = BREACH.x * 21;
      const hz = BREACH.z * 21;
      // the darker the plume, the bigger the release: a small release is mostly steam with a grey core
      const sa = 0.3 + 0.14 * relDensity;
      this.emit(5, 18 * amt * (0.35 + 0.65 * relDensity), dt, () => this.smoke.emit(hx + rnd(5), 58 + rnd(4), hz + rnd(5), W.x * 0.4 + BREACH.x * 4 + rnd(2), 9 + rnd(3), W.z * 0.4 + rnd(2), 55, 10, 90, sa));
      this.emit(6, 10 * amt + 8 * (1 - relDensity), dt, () => this.steam.emit(hx + rnd(5), 60 + rnd(4), hz + rnd(5), W.x * 0.4, 10 + rnd(3), W.z * 0.4 + BREACH.z * 3, 40, 10, 80, 0.45));
    }
    // turbine missile: fire in the turbine hall, black smoke through the torn roof
    let fireAmt = 0;
    if (cat === 'turbine-missile') {
      fireAmt = Math.max(0.35, 1 - this.catT / 600);
      this.emit(5, 40 * fireAmt, dt, () => this.fire.emit(104 + rnd(13), 37 + rnd(2), 5 + rnd(7), rnd(1.5), 8 + rnd(3), rnd(1.5), 1.6 + Math.random(), 7, 3, 0.9));
      this.emit(6, 14 * fireAmt, dt, () => this.smoke.emit(104 + rnd(12), 42, 5 + rnd(6), W.x * 0.4, 9, W.z * 0.4, 50, 8, 75, 0.45));
      this.emit(7, 4, dt, () => this.steam.emit(100 + rnd(15), 40, 5 + rnd(6), W.x * 0.4, 7, W.z * 0.4, 25, 6, 40, 0.3));
    }
    this.fireLight.intensity = fireAmt * (6000 + 2500 * Math.sin(this.time * 13) * Math.sin(this.time * 7.3));
    this.steam.update(dt, W.x, W.z);
    this.smoke.update(dt, W.x, W.z);
    this.fire.update(dt, W.x * 0.2, W.z * 0.2);
    this.steam.points.visible = this.steam.active > 0;
    this.smoke.points.visible = this.smoke.active > 0;
    this.fire.points.visible = this.fire.active > 0;
  }

  /** accumulate fractional emission per emitter channel */
  private emit(ch: number, rate: number, dt: number, fn: (k: number) => void) {
    this.emitAcc[ch] += rate * dt;
    let k = 0;
    while (this.emitAcc[ch] >= 1 && k < 40) {
      this.emitAcc[ch] -= 1;
      fn(k++);
    }
  }

  private placeRubble(cat: string | null) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const sc = new THREE.Vector3();
    const p = new THREE.Vector3();
    let seed = 5;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let cx = 0;
    let cz = 0;
    let spread = 70;
    if (cat === 'turbine-missile') {
      cx = 115;
      cz = 10;
      spread = 90;
    } else if (cat === 'containment-failure') {
      cx = -12;
      cz = 25;
    }
    const show = cat === 'steam-explosion' || cat === 'vessel-rupture' || cat === 'containment-failure' || cat === 'turbine-missile';
    this.rubble.visible = show;
    if (!show) return;
    for (let i = 0; i < 90; i++) {
      const a = r() * Math.PI * 2;
      const d = 25 + Math.pow(r(), 0.6) * spread;
      p.set(cx + Math.sin(a) * d, 0.6, cz + Math.cos(a) * d);
      // some land on roofs
      if (Math.abs(p.x + 52) < 29 && Math.abs(p.z) < 25) p.y = 31;
      if (Math.abs(p.x - 112) < 61 && Math.abs(p.z) < 23) p.y = 37.6;
      const s = 0.4 + r() * 1.3;
      sc.set(s, s * (0.5 + r() * 0.5), s * (0.7 + r() * 0.6));
      q.setFromEuler(e.set(r() * 3, r() * 3, r() * 3));
      m.compose(p, q, sc);
      this.rubble.setMatrixAt(i, m);
    }
    this.rubble.instanceMatrix.needsUpdate = true;
    this.rubble.computeBoundingSphere();
  }

  private applyTimeOfDay(hour: number) {
    const a = ((hour - 6) / 12) * Math.PI; // 0 at sunrise, π at sunset
    const elev = Math.sin(a); // >0 day
    const day = smoothstep(-0.12, 0.25, elev);
    const dusk = Math.max(0, 1 - Math.abs(elev) / 0.3) * (elev > -0.25 ? 1 : 0);
    // sun position: rises in the east (+x), south (+z) at noon, sets in the west
    // at night the directional light becomes a dim, cool moon high in the opposite sky
    if (elev > -0.05) this.sun.position.set(Math.cos(a) * 1000, Math.max(-300, elev * 800), 450);
    else this.sun.position.set(-Math.cos(a) * 1000, 600, -300);
    this.sun.target.position.set(0, 0, 0);
    this.sun.updateMatrix();
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrix();
    this.sun.target.updateMatrixWorld();
    const zen = this._c1.setRGB(0.02, 0.035, 0.09).lerp(new THREE.Color(0x3d7cc9), day);
    const hor = this._c2.setRGB(0.07, 0.09, 0.16).lerp(new THREE.Color(0xc4dbee), day).lerp(new THREE.Color(0xf0a070), dusk * 0.7);
    const n = this.skyY.length;
    const tmp = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const y = this.skyY[i];
      const k = smoothstep(-0.05, 0.55, y);
      tmp.copy(hor).lerp(zen, k);
      this.skyCols[i * 3] = tmp.r;
      this.skyCols[i * 3 + 1] = tmp.g;
      this.skyCols[i * 3 + 2] = tmp.b;
    }
    this.sky.geometry.attributes.color.needsUpdate = true;
    this.fog.color.copy(hor);
    (this.scene.background as THREE.Color).copy(hor);
    const moon = elev > -0.05 ? 0 : smoothstep(-0.05, -0.3, elev);
    this.sun.intensity = 2.3 * day + 0.45 * moon;
    if (moon > 0) this.sun.color.setRGB(0.6, 0.7, 1.0);
    else this.sun.color.setRGB(1, 0.92 - 0.25 * dusk, 0.82 - 0.4 * dusk);
    this.hemi.intensity = 0.4 + 0.65 * day;
    this.hemi.color.copy(zen).lerp(new THREE.Color(0xffffff), 0.5);
    this.sunMat.color.setRGB(1, 0.95 - 0.3 * dusk, 0.85 - 0.5 * dusk);
    this.sunDisk.visible = elev > -0.05;
    this.nightMat.opacity = 1 - day;
    this.waterMat.color.copy(hor).multiplyScalar(0.5).lerp(new THREE.Color(0x285c80), 0.6);
    // plumes are lit by the sky
    const lit = 0.35 + 0.65 * day;
    this.steam.mat.uniforms.uColA.value.set(0xf5f7f9).multiplyScalar(lit);
    this.steam.mat.uniforms.uColB.value.set(0xb9c0c6).multiplyScalar(lit);
    this.smoke.mat.uniforms.uColA.value.set(0x5d554c).multiplyScalar(0.6 + 0.4 * day);
  }
}

const rnd = (r: number) => (Math.random() * 2 - 1) * r;

function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const a = p.getAttribute('position');
    pos.set(a.array as Float32Array, o * 3);
    nor.set(p.getAttribute('normal').array as Float32Array, o * 3);
    col.set(p.getAttribute('color').array as Float32Array, o * 3);
    o += a.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
