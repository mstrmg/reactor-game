/**
 * Annunciator windows along the top of every board section + the reactor
 * trip first-out panel. One merged mesh; tile brightness via a dynamic
 * vertex-color attribute; tile text drawn into a canvas atlas on demand.
 * Alarms are assigned to windows dynamically by keyword (sim alarm ids are
 * not known in advance), each window keeps its alarm once assigned.
 */
import * as THREE from 'three';
import type { Alarm, PlantState, TripId } from '../sim/types';
import { FONT, fitText, wrapWords } from './util';
import { BOARD_TOP, HALF_W, Section, PanelKit, surfaceFrame } from './panel';

const COLS = 10;
const ROWS = 3;
const TILE_W = 0.205;
const TILE_H = 0.096; // matches the 128x60 atlas cell aspect
const GAP = 0.012;
const CELL_W = 128;
const CELL_H = 60;
const ATLAS_COLS = 16;

interface Tile {
  cell: number;
  sec: number;
  alarmId: string | null;
  label: string;
  /** for first-out tiles */
  trip?: TripId;
  stamp: number;
  state: number; // 0 off,1 steady,2 fast flash,3 slow flash (ringback)
  sev: string;
  colorKey: number;
}

export const TRIP_LABELS: Record<TripId, string> = {
  MANUAL: 'MANUAL TRIP',
  PR_HIGH_FLUX_HI: 'PR HI FLUX HI SETPT',
  PR_HIGH_FLUX_LO: 'PR HI FLUX LO SETPT',
  PR_POS_RATE: 'PR POS RATE',
  IR_HIGH_FLUX: 'IR HI FLUX',
  SR_HIGH_FLUX: 'SR HI FLUX',
  OTDT: 'OVERTEMP ΔT',
  OPDT: 'OVERPOWER ΔT',
  PZR_PRESS_LO: 'PZR PRESS LO',
  PZR_PRESS_HI: 'PZR PRESS HI',
  PZR_LEVEL_HI: 'PZR LEVEL HI',
  RCS_FLOW_LO: 'RCS LOOP FLOW LO',
  RCP_UNDERVOLTAGE: 'RCP UNDER VOLTAGE',
  SG_LEVEL_LOLO: 'SG LEVEL LO-LO',
  TURBINE_TRIP: 'TURBINE TRIP',
  SAFETY_INJECTION: 'SAFETY INJECTION',
  STARTUP_RATE: 'HI STARTUP RATE',
};
const TRIP_IDS = Object.keys(TRIP_LABELS) as TripId[];

const ROUTES: [RegExp, number][] = [
  // balance-of-plant alarms first (they contain generic words like FLOW LO / HEATER / CRITICAL)
  [/CW FLOW|CIRC WATER|HOTWELL|FW HTRS|FW HEATER|CONDENSATE|MFP SUCTION/, 8],
  [/TURB CRIT|CRITICAL SPEED|TURN(ING)? GEAR|ECCENTRIC|DIFF EXP|GEN FIELD|GEN MVAR|GEN PROTECT/, 9],
  [/CCW|COMPONENT COOL|SERVICE WATER|\bSW FLOW|HOUSE ON|AUX LOADS|DG OVERLOAD|DIESEL GEN OVER/, 0],
  [/SEAL INJ|LD HX|LETDOWN HX|MAKEUP BATCH/, 1],
  [/RCP\d? ?BRG|RCP\d? ?SEAL|BEARING TEMP/, 3],
  [/\bSG\b|SG\d|S\/G|STEAM GEN|STM GEN|STEAMLINE|STEAM LINE|STM LINE|MSIV|CARRYOVER/, 7],
  [/PZR|PRZ|PORV|SPRAY|HEATER|PRESSURIZER|SAFETY V|\bPRT\b/, 2],
  [/OFFSITE|DIESEL|\bDG\b|ACCUM|\bSI\b|SAFETY INJ|CNMT|CTMT|CONTAINMENT|HYDROGEN|\bH2\b|RVLIS|VESSEL LEVEL|ECCS|CORE COOL/, 0],
  [/BORON|BORAT|DILUT|CHARG|\bCHG\b|LETDOWN|VCT|MAKEUP|CVCS|SHUTDOWN MARGIN|\bSDM\b/, 1],
  [/RCP|RCS|LOOP|TAVG|DNB|SUBCOOL|CORE EXIT|\bCET\b|LEAK|FLOW LO/, 3],
  [/ROD|RPI|BANK|INSERT|TRIP BKR|REACTOR TRIP|RX TRIP|DROP/, 4],
  [/\bSR\b|\bIR\b|\bPR\b|FLUX|NIS|\bSUR\b|STARTUP|NEUTRON|PERIOD|AXIAL|SOURCE|INTERMEDIATE|POWER RANGE|CRITICAL|XENON/, 5],
  [/FW|FEED|MFP|AFW|STEAM DUMP|STM DUMP|DUMP|HEADER/, 8],
  [/TURB|GEN|COND|MWE|GRID|BKR|BREAKER|VACUUM|LOAD|SYNC|OVERSPEED/, 9],
  [/RAD|PERMISS|P-\d|LOSS OF/, 0],
];

function routeFor(a: Alarm): number {
  const key = `${a.id} ${a.label}`.toUpperCase().replace(/_/g, ' ');
  for (const [re, sec] of ROUTES) if (re.test(key)) return sec;
  return 6; // plant computer / general
}

const SEV_COLORS: Record<string, [number, number, number]> = {
  info: [1.9, 1.85, 1.6],
  warning: [2.6, 1.7, 0.35],
  alarm: [2.8, 0.9, 0.25],
  trip: [3.0, 0.3, 0.22],
};
const OFF: [number, number, number] = [0.16, 0.155, 0.145];
const OFF_DEAD: [number, number, number] = [0.06, 0.06, 0.058];

export class Annunciators {
  private tiles: Tile[] = [];
  private bySec: number[][] = [];
  private byAlarm = new Map<string, Tile>();
  private firstOut: Tile[] = [];
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private colors!: THREE.BufferAttribute;
  private frame = 0;
  mesh!: THREE.Mesh;
  /** count of active unacknowledged alarms (for atmosphere) */
  unacked = 0;
  activeCount = 0;
  activeTrips = 0;

  constructor(
    private kit: PanelKit,
    private sections: Section[],
    firstOutAt: { sec: Section; u: number; v: number },
  ) {
    const totalTiles = sections.length * COLS * ROWS + TRIP_IDS.length + 1;
    const rows = Math.ceil(totalTiles / ATLAS_COLS);
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_COLS * CELL_W;
    this.canvas.height = rows * CELL_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.fillStyle = '#e6e1d3';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;

    const geos: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const addTile = (frame: THREE.Matrix4, w: number, h: number, t: Tile) => {
      const g = new THREE.PlaneGeometry(w, h);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const cx = (t.cell % ATLAS_COLS) * CELL_W;
      const cy = Math.floor(t.cell / ATLAS_COLS) * CELL_H;
      const W = this.canvas.width;
      const H = this.canvas.height;
      const u0 = (cx + 1) / W;
      const u1 = (cx + CELL_W - 1) / W;
      const v1 = 1 - (cy + 1) / H;
      const v0 = 1 - (cy + CELL_H - 1) / H;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
      g.applyMatrix4(frame);
      geos.push(g);
      this.tiles.push(t);
    };

    // section windows
    const bandY = 2.125;
    const gridW = COLS * TILE_W + (COLS - 1) * GAP;
    const gridH = ROWS * TILE_H + (ROWS - 1) * GAP;
    for (const sec of sections) {
      const list: number[] = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const u = -gridW / 2 + TILE_W / 2 + c * (TILE_W + GAP);
          const y = bandY + gridH / 2 - TILE_H / 2 - r * (TILE_H + GAP);
          m.makeTranslation(u, y, 0.1445).premultiply(sec.matrix);
          const t: Tile = { cell: this.tiles.length, sec: sec.index, alarmId: null, label: '', stamp: -1, state: 0, sev: 'info', colorKey: -1 };
          list.push(this.tiles.length);
          addTile(m, TILE_W, TILE_H, t);
          // grid frame bars (static, dark)
        }
      }
      this.bySec.push(list);
      // black egg-crate grid behind the windows
      this.kit.shell.add(new THREE.BoxGeometry(gridW + 0.03, gridH + 0.03, 0.004).toNonIndexed().deleteAttribute('uv'), m.makeTranslation(0, bandY, 0.141).premultiply(sec.matrix), 0x0b0b0b, { ao: false });
      // hover: whole band
      const band = new THREE.Matrix4().makeTranslation(0, bandY, 0.142).premultiply(sec.matrix);
      const secIdx = sec.index;
      this.kit.interactables.push({
        id: 'ann:' + sec.index,
        label: 'ANNUNCIATOR',
        kind: 'info',
        inv: band.clone().invert(),
        half: new THREE.Vector3(gridW / 2, gridH / 2, 0.03),
        center: new THREE.Vector3().setFromMatrixPosition(band),
        detail: () => '',
        sub: (lx, ly) => {
          const c = Math.floor((lx + gridW / 2) / (TILE_W + GAP));
          const r = Math.floor((gridH / 2 - ly) / (TILE_H + GAP));
          if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return null;
          const t = this.tiles[this.bySec[secIdx][r * COLS + c]];
          if (!t.alarmId) return { label: 'ANNUNCIATOR', detail: '(spare window)' };
          const st = ['clear', 'ALARM (acknowledged)', 'ALARM — unacknowledged', 'cleared — needs RESET'][t.state];
          return { label: t.label, detail: `${st}  · ${t.sev.toUpperCase()}` };
        },
      });
    }
    void HALF_W;
    void BOARD_TOP;

    // first-out panel
    const foCols = 6;
    const foW = 0.15;
    const foH = 0.07;
    const foGap = 0.008;
    const foGridW = foCols * foW + (foCols - 1) * foGap;
    const foRows = Math.ceil(TRIP_IDS.length / foCols);
    const foGridH = foRows * foH + (foRows - 1) * foGap;
    const base = surfaceFrame(firstOutAt.sec, 'v', firstOutAt.u, firstOutAt.v, 0);
    this.kit.shell.add(new THREE.BoxGeometry(foGridW + 0.04, foGridH + 0.04, 0.03).toNonIndexed().deleteAttribute('uv'), m.makeTranslation(0, 0, 0.015).premultiply(base), 0x2a2d2f, { ao: false });
    for (let i = 0; i < TRIP_IDS.length; i++) {
      const c = i % foCols;
      const r = Math.floor(i / foCols);
      const u = -foGridW / 2 + foW / 2 + c * (foW + foGap);
      const y = foGridH / 2 - foH / 2 - r * (foH + foGap);
      m.makeTranslation(u, y, 0.031).premultiply(base);
      const t: Tile = { cell: this.tiles.length, sec: -1, alarmId: null, label: TRIP_LABELS[TRIP_IDS[i]], trip: TRIP_IDS[i], stamp: -1, state: 0, sev: 'trip', colorKey: -1 };
      addTile(m, foW, foH, t);
      this.firstOut.push(t);
      this.drawCell(t, t.label);
    }
    const foFrame = new THREE.Matrix4().makeTranslation(0, foGridH / 2 + 0.035, 0.004).premultiply(base);
    this.kit.labelAt(foFrame, 'REACTOR TRIP  FIRST OUT', 0.36, 0.026, 'red');
    const foBand = new THREE.Matrix4().makeTranslation(0, 0, 0.031).premultiply(base);
    this.kit.interactables.push({
      id: 'firstout',
      label: 'TRIP FIRST-OUT',
      kind: 'info',
      inv: foBand.clone().invert(),
      half: new THREE.Vector3(foGridW / 2, foGridH / 2, 0.03),
      center: new THREE.Vector3().setFromMatrixPosition(foBand),
      detail: () => '',
      sub: (lx, ly) => {
        const c = Math.floor((lx + foGridW / 2) / (foW + foGap));
        const r = Math.floor((foGridH / 2 - ly) / (foH + foGap));
        const t = this.firstOut[r * foCols + c];
        if (!t) return null;
        return { label: t.label, detail: ['no signal', 'trip signal present', 'FIRST OUT', 'FIRST OUT'][t.state] };
      },
    });

    const { mergeGeometries } = THREE_BGU;
    const merged = mergeGeometries(geos, false)!;
    for (const g of geos) g.dispose();
    const n = merged.getAttribute('position').count;
    this.colors = new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.15), 3);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    merged.setAttribute('color', this.colors);
    this.mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ map: this.tex, vertexColors: true }));
    this.mesh.name = 'annunciators';
    this.mesh.matrixAutoUpdate = false;
  }

  private drawCell(t: Tile, text: string): void {
    const ctx = this.ctx;
    const x = (t.cell % ATLAS_COLS) * CELL_W;
    const y = Math.floor(t.cell / ATLAS_COLS) * CELL_H;
    ctx.fillStyle = '#ece7d8';
    ctx.fillRect(x, y, CELL_W, CELL_H);
    ctx.fillStyle = '#141414';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrapWords(text.toUpperCase(), 3, 11);
    const lh = lines.length === 1 ? 22 : lines.length === 2 ? 20 : 17;
    const y0 = y + CELL_H / 2 - ((lines.length - 1) * lh) / 2;
    for (let i = 0; i < lines.length; i++) fitText(ctx, lines[i], x + CELL_W / 2, y0 + i * lh + 1, CELL_W - 8, lh - 2, 'bold', FONT);
    this.tex.needsUpdate = true;
  }

  private assign(a: Alarm): Tile {
    const want = routeFor(a);
    const order = [want, 6, ...this.bySec.map((_, i) => i)];
    for (const s of order) {
      for (const idx of this.bySec[s]) {
        const t = this.tiles[idx];
        if (!t.alarmId) {
          t.alarmId = a.id;
          t.label = a.label;
          this.byAlarm.set(a.id, t);
          this.drawCell(t, a.label);
          return t;
        }
      }
    }
    // full: reuse a spare by overwriting the oldest inactive tile of the wanted section
    const t = this.tiles[this.bySec[want][this.bySec[want].length - 1]];
    if (t.alarmId) this.byAlarm.delete(t.alarmId);
    t.alarmId = a.id;
    t.label = a.label;
    this.byAlarm.set(a.id, t);
    this.drawCell(t, a.label);
    return t;
  }

  update(s: PlantState, time: number, powerOK: boolean): void {
    this.frame++;
    const f = this.frame;
    let unacked = 0;
    let active = 0;
    let trips = 0;
    const alarms = s.alarms ?? [];
    for (let i = 0; i < alarms.length; i++) {
      const a = alarms[i];
      let t = this.byAlarm.get(a.id);
      if (!t) t = this.assign(a);
      t.stamp = f;
      t.sev = a.severity;
      t.state = a.active ? (a.acknowledged ? 1 : 2) : a.acknowledged ? 0 : 3;
      if (a.active) {
        active++;
        if (a.severity === 'trip') trips++;
      }
      if (!a.acknowledged) unacked++;
    }
    this.unacked = unacked;
    this.activeCount = active;
    this.activeTrips = trips;
    // first-out
    const sig = s.tripSignals ?? [];
    for (const t of this.firstOut) {
      t.stamp = f;
      t.state = s.firstOut === t.trip ? 2 : sig.includes(t.trip!) ? 1 : 0;
      t.sev = s.firstOut === t.trip ? 'trip' : 'warning';
    }
    // colors
    const fast = Math.floor(time * 3.2) % 2 === 0;
    const slow = Math.floor(time * 1.2) % 2 === 0;
    const arr = this.colors.array as Float32Array;
    let dirty = false;
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      if (t.stamp !== f && t.alarmId) t.state = 0;
      let lit = false;
      if (powerOK) {
        if (t.state === 1) lit = true;
        else if (t.state === 2) lit = fast;
        else if (t.state === 3) lit = slow;
      }
      const sevIdx = t.sev === 'info' ? 0 : t.sev === 'warning' ? 1 : t.sev === 'alarm' ? 2 : 3;
      const key = lit ? 10 + sevIdx + (t.state === 3 ? 5 : 0) : powerOK ? 0 : 1;
      if (key === t.colorKey) continue;
      t.colorKey = key;
      dirty = true;
      let c = lit ? SEV_COLORS[t.sev] ?? SEV_COLORS.info : powerOK ? OFF : OFF_DEAD;
      const dim = t.state === 3 ? 0.55 : 1;
      for (let v = 0; v < 4; v++) {
        const o = (i * 4 + v) * 3;
        arr[o] = c[0] * dim;
        arr[o + 1] = c[1] * dim;
        arr[o + 2] = c[2] * dim;
      }
    }
    if (dirty) this.colors.needsUpdate = true;
  }
}

import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
const THREE_BGU = BGU;
