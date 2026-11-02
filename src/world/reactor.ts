/**
 * Remote reactor view (the colleague's camera on the refueling bridge) and the guided tour
 * inside the reactor. Lazily built on first use; one scene, two "spaces":
 *  - plant: containment, refueling cavity and a cut-away reactor vessel (front half removed)
 *    whose contents follow the live sim state (Cherenkov glow, rod positions, boiling, level,
 *    fuel temperature, damage, catastrophes, SI, flow);
 *  - exhibits: magnified close-up models shown one at a time during the tour.
 * Coordinates (plant): vessel axis at x = z = 0, flange at y = 0, operating deck at y = 0.5.
 */
import * as THREE from 'three';
import type { PlantState, RodBankId, ReactorSimApi } from '../sim/types';
import { ROD_BANKS } from '../sim/types';
import { bus } from '../core/bus';
import { GeoBucket, box, cyl } from './util';

/* ------------------------------------------------------------------ */
/* dimensions                                                          */
/* ------------------------------------------------------------------ */
const R_IN = 2.2; // vessel inner radius
const R_OUT = 2.42;
const SHELL_BOT = -7.4;
const CORE_BOT = -6.4;
const CORE_H = 3.66;
const CORE_TOP = CORE_BOT + CORE_H;
const PITCH = 0.215;
const BARREL_R = 1.82;
const NOZZLE_Y = -1.5;
const HEAD_Y = 0.2;
const DECK_Y = 0.5;
const CAV_R = 5.2;
const CAV_FLOOR = -10.2;
const CONT_R = 20;
const CONT_H = 34;
const EXHIBIT_BASE = new THREE.Vector3(300, 0, 0);
const PRZ_TOP = 3.65; // pressurizer exhibit: top of the cylindrical shell (artistically shortened)
const ROW_COUNTS = [7, 11, 13, 13, 15, 15, 15, 15, 15, 15, 15, 13, 13, 11, 7]; // 193 assemblies
const BACK = 0.12; // cut-away plane: things with z > BACK are removed (except where noted)

const DEG = Math.PI / 180;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);
const smooth = (x: number) => x * x * (3 - 2 * x);

/** back half (z ≤ 0) of a cylinder */
const halfCyl = (rt: number, rb: number, h: number, seg = 32, open = true) => {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open, Math.PI / 2, Math.PI).toNonIndexed();
  g.deleteAttribute('uv');
  return g;
};
const halfSphere = (r: number, top: boolean, seg = 28) => {
  const g = new THREE.SphereGeometry(r, seg, 10, Math.PI, Math.PI, top ? 0 : Math.PI / 2, Math.PI / 2).toNonIndexed();
  g.deleteAttribute('uv');
  return g;
};
const sphereCap = (r: number, top: boolean, seg = 28) => {
  const g = new THREE.SphereGeometry(r, seg, 10, 0, Math.PI * 2, top ? 0 : Math.PI / 2, Math.PI / 2).toNonIndexed();
  g.deleteAttribute('uv');
  return g;
};
const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(s, s, s));
const torus = (r: number, t: number, rs = 6, ts = 24, arc = Math.PI * 2) => {
  const g = new THREE.TorusGeometry(r, t, rs, ts, arc).toNonIndexed();
  g.deleteAttribute('uv');
  return g;
};

function softDot(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

function fuelTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 512;
  const x = c.getContext('2d')!;
  x.fillStyle = '#5d6460';
  x.fillRect(0, 0, 64, 512);
  for (let i = 0; i < 16; i++) {
    const gx = i * 4;
    const gr = x.createLinearGradient(gx, 0, gx + 4, 0);
    gr.addColorStop(0, '#6e7672');
    gr.addColorStop(0.5, '#c4ccc6');
    gr.addColorStop(1, '#5a615d');
    x.fillStyle = gr;
    x.fillRect(gx, 0, 4, 512);
  }
  for (let k = 0; k < 8; k++) {
    const y = 20 + k * 66;
    x.fillStyle = '#9aa29c';
    x.fillRect(0, y, 64, 9);
    x.fillStyle = '#3c423f';
    x.fillRect(0, y + 9, 64, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------ */
/* tour script                                                         */
/* ------------------------------------------------------------------ */
interface Stop {
  title: string;
  text: string;
  space: 'plant' | number; // exhibit index
  pos: [number, number, number];
  look: [number, number, number];
}
const STOPS: Stop[] = [
  {
    title: 'The reactor pressure vessel',
    text: "Here's the whole thing, cut in half so we can peek inside. The vessel is forged low-alloy steel about 22 cm thick, lined with stainless, and it holds the core under 2235 psi. Those big pipes are the nozzles: four cold-leg inlets bring water in from the reactor coolant pumps, four hot-leg outlets send it to the steam generators.",
    space: 'plant',
    pos: [6.2, -1.2, 7.2],
    look: [0, -3.0, 0],
  },
  {
    title: 'The coolant flow path',
    text: "Follow the little dots. Cold water (about 557 °F... well, 'cold') enters the inlet nozzles, turns down through the downcomer ring between the vessel wall and the core barrel, swings around the bottom head and comes back up through the fuel. It leaves about 60 °F hotter through the outlet nozzles. The pumps push roughly 380,000 gallons a minute around this loop.",
    space: 'plant',
    pos: [3.4, -4.6, 3.9],
    look: [0, -4.2, -0.6],
  },
  {
    title: 'A fuel assembly',
    text: "This is one of 193 fuel assemblies. It's a 17×17 grid: 264 fuel rods, 24 guide thimbles where control rods can slide in, and one instrument tube in the middle. Spring-loaded spacer grids hold the rods and stir the water, and the top nozzle's hold-down springs keep the whole thing from floating up in the flow.",
    space: 0,
    pos: [0.36, 0.26, 0.42],
    look: [0, -0.03, 0],
  },
  {
    title: 'Fuel rod and zirconium cladding',
    text: "Inside each rod is a stack of uranium dioxide ceramic pellets, about the size of a pencil eraser, enriched to roughly 4–5 % U-235. The tube around them is zirconium alloy (Zircaloy or ZIRLO): it barely absorbs neutrons and resists corrosion. A tiny helium-filled gap separates pellet and clad, and the spring up in the plenum leaves room for fission gas. Above about 2200 °F that zirconium reacts with steam and makes hydrogen. Bad day.",
    space: 1,
    pos: [0.3, 0.2, 0.42],
    look: [0.36, -0.01, 0],
  },
  {
    title: 'Control rods (RCCA)',
    text: "A rod cluster control assembly: a spider-shaped hub holding 24 absorber rods of silver-indium-cadmium in stainless tubes. They slide down the guide thimbles of a fuel assembly. When the reactor trips, the drive mechanisms let go and gravity drops all 53 clusters into the core in under two seconds. Watch it fall!",
    space: 2,
    pos: [0.48, 0.5, 0.7],
    look: [0, 0.22, 0],
  },
  {
    title: 'Control rod drive mechanisms',
    text: "Each of these tall housings on the vessel head holds a magnetic jack. Stacks of coils (lift, movable and stationary grippers) latch the drive shaft and step it 5/8 inch at a time, about 72 steps a minute. Cut the power to the coils and the latches open: that's how a reactor trip drops the rods. The rods you see below are at their live bank positions.",
    space: 'plant',
    pos: [2.0, 6.2, 3.0],
    look: [0, 3.2, -0.6],
  },
  {
    title: 'In-core instruments and boron',
    text: "Those thin tubes poking up through the bottom head are in-core instrument thimbles: movable detectors or fixed thermocouples run up into the middle of selected fuel assemblies to map the power shape. The water itself is doing a job too: it carries dissolved boric acid. Boron-10 soaks up neutrons, so we dilute or borate a few ppm to trim reactivity slowly while the rods handle fast changes.",
    space: 'plant',
    pos: [3.0, -6.9, 3.7],
    look: [0, -7.6, -0.4],
  },
  {
    title: 'Cherenkov radiation',
    text: "That blue glow is real. Fast electrons knocked loose by gamma rays travel faster than light does in water, and they throw off a blue shock wave of light, a bit like a sonic boom. The brighter the core is working, the brighter the blue. At full power it's dazzling; shut down it fades to a dim decay-heat glimmer.",
    space: 'plant',
    pos: [0.9, 2.4, 3.3],
    look: [0, -3.6, -0.3],
  },
  {
    title: 'Steam generator U-tubes',
    text: "Out in the loops, the hot reactor water flows up one leg and down the other of thousands of thin Inconel U-tubes. On the outside of the tubes, separate feedwater boils into steam at about 1000 psi. The swirl separators and dryers up top strip the water droplets out before the steam heads to the turbine. The two water systems never touch, which keeps radioactivity out of the turbine.",
    space: 3,
    pos: [1.3, 2.5, 2.6],
    look: [0, 2.0, -0.3],
  },
  {
    title: 'Pressurizer heaters and spray',
    text: "Last stop: the pressurizer, the one place where the reactor coolant is allowed to boil. Electric heaters in the bottom (live, from the board) make a steam bubble up top; spray from a cold leg condenses it. Heat to raise pressure, spray to lower it, and the level here is your window on the RCS water inventory. That's the tour! Head back whenever you like.",
    space: 4,
    pos: [1.6, 2.3, 3.2],
    look: [0, 2.0, -0.1],
  },
];

/* ------------------------------------------------------------------ */
interface RccaInst {
  x: number;
  z: number;
  bank: RodBankId;
  pos: number; // displayed fraction withdrawn
}

export class ReactorView {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.03, 220);
  private sim: ReactorSimApi;
  private mode: 'reactor-cam' | 'tour' = 'reactor-cam';
  private time = 0;
  private plant = new THREE.Group();
  private exhibits: THREE.Group[] = [];
  private dot = softDot();

  // dynamic plant parts
  private fuel!: THREE.InstancedMesh;
  private fuelMat!: THREE.MeshLambertMaterial;
  private fuelPos: { x: number; z: number; h: number }[] = [];
  private rccas: RccaInst[] = [];
  private spiders!: THREE.InstancedMesh;
  private drives!: THREE.InstancedMesh;
  private bundles!: THREE.InstancedMesh;
  private water!: THREE.Mesh;
  private waterMat!: THREE.MeshLambertMaterial;
  private glow!: THREE.Mesh;
  private glowMat!: THREE.MeshBasicMaterial;
  private coreLight!: THREE.PointLight;
  private meltLight!: THREE.PointLight;
  private beaconLight!: THREE.PointLight;
  private beacons!: THREE.InstancedMesh;
  private beaconMat!: THREE.MeshBasicMaterial;
  private beaconLampMat!: THREE.MeshBasicMaterial;
  private head!: THREE.Mesh;
  private melt!: THREE.Mesh;
  private meltMat!: THREE.MeshLambertMaterial;
  private debris!: THREE.InstancedMesh;
  private debrisState: { p: THREE.Vector3; v: THREE.Vector3; r: THREE.Euler; w: THREE.Vector3; rest: boolean }[] = [];
  private exploded = false;
  private flash = 0; // explosion flash + camera shake, decays
  private flashMat!: THREE.MeshBasicMaterial;
  private headT = 0;
  private hemi!: THREE.HemisphereLight;
  private lamp!: THREE.PointLight;
  private sun!: THREE.DirectionalLight;
  private fog = new THREE.FogExp2(0x1a2026, 0.012);

  // particles
  private bubbles!: THREE.Points;
  private bubbleData!: Float32Array;
  private flow!: THREE.Points;
  private flowData!: Float32Array;
  private flowMat!: THREE.PointsMaterial;
  private steam!: THREE.Points;
  private steamData!: Float32Array;
  private smoke!: THREE.Points;
  private smokeData!: Float32Array;
  private si!: THREE.Points;
  private siData!: Float32Array;
  private dust!: THREE.Points;

  // exhibits dynamic
  private pelletMat!: THREE.MeshLambertMaterial;
  private spiderEx!: THREE.Group;
  private heaterMat!: THREE.MeshLambertMaterial;
  private przWater!: THREE.Mesh;
  private przBubbles!: THREE.Points;
  private przBubbleData!: Float32Array;
  private przSpray!: THREE.Points;
  private sgFlow!: THREE.Points;
  private sgPaths: THREE.Vector3[][] = [];
  private sgFlowData!: Float32Array;
  private exBubbles!: THREE.Points;

  // camera
  private look = { yaw: 0, pitch: 0, fov: 55, drag: false, lx: 0, ly: 0 };
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private stop = 0;
  private tw: { from: THREE.Vector3; fromL: THREE.Vector3; to: THREE.Vector3; toL: THREE.Vector3; t: number; dur: number; fade: boolean; switched: boolean } | null = null;
  private fadeMat!: THREE.MeshBasicMaterial;
  private fade = 0;
  private introFade = 0;
  private space: 'plant' | number = 'plant';
  private enabled = false;

  // live smoothed values
  private glowV = 0;
  private levelV = 1;
  private boilV = 0;
  private steamV = 0;
  private damageV = 0;
  private fuelHotV = 0;
  private lastDamageApplied = -1;

  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  private _v = new THREE.Vector3();
  private _s = new THREE.Vector3();
  private _c = new THREE.Color();
  private _e = new THREE.Euler();

  constructor(sim: ReactorSimApi, canvas: HTMLCanvasElement) {
    this.sim = sim;
    this.scene.background = new THREE.Color(0x0d1014);
    this.scene.fog = this.fog;
    this.scene.add(this.plant);
    this.scene.add(this.camera);
    this.buildLights();
    this.buildPlant();
    this.buildParticles();
    this.buildExhibits();
    this.buildFade();
    this.attachInput(canvas);
  }

  /* ================================================================ */
  /* building                                                          */
  /* ================================================================ */
  private buildLights() {
    this.hemi = new THREE.HemisphereLight(0xcfd8e0, 0x2a2622, 0.85);
    this.sun = new THREE.DirectionalLight(0xfff2dc, 1.3);
    this.sun.position.set(6, 30, 12);
    this.coreLight = new THREE.PointLight(0x3aa0ff, 0, 22, 1.4);
    this.coreLight.position.set(0, CORE_TOP + 0.6, -0.3);
    this.meltLight = new THREE.PointLight(0xff5a14, 0, 16, 1.5);
    this.meltLight.position.set(0, -6.5, 0.3);
    this.beaconLight = new THREE.PointLight(0xff2010, 0, 40, 1.2);
    this.beaconLight.position.set(0, 6, 8);
    // the colleague's helmet lamp: lights the close-up exhibits
    this.lamp = new THREE.PointLight(0xfff4e0, 0, 0, 1);
    this.lamp.position.set(0.15, 0.1, 0);
    this.camera.add(this.lamp);
    this.scene.add(this.hemi, this.sun, this.coreLight, this.meltLight, this.beaconLight);
  }

  private buildPlant() {
    const B = new GeoBucket();
    const C = { concrete: 0x8c8a84, steel: 0x8d9499, ss: 0xb9bec2, paint: 0x5f7f6a, yellow: 0xd8b21c, dark: 0x2c3034, vessel: 0x6c7176, clad: 0xc9ced2, red: 0x8c2a20 };
    const add = (g: THREE.BufferGeometry, m: THREE.Matrix4 | null, c: number) => B.add(g, m, c, { ao: false });

    /* ---- containment ---- */
    const wall = new THREE.CylinderGeometry(CONT_R, CONT_R, CONT_H, 48, 6, true).toNonIndexed();
    wall.deleteAttribute('uv');
    add(wall, M(0, DECK_Y + CONT_H / 2 - 0.01), 0x9a968c);
    add(sphereCap(CONT_R, true, 48), M(0, DECK_Y + CONT_H), 0x8e8b84);
    // horizontal liner seams + wall stiffener rings
    for (let k = 1; k < 7; k++) add(torus(CONT_R - 0.05, 0.06, 4, 64), M(0, DECK_Y + k * 4.8, 0, Math.PI / 2), 0x6d6a64);
    // operating deck: ring from the cavity to the wall, with yellow safety band
    {
      const deck = new THREE.RingGeometry(CAV_R, CONT_R, 64, 1).toNonIndexed();
      deck.deleteAttribute('uv');
      deck.rotateX(-Math.PI / 2);
      add(deck, M(0, DECK_Y), 0x76736c);
      const band = new THREE.RingGeometry(CAV_R + 0.05, CAV_R + 0.45, 64, 1).toNonIndexed();
      band.deleteAttribute('uv');
      band.rotateX(-Math.PI / 2);
      add(band, M(0, DECK_Y + 0.006), C.yellow);
      // floor grid lines
      for (let i = -9; i <= 9; i++) {
        if (Math.abs(i * 2) < CAV_R + 1) continue;
        add(box(0.04, 0.004, 36), M(i * 2, DECK_Y + 0.004, 0), 0x5e5b55);
        add(box(36, 0.004, 0.04), M(0, DECK_Y + 0.004, i * 2), 0x5e5b55);
      }
    }
    // cavity: stainless liner walls (back half: the cut-away continues through the concrete),
    // floor, rim curb, and the sectioned concrete of the biological shield
    {
      const cavH = DECK_Y - CAV_FLOOR;
      add(halfCyl(CAV_R, CAV_R, cavH, 48), M(0, (DECK_Y + CAV_FLOOR) / 2), 0x7d8386);
      add(halfCyl(CAV_R + 2.6, CAV_R + 2.6, cavH + 1, 48), M(0, (DECK_Y + CAV_FLOOR - 1) / 2), 0x77746d);
      for (let k = 0; k < 6; k++) add(torus(CAV_R - 0.02, 0.025, 4, 32, Math.PI), M(0, CAV_FLOOR + 1 + k * 1.8, 0, -Math.PI / 2), 0x63696c);
      const floor = new THREE.CircleGeometry(CAV_R, 48).toNonIndexed();
      floor.deleteAttribute('uv');
      floor.rotateX(-Math.PI / 2);
      add(floor, M(0, CAV_FLOOR), 0x6f7476);
      // section faces of the shield wall + the floor slab, hatched with darker bands
      for (const sx of [-1, 1]) {
        add(box(2.6, cavH + 1, 0.04), M(sx * (CAV_R + 1.3), (DECK_Y + CAV_FLOOR - 1) / 2, 0.01), 0x8d8a82);
        for (let k = 0; k < 9; k++) add(box(2.6, 0.05, 0.05), M(sx * (CAV_R + 1.3), CAV_FLOOR - 0.6 + k * 1.3, 0.03, 0, 0, 0.45), 0x6a675f);
        add(box(0.06, cavH + 1, 0.06), M(sx * CAV_R, (DECK_Y + CAV_FLOOR - 1) / 2, 0.03), 0xb9bec2); // liner edge
      }
      add(box(2 * (CAV_R + 2.6), 1.0, 0.04), M(0, CAV_FLOOR - 0.5, 0.01), 0x8d8a82);
      // lower containment floor in front of the section (so the cut-away doesn't float in a void)
      const lf = new THREE.CircleGeometry(CONT_R, 48, 0, Math.PI).toNonIndexed();
      lf.deleteAttribute('uv');
      lf.rotateX(-Math.PI / 2);
      lf.rotateY(Math.PI);
      add(lf, M(0, CAV_FLOOR - 1.0, 0.01), 0x4e4c48);
      // deck slab thickness along the section
      for (const sx of [-1, 1]) add(box(CONT_R - CAV_R, 0.6, 0.04), M(sx * (CAV_R + CONT_R) / 2, DECK_Y - 0.3, 0.01), 0x8d8a82);
      add(torus(CAV_R + 0.05, 0.08, 6, 64), M(0, DECK_Y + 0.06, 0, Math.PI / 2), C.steel);
    }
    // railing around the cavity (posts + 2 rails), front part left open for the camera's view
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      add(cyl(0.025, 0.025, 1.05, 6), M(Math.sin(a) * (CAV_R + 0.3), DECK_Y + 0.52, Math.cos(a) * (CAV_R + 0.3)), C.yellow);
    }
    add(torus(CAV_R + 0.3, 0.025, 4, 80), M(0, DECK_Y + 1.05, 0, Math.PI / 2), C.yellow);
    add(torus(CAV_R + 0.3, 0.02, 4, 80), M(0, DECK_Y + 0.55, 0, Math.PI / 2), C.yellow);
    // polar crane: ring girder + bridge + trolley + hook
    {
      const y = DECK_Y + 26;
      add(torus(CONT_R - 0.9, 0.35, 4, 64), M(0, y, 0, Math.PI / 2), 0xc49a1a);
      for (const sz of [-1.6, 1.6]) add(box(2 * (CONT_R - 1.2), 1.4, 0.5), M(0, y + 0.6, sz, 0, 0.5), 0xd2a71c);
      add(box(3.6, 1.2, 4.2), M(2.5, y + 1.6, 0, 0, 0.5), 0x9c7a12);
      add(cyl(0.05, 0.05, 14, 6), M(2.5 * Math.cos(0.5), y - 6, -2.5 * Math.sin(0.5)), 0x333333);
      add(box(0.5, 0.9, 0.3), M(2.5 * Math.cos(0.5), y - 13.3, -2.5 * Math.sin(0.5)), C.yellow);
    }
    // steam generator / pressurizer compartments: concrete shield walls, with SG tops poking out
    for (let i = 0; i < 4; i++) {
      const a = (45 + i * 90) * DEG;
      const r = 11.5;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      add(box(6.5, 9, 0.8), M(x, DECK_Y + 4.5, z, 0, a), 0x8a877f);
      add(box(0.8, 9, 5.5), M(x + Math.sin(a + Math.PI / 2) * 3.2, DECK_Y + 4.5, z + Math.cos(a + Math.PI / 2) * 3.2, 0, a), 0x837f78);
      add(cyl(2.2, 2.2, 6, 24), M(Math.sin(a) * 13.5, DECK_Y + 9.5, Math.cos(a) * 13.5), 0xb8b4a6);
      add(sphereCap(2.2, true, 24), M(Math.sin(a) * 13.5, DECK_Y + 12.5, Math.cos(a) * 13.5), 0xb8b4a6);
    }
    add(cyl(1.3, 1.3, 7, 20), M(-15, DECK_Y + 8, -2), 0xb8b4a6); // pressurizer top
    add(sphereCap(1.3, true, 20), M(-15, DECK_Y + 11.5, -2), 0xb8b4a6);
    // high-bay light fixtures on the wall
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      add(box(0.6, 0.25, 0.4), M(Math.sin(a) * (CONT_R - 0.3), DECK_Y + 14, Math.cos(a) * (CONT_R - 0.3), 0, a), 0xf2ead2);
    }
    // stored equipment: head stand ring, upper internals stand, laydown boxes
    add(cyl(2.6, 2.6, 0.5, 32), M(-10, DECK_Y + 0.25, -7), 0x6a6e70);
    add(box(2.5, 1.6, 1.4), M(9, DECK_Y + 0.8, -9, 0, 0.4), 0x2f5a8a);
    add(box(1.4, 1.2, 1.2), M(10.6, DECK_Y + 0.6, -7.6, 0, 0.2), 0x2f5a8a);
    add(box(2.2, 1.0, 1.0), M(-12, DECK_Y + 0.5, 6, 0, -0.3), 0x8a6a2a);
    // refueling machine bridge spanning the cavity (parked behind the vessel)
    {
      const zb = -3.4;
      for (const dz of [-0.7, 0.7]) add(box(13, 0.7, 0.35), M(0, DECK_Y + 1.6, zb + dz), C.yellow);
      add(box(13, 0.06, 1.4), M(0, DECK_Y + 1.98, zb), 0x5a5a56);
      for (const dx of [-6.3, 6.3]) add(box(0.6, 1.6, 2.2), M(dx, DECK_Y + 0.8, zb), C.yellow);
      add(box(1.6, 1.2, 1.6), M(-2.4, DECK_Y + 2.6, zb), 0xd8c070);
      add(box(0.45, 7.5, 0.45), M(-2.4, DECK_Y - 1.6, zb), 0xb9bec2); // mast
    }

    /* ---- vessel (back half) ---- */
    add(halfCyl(R_OUT, R_OUT, 0 - SHELL_BOT, 48), M(0, SHELL_BOT / 2), C.vessel);
    add(halfCyl(R_IN, R_IN, 0 - SHELL_BOT, 48), M(0, SHELL_BOT / 2), C.clad);
    add(halfSphere(R_OUT, false, 40), M(0, SHELL_BOT), C.vessel);
    add(halfSphere(R_IN, false, 40), M(0, SHELL_BOT), C.clad);
    // cut faces of the shell (wall thickness)
    for (const sx of [-1, 1]) add(box(R_OUT - R_IN, -SHELL_BOT, 0.02), M(sx * (R_IN + R_OUT) / 2, SHELL_BOT / 2, 0.005), 0x4c5054);
    add(halfCyl(R_OUT + 0.45, R_OUT + 0.45, 0.4, 48, false), M(0, 0.2), C.vessel); // flange
    // nozzles (back half) + pipes to the cavity wall; insulation-white pipes
    const nozA = [112.5, 157.5, 202.5, 247.5];
    nozA.forEach((deg, i) => {
      const a = deg * DEG;
      const hot = i % 2 === 0;
      const len = CAV_R - R_IN + 0.2;
      const g = cyl(0.42, 0.5, 0.9, 20);
      add(g, M(Math.sin(a) * (R_OUT + 0.3), NOZZLE_Y, Math.cos(a) * (R_OUT + 0.3), Math.PI / 2, a), C.vessel);
      add(cyl(0.38, 0.38, len, 20), M(Math.sin(a) * (R_IN + len / 2), NOZZLE_Y, Math.cos(a) * (R_IN + len / 2), Math.PI / 2, a), hot ? 0xd9d2c4 : 0xc4ccd4);
    });
    // core barrel (back half), lower core plate, upper core plate, upper support plate
    add(halfCyl(BARREL_R, BARREL_R, CORE_TOP + 2.4 - (SHELL_BOT + 0.4), 40), M(0, (CORE_TOP + 2.4 + SHELL_BOT + 0.4) / 2), 0xa7adb2);
    for (const sx of [-1, 1]) add(box(0.05, CORE_TOP + 2.4 - SHELL_BOT - 0.4, 0.02), M(sx * BARREL_R, (CORE_TOP + 2.4 + SHELL_BOT + 0.4) / 2, 0.005), 0x6a7074);
    const plate = (y: number, t: number, r: number, c: number) => {
      const g = halfCyl(r, r, t, 40, false);
      add(g, M(0, y), c);
      add(box(2 * r, t, 0.02), M(0, y, 0.005), 0x6a7074);
    };
    plate(CORE_BOT - 0.12, 0.2, BARREL_R, 0x9aa0a4);
    plate(CORE_TOP + 0.25, 0.08, BARREL_R, 0xa4aaae);
    plate(-0.35, 0.35, R_IN - 0.02, 0x9aa0a4);
    // lower support columns + instrument thimbles through the bottom head
    for (let k = 0; k < 14; k++) {
      const a = Math.PI / 2 + (k / 13) * Math.PI;
      const r = 0.25 + (k % 4) * 0.38;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      add(cyl(0.05, 0.05, 1.0, 8), M(x, CORE_BOT - 0.7, z), 0x9aa0a4);
      add(cyl(0.022, 0.022, 3.6, 6), M(x * 1.05, SHELL_BOT - 1.4, z * 1.05), 0xd8dde0); // thimble guide tubes
    }
    // instrument thimble conduit bundle out of the bottom (to the seal table)
    add(box(0.5, 0.18, 4.5), M(0, CAV_FLOOR + 0.2, -2.4), 0x9a9fa2);

    /* ---- head + CRDMs (separate mesh so an explosion can throw it) ---- */
    const H = new GeoBucket();
    const hadd = (g: THREE.BufferGeometry, m: THREE.Matrix4 | null, c: number) => H.add(g, m, c, { ao: false });
    hadd(halfSphere(R_OUT, true, 40), M(0, HEAD_Y), C.vessel);
    hadd(halfSphere(R_IN, true, 40), M(0, HEAD_Y), C.clad);
    hadd(halfCyl(R_OUT + 0.45, R_OUT + 0.45, 0.35, 48, false), M(0, 0.55), C.vessel);
    for (let k = 0; k < 16; k++) {
      const a = Math.PI / 2 + ((k + 0.5) / 16) * Math.PI;
      hadd(cyl(0.07, 0.07, 0.6, 8), M(Math.sin(a) * (R_OUT + 0.25), 0.7, Math.cos(a) * (R_OUT + 0.25)), 0x3d3f41); // studs
    }

    /* ---- core: 193 fuel assemblies, RCCA positions ---- */
    const pos: { x: number; z: number; i: number; j: number }[] = [];
    ROW_COUNTS.forEach((n, j) => {
      for (let k = 0; k < n; k++) {
        const i = k + (15 - n) / 2;
        pos.push({ x: (i - 7) * PITCH, z: (j - 7) * PITCH, i, j });
      }
    });
    // RCCA locations: odd/odd lattice positions inside the core, topped up toward 53 near the periphery
    const rpos = pos.filter((p) => p.i % 2 === 1 && p.j % 2 === 1);
    const extra = pos.filter((p) => p.i % 2 === 0 && p.j % 2 === 0 && Math.hypot(p.i - 7, p.j - 7) > 3 && Math.hypot(p.i - 7, p.j - 7) < 6.2);
    extra.sort((a, b) => Math.atan2(a.j - 7, a.i - 7) - Math.atan2(b.j - 7, b.i - 7));
    for (let k = 0; rpos.length < 53 && k < extra.length; k += 2) rpos.push(extra[k]);
    rpos.splice(53);
    rpos.forEach((p, k) => {
      const ring = Math.round(Math.hypot(p.i - 7, p.j - 7));
      const bank = ROD_BANKS[(ring * 2 + k) % ROD_BANKS.length];
      this.rccas.push({ x: p.x, z: p.z, bank, pos: 0 });
    });
    // fuel (only the back half + the centre row is drawn: the cut-away)
    const fuelList = pos.filter((p) => p.z <= BACK);
    this.fuelPos = fuelList.map((p) => ({ x: p.x, z: p.z, h: 1 }));
    const tex = fuelTexture();
    this.fuelMat = new THREE.MeshLambertMaterial({ map: tex, color: 0xffffff, emissive: 0x000000 });
    const fg = new THREE.BoxGeometry(PITCH * 0.97, CORE_H, PITCH * 0.97);
    this.fuel = new THREE.InstancedMesh(fg, this.fuelMat, fuelList.length);
    this.fuel.name = 'fuel';
    const tint = new THREE.Color();
    fuelList.forEach((p, k) => {
      this.fuel.setMatrixAt(k, M(p.x, CORE_BOT + CORE_H / 2, p.z));
      const burn = 0.82 + 0.18 * ((p.i * 7 + p.j * 3) % 5) / 4;
      this.fuel.setColorAt(k, tint.setRGB(burn, burn, burn * 0.98));
    });
    this.plant.add(this.fuel);
    // top nozzles of the assemblies (static)
    for (const p of fuelList) add(box(PITCH * 0.9, 0.09, PITCH * 0.9), M(p.x, CORE_TOP + 0.05, p.z), 0xb4b9bc);

    // guide tubes in the upper plenum + CRDM housings on the head (only behind the cut)
    const vis = this.rccas.filter((r) => r.z <= BACK);
    for (const r of vis) {
      add(cyl(0.085, 0.085, -0.35 - (CORE_TOP + 0.3), 10), M(r.x, (CORE_TOP + 0.3 - 0.35) / 2, r.z), 0xa9aeb2);
      const rr = Math.hypot(r.x, r.z);
      const yHead = HEAD_Y + Math.sqrt(Math.max(0, R_OUT * R_OUT - rr * rr));
      const top = 6.4;
      hadd(cyl(0.075, 0.075, top - yHead + 0.05, 10), M(r.x, (top + yHead) / 2, r.z), 0xc3c8cb);
      // latch coil stack (copper/dark rings) + rod position indicator coil
      for (let k = 0; k < 4; k++) hadd(cyl(0.115, 0.115, 0.16, 12), M(r.x, yHead + 0.55 + k * 0.22, r.z), k % 2 ? 0x7a4a22 : 0x3a3c3e);
      hadd(cyl(0.1, 0.1, 1.4, 10), M(r.x, yHead + 2.4, r.z), 0x50555a);
    }
    // CRDM seismic support platform + cooling shroud ring + cable tray ring (back half)
    hadd(halfCyl(2.05, 2.05, 0.2, 40, false), M(0, 6.2), 0x707478);
    hadd(halfCyl(2.15, 2.15, 2.2, 40, true), M(0, 4.4), 0x8a9094);
    const headMesh = H.build(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    headMesh.name = 'vessel-head';
    headMesh.matrixAutoUpdate = true;
    this.head = headMesh;
    this.plant.add(headMesh);

    // rods: drive shafts (thin, up into the CRDMs), spiders, absorber bundles
    const nV = vis.length;
    const dg = new THREE.CylinderGeometry(0.022, 0.022, 1, 6);
    dg.translate(0, 0.5, 0);
    this.drives = new THREE.InstancedMesh(dg, new THREE.MeshLambertMaterial({ color: 0x9da4a8 }), nV);
    const sg = new THREE.BufferGeometry();
    {
      const parts = [box(0.19, 0.03, 0.03), box(0.03, 0.03, 0.19), new THREE.CylinderGeometry(0.035, 0.035, 0.12, 10).toNonIndexed()];
      parts[2].deleteAttribute('uv');
      const merged = mergeRaw(parts);
      sg.copy(merged);
    }
    this.spiders = new THREE.InstancedMesh(sg, new THREE.MeshLambertMaterial({ color: 0xc8ccd0 }), nV);
    const bg = new THREE.BoxGeometry(0.15, 1, 0.15);
    bg.translate(0, -0.5, 0);
    this.bundles = new THREE.InstancedMesh(bg, new THREE.MeshLambertMaterial({ color: 0x55595d }), nV);
    this.rccas = vis.concat(this.rccas.filter((r) => r.z > BACK)); // visible ones first
    for (const m of [this.drives, this.spiders, this.bundles]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.plant.add(m);
    }
    this.nVisRods = nV;

    // coolant (transparent, back half + cut face), Cherenkov glow volume
    {
      const g = halfCyl(R_IN - 0.01, R_IN - 0.01, 1, 40, false);
      const face = new THREE.PlaneGeometry(2 * (R_IN - 0.01), 1).toNonIndexed();
      face.deleteAttribute('uv');
      face.translate(0, 0, 0.0);
      const merged = mergeRaw([g, face]);
      merged.translate(0, 0.5, 0);
      this.waterMat = new THREE.MeshLambertMaterial({ color: 0x3f8fb8, transparent: true, opacity: 0.22, depthWrite: false, emissive: 0x000000, side: THREE.DoubleSide });
      this.water = new THREE.Mesh(merged, this.waterMat);
      this.water.name = 'coolant';
      this.water.renderOrder = 2;
      this.plant.add(this.water);
      const gg = halfCyl(1.72, 1.72, CORE_H + 0.8, 32, true);
      this.glowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      this.glow = new THREE.Mesh(gg, this.glowMat);
      this.glow.position.set(0, CORE_BOT + CORE_H / 2 + 0.3, 0);
      this.glow.renderOrder = 3;
      this.plant.add(this.glow);
    }
    // molten / slumped core debris (hidden until damage)
    {
      const prof = [new THREE.Vector2(0, 0.7), new THREE.Vector2(0.6, 0.62), new THREE.Vector2(1.2, 0.42), new THREE.Vector2(1.7, 0.15), new THREE.Vector2(1.8, 0)];
      const lg = new THREE.LatheGeometry(prof, 32);
      this.meltMat = new THREE.MeshLambertMaterial({ color: 0x3a2a22, emissive: 0x000000 });
      this.melt = new THREE.Mesh(lg, this.meltMat);
      this.melt.position.set(0, SHELL_BOT - 1.6, 0);
      this.melt.visible = false;
      this.plant.add(this.melt);
    }
    // debris chunks (steam explosion / vessel rupture)
    {
      const g = new THREE.DodecahedronGeometry(0.25, 0);
      this.debris = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: 0x5a5852 }), 140);
      this.debris.visible = false;
      for (let i = 0; i < 140; i++) this.debrisState.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), rest: false });
      this.plant.add(this.debris);
    }
    // rotating warning beacons on the containment wall (beam cones) + lamp bodies
    {
      const cone = new THREE.ConeGeometry(1.2, 9, 16, 1, true);
      cone.translate(0, -4.5, 0);
      cone.rotateZ(Math.PI / 2);
      this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2010, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      this.beacons = new THREE.InstancedMesh(cone, this.beaconMat, 4);
      this.beacons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.beacons.frustumCulled = false;
      this.plant.add(this.beacons);
      this.beaconLampMat = new THREE.MeshBasicMaterial({ color: 0x330806, toneMapped: false });
      const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 12, 8), this.beaconLampMat, 4);
      for (let i = 0; i < 4; i++) lamps.setMatrixAt(i, M(...this.beaconPos(i).toArray()));
      this.plant.add(lamps);
    }

    const plantMesh = B.build(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    plantMesh.name = 'containment-static';
    this.plant.add(plantMesh);
  }
  private nVisRods = 0;

  private beaconPos(i: number): THREE.Vector3 {
    const a = (30 + i * 90) * DEG + Math.PI;
    return this._tmpV.set(Math.sin(a) * (CONT_R - 0.6), DECK_Y + 7, Math.cos(a) * (CONT_R - 0.6));
  }
  private _tmpV = new THREE.Vector3();

  private points(n: number, color: number, size: number, opacity: number, additive = false, sizeAtt = true): { pts: THREE.Points; data: Float32Array } {
    const g = new THREE.BufferGeometry();
    const data = new Float32Array(n * 3);
    g.setAttribute('position', new THREE.BufferAttribute(data, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.PointsMaterial({ color, size, map: this.dot, transparent: true, opacity, depthWrite: false, sizeAttenuation: sizeAtt, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    return { pts, data };
  }

  private buildParticles() {
    // boiling bubbles in the core region (behind the cut)
    let r = this.points(420, 0xe8f6ff, 0.06, 0, false);
    this.bubbles = r.pts;
    this.bubbleData = r.data;
    for (let i = 0; i < 420; i++) this.respawnBubble(i, true);
    this.plant.add(this.bubbles);
    // coolant flow tracers: per particle phase (x), angle (y), radial jitter (z) — positions written each frame
    r = this.points(700, 0x7fd0ff, 0.07, 0.0, true);
    this.flow = r.pts;
    this.flowMat = this.flow.material as THREE.PointsMaterial;
    this.flowData = r.data;
    this.flowState = new Float32Array(700 * 3);
    for (let i = 0; i < 700; i++) {
      this.flowState[i * 3] = Math.random();
      this.flowState[i * 3 + 1] = Math.random();
      this.flowState[i * 3 + 2] = Math.random();
    }
    this.plant.add(this.flow);
    // steam puffs
    r = this.points(70, 0xdde4ea, 2.2, 0, false);
    this.steam = r.pts;
    this.steamData = r.data;
    for (let i = 0; i < 70; i++) this.respawnPuff(this.steamData, i, true);
    this.plant.add(this.steam);
    // smoke
    r = this.points(70, 0x231d1a, 2.4, 0, false);
    this.smoke = r.pts;
    this.smokeData = r.data;
    for (let i = 0; i < 70; i++) this.respawnPuff(this.smokeData, i, true);
    this.plant.add(this.smoke);
    // SI injection jets (into the downcomer from the cold legs)
    r = this.points(240, 0xbfe6ff, 0.08, 0, false);
    this.si = r.pts;
    this.siData = r.data;
    this.siState = new Float32Array(240);
    for (let i = 0; i < 240; i++) this.siState[i] = Math.random();
    this.plant.add(this.si);
    // dust after an explosion
    r = this.points(160, 0x9a8a78, 3.0, 0, false);
    this.dust = r.pts;
    const dd = r.data;
    for (let i = 0; i < 160; i++) {
      dd[i * 3] = (Math.random() - 0.5) * 30;
      dd[i * 3 + 1] = DECK_Y + Math.random() * 18;
      dd[i * 3 + 2] = (Math.random() - 0.5) * 30;
    }
    this.plant.add(this.dust);
  }
  private flowState!: Float32Array;
  private siState!: Float32Array;

  private respawnBubble(i: number, init: boolean) {
    const d = this.bubbleData;
    const a = Math.PI / 2 + Math.random() * Math.PI;
    const rr = Math.sqrt(Math.random()) * 1.6;
    d[i * 3] = Math.sin(a) * rr;
    d[i * 3 + 1] = init ? CORE_BOT + Math.random() * (CORE_H + 2) : CORE_BOT + Math.random() * CORE_H * 0.6;
    d[i * 3 + 2] = Math.cos(a) * rr * 0.9 + 0.08;
  }
  private respawnPuff(d: Float32Array, i: number, init: boolean) {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.random() * 2.2;
    d[i * 3] = Math.sin(a) * rr;
    d[i * 3 + 1] = init ? -2 + Math.random() * 14 : -1 + Math.random() * 2;
    d[i * 3 + 2] = Math.cos(a) * rr;
  }

  /* ---------------- exhibits ---------------- */
  private buildExhibits() {
    const mk = () => {
      const g = new THREE.Group();
      g.position.copy(EXHIBIT_BASE);
      g.visible = false;
      this.scene.add(g);
      this.exhibits.push(g);
      return g;
    };
    const lam = (c: number, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color: c, ...extra });

    // ---- 0: 17x17 fuel assembly (top 1.4 m) ----
    {
      const G = mk();
      const B = new GeoBucket();
      const p = 0.0126;
      const gt = guideThimbles();
      const rodsFuel: [number, number][] = [];
      for (let i = 0; i < 17; i++) for (let j = 0; j < 17; j++) if (!gt.some(([a, b]) => a === i && b === j) && !(i === 8 && j === 8)) rodsFuel.push([i, j]);
      const L = 1.4;
      const rg = new THREE.CylinderGeometry(0.00475, 0.00475, L, 10);
      rg.translate(0, -L / 2 - 0.02, 0);
      const rods = new THREE.InstancedMesh(rg, lam(0xa9b2ad), rodsFuel.length);
      rodsFuel.forEach(([i, j], k) => {
        const cut = i >= 11 && j >= 11; // cut-away corner shows the inside
        rods.setMatrixAt(k, new THREE.Matrix4().makeScale(1, cut ? 0.22 : 1, 1).setPosition((i - 8) * p, cut ? -0.02 * 0.78 : 0, (j - 8) * p));
      });
      G.add(rods);
      for (const [i, j] of gt) B.add(cyl(0.0061, 0.0061, L + 0.05, 10), M((i - 8) * p, -L / 2 + 0.01, (j - 8) * p), 0xc9cfd2, { ao: false });
      B.add(cyl(0.0061, 0.0061, L + 0.05, 10), M(0, -L / 2 + 0.01, 0), 0xe0c070, { ao: false }); // instrument tube
      // spacer grids (egg-crate straps)
      const W = 17 * p;
      for (const gy of [-0.12, -0.64, -1.16]) {
        for (let k = 0; k <= 17; k++) {
          const o = -W / 2 + k * p;
          B.add(box(W, 0.038, 0.0007), M(0, gy, o), 0xc6c9b4, { ao: false });
          B.add(box(0.0007, 0.038, W), M(o, gy, 0), 0xc6c9b4, { ao: false });
        }
      }
      // top nozzle: frame + adapter plate with holes suggested + hold-down leaf springs
      B.add(box(W + 0.004, 0.012, W + 0.004), M(0, 0.0, 0), 0xb6bbbe, { ao: false });
      for (const [sx, sz, w, d] of [[0, -1, W + 0.008, 0.012], [0, 1, W + 0.008, 0.012], [-1, 0, 0.012, W + 0.008], [1, 0, 0.012, W + 0.008]] as const)
        B.add(box(w, 0.09, d), M((sx * (W + 0.002)) / 2, 0.05, (sz * (W + 0.002)) / 2), 0xb6bbbe, { ao: false });
      B.add(box(W, 0.012, W), M(0, 0.095, 0), 0xc2c7ca, { ao: false });
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        for (let l = 0; l < 3; l++) B.add(box(0.07, 0.006, 0.02), M(Math.sin(a) * 0.075, 0.11 + l * 0.008, Math.cos(a) * 0.075, 0, a + Math.PI / 2, 0.25 - l * 0.05), 0x8e9396, { ao: false });
      }
      // bottom nozzle hint far below (fades in fog)
      const st = B.build(lam(0xffffff, { vertexColors: true }));
      G.add(st);
    }

    // ---- 1: fuel rod cut-away (×15) ----
    {
      const G = mk();
      const B = new GeoBucket();
      const rIn = 0.063;
      const rOut = 0.071;
      const x0 = -1.7;
      const x1 = 1.45;
      // cladding: back half tube along x, plus cut edges
      for (const [r, c] of [[rOut, 0x8f9a96], [rIn, 0xb8c2bd]] as const) {
        const g = halfCyl(r, r, x1 - x0, 40, true);
        g.rotateZ(Math.PI / 2);
        B.add(g, M((x0 + x1) / 2, 0, 0), c, { ao: false });
      }
      for (const sy of [-1, 1]) B.add(box(x1 - x0, rOut - rIn, 0.004), M((x0 + x1) / 2, (sy * (rIn + rOut)) / 2, 0.001), 0x5f6a66, { ao: false });
      // end plugs
      const plug = cyl(rOut, rOut, 0.16, 24);
      plug.rotateZ(Math.PI / 2);
      B.add(plug, M(x0 - 0.08, 0, 0), 0x9aa49f, { ao: false });
      const tip = sphereCap(rOut, true, 20);
      tip.rotateZ(-Math.PI / 2);
      B.add(plug, M(x1 + 0.08, 0, 0), 0x9aa49f, { ao: false });
      B.add(tip, M(x1 + 0.16, 0, 0), 0x9aa49f, { ao: false });
      // plenum spring (helix)
      const pts: THREE.Vector3[] = [];
      const sx0 = 0.62;
      for (let k = 0; k <= 220; k++) {
        const t = k / 220;
        const a = t * Math.PI * 2 * 11;
        pts.push(new THREE.Vector3(sx0 + t * (x1 - sx0 - 0.02), Math.sin(a) * 0.048, Math.cos(a) * 0.048));
      }
      const tg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 260, 0.006, 5, false).toNonIndexed();
      tg.deleteAttribute('uv');
      B.add(tg, null, 0xc8c8c0, { ao: false });
      G.add(B.build(lam(0xffffff, { vertexColors: true, side: THREE.DoubleSide })));
      // pellet stack (dished, chamfered UO2), slightly glowing with fuel temperature
      const prof = [new THREE.Vector2(0, 0.068), new THREE.Vector2(0.03, 0.074), new THREE.Vector2(0.052, 0.074), new THREE.Vector2(0.058, 0.07), new THREE.Vector2(0.058, -0.07), new THREE.Vector2(0.052, -0.074), new THREE.Vector2(0.03, -0.074), new THREE.Vector2(0, -0.068)];
      const pg = new THREE.LatheGeometry(prof, 24);
      pg.rotateZ(Math.PI / 2);
      this.pelletMat = lam(0x4a4440, { emissive: 0x000000 });
      const n = 14;
      const pellets = new THREE.InstancedMesh(pg, this.pelletMat, n);
      for (let k = 0; k < n; k++) pellets.setMatrixAt(k, M(x0 + 0.08 + k * 0.152, 0, 0));
      G.add(pellets);
    }

    // ---- 2: RCCA spider + rodlets over a fuel assembly top nozzle ----
    {
      const G = mk();
      const p = 0.0126;
      const gt = guideThimbles();
      const S = new THREE.Group();
      const B = new GeoBucket();
      B.add(cyl(0.022, 0.022, 0.16, 16), M(0, 0.08, 0), 0xc8ccd0, { ao: false });
      B.add(cyl(0.03, 0.022, 0.03, 16), M(0, 0.17, 0), 0xb0b4b8, { ao: false });
      B.add(cyl(0.012, 0.012, 0.6, 10), M(0, 0.48, 0), 0x9da4a8, { ao: false }); // drive rod
      // vanes: from hub to each guide thimble (as radial arms)
      for (const [i, j] of gt) {
        const x = (i - 8) * p;
        const z = (j - 8) * p;
        const L = Math.hypot(x, z);
        const a = Math.atan2(x, z);
        B.add(box(0.004, 0.02, L), M(x / 2, 0.06, z / 2, 0, a), 0xb7bcc0, { ao: false });
        B.add(cyl(0.0065, 0.0065, 0.03, 8), M(x, 0.05, z), 0xb7bcc0, { ao: false });
      }
      S.add(B.build(lam(0xffffff, { vertexColors: true })));
      const rl = new THREE.CylinderGeometry(0.0048, 0.0048, 0.7, 8);
      rl.translate(0, -0.35 + 0.04, 0);
      const rods = new THREE.InstancedMesh(rl, lam(0xd8dde0), gt.length);
      gt.forEach(([i, j], k) => rods.setMatrixAt(k, M((i - 8) * p, 0, (j - 8) * p)));
      S.add(rods);
      G.add(S);
      this.spiderEx = S;
      // assembly top nozzle + rod tops below (translucent frame)
      const A = new GeoBucket();
      const W = 17 * p;
      A.add(box(W + 0.004, 0.012, W + 0.004), M(0, -0.35, 0), 0xb6bbbe, { ao: false });
      for (const [sx, sz, w, d] of [[0, -1, W + 0.008, 0.012], [0, 1, W + 0.008, 0.012], [-1, 0, 0.012, W + 0.008], [1, 0, 0.012, W + 0.008]] as const)
        A.add(box(w, 0.09, d), M((sx * (W + 0.002)) / 2, -0.3, (sz * (W + 0.002)) / 2), 0xb6bbbe, { ao: false });
      for (let i = 0; i < 17; i++)
        for (let j = 0; j < 17; j++) {
          const g = gt.some(([a, b]) => a === i && b === j);
          A.add(cyl(g ? 0.0061 : 0.00475, g ? 0.0061 : 0.00475, 0.5, 6), M((i - 8) * p, -0.62, (j - 8) * p), g ? 0xd0d6d8 : 0x9aa49f, { ao: false });
        }
      G.add(A.build(lam(0xffffff, { vertexColors: true })));
    }

    // ---- 3: steam generator cut-away (×0.22) ----
    {
      const G = mk();
      const B = new GeoBucket();
      const rL = 0.76;
      const rU = 1.0;
      const hL = 3.0;
      B.add(halfCyl(rL, rL, hL, 40), M(0, hL / 2), 0x8d9499, { ao: false });
      B.add(halfCyl(rU, rL, 0.5, 40), M(0, hL + 0.25), 0x8d9499, { ao: false });
      B.add(halfCyl(rU, rU, 1.6, 40), M(0, hL + 1.3), 0x8d9499, { ao: false });
      B.add(halfSphere(rU, true, 32), M(0, hL + 2.1), 0x8d9499, { ao: false });
      B.add(halfSphere(rL, false, 32), M(0, 0), 0x7d8489, { ao: false });
      B.add(halfCyl(rL, rL, 0.14, 40, false), M(0, 0.07), 0x6a6f74, { ao: false }); // tube sheet
      B.add(box(0.03, rL, rL), M(0, -rL / 2, -rL / 2), 0x6a6f74, { ao: false }); // divider plate
      B.add(halfCyl(0.68, 0.68, 2.6, 36, true), M(0, 1.45), 0x9aa0a4, { ao: false }); // wrapper
      for (const sx of [-1, 1]) {
        B.add(cyl(0.2, 0.2, 0.6, 16), M(sx * 0.45, -0.45, 0.25, Math.PI / 2, 0), 0xd2d2c8, { ao: false }); // primary nozzles
      }
      // U-tubes
      this.sgPaths = [];
      for (let k = 0; k < 10; k++) {
        const z = -0.03 - k * 0.062;
        const maxR = Math.sqrt(0.64 * 0.64 - z * z) - 0.03;
        for (let rr = 0.06; rr < maxR; rr += 0.065) {
          const hs = 2.35;
          B.add(cyl(0.011, 0.011, hs - 0.14, 5), M(-rr, 0.14 + (hs - 0.14) / 2, z), 0xc9b9a0, { ao: false });
          B.add(cyl(0.011, 0.011, hs - 0.14, 5), M(rr, 0.14 + (hs - 0.14) / 2, z), 0xc9b9a0, { ao: false });
          B.add(torus(rr, 0.011, 5, 14, Math.PI), M(0, hs, z), 0xc9b9a0, { ao: false });
          if (k < 4 && this.sgPaths.length < 26) {
            const path: THREE.Vector3[] = [new THREE.Vector3(-rr, 0.14, z), new THREE.Vector3(-rr, hs, z)];
            for (let a = 1; a < 8; a++) path.push(new THREE.Vector3(-rr * Math.cos((a / 8) * Math.PI), hs + rr * Math.sin((a / 8) * Math.PI), z));
            path.push(new THREE.Vector3(rr, hs, z), new THREE.Vector3(rr, 0.14, z));
            this.sgPaths.push(path);
          }
        }
      }
      // separators, dryer bank, feed ring
      for (let k = 0; k < 5; k++) {
        const x = -0.6 + k * 0.3;
        B.add(cyl(0.11, 0.11, 0.6, 14), M(x, hL + 0.95, -0.25), 0xa4aaae, { ao: false });
        B.add(cyl(0.13, 0.11, 0.08, 14), M(x, hL + 1.28, -0.25), 0x8a9094, { ao: false });
      }
      B.add(box(1.6, 0.35, 0.5), M(0, hL + 1.75, -0.45), 0x7a8086, { ao: false });
      B.add(torus(0.7, 0.03, 6, 32, Math.PI), M(0, hL - 0.15, 0, Math.PI / 2, Math.PI), 0xb0b6ba, { ao: false });
      G.add(B.build(lam(0xffffff, { vertexColors: true, side: THREE.DoubleSide })));
      // secondary water (transparent) + boiling
      const wg = mergeRaw([halfCyl(0.74, 0.74, 3.0, 32, false), (() => { const f = new THREE.PlaneGeometry(1.48, 3.0).toNonIndexed(); f.deleteAttribute('uv'); return f; })()]);
      const w = new THREE.Mesh(wg, new THREE.MeshLambertMaterial({ color: 0x4f8fb0, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
      w.position.y = 1.65;
      w.renderOrder = 2;
      G.add(w);
      let r = this.points(260, 0xeaf6ff, 0.035, 0.7, false);
      this.exBubbles = r.pts;
      for (let i = 0; i < 260; i++) {
        r.data[i * 3] = (Math.random() - 0.5) * 1.3;
        r.data[i * 3 + 1] = 0.2 + Math.random() * 2.9;
        r.data[i * 3 + 2] = -Math.random() * 0.65;
      }
      G.add(this.exBubbles);
      r = this.points(400, 0xff6a3a, 0.04, 0.95, true);
      this.sgFlow = r.pts;
      this.sgFlowData = r.data;
      this.sgFlowState = new Float32Array(400);
      for (let i = 0; i < 400; i++) this.sgFlowState[i] = Math.random();
      const cols = new Float32Array(400 * 3);
      this.sgFlow.geometry.setAttribute('color', new THREE.BufferAttribute(cols, 3).setUsage(THREE.DynamicDrawUsage));
      (this.sgFlow.material as THREE.PointsMaterial).vertexColors = true;
      (this.sgFlow.material as THREE.PointsMaterial).color.set(0xffffff);
      G.add(this.sgFlow);
    }

    // ---- 4: pressurizer cut-away (drawn squat: widened 1.7x so it reads on a wide screen) ----
    {
      const G = mk();
      G.scale.set(1.7, 1, 1.7);
      const B = new GeoBucket();
      const r = 0.42;
      const y0 = 0.45;
      const y1 = PRZ_TOP;
      B.add(halfCyl(r + 0.03, r + 0.03, y1 - y0, 36), M(0, (y0 + y1) / 2), 0x8d9499, { ao: false });
      B.add(halfSphere(r + 0.03, true, 28), M(0, y1), 0x8d9499, { ao: false });
      B.add(halfSphere(r + 0.03, false, 28), M(0, y0), 0x8d9499, { ao: false });
      for (const sx of [-1, 1]) B.add(box(0.03, y1 - y0, 0.01), M(sx * (r + 0.015), (y0 + y1) / 2, 0.002), 0x5f666a, { ao: false });
      B.add(cyl(0.07, 0.07, 1.0, 12), M(0, y0 - r - 0.5), 0xd2d2c8, { ao: false }); // surge line
      B.add(cyl(0.045, 0.045, 0.7, 10), M(0.12, y1 + r + 0.25), 0xd2d2c8, { ao: false }); // spray line
      for (let k = 0; k < 3; k++) B.add(cyl(0.05, 0.06, 0.28, 10), M(-0.25 + k * 0.12, y1 + 0.34, -0.12), 0xb03a2a, { ao: false }); // safeties/PORV
      B.add(cyl(0.06, 0.03, 0.08, 12), M(0.12, y1 + 0.2, 0), 0x9aa0a4, { ao: false }); // spray nozzle
      G.add(B.build(lam(0xffffff, { vertexColors: true, side: THREE.DoubleSide })));
      // heaters
      const hg = new THREE.CylinderGeometry(0.009, 0.009, 1.05, 6);
      hg.translate(0, 0.525, 0);
      this.heaterMat = lam(0x8a8f92, { emissive: 0x000000 });
      const heaters: [number, number][] = [];
      for (let i = -6; i <= 6; i++) for (let j = -6; j <= 0; j++) if (Math.hypot(i, j) * 0.055 < r - 0.05) heaters.push([i * 0.055, j * 0.055]);
      const hm = new THREE.InstancedMesh(hg, this.heaterMat, heaters.length);
      heaters.forEach(([x, z], k) => hm.setMatrixAt(k, M(x, y0 - 0.25, z)));
      G.add(hm);
      const wg = mergeRaw([halfCyl(r - 0.005, r - 0.005, 1, 32, false), (() => { const f = new THREE.PlaneGeometry(2 * (r - 0.005), 1).toNonIndexed(); f.deleteAttribute('uv'); return f; })()]);
      wg.translate(0, 0.5, 0);
      this.przWater = new THREE.Mesh(wg, new THREE.MeshLambertMaterial({ color: 0x4f8fb0, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }));
      this.przWater.position.y = y0 - 0.3;
      this.przWater.renderOrder = 2;
      G.add(this.przWater);
      let p = this.points(160, 0xeaf6ff, 0.03, 0.8, false);
      this.przBubbles = p.pts;
      this.przBubbleData = p.data;
      for (let i = 0; i < 160; i++) {
        p.data[i * 3] = (Math.random() - 0.5) * 0.7;
        p.data[i * 3 + 1] = y0 + Math.random() * 2;
        p.data[i * 3 + 2] = -Math.random() * 0.35;
      }
      G.add(this.przBubbles);
      p = this.points(120, 0xdff0ff, 0.035, 0.0, false);
      this.przSpray = p.pts;
      for (let i = 0; i < 120; i++) {
        p.data[i * 3] = 0.12;
        p.data[i * 3 + 1] = y1 + 0.15;
        p.data[i * 3 + 2] = 0;
      }
      this.przSprayState = new Float32Array(120 * 3);
      for (let i = 0; i < 120; i++) {
        this.przSprayState[i * 3] = Math.random();
        this.przSprayState[i * 3 + 1] = (Math.random() - 0.5) * 0.5;
        this.przSprayState[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
      }
      G.add(this.przSpray);
    }
  }
  private sgFlowState!: Float32Array;
  private przSprayState!: Float32Array;

  private buildFade() {
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffd2a0, transparent: true, opacity: 0, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const fq = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), this.flashMat);
    fq.position.set(0, 0, -0.21);
    fq.renderOrder = 998;
    fq.frustumCulled = false;
    this.camera.add(fq);
    this.fadeMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), this.fadeMat);
    q.position.set(0, 0, -0.2);
    q.renderOrder = 999;
    q.frustumCulled = false;
    this.camera.add(q);
  }

  /* ================================================================ */
  /* input: drag to look, wheel to zoom (pointer is not locked here)   */
  /* ================================================================ */
  private attachInput(canvas: HTMLCanvasElement) {
    // The UI's camera-feed overlay covers the canvas, so listen on the window (capture phase)
    // and only ignore presses that land on its controls.
    const onControl = (t: EventTarget | null) =>
      t instanceof Element && t !== canvas && !!t.closest('button, a, input, select, textarea, label, [role="button"], [data-act]');
    window.addEventListener(
      'mousedown',
      (e) => {
        if (!this.enabled || e.button !== 0 || onControl(e.target)) return;
        this.look.drag = true;
        this.look.lx = e.clientX;
        this.look.ly = e.clientY;
      },
      true,
    );
    window.addEventListener('mouseup', () => (this.look.drag = false));
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || !this.look.drag) return;
      const k = 0.004 * (this.look.fov / 55);
      this.look.yaw = Math.max(-0.75, Math.min(0.75, this.look.yaw - (e.clientX - this.look.lx) * k));
      this.look.pitch = Math.max(-0.5, Math.min(0.5, this.look.pitch - (e.clientY - this.look.ly) * k));
      this.look.lx = e.clientX;
      this.look.ly = e.clientY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled || onControl(e.target)) return;
        this.look.fov = Math.max(22, Math.min(70, this.look.fov + (e.deltaY > 0 ? 3 : -3)));
      },
      { passive: true },
    );
  }

  /* ================================================================ */
  /* modes                                                             */
  /* ================================================================ */
  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.look.drag = false;
  }

  setMode(mode: 'reactor-cam' | 'tour') {
    this.mode = mode;
    this.applyViewOffset();
    this.look.yaw = 0;
    this.look.pitch = 0;
    this.look.fov = 55;
    if (mode === 'reactor-cam') {
      this.tw = null;
      this.fade = 0;
      this.introFade = 0.8;
      this.setSpace('plant');
      this.camPos.set(1.7, 4.8, 8.8);
      this.camLook.set(0, -2.3, 0);
    } else {
      this.stop = 0;
      const s = STOPS[0];
      this.setSpace(s.space);
      this.camPos.set(s.pos[0] + 1.2, s.pos[1] + 0.9, s.pos[2] + 1.6);
      this.camLook.set(...s.look);
      this.goTo(0, false);
      this.introFade = 1;
    }
  }

  tourNav(d: 1 | -1) {
    if (this.mode !== 'tour') return;
    const j = Math.max(0, Math.min(STOPS.length - 1, this.stop + d));
    if (j === this.stop && !this.tw) {
      this.emitStop();
      return;
    }
    this.goTo(j, true);
  }

  private goTo(j: number, allowFade: boolean) {
    const from = STOPS[this.stop];
    const to = STOPS[j];
    this.stop = j;
    const fade = allowFade && (from.space !== to.space || to.space !== 'plant');
    const off = to.space === 'plant' ? new THREE.Vector3() : EXHIBIT_BASE;
    this.tw = {
      from: this.camPos.clone(),
      fromL: this.camLook.clone(),
      to: new THREE.Vector3(...to.pos).add(off),
      toL: new THREE.Vector3(...to.look).add(off),
      t: 0,
      dur: fade ? 1.2 : 2.4,
      fade,
      switched: !fade,
    };
    if (!fade) this.setSpace(to.space);
    this.look.yaw = 0;
    this.look.pitch = 0;
  }

  private emitStop() {
    const s = STOPS[this.stop];
    bus.emit('tour-stop', { index: this.stop, count: STOPS.length, title: s.title, text: s.text });
  }

  private setSpace(sp: 'plant' | number) {
    this.space = sp;
    this.plant.visible = sp === 'plant';
    this.exhibits.forEach((g, i) => (g.visible = sp === i));
    if (sp === 'plant') {
      (this.scene.background as THREE.Color).set(0x0d1014);
    } else {
      (this.scene.background as THREE.Color).set(0x06202c);
    }
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.applyViewOffset();
  }

  /** in the tour the caption card covers the lower part of the screen: shift the picture up */
  private applyViewOffset() {
    if (this.mode === 'tour') {
      const h = 1000;
      const w = h * this.camera.aspect;
      this.camera.setViewOffset(w, h, 0, h * 0.12, w, h);
    } else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  get stopCount() {
    return STOPS.length;
  }

  /* ================================================================ */
  /* per frame                                                         */
  /* ================================================================ */
  update(dt: number, s: PlantState | undefined) {
    this.time += dt;
    const t = this.time;
    if (s) this.updatePlant(dt, s);
    if (s && this.space !== 'plant') this.updateExhibits(dt, s);

    // ---- camera ----
    if (this.tw) {
      const w = this.tw;
      w.t += dt / w.dur;
      if (w.fade) {
        // fade out, jump, fade in
        if (w.t < 0.4) this.fade = w.t / 0.4;
        else {
          if (!w.switched) {
            w.switched = true;
            this.setSpace(STOPS[this.stop].space);
            this.camPos.copy(w.to).add(this._v.set(0.25, 0.12, 0.3));
            this.camLook.copy(w.toL);
          }
          this.fade = Math.max(0, 1 - (w.t - 0.4) / 0.4);
          this.camPos.lerp(w.to, 1 - Math.exp(-4 * dt));
        }
      } else {
        const k = smooth(Math.min(1, w.t));
        this.camPos.lerpVectors(w.from, w.to, k);
        this.camPos.y += Math.sin(k * Math.PI) * 0.8 * Math.min(1, w.from.distanceTo(w.to) / 6);
        this.camLook.lerpVectors(w.fromL, w.toL, k);
        this.fade = 0;
      }
      if (w.t >= 1) {
        this.camPos.copy(w.to);
        this.camLook.copy(w.toL);
        this.tw = null;
        this.fade = 0;
        this.emitStop();
      }
    }
    if (this.introFade > 0) this.introFade = Math.max(0, this.introFade - dt * 1.2);
    const fd = Math.max(this.fade, this.introFade);
    this.fadeMat.opacity = fd;
    this.fadeMat.visible = fd > 0.001;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 0.35);
    this.flashMat.opacity = Math.min(1, Math.pow(this.flash, 4) * 1.4);
    this.flashMat.visible = this.flashMat.opacity > 0.003;

    const sway = this.mode === 'reactor-cam' ? 1 : 0.35;
    this.camera.position.copy(this.camPos);
    this.camera.position.x += Math.sin(t * 0.7) * 0.02 * sway;
    this.camera.position.y += Math.sin(t * 1.1 + 1) * 0.015 * sway;
    if (this.mode === 'tour' && !this.tw) {
      // slow drift around the stop
      this.camera.position.x += Math.sin(t * 0.25) * 0.05 * (this.space === 'plant' ? 3 : 1);
      this.camera.position.z += Math.cos(t * 0.21) * 0.03 * (this.space === 'plant' ? 3 : 1);
    }
    this.camera.lookAt(this.camLook);
    if (this.flash > 0.05 && this.space === 'plant') {
      // the blast shakes the camera
      const k = this.flash * this.flash * 0.05;
      this.camera.position.x += (Math.random() - 0.5) * k * 4;
      this.camera.position.y += (Math.random() - 0.5) * k * 4;
      this.camera.rotateZ((Math.random() - 0.5) * k);
      this.camera.rotateX((Math.random() - 0.5) * k * 0.6);
    }
    this._e.set(this.look.pitch + Math.sin(t * 0.9) * 0.006 * sway, this.look.yaw + Math.sin(t * 0.63) * 0.008 * sway, Math.sin(t * 0.5) * 0.006 * sway, 'YXZ');
    this._q.setFromEuler(this._e);
    this.camera.quaternion.multiply(this._q);
    const tf = this.look.fov;
    if (Math.abs(this.camera.fov - tf) > 0.05) {
      this.camera.fov += (tf - this.camera.fov) * (1 - Math.exp(-10 * dt));
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  private updatePlant(dt: number, s: PlantState) {
    const t = this.time;
    const n = Math.max(0, s.neutronPower ?? 0);
    const decay = Math.max(0, s.decayHeat ?? 0);
    const flowAvg = loopFlow(s);
    const dmg = clamp01(s.fuelDamage ?? 0);
    const melt = s.coreStatus === 'meltdown' ? 1 : 0;
    const cat = s.catastrophe?.kind ?? null;
    // Cherenkov ~ log power; decay-heat gammas keep a faint glow after shutdown
    const logG = clamp01((Math.log10(Math.max(n, 1e-12)) + 6) / 6);
    let g = Math.pow(logG, 2.6);
    g = Math.max(g, 0.22 * Math.pow(clamp01(decay / 0.07), 0.7));
    // level
    let level = 1;
    const lvl = s.ext?.coreLevelPct;
    if (Number.isFinite(lvl as number) && (lvl as number) < 100) level = clamp01((lvl as number) / 100) * 0.62;
    if (s.coreUncovered) level = Math.min(level, 0.45);
    if (cat === 'vessel-rupture' || cat === 'steam-explosion') level = Math.min(level, 0.15);
    // boiling & steam
    const sub = s.subcoolingMargin ?? 50;
    let boil = clamp01((25 - sub) / 25);
    if (n > 0.2 && flowAvg < 0.4) boil = Math.max(boil, clamp01((n - 0.2) * 2) * (1 - flowAvg / 0.4));
    boil = Math.max(boil, clamp01(1 - level / 0.62) * (g > 0.05 || decay > 0.005 ? 1 : 0));
    const lowP = clamp01((1400 - (s.rcsPressure ?? 2235)) / 1100);
    const leak = clamp01((s.rcsLeakGpm ?? 0) / 300);
    let steam = Math.max(lowP * 0.7, leak);
    if (cat) steam = Math.max(steam, 0.7);
    const fuelT = Math.max(s.cladTemp ?? 600, s.ext?.clad?.maxTempF ?? 0);
    const hot = clamp01((fuelT - 750) / 2400);

    const k = 1 - Math.exp(-2.5 * dt);
    this.glowV += (g * (level > 0.55 ? 1 : 0.35 + level) - this.glowV) * k;
    this.levelV += (level - this.levelV) * (1 - Math.exp(-0.8 * dt));
    this.boilV += (boil - this.boilV) * k;
    this.steamV += (steam - this.steamV) * (1 - Math.exp(-0.6 * dt));
    this.damageV += (Math.max(dmg, melt) - this.damageV) * (1 - Math.exp(-0.5 * dt));
    this.fuelHotV += (Math.max(hot, this.damageV * 0.8) - this.fuelHotV) * k;

    // glow & water
    const G = this.glowV;
    this.glowMat.color.setRGB(0.02 * G, 0.17 * G, 0.72 * G);
    this.glowMat.visible = G > 0.004;
    this.waterMat.emissive.setRGB(0.01 * G, 0.1 * G, 0.38 * G);
    this.coreLight.intensity = 22 * G + 30 * this.fuelHotV;
    this.coreLight.color.setRGB(0.23, 0.63, 1).lerp(this._c.setRGB(1, 0.42, 0.12), clamp01(this.fuelHotV * 1.5));
    const wb = SHELL_BOT - R_IN + 0.15;
    const top = -0.05;
    const lvY = this.levelV >= 0.999 ? top : CORE_BOT + (this.levelV / 0.62) * (top - CORE_BOT) * 0.62;
    const lvClamped = Math.max(wb + 0.05, Math.min(top, this.levelV >= 0.62 ? top : CORE_BOT - 0.4 + (this.levelV / 0.62) * (CORE_H + 3.0)));
    void lvY;
    this.water.position.y = wb;
    this.water.scale.y = lvClamped - wb;
    this.water.visible = cat !== 'steam-explosion' || this.levelV > 0.05;

    // fuel colour: hot → orange → white; damage darkens & slumps
    const h = this.fuelHotV;
    this._c.setRGB(0, 0, 0);
    if (h > 0.02) this._c.setRGB(1.6 * h, 0.55 * h * h + 0.1 * h, 0.25 * h * h * h);
    this.fuelMat.emissive.copy(this._c).addScalar(0);
    this.fuelMat.emissive.r += 0.02 * G;
    this.fuelMat.emissive.g += 0.05 * G;
    this.fuelMat.emissive.b += 0.15 * G;
    const D = this.damageV;
    if (Math.abs(D - this.lastDamageApplied) > 0.01) {
      this.lastDamageApplied = D;
      for (let i = 0; i < this.fuelPos.length; i++) {
        const p = this.fuelPos[i];
        const rnd = ((i * 7919) % 97) / 97;
        const slump = clamp01(D * 1.6 - rnd * 0.6);
        const hh = 1 - 0.85 * slump;
        this._q.setFromEuler(this._e.set((rnd - 0.5) * 0.5 * slump, 0, (rnd * 1.7 % 1 - 0.5) * 0.6 * slump));
        this._v.set(p.x, CORE_BOT + (CORE_H * hh) / 2 - slump * 0.6, p.z);
        this._s.set(1, hh, 1);
        this.fuel.setMatrixAt(i, this._m.compose(this._v, this._q, this._s));
      }
      this.fuel.instanceMatrix.needsUpdate = true;
      this.fuelMat.color.setScalar(1 - 0.6 * D);
    }
    // melt pool
    this.melt.visible = D > 0.05;
    if (this.melt.visible) {
      const sc = 0.4 + 0.6 * D;
      this.melt.scale.set(sc, 0.6 + 1.6 * D, sc);
      this.melt.position.y = (melt ? SHELL_BOT - 2.0 : CORE_BOT - 0.15) ;
      const pulse = 0.8 + 0.2 * Math.sin(t * 3.1);
      this.meltMat.emissive.setRGB(1.6 * D * pulse, 0.35 * D * pulse, 0.05 * D);
    }
    this.meltLight.intensity = 45 * D * (0.85 + 0.15 * Math.sin(t * 2.3));

    // rods: displayed position follows the bank; gravity drop when inserting fast
    const rods = s.rods as Record<RodBankId, number> | undefined;
    for (let i = 0; i < this.nVisRods; i++) {
      const r = this.rccas[i];
      const tgt = clamp01((rods?.[r.bank] ?? 0) / 228);
      if (tgt < r.pos) r.pos = Math.max(tgt, r.pos - dt * (s.reactorTripped ? 0.7 : 0.25));
      else r.pos = Math.min(tgt, r.pos + dt * 0.25);
      const ySp = CORE_TOP + 0.12 + r.pos * CORE_H;
      this._q.identity();
      this._s.set(1, 1, 1);
      this._v.set(r.x, ySp, r.z);
      this.spiders.setMatrixAt(i, this._m.compose(this._v, this._q, this._s));
      this._s.set(1, CORE_H, 1);
      this.bundles.setMatrixAt(i, this._m.compose(this._v, this._q, this._s));
      this._s.set(1, Math.max(0.1, 6.3 - ySp), 1);
      this.drives.setMatrixAt(i, this._m.compose(this._v, this._q, this._s));
    }
    this.spiders.instanceMatrix.needsUpdate = true;
    this.bundles.instanceMatrix.needsUpdate = true;
    this.drives.instanceMatrix.needsUpdate = true;

    // bubbles
    const bd = this.bubbleData;
    const waterTop = this.water.position.y + this.water.scale.y;
    const bm = this.bubbles.material as THREE.PointsMaterial;
    bm.opacity = Math.min(0.85, this.boilV * 1.2);
    this.bubbles.visible = this.boilV > 0.02;
    if (this.bubbles.visible) {
      const nAct = Math.floor(420 * this.boilV);
      for (let i = 0; i < 420; i++) {
        if (i >= nAct) {
          bd[i * 3 + 1] = -100;
          continue;
        }
        if (bd[i * 3 + 1] < -50) this.respawnBubble(i, false);
        bd[i * 3 + 1] += dt * (0.8 + (i % 7) * 0.12) * (0.6 + flowAvg);
        bd[i * 3] += Math.sin(t * 3 + i) * 0.002;
        if (bd[i * 3 + 1] > waterTop) this.respawnBubble(i, false);
      }
      this.bubbles.geometry.attributes.position.needsUpdate = true;
    }

    // flow tracers (show RCP flow; brighter/larger in the tour)
    const tour = this.mode === 'tour';
    this.flowMat.size = tour ? 0.11 : 0.06;
    this.flowMat.opacity = (tour ? 0.9 : 0.45) * clamp01(flowAvg * 1.5 + 0.05) * (this.levelV > 0.6 ? 1 : 0.3);
    this.flow.visible = this.flowMat.opacity > 0.02;
    if (this.flow.visible) {
      const fs = this.flowState;
      const fd = this.flowData;
      const sp = dt * 0.09 * (0.05 + flowAvg);
      const inA = [157.5 * DEG, 247.5 * DEG];
      const outA = [112.5 * DEG, 202.5 * DEG];
      for (let i = 0; i < 700; i++) {
        let ph = fs[i * 3] + sp * (0.8 + fs[i * 3 + 2] * 0.4);
        if (ph >= 1) ph -= 1;
        fs[i * 3] = ph;
        const jit = fs[i * 3 + 2];
        const aR = Math.PI / 2 + fs[i * 3 + 1] * Math.PI; // back half
        let x: number, y: number, z: number;
        const side = i & 1 ? -1 : 1; // which section edge the particle's downcomer run shows on
        const rD = (R_IN + BARREL_R) / 2 + (jit - 0.5) * 0.22;
        if (ph < 0.1) {
          // cold leg into the inlet nozzle
          const a = inA[i & 1];
          const r = 3.8 - (ph / 0.1) * (3.8 - rD);
          x = Math.sin(a) * r;
          z = Math.cos(a) * r;
          y = NOZZLE_Y + (jit - 0.5) * 0.3;
        } else if (ph < 0.45) {
          // round the downcomer to the section edge, then down it
          const u = (ph - 0.1) / 0.35;
          const a = inA[i & 1] + ((side > 0 ? Math.PI / 2 : Math.PI * 1.5) - inA[i & 1]) * Math.min(1, u * 4);
          x = Math.sin(a) * rD;
          z = Math.cos(a) * rD + Math.min(1, u * 4) * 0.12;
          y = NOZZLE_Y - Math.max(0, u - 0.1) / 0.9 * (NOZZLE_Y - (SHELL_BOT - 0.3));
        } else if (ph < 0.55) {
          // turn in the lower plenum
          const u = (ph - 0.45) / 0.1;
          const xe = (jit * 2 - 1) * 1.5;
          x = side * rD + (xe - side * rD) * u;
          z = 0.12 + 0.1 * u;
          y = SHELL_BOT - 0.3 - Math.sin(u * Math.PI) * 1.2 + u * 0.3;
        } else if (ph < 0.9) {
          // up through the core, in front of the fuel face
          const u = (ph - 0.55) / 0.35;
          x = (jit * 2 - 1) * 1.5;
          z = 0.22;
          y = SHELL_BOT + u * (NOZZLE_Y + 0.3 - SHELL_BOT);
        } else {
          // out of the hot-leg nozzle
          const u = (ph - 0.9) / 0.1;
          const a = outA[i & 1];
          const x0 = (jit * 2 - 1) * 1.5;
          const xe = Math.sin(a) * 3.8;
          const ze = Math.cos(a) * 3.8;
          x = x0 + (xe - x0) * u;
          z = 0.22 + (ze - 0.22) * u;
          y = NOZZLE_Y + 0.3 - u * 0.3 + (jit - 0.5) * 0.3;
        }
        fd[i * 3] = x;
        fd[i * 3 + 1] = y;
        fd[i * 3 + 2] = z;
      }
      this.flow.geometry.attributes.position.needsUpdate = true;
    }

    // steam puffs & smoke
    this.puffs(this.steam, this.steamData, this.steamV * 0.4, dt, 1.6, waterTop);
    this.puffs(this.smoke, this.smokeData, Math.min(0.75, this.damageV * 1.4 + (cat ? 0.4 : 0)), dt, 1.2, waterTop);
    // fog thickens with steam / dust
    const dust = this.exploded ? 1 : 0;
    this.fog.color.setRGB(0.1 + 0.22 * this.steamV + 0.09 * dust, 0.12 + 0.22 * this.steamV + 0.06 * dust, 0.15 + 0.22 * this.steamV + 0.03 * dust);
    if (this.space === 'plant') {
      this.fog.density = 0.006 + 0.022 * this.steamV + 0.016 * dust;
      (this.scene.background as THREE.Color).copy(this.fog.color).multiplyScalar(0.6);
    }

    // SI injection jets
    const siOn = !!s.siActuated && (s.siFlowGpm ?? 0) > 1;
    const sm = this.si.material as THREE.PointsMaterial;
    sm.opacity = siOn ? 0.75 : 0;
    this.si.visible = siOn;
    if (siOn) {
      const st = this.siState;
      const d = this.siData;
      for (let i = 0; i < 240; i++) {
        st[i] += dt * 0.6;
        if (st[i] > 1) st[i] -= 1;
        const u = st[i];
        const a = (i & 1 ? 157.5 : 247.5) * DEG;
        const r = u < 0.4 ? 4.6 - (u / 0.4) * (4.6 - 2.0) : 2.0;
        const y = u < 0.4 ? NOZZLE_Y + 0.15 : NOZZLE_Y - (u - 0.4) * 9;
        d[i * 3] = Math.sin(a) * r + Math.sin(i * 1.3) * 0.08;
        d[i * 3 + 1] = y;
        d[i * 3 + 2] = Math.cos(a) * r + Math.cos(i * 1.7) * 0.08;
      }
      this.si.geometry.attributes.position.needsUpdate = true;
    }

    // catastrophes: head blown off + debris + dust
    if ((cat === 'steam-explosion' || cat === 'vessel-rupture' || cat === 'containment-failure') && !this.exploded) this.explode(cat);
    if (!cat && this.exploded && s.t !== undefined && this.sim.state === s && s.fuelDamage === 0) this.unexplode();
    if (this.exploded) this.updateDebris(dt);
    (this.dust.material as THREE.PointsMaterial).opacity = this.exploded ? 0.22 : 0;
    this.dust.visible = this.exploded;

    // beacons: rotating red beams when tripped / SI / emergency
    const alarm = s.reactorTripped || s.siActuated || !!cat || (s.coreStatus ?? 'ok') !== 'ok';
    this.beacons.visible = alarm;
    this.beaconMat.opacity = alarm ? 0.16 : 0;
    this.beaconLampMat.color.setRGB(alarm ? 3 : 0.2, alarm ? 0.25 : 0.03, alarm ? 0.15 : 0.02);
    if (alarm) {
      for (let i = 0; i < 4; i++) {
        const p = this.beaconPos(i);
        this._q.setFromEuler(this._e.set(0, t * 4.2 + i * 1.3, 0));
        this._s.set(1, 1, 1);
        this.beacons.setMatrixAt(i, this._m.compose(p, this._q, this._s));
      }
      this.beacons.instanceMatrix.needsUpdate = true;
      this.beaconLight.intensity = 30 * (0.5 + 0.5 * Math.sin(t * 8.4));
    } else this.beaconLight.intensity = 0;
    // light level: dimmer under emergency
    const ex = this.space !== 'plant';
    this.hemi.intensity = ex ? 1.25 : cat ? 0.35 : 0.85;
    this.sun.intensity = ex ? 1.0 : cat ? 0.4 : 1.3;
    this.lamp.intensity = ex ? 1.1 * this.camPos.distanceTo(this.camLook) : 0;
  }

  private puffs(p: THREE.Points, d: Float32Array, amt: number, dt: number, rise: number, waterTop: number) {
    const m = p.material as THREE.PointsMaterial;
    m.opacity = amt * 0.5;
    p.visible = amt > 0.02;
    if (!p.visible) return;
    for (let i = 0; i < d.length / 3; i++) {
      d[i * 3 + 1] += dt * rise * (0.6 + (i % 5) * 0.15);
      d[i * 3] += Math.sin(this.time * 0.3 + i) * dt * 0.2;
      if (d[i * 3 + 1] > 16) {
        this.respawnPuff(d, i, false);
        d[i * 3 + 1] = Math.max(waterTop, -2) + Math.random();
      }
    }
    p.geometry.attributes.position.needsUpdate = true;
  }

  private explode(kind: string) {
    this.exploded = true;
    this.headT = 0;
    this.debris.visible = true;
    this.drives.visible = false; // drive shafts leave with the head
    this.flash = kind === 'containment-failure' ? 0.8 : 1;
    for (let i = 0; i < this.debrisState.length; i++) {
      const st = this.debrisState[i];
      const a = Math.random() * Math.PI * 2;
      st.p.set(Math.sin(a) * Math.random() * 2, kind === 'containment-failure' ? DECK_Y + 20 + Math.random() * 8 : 0.5 + Math.random() * 2, Math.cos(a) * Math.random() * 2);
      const sp = kind === 'containment-failure' ? 2 : 6 + Math.random() * 14;
      st.v.set(Math.sin(a) * sp * 0.6, kind === 'containment-failure' ? -2 : sp, Math.cos(a) * sp * 0.6);
      st.r.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      st.w.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      st.rest = false;
    }
  }
  private unexplode() {
    this.exploded = false;
    this.debris.visible = false;
    this.drives.visible = true;
    this.flash = 0;
    this.head.position.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
  }
  private updateDebris(dt: number) {
    const kind = this.sim.state?.catastrophe?.kind;
    if (kind !== 'containment-failure') {
      // the head is thrown up and lands tilted on the deck
      this.headT = Math.min(1, this.headT + dt * 0.6);
      const u = this.headT;
      this.head.position.set(-5 * u, Math.sin(u * Math.PI) * 14 + u * 0.8, -6 * u);
      this.head.rotation.set(0.5 * u, u * 1.2, 0.35 * u);
    }
    for (let i = 0; i < this.debrisState.length; i++) {
      const st = this.debrisState[i];
      if (!st.rest) {
        st.v.y -= 9.8 * dt;
        st.p.addScaledVector(st.v, dt);
        st.r.x += st.w.x * dt;
        st.r.y += st.w.y * dt;
        const r = Math.hypot(st.p.x, st.p.z);
        const floor = r < CAV_R ? CAV_FLOOR + 0.2 : DECK_Y + 0.15;
        if (r > CONT_R - 0.5) {
          st.p.x *= (CONT_R - 0.5) / r;
          st.p.z *= (CONT_R - 0.5) / r;
          st.v.x *= -0.3;
          st.v.z *= -0.3;
        }
        if (st.p.y < floor && st.v.y < 0) {
          st.p.y = floor;
          st.v.multiplyScalar(0.3);
          st.v.y = -st.v.y * 0.3;
          if (Math.abs(st.v.y) < 0.5) st.rest = true;
        }
      }
      this._q.setFromEuler(st.r);
      const sc = 0.5 + ((i * 37) % 10) / 10;
      this._s.set(sc, sc * 0.7, sc);
      this.debris.setMatrixAt(i, this._m.compose(st.p, this._q, this._s));
    }
    this.debris.instanceMatrix.needsUpdate = true;
  }

  private updateExhibits(dt: number, s: PlantState) {
    const t = this.time;
    const ex = this.space as number;
    if (ex === 1) {
      const T = Math.max(s.fuelTempCenterline ?? 600, 500);
      const h = clamp01((T - 500) / 3500);
      this.pelletMat.emissive.setRGB(0.55 * h + 0.02, 0.14 * h * h, 0.03 * h * h * h);
    } else if (ex === 2) {
      // RCCA cycle: hold up, gravity drop, dashpot, slow withdrawal
      const cyc = 6.5;
      const u = (t % cyc) / cyc;
      const top = 0.36;
      let y: number;
      if (u < 0.35) y = top;
      else if (u < 0.45) {
        const f = (u - 0.35) / 0.1;
        y = top - top * f * f;
      } else if (u < 0.55) y = 0;
      else y = ((u - 0.55) / 0.45) * top;
      this.spiderEx.position.y = y;
    } else if (ex === 3) {
      // primary flow through the U-tubes: hot (red) up the left leg, cold (blue) down the right
      const st = this.sgFlowState;
      const d = this.sgFlowData;
      const col = this.sgFlow.geometry.getAttribute('color') as THREE.BufferAttribute;
      const np = this.sgPaths.length;
      const flowAvg = loopFlow(s);
      for (let i = 0; i < 400; i++) {
        st[i] = (st[i] + dt * 0.12 * (0.1 + flowAvg)) % 1;
        const path = this.sgPaths[i % np];
        const f = st[i] * (path.length - 1);
        const k = Math.floor(f);
        const a = path[k];
        const b = path[Math.min(path.length - 1, k + 1)];
        const w = f - k;
        d[i * 3] = a.x + (b.x - a.x) * w;
        d[i * 3 + 1] = a.y + (b.y - a.y) * w;
        d[i * 3 + 2] = a.z + 0.016;
        const c = st[i];
        col.setXYZ(i, 1.2 - 0.9 * c, 0.35 + 0.1 * c, 0.15 + 1.0 * c);
      }
      col.needsUpdate = true;
      this.sgFlow.geometry.attributes.position.needsUpdate = true;
      const bd = this.exBubbles.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < bd.count; i++) {
        let y = bd.getY(i) + dt * (0.4 + (i % 5) * 0.08);
        if (y > 3.1) y = 0.2;
        bd.setY(i, y);
      }
      bd.needsUpdate = true;
    } else if (ex === 4) {
      const kw = clamp01((s.przHeaterKW ?? 0) / 1800);
      this.heaterMat.emissive.setRGB(1.4 * kw, 0.35 * kw, 0.05 * kw);
      const y0 = 0.45 - 0.3;
      const lv = 0.45 + (PRZ_TOP - 0.45) * clamp01((s.przLevel ?? 50) / 100);
      this.przWater.scale.y = Math.max(0.05, lv - y0);
      const bd = this.przBubbleData;
      (this.przBubbles.material as THREE.PointsMaterial).opacity = 0.2 + 0.7 * kw;
      for (let i = 0; i < 160; i++) {
        bd[i * 3 + 1] += dt * (0.3 + (i % 4) * 0.1) * (0.3 + kw);
        if (bd[i * 3 + 1] > lv) bd[i * 3 + 1] = 0.5 + Math.random() * 0.5;
      }
      this.przBubbles.geometry.attributes.position.needsUpdate = true;
      const spray = clamp01(s.przSprayPos ?? 0);
      const pm = this.przSpray.material as THREE.PointsMaterial;
      pm.opacity = 0.15 + 0.8 * spray;
      const pd = (this.przSpray.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      const ss = this.przSprayState;
      for (let i = 0; i < 120; i++) {
        ss[i * 3] = (ss[i * 3] + dt * (0.5 + spray)) % 1;
        const u = ss[i * 3];
        pd[i * 3] = 0.12 + ss[i * 3 + 1] * u * 0.7;
        pd[i * 3 + 1] = PRZ_TOP + 0.15 - u * 1.4 - u * u * 0.6;
        pd[i * 3 + 2] = Math.min(0, ss[i * 3 + 2] * u * 0.7);
      }
      this.przSpray.geometry.attributes.position.needsUpdate = true;
    }
    // underwater exhibit fog
    this.fog.color.set(0x0b2a38);
    this.fog.density = ex === 0 || ex === 2 ? 0.3 : 0.06;
    void t;
  }
}

/** mean RCS loop flow as a fraction of rated (1 if the state has no loops) */
function loopFlow(s: PlantState): number {
  const L = s.loops;
  if (!L || !L.length) return 1;
  let a = 0;
  for (let i = 0; i < L.length; i++) a += L[i].flow ?? 0;
  return a / L.length / 100;
}

/* standard 17x17 guide thimble positions (24) */
function guideThimbles(): [number, number][] {
  const out: [number, number][] = [];
  const pts = [
    [2, 5], [2, 8], [2, 11], [3, 3], [3, 13], [5, 2], [5, 5], [5, 8], [5, 11], [5, 14],
    [8, 2], [8, 5], [8, 11], [8, 14], [11, 2], [11, 5], [11, 8], [11, 11], [11, 14], [13, 3], [13, 13], [14, 5], [14, 8], [14, 11],
  ];
  for (const [i, j] of pts) out.push([i, j]);
  return out;
}

function mergeRaw(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const ps = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  let n = 0;
  for (const p of ps) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of ps) {
    if (!p.getAttribute('normal')) p.computeVertexNormals();
    pos.set(p.getAttribute('position').array as Float32Array, o * 3);
    nor.set(p.getAttribute('normal').array as Float32Array, o * 3);
    o += p.getAttribute('position').count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}
