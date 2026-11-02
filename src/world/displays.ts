/**
 * Plant computer CRTs (green phosphor) and the NIS strip-chart recorder.
 * Canvas textures redrawn at a throttled, staggered rate.
 */
import * as THREE from 'three';
import type { PlantState, RodBankId } from '../sim/types';
import { ROD_BANKS } from '../sim/types';
import { MONO, fmt, fmtExp, safeNum } from './util';

const G = '#4dff88';
const GD = '#1f7a40';
const GDD = '#0d3a1e';
const AMB = '#ffbf3a';
const RED = '#ff5040';
const CY = '#5fe8ff';

const HIST = 360;

/** Ring-buffer of trend samples, sampled in sim time. */
export class History {
  n = 0;
  head = 0;
  lastT = -1;
  interval = 2;
  ch: Record<string, Float32Array> = {};
  constructor(public names: string[]) {
    for (const k of names) this.ch[k] = new Float32Array(HIST);
  }
  sample(s: PlantState): void {
    const t = s.t ?? 0;
    if (t < this.lastT - 1) {
      this.n = 0;
      this.head = 0;
      this.lastT = -1;
    }
    if (this.lastT >= 0 && t - this.lastT < this.interval) return;
    this.lastT = t;
    const vals: Record<string, number> = {
      logPower: Math.log10(Math.max(1e-10, safeNum((x) => x.neutronPower, s))),
      pr: safeNum((x) => x.powerRangePct, s),
      tavg: safeNum((x) => x.tAvg, s),
      tref: safeNum((x) => x.tRef, s),
      press: safeNum((x) => x.rcsPressure, s),
      przLvl: safeNum((x) => x.przLevel, s),
      sgLvl: safeNum((x) => (x.loops[0].sgLevel + x.loops[1].sgLevel + x.loops[2].sgLevel + x.loops[3].sgLevel) / 4, s),
      mwe: safeNum((x) => x.grossMWe, s),
      boron: safeNum((x) => x.boronPpm, s),
      rho: safeNum((x) => x.reactivity.total, s),
    };
    for (const k of this.names) this.ch[k][this.head] = vals[k];
    this.head = (this.head + 1) % HIST;
    this.n = Math.min(HIST, this.n + 1);
  }
  get(k: string, i: number): number {
    // i = 0 oldest .. n-1 newest
    return this.ch[k][(this.head - this.n + i + HIST) % HIST];
  }
}

function makeScanlines(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  x.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = 0; y < h; y += 3) x.fillRect(0, y, w, 1);
  const g = x.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.85);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  return c;
}

export class CRT {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  page = 0;
  timer: number;
  private scan: HTMLCanvasElement;
  constructor(
    public name: string,
    public pages: string[],
    phase: number,
    private hist: History,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 640;
    this.canvas.height = 480;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    this.timer = phase;
    this.scan = makeScanlines(640, 480);
  }

  update(dt: number, s: PlantState, dead: boolean): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    const c = this.ctx;
    c.fillStyle = '#020a05';
    c.fillRect(0, 0, 640, 480);
    if (!dead) {
      c.textBaseline = 'top';
      c.textAlign = 'left';
      try {
        const p = this.pages[this.page];
        this.header(s, p);
        if (p === 'MIMIC') this.mimic(s);
        else if (p === 'CORE') this.core(s);
        else if (p === 'TRENDS') this.trends();
        else if (p === 'REACTIVITY') this.reactivity(s);
        else if (p === 'ALARMS') this.alarmPage(s);
      } catch (e) {
        c.fillStyle = RED;
        c.font = `bold 20px ${MONO}`;
        c.fillText('DATA LINK ERROR', 20, 200);
      }
    }
    c.drawImage(this.scan, 0, 0);
    this.tex.needsUpdate = true;
  }

  private t(x: number, y: number, s: string, col = G, size = 16, bold = false): void {
    const c = this.ctx;
    c.fillStyle = col;
    c.font = `${bold ? 'bold ' : ''}${size}px ${MONO}`;
    c.fillText(s, x, y);
  }

  private header(s: PlantState, page: string): void {
    const c = this.ctx;
    c.fillStyle = GDD;
    c.fillRect(0, 0, 640, 26);
    this.t(8, 5, `UNIT 2 PLANT COMPUTER  ${this.name}`, G, 15, true);
    const tt = s.t ?? 0;
    const hh = Math.floor(tt / 3600 + 6) % 24;
    const mm = Math.floor(tt / 60) % 60;
    const ss = Math.floor(tt) % 60;
    this.t(430, 5, `${page.padEnd(10)} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, AMB, 15, true);
    // footer: page list
    c.fillStyle = GDD;
    c.fillRect(0, 456, 640, 24);
    let x = 8;
    for (let i = 0; i < this.pages.length; i++) {
      this.t(x, 460, `${i === this.page ? '>' : ' '}${this.pages[i]}`, i === this.page ? AMB : GD, 14, i === this.page);
      x += 120;
    }
  }

  private box(x: number, y: number, w: number, h: number, col = G): void {
    const c = this.ctx;
    c.strokeStyle = col;
    c.lineWidth = 2;
    c.strokeRect(x, y, w, h);
  }
  private line(pts: number[], col = G, w = 2): void {
    const c = this.ctx;
    c.strokeStyle = col;
    c.lineWidth = w;
    c.beginPath();
    c.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    c.stroke();
  }

  private mimic(s: PlantState): void {
    const c = this.ctx;
    const L = s.loops ?? [];
    const flowOK = (L[0]?.flow ?? 0) > 5;
    const hot = flowOK ? RED : GD;
    const cold = flowOK ? CY : GD;
    // reactor vessel
    c.strokeStyle = G;
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(40, 120, 90, 200, 30);
    c.stroke();
    // core with rod insertion
    const avg = ((s.rods?.CD ?? 0) / 228) * 100;
    c.fillStyle = s.thermalPower > 0.02 ? 'rgba(255,120,60,0.6)' : 'rgba(60,160,90,0.35)';
    c.fillRect(60, 220, 50, 80);
    c.fillStyle = GD;
    for (let i = 0; i < 5; i++) c.fillRect(63 + i * 10, 140, 4, 80 * (1 - avg / 100) + 4);
    this.t(44, 324, 'REACTOR', G, 13, true);
    this.t(44, 340, `${fmt(s.thermalPower * 100, 1)}% TH`, AMB, 14, true);
    // pressurizer
    this.box(170, 50, 40, 80);
    const pl = Math.max(0, Math.min(100, s.przLevel ?? 0));
    c.fillStyle = 'rgba(80,200,255,0.5)';
    c.fillRect(172, 50 + 78 - (76 * pl) / 100, 36, (76 * pl) / 100);
    this.t(160, 30, 'PZR', G, 13, true);
    this.t(215, 55, `${fmt(s.rcsPressure)} PSIG`, G, 14);
    this.t(215, 73, `LVL ${fmt(s.przLevel, 1)}%`, G, 14);
    if (s.porvOpen) this.t(215, 91, 'PORV OPEN', RED, 14, true);
    // hot leg / cold leg to SG
    this.line([130, 160, 290, 160], hot, 4);
    this.line([190, 160, 190, 130], hot, 3);
    this.line([290, 290, 130, 290], cold, 4);
    // SG
    c.strokeStyle = G;
    c.beginPath();
    c.roundRect(290, 100, 70, 230, 26);
    c.stroke();
    const sgl = L.length ? (L[0].sgLevel + L[1].sgLevel + L[2].sgLevel + L[3].sgLevel) / 4 : 0;
    c.fillStyle = 'rgba(80,200,255,0.35)';
    c.fillRect(294, 326 - 2.2 * sgl, 62, 2.2 * sgl);
    this.t(296, 336, 'S/G x4', G, 13, true);
    this.t(296, 352, `NR ${fmt(sgl, 0)}%`, G, 14);
    // RCP
    c.beginPath();
    c.arc(210, 290, 16, 0, Math.PI * 2);
    c.stroke();
    const nRcp = L.filter((l) => l.rcpRunning).length;
    this.t(190, 312, `RCP ${nRcp}/4`, nRcp ? G : AMB, 13, true);
    this.t(140, 168, `TH ${fmt(L[0]?.tHot)}`, RED, 14);
    this.t(140, 270, `TC ${fmt(L[0]?.tCold)}`, CY, 14);
    // steam line to turbine
    const stm = !s.turbineTripped && s.turbineLatched;
    this.line([325, 100, 325, 70, 460, 70, 460, 110], stm ? G : GD, 3);
    this.t(338, 48, `${fmt(s.steamHeaderPressure)} PSIG`, G, 14);
    // turbine (trapezoid)
    c.strokeStyle = stm ? G : GD;
    c.beginPath();
    c.moveTo(440, 110);
    c.lineTo(500, 90);
    c.lineTo(500, 170);
    c.lineTo(440, 150);
    c.closePath();
    c.stroke();
    this.t(430, 176, `${fmt(s.turbineSpeedRpm)} RPM`, G, 14);
    // generator
    this.box(520, 105, 60, 50, s.generatorBreakerClosed ? RED : G);
    this.t(530, 122, 'GEN', G, 14, true);
    this.line([500, 130, 520, 130], G, 3);
    this.t(510, 162, `${fmt(s.grossMWe)} MWE`, AMB, 16, true);
    this.t(520, 182, s.generatorBreakerClosed ? 'BKR CLOSED' : 'BKR OPEN', s.generatorBreakerClosed ? RED : G, 13);
    // condenser + feed
    this.box(430, 230, 100, 40, G);
    this.t(440, 243, 'CONDENSER', G, 13);
    this.t(440, 274, `${fmt(s.condenserVacuum, 1)} IN HG`, G, 13);
    this.line([470, 170, 470, 230], s.steamDumpDemand > 0.01 ? AMB : GD, 2);
    if (s.steamDumpDemand > 0.01) this.t(476, 200, `DUMP ${fmt(s.steamDumpDemand * 100)}%`, AMB, 13);
    const fw = (s.mainFeedPumpsRunning ?? []).some(Boolean);
    this.line([430, 260, 380, 260, 380, 300, 360, 300], fw ? CY : GD, 3);
    this.t(372, 306, `MFP ${(s.mainFeedPumpsRunning ?? []).map((x) => (x ? 'R' : '-')).join('')}`, fw ? G : AMB, 13);
    this.t(372, 322, `AFW ${(s.auxFeedPumpsRunning ?? []).map((x) => (x ? 'R' : '-')).join('')}`, (s.auxFeedPumpsRunning ?? []).some(Boolean) ? AMB : GD, 13);
    // status column
    const y0 = 360;
    this.t(20, y0, `TAVG ${fmt(s.tAvg, 1)}F  TREF ${fmt(s.tRef, 1)}F  SUBCOOL ${fmt(s.subcoolingMargin, 0)}F`, G, 15);
    this.t(20, y0 + 20, `BORON ${fmt(s.boronPpm)} PPM   DNBR ${fmt(s.dnbr, 2)}   CET ${fmt(s.coreExitTemp)}F`, G, 15);
    this.t(20, y0 + 40, `CTMT ${fmt(s.containmentPressure, 1)} PSIG   RAD ${fmt(s.containmentRadiation, 1)} R/HR`, s.containmentPressure > 3 ? AMB : G, 15);
    const tripTxt = s.reactorTripped ? 'REACTOR TRIPPED' : 'REACTOR TRIP BKRS CLOSED';
    this.t(20, y0 + 64, tripTxt, s.reactorTripped ? RED : G, 17, true);
    if (s.siActuated) this.t(330, y0 + 64, 'SAFETY INJECTION', RED, 17, true);
  }

  private core(s: PlantState): void {
    const c = this.ctx;
    this.t(20, 40, 'ROD POSITIONS (STEPS)', G, 15, true);
    for (let i = 0; i < ROD_BANKS.length; i++) {
      const b = ROD_BANKS[i] as RodBankId;
      const v = s.rods?.[b] ?? 0;
      const x = 30 + i * 46;
      this.box(x, 64, 26, 180, GD);
      c.fillStyle = v <= 0 ? RED : G;
      const h = (176 * v) / 228;
      c.fillRect(x + 2, 64 + 178 - h, 22, h);
      this.t(x + 2, 250, b, G, 14, true);
      this.t(x - 2, 268, String(Math.round(v)).padStart(3), AMB, 14);
    }
    const rows: [string, string, string?][] = [
      ['KEFF', s.keff?.toFixed(5) ?? '----'],
      ['TOTAL RHO', `${fmt(s.reactivity?.total, 0)} PCM`, Math.abs(s.reactivity?.total ?? 0) > 100 ? AMB : undefined],
      ['NEUTRON PWR', fmtExp(s.neutronPower)],
      ['FLUX', `${fmtExp(s.neutronFlux)} N/CM2S`],
      ['PERIOD', Number.isFinite(s.periodSeconds) ? `${fmt(s.periodSeconds, 0)} S` : 'INFINITE'],
      ['SUR', `${fmt(s.startupRateDpm, 2)} DPM`],
      ['AXIAL OFFSET', `${fmt(s.axialOffset, 1)} %`],
      ['FUEL CL TEMP', `${fmt(s.fuelTempCenterline)} F`, s.fuelTempCenterline > 4000 ? RED : undefined],
      ['CLAD TEMP', `${fmt(s.cladTemp)} F`, s.cladTemp > 1200 ? RED : undefined],
      ['DNBR', fmt(s.dnbr, 2), s.dnbr < 1.3 ? RED : undefined],
      ['DECAY HEAT', `${fmt((s.decayHeat ?? 0) * 100, 2)} %`],
      ['XENON', `${fmt(s.xenonPcm, 0)} PCM`],
      ['IODINE / XE', `${fmt(s.iodine, 2)} / ${fmt(s.xenon, 2)}`],
      ['FUEL DAMAGE', `${fmt((s.fuelDamage ?? 0) * 100, 2)} %`, s.fuelDamage > 0 ? RED : undefined],
      ['CORE', (s.coreStatus ?? 'ok').toUpperCase() + (s.coreUncovered ? ' UNCOVERED' : ''), s.coreStatus !== 'ok' ? RED : undefined],
    ];
    for (let i = 0; i < rows.length; i++) {
      this.t(330, 44 + i * 26, rows[i][0].padEnd(13), GD, 16);
      this.t(470, 44 + i * 26, rows[i][1], rows[i][2] ?? G, 16, true);
    }
    const p = s.permissives;
    if (p) {
      let x = 20;
      this.t(20, 300, 'PERMISSIVES', G, 15, true);
      for (const k of ['P6', 'P7', 'P8', 'P9', 'P10', 'P11'] as const) {
        this.box(x, 324, 42, 24, p[k] ? AMB : GD);
        this.t(x + 6, 328, k.replace('P', 'P-'), p[k] ? AMB : GD, 14, true);
        x += 48;
      }
    }
    this.t(20, 370, `ROD SPEED ${fmt(s.rodSpeedSpm, 0)} SPM  ${s.rodsMoving ? 'MOVING' : ''}`, s.rodsMoving ? AMB : G, 15);
    if (s.droppedRods > 0) this.t(20, 392, `DROPPED RODS: ${s.droppedRods}`, RED, 16, true);
    if (s.rodBottomLights) this.t(20, 414, 'ROD BOTTOM', RED, 16, true);
  }

  private trends(): void {
    const H = this.hist;
    const plots: { k: string; label: string; min: number; max: number; col: string; k2?: string; col2?: string }[] = [
      { k: 'logPower', label: 'LOG NEUTRON POWER', min: -9, max: 0.3, col: AMB },
      { k: 'tavg', label: 'TAVG / TREF  F', min: 540, max: 600, col: G, k2: 'tref', col2: CY },
      { k: 'press', label: 'PZR PRESSURE PSIG', min: 1800, max: 2500, col: G },
      { k: 'mwe', label: 'GROSS MWE', min: 0, max: 1250, col: AMB },
    ];
    const c = this.ctx;
    const ph = 100;
    for (let i = 0; i < plots.length; i++) {
      const P = plots[i];
      const y0 = 34 + i * (ph + 4);
      this.box(60, y0, 570, ph - 4, GDD);
      c.strokeStyle = GDD;
      c.lineWidth = 1;
      for (let g = 1; g < 4; g++) {
        c.beginPath();
        c.moveTo(60, y0 + (g * (ph - 4)) / 4);
        c.lineTo(630, y0 + (g * (ph - 4)) / 4);
        c.stroke();
      }
      this.t(64, y0 + 3, P.label, P.col, 13, true);
      this.t(2, y0, String(P.max), GD, 12);
      this.t(2, y0 + ph - 18, String(P.min), GD, 12);
      const n = H.n;
      if (n > 1) {
        for (const [key, col] of [[P.k, P.col], [P.k2, P.col2]] as [string | undefined, string | undefined][]) {
          if (!key) continue;
          c.strokeStyle = col!;
          c.lineWidth = 2;
          c.beginPath();
          for (let j = 0; j < n; j++) {
            const v = H.get(key, j);
            const x = 60 + (570 * (j + HIST - n)) / (HIST - 1);
            const y = y0 + ph - 4 - ((ph - 4) * (Math.min(P.max, Math.max(P.min, v)) - P.min)) / (P.max - P.min);
            if (j === 0) c.moveTo(x, y);
            else c.lineTo(x, y);
          }
          c.stroke();
        }
        const last = H.get(P.k, n - 1);
        this.t(540, y0 + 3, P.k === 'logPower' ? fmtExp(Math.pow(10, last), 1) : fmt(last, 0), P.col, 13, true);
      }
    }
    this.t(400, 440, `WINDOW ${(HIST * H.interval) / 60} MIN`, GD, 12);
  }

  private reactivity(s: PlantState): void {
    const r = s.reactivity;
    if (!r) return;
    const comps: [string, number][] = [
      ['RODS', r.rods],
      ['BORON', r.boron],
      ['DOPPLER', r.doppler],
      ['MODERATOR', r.moderator],
      ['XENON', r.xenon],
      ['SAMARIUM', r.samarium],
    ];
    const c = this.ctx;
    this.t(20, 38, 'REACTIVITY BALANCE (PCM)', G, 16, true);
    let maxAbs = 500;
    for (const [, v] of comps) if (Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
    const cx = 380;
    const scale = 220 / maxAbs;
    c.strokeStyle = GD;
    c.beginPath();
    c.moveTo(cx, 64);
    c.lineTo(cx, 330);
    c.stroke();
    for (let i = 0; i < comps.length; i++) {
      const [name, v] = comps[i];
      const y = 70 + i * 40;
      this.t(20, y + 6, name.padEnd(10), G, 16, true);
      this.t(150, y + 6, `${Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(0) : '----'}`.padStart(7), v >= 0 ? AMB : CY, 16);
      const w = (Number.isFinite(v) ? v : 0) * scale;
      c.fillStyle = v >= 0 ? 'rgba(255,191,58,0.7)' : 'rgba(95,232,255,0.6)';
      c.fillRect(Math.min(cx, cx + w), y + 4, Math.abs(w), 22);
    }
    const tot = r.total;
    const y = 70 + comps.length * 40 + 8;
    c.fillStyle = GD;
    c.fillRect(20, y - 6, 600, 2);
    this.t(20, y + 6, 'TOTAL', G, 18, true);
    this.t(150, y + 6, `${Number.isFinite(tot) ? (tot >= 0 ? '+' : '') + tot.toFixed(1) : '----'}`.padStart(7), Math.abs(tot) < 10 ? G : tot > 0 ? AMB : CY, 18, true);
    const crit = s.keff > 1.0001 ? 'SUPERCRITICAL' : s.keff < 0.9999 ? 'SUBCRITICAL' : 'CRITICAL';
    this.t(20, y + 44, `KEFF ${s.keff?.toFixed(5)}   ${crit}`, crit === 'SUPERCRITICAL' ? AMB : G, 18, true);
    this.t(20, y + 70, `PERIOD ${Number.isFinite(s.periodSeconds) ? fmt(s.periodSeconds, 0) + ' S' : 'INF'}   SUR ${fmt(s.startupRateDpm, 2)} DPM`, G, 16);
    this.t(20, y + 92, `BORON ${fmt(s.boronPpm)} PPM  XE ${fmt(s.xenonPcm)} PCM`, G, 16);
  }

  private alarmPage(s: PlantState): void {
    const list = (s.alarms ?? []).filter((a) => a.active || !a.acknowledged).sort((a, b) => b.time - a.time);
    this.t(20, 36, `ACTIVE ALARMS: ${list.length}`, G, 16, true);
    for (let i = 0; i < Math.min(list.length, 17); i++) {
      const a = list[i];
      const col = a.severity === 'trip' ? RED : a.severity === 'alarm' ? AMB : a.severity === 'warning' ? AMB : G;
      const tt = a.time ?? 0;
      const ts = `${String(Math.floor(tt / 3600 + 6) % 24).padStart(2, '0')}:${String(Math.floor(tt / 60) % 60).padStart(2, '0')}:${String(Math.floor(tt) % 60).padStart(2, '0')}`;
      const st = !a.active ? 'CLR' : a.acknowledged ? 'ACK' : '***';
      this.t(20, 62 + i * 23, `${ts} ${st} ${a.label.padEnd(24)} ${a.severity.toUpperCase()}`, col, 15, !a.acknowledged);
    }
    if ((s.faults ?? []).length && s.faults.length) {
      // faults are hidden from the operator on purpose
    }
  }
}

/** Two-pen strip chart: red = log neutron power (IR scale), blue = PR %. */
export class ChartRecorder {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  private acc = 0;
  private lastT = -1;
  private lastA = -1;
  private lastB = -1;
  private timer = 0;
  private lineY = 0;
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 384;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.fillStyle = '#f3efe2';
    this.ctx.fillRect(0, 0, 256, 384);
    this.ctx.fillStyle = '#d7b9a4';
    for (let g = 0; g <= 8; g++) this.ctx.fillRect(8 + g * 30, 0, 1, 384);
    for (let y = 0; y < 384; y += 30) this.ctx.fillRect(0, y, 256, 1);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
  }
  update(dt: number, s: PlantState): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;
    const t = s.t ?? 0;
    if (this.lastT < 0 || t < this.lastT) this.lastT = t;
    const px = Math.floor((t - this.lastT) / 2); // 1 px per 2 s sim
    const a = Math.log10(Math.max(1e-11, safeNum((x) => x.intermediateRangeAmps, s)));
    const tA = 8 + ((a + 11) / 8) * 240; // 1e-11..1e-3
    const b = safeNum((x) => x.powerRangePct, s);
    const tB = 8 + (Math.max(0, Math.min(120, b)) / 120) * 240;
    if (px <= 0 && this.lastA >= 0) return;
    this.lastT += px * 2;
    const n = Math.min(px, 384);
    const c = this.ctx;
    if (n > 0) {
      c.drawImage(this.canvas, 0, n);
      c.fillStyle = '#f3efe2';
      c.fillRect(0, 0, 256, n);
      // grid for the new strip
      c.fillStyle = '#d7b9a4';
      for (let g = 0; g <= 8; g++) c.fillRect(8 + g * 30, 0, 1, n);
      for (let y = 0; y < n; y++) {
        this.lineY = (this.lineY + 1) % 30;
        if (this.lineY === 0) c.fillRect(0, n - 1 - y, 256, 1);
      }
    }
    const pen = (from: number, to: number, col: string) => {
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(from < 0 ? to : from, Math.max(1, n));
      c.lineTo(Number.isFinite(to) ? to : 0, 0);
      c.stroke();
    };
    pen(this.lastA, tA, '#c0281c');
    pen(this.lastB, tB, '#2040b0');
    this.lastA = tA;
    this.lastB = tB;
    this.tex.needsUpdate = true;
  }
}
