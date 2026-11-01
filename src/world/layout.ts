/**
 * Control board layout: which instrument sits where, and how it binds to the sim.
 * Sections are arranged left→right around a horseshoe (index 0 far left).
 * Coordinates: vertical face 'v' → (u, y-height in m); bench 'b' → (u, v from front edge, up-slope).
 */
import * as THREE from 'three';
import type { OnOffAuto, PlantState, ReactorSimApi, RodBankId } from '../sim/types';
import { ROD_BANKS } from '../sim/types';
import { bus } from '../core/bus';
import { CRT, ChartRecorder, History } from './displays';
import { PanelKit, Section, makeSection, surfaceFrame, PALETTE } from './panel';
import { DEG, FONT, MONO, box, fitText, fmt, fmtExp, Region } from './util';

export const SECTION_NAMES = [
  'SAFETY SYSTEMS & ELECTRICAL',
  'CVCS / BORON CONTROL',
  'PRESSURIZER',
  'REACTOR COOLANT SYSTEM',
  'REACTOR CONTROL',
  'NUCLEAR INSTRUMENTATION',
  'PLANT COMPUTER',
  'STEAM GENERATORS',
  'FEEDWATER & STEAM DUMP',
  'TURBINE / GENERATOR',
];

const OAA: OnOffAuto[] = ['off', 'auto', 'on'];

export interface LayoutResult {
  sections: Section[];
  crtA: CRT;
  crtB: CRT;
  chart: ChartRecorder;
  hist: History;
  displayMeshes: THREE.Mesh[];
  firstOutAt: { sec: Section; u: number; v: number };
}

export function buildLayout(kit: PanelKit, sim: ReactorSimApi): LayoutResult {
  const C = () => sim.controls;
  const sections = SECTION_NAMES.map((n, i) => makeSection(i, n));
  for (const s of sections) {
    kit.buildSectionShell(s);
    kit.placard(s, s.name);
  }
  const [S0, S1, S2, S3, S4, S5, S6, S7, S8, S9] = sections;
  const loopTitle = ['1', '2', '3', '4'];
  const sgTitle = ['A', 'B', 'C', 'D'];
  const loops = (s: PlantState) => s.loops;
  void loops;

  /* ============ 0: SAFETY & ELECTRICAL ============ */
  kit.groupBox(S0, 'v', -1.05, 1.58, -0.33, 1.9, 'CONTAINMENT / ECCS');
  kit.meter(S0, 'v', -0.88, 1.72, { title: 'CTMT PRESSURE', unit: 'PSIG', min: -5, max: 60, ticks: [-5, 10, 25, 40, 60], get: (s) => s.containmentPressure, zones: [[3, 50, '#e0b020'], [50, 60, '#c82020']] });
  kit.meter(S0, 'v', -0.69, 1.72, { title: 'CTMT RADIATION', unit: 'R/HR', min: 0.01, max: 1e4, log: true, get: (s) => s.containmentRadiation, zones: [[10, 1e4, '#c82020']], tickFmt: (v) => (v < 1 ? String(v) : v >= 1000 ? `1E${Math.round(Math.log10(v))}` : String(v)) });
  kit.meter(S0, 'v', -0.5, 1.72, { title: 'SI FLOW', unit: 'GPM', min: 0, max: 6000, ticks: [0, 1500, 3000, 4500, 6000], get: (s) => s.siFlowGpm, fmt: (v) => v.toFixed(0) });

  kit.groupBox(S0, 'v', -0.22, 1.58, 1.05, 1.9, 'ELECTRICAL');
  kit.lamp(S0, 'v', -0.1, 1.79, { title: 'OFFSITE PWR\nAVAILABLE', color: 'green', get: (s) => s.offsitePower });
  kit.lamp(S0, 'v', 0.08, 1.79, { title: 'LOSS OF\nOFFSITE PWR', color: 'red', get: (s) => !s.offsitePower, flash: true });
  kit.lamp(S0, 'v', 0.26, 1.79, { title: 'DG A\nRUNNING', color: 'red', get: (s) => s.dieselGeneratorsRunning[0] });
  kit.lamp(S0, 'v', 0.44, 1.79, { title: 'DG B\nRUNNING', color: 'red', get: (s) => s.dieselGeneratorsRunning[1] });
  kit.lamp(S0, 'v', 0.62, 1.79, { title: 'SI\nACTUATED', color: 'red', get: (s) => s.siActuated });
  kit.lamp(S0, 'v', 0.8, 1.79, { title: 'ACCUM\nINJECTED', color: 'amber', get: (s) => s.accumulatorsInjected });
  kit.lamp(S0, 'v', 0.98, 1.79, { title: 'SI\nBLOCKED', color: 'amber', get: () => C().siBlocked });
  kit.readout(S0, 'v', 0.2, 1.64, { title: 'RCS LEAKAGE GPM', get: (s) => fmt(s.rcsLeakGpm, 1), unit: 'gpm' });
  kit.readout(S0, 'v', 0.5, 1.64, { title: 'SI FLOW GPM', get: (s) => fmt(s.siFlowGpm, 0), unit: 'gpm' });
  kit.readout(S0, 'v', 0.8, 1.64, { title: 'CTMT PRESS PSIG', get: (s) => fmt(s.containmentPressure, 2), unit: 'psig' });

  kit.groupBox(S0, 'v', -1.05, 1.2, 1.05, 1.46, 'REACTOR PROTECTION PERMISSIVES');
  const perms: [keyof PlantState['permissives'], string][] = [
    ['P6', 'P-6\nIR > 1E-10A'],
    ['P7', 'P-7\nLOW PWR BLK'],
    ['P8', 'P-8\nPWR > 48%'],
    ['P9', 'P-9\nPWR > 50%'],
    ['P10', 'P-10\nPWR > 10%'],
    ['P11', 'P-11\nPZR < 1915'],
  ];
  perms.forEach(([k, t], i) => kit.lamp(S0, 'v', -0.8 + i * 0.32, 1.37, { title: t, color: 'white', get: (s) => s.permissives[k] }));

  kit.button(S0, 'b', -0.62, 0.3, { id: 'SI_ACTUATE', title: 'SAFETY INJECTION\nACTUATE', press: 'SI_ACTUATE', color: 0xb01c14, mushroom: true, guard: true });
  kit.button(S0, 'b', -0.25, 0.3, { id: 'SI_RESET', title: 'SI RESET', press: 'SI_RESET', color: 0x1c1c1c });
  kit.switch(S0, 'b', 0.12, 0.32, { id: 'SI_BLOCK', title: 'LO PZR PRESS SI', positions: ['NORMAL', 'BLOCK'], get: (c) => (c.siBlocked ? 1 : 0), set: (c, i) => (c.siBlocked = i === 1) });
  kit.label(S0, 'b', 0.6, 0.38, 'SI BLOCK PERMITTED\nONLY BELOW P-11', 0.22, 0.05, 'yellow');

  /* ============ 1: CVCS ============ */
  kit.readout(S1, 'v', -0.8, 1.76, { title: 'RCS BORON PPM', get: (s) => fmt(s.boronPpm, 0), color: 'green', w: 0.16, h: 0.055, unit: 'ppm' });
  kit.meter(S1, 'v', -0.45, 1.74, { title: 'CHARGING FLOW', unit: 'GPM', min: 0, max: 200, ticks: [0, 50, 100, 150, 200], get: (s) => s.chargingFlowGpm });
  kit.meter(S1, 'v', -0.25, 1.74, { title: 'LETDOWN FLOW', unit: 'GPM', min: 0, max: 160, ticks: [0, 40, 80, 120, 160], get: (s) => s.letdownFlowGpm });
  kit.meter(S1, 'v', -0.05, 1.74, { title: 'PZR LEVEL', unit: '% (RED=PROG)', min: 0, max: 100, get: (s) => s.przLevel, get2: (s) => s.przLevelProgram, zones: [[0, 17, '#c82020'], [92, 100, '#c82020']] });
  kit.lamp(S1, 'v', 0.25, 1.8, { title: 'DILUTE IN\nPROGRESS', color: 'amber', get: () => C().makeupMode === 'dilute' && C().makeupRateGpm > 0 });
  kit.lamp(S1, 'v', 0.45, 1.8, { title: 'BORATE IN\nPROGRESS', color: 'amber', get: () => C().makeupMode === 'borate' && C().makeupRateGpm > 0 });
  kit.lamp(S1, 'v', 0.65, 1.8, { title: 'LETDOWN\nISOLATED', color: 'red', get: (s) => C().letdownIsolated || s.letdownFlowGpm < 1 });
  kit.lamp(S1, 'v', 0.85, 1.8, { title: 'CHARGING\nIN MANUAL', color: 'white', get: () => C().chargingMode === 'manual' });
  kit.readout(S1, 'v', 0.35, 1.58, { title: 'MAKEUP RATE GPM', get: () => fmt(C().makeupRateGpm, 0), color: 'amber', unit: 'gpm' });
  kit.readout(S1, 'v', 0.7, 1.58, { title: 'CHG DEMAND %', get: () => fmt(C().chargingFlowDemand, 0), color: 'amber', unit: '%' });
  kit.readout(S1, 'v', -0.45, 1.5, { title: 'CHARGING GPM', get: (s) => fmt(s.chargingFlowGpm, 1), unit: 'gpm' });
  kit.readout(S1, 'v', -0.15, 1.5, { title: 'LETDOWN GPM', get: (s) => fmt(s.letdownFlowGpm, 1), unit: 'gpm' });
  kit.label(S1, 'v', 0.0, 1.27, 'DILUTE: ADDS +REACTIVITY · BORATE: ADDS −REACTIVITY', 0.9, 0.03, 'yellow');

  kit.groupBox(S1, 'b', -1.0, 0.08, -0.05, 0.6, 'REACTOR MAKEUP');
  const mk = ['off', 'auto', 'dilute', 'borate'] as const;
  kit.switch(S1, 'b', -0.75, 0.33, { id: 'MAKEUP_MODE', title: 'MAKEUP MODE', positions: ['OFF', 'AUTO', 'DIL', 'BOR'], get: (c) => mk.indexOf(c.makeupMode), set: (c, i) => (c.makeupMode = mk[i]) });
  kit.knob(S1, 'b', -0.32, 0.33, { id: 'MAKEUP_RATE', title: 'MAKEUP RATE GPM', min: 0, max: 120, step: 1, coarse: 10, get: (c) => c.makeupRateGpm, set: (c, v) => (c.makeupRateGpm = v), fmt: (v) => `${v.toFixed(0)} gpm`, ticks: ['0', '60', '120'] });
  kit.groupBox(S1, 'b', 0.05, 0.08, 1.0, 0.6, 'CHARGING / LETDOWN');
  kit.switch(S1, 'b', 0.22, 0.33, { id: 'CHG_MODE', title: 'CHARGING CTRL', positions: ['MAN', 'AUTO'], get: (c) => (c.chargingMode === 'auto' ? 1 : 0), set: (c, i) => (c.chargingMode = i ? 'auto' : 'manual') });
  kit.knob(S1, 'b', 0.52, 0.33, { id: 'CHG_DEMAND', title: 'CHARGING DEMAND', min: 0, max: 100, step: 1, coarse: 10, get: (c) => c.chargingFlowDemand, set: (c, v) => (c.chargingFlowDemand = v), fmt: (v) => `${v.toFixed(0)} %`, ticks: ['0', '50', '100'] });
  kit.switch(S1, 'b', 0.82, 0.33, { id: 'LETDOWN', title: 'LETDOWN ISOL', positions: ['ISOL', 'NORM'], get: (c) => (c.letdownIsolated ? 0 : 1), set: (c, i) => (c.letdownIsolated = i === 0) });

  /* ============ 2: PRESSURIZER ============ */
  kit.meter(S2, 'v', -0.85, 1.72, { title: 'PZR PRESSURE', unit: 'PSIG', min: 1700, max: 2500, size: 0.19, ticks: [1700, 1900, 2100, 2300, 2500], minor: 3, get: (s) => s.rcsPressure, zones: [[1700, 1865, '#c82020'], [2385, 2500, '#c82020']], fmt: (v) => v.toFixed(0) });
  kit.meter(S2, 'v', -0.6, 1.72, { title: 'RCS PRESS WR', unit: 'PSIG', min: 0, max: 3000, ticks: [0, 1000, 2000, 3000], get: (s) => s.rcsPressure, fmt: (v) => v.toFixed(0) });
  kit.meter(S2, 'v', -0.4, 1.72, { title: 'PZR LEVEL', unit: '% (RED=PROG)', min: 0, max: 100, get: (s) => s.przLevel, get2: (s) => s.przLevelProgram, zones: [[0, 17, '#c82020'], [92, 100, '#c82020']] });
  kit.meter(S2, 'v', -0.2, 1.72, { title: 'HEATER OUTPUT', unit: 'KW', min: 0, max: 1800, ticks: [0, 600, 1200, 1800], get: (s) => s.przHeaterKW, fmt: (v) => v.toFixed(0) });
  kit.meter(S2, 'v', 0.0, 1.72, { title: 'SPRAY VALVE', unit: '% OPEN', min: 0, max: 100, get: (s) => s.przSprayPos * 100 });
  kit.readout(S2, 'v', -0.85, 1.48, { title: 'PZR PRESS PSIG', get: (s) => fmt(s.rcsPressure, 0), unit: 'psig' });
  kit.readout(S2, 'v', -0.55, 1.48, { title: 'PZR LEVEL %', get: (s) => fmt(s.przLevel, 1), unit: '%' });
  kit.readout(S2, 'v', -0.25, 1.48, { title: 'PZR TEMP °F', get: (s) => fmt(s.przTemp, 1), unit: '°F' });
  kit.readout(S2, 'v', 0.05, 1.48, { title: 'LEVEL PROGRAM %', get: (s) => fmt(s.przLevelProgram, 1), color: 'amber', unit: '%' });
  kit.groupBox(S2, 'v', 0.2, 1.58, 1.05, 1.9, 'RELIEF VALVES / HEATERS');
  kit.lamp(S2, 'v', 0.33, 1.8, { title: 'PORV\nOPEN', color: 'red', get: (s) => s.porvOpen });
  kit.lamp(S2, 'v', 0.51, 1.8, { title: 'BLOCK VLV\nOPEN', color: 'red', get: () => C().porvBlockValveOpen });
  kit.lamp(S2, 'v', 0.69, 1.8, { title: 'SAFETY VLV\nOPEN', color: 'red', get: (s) => s.safetyValvesOpen, flash: true });
  kit.lamp(S2, 'v', 0.87, 1.8, { title: 'BACKUP HTRS\nENERGIZED', color: 'red', get: (s) => s.przHeaterKW > 400 });
  kit.label(S2, 'v', 0.6, 1.37, 'NORMAL OPERATING PRESSURE 2235 PSIG\nHI TRIP 2385 · LO TRIP 1865 · PORV 2335', 0.75, 0.07, 'white');

  kit.switch(S2, 'b', -0.8, 0.33, { id: 'PZR_HEATERS', title: 'BACKUP HEATERS', positions: ['OFF', 'AUTO', 'ON'], get: (c) => OAA.indexOf(c.przHeaters), set: (c, i) => (c.przHeaters = OAA[i]) });
  kit.switch(S2, 'b', -0.45, 0.33, { id: 'PZR_SPRAY_MODE', title: 'SPRAY CONTROL', positions: ['MAN', 'AUTO'], get: (c) => (c.przSprayMode === 'auto' ? 1 : 0), set: (c, i) => (c.przSprayMode = i ? 'auto' : 'manual') });
  kit.knob(S2, 'b', -0.15, 0.33, { id: 'PZR_SPRAY_DEMAND', title: 'SPRAY DEMAND', min: 0, max: 1, step: 0.02, coarse: 0.1, get: (c) => c.przSprayDemand, set: (c, v) => (c.przSprayDemand = v), fmt: (v) => `${(v * 100).toFixed(0)} %`, ticks: ['0', '50', '100'] });
  const porv = ['closed', 'auto', 'open'] as const;
  kit.switch(S2, 'b', 0.3, 0.33, { id: 'PORV', title: 'PORV PCV-455A', positions: ['CLOSE', 'AUTO', 'OPEN'], get: (c) => porv.indexOf(c.porvMode), set: (c, i) => (c.porvMode = porv[i]), red: true });
  kit.switch(S2, 'b', 0.65, 0.33, { id: 'PORV_BLOCK', title: 'PORV BLOCK VLV', positions: ['CLOSE', 'OPEN'], get: (c) => (c.porvBlockValveOpen ? 1 : 0), set: (c, i) => (c.porvBlockValveOpen = i === 1) });

  /* ============ 3: RCS ============ */
  for (let L = 0; L < 4; L++) {
    const cu = -0.81 + L * 0.54;
    kit.groupBox(S3, 'v', cu - 0.135, 1.53, cu + 0.135, 1.88, `LOOP ${loopTitle[L]}`);
    kit.vmeter(S3, 'v', cu - 0.075, 1.69, { title: `LOOP ${L + 1} THOT`, unit: '°F', min: 500, max: 650, ticks: [500, 550, 600, 650], get: (s) => s.loops[L].tHot, zones: [[620, 650, '#c82020']] }, 'THOT');
    kit.vmeter(S3, 'v', cu, 1.69, { title: `LOOP ${L + 1} TCOLD`, unit: '°F', min: 500, max: 650, ticks: [500, 550, 600, 650], get: (s) => s.loops[L].tCold }, 'TCOLD');
    kit.vmeter(S3, 'v', cu + 0.075, 1.69, { title: `LOOP ${L + 1} FLOW`, unit: '%', min: 0, max: 120, ticks: [0, 40, 80, 120], get: (s) => s.loops[L].flow, zones: [[0, 90, '#e0b020']] }, 'FLOW');
  }
  const rcsRead: [string, (s: PlantState) => string, 'red' | 'green' | 'amber'][] = [
    ['TAVG °F', (s) => fmt(s.tAvg, 1), 'red'],
    ['TREF °F', (s) => fmt(s.tRef, 1), 'amber'],
    ['CORE ΔT °F', (s) => fmt(s.deltaT, 1), 'red'],
    ['SUBCOOLING °F', (s) => fmt(s.subcoolingMargin, 0), 'green'],
    ['CORE EXIT °F', (s) => fmt(s.coreExitTemp, 0), 'red'],
    ['DNBR', (s) => fmt(s.dnbr, 2), 'green'],
  ];
  rcsRead.forEach(([t, g, c], i) => kit.readout(S3, 'v', -0.88 + i * 0.352, 1.33, { title: t, get: g, color: c }));
  for (let L = 0; L < 4; L++) {
    const cu = -0.75 + L * 0.5;
    kit.groupBox(S3, 'b', cu - 0.2, 0.08, cu + 0.2, 0.6, `RCP ${loopTitle[L]}`);
    kit.lamp(S3, 'b', cu - 0.08, 0.49, { title: 'RUN', hover: `RCP ${L + 1} RUNNING`, color: 'red', get: (s) => s.loops[L].rcpRunning });
    kit.lamp(S3, 'b', cu + 0.08, 0.49, { title: 'STOP', hover: `RCP ${L + 1} STOPPED`, color: 'green', get: (s) => !s.loops[L].rcpRunning });
    kit.button(S3, 'b', cu - 0.08, 0.2, { id: `RCP_START_${L}`, title: 'START', hover: `RCP ${L + 1} START`, press: `RCP_START_${L}`, color: 0x8c1a14 });
    kit.button(S3, 'b', cu + 0.08, 0.2, { id: `RCP_STOP_${L}`, title: 'STOP', hover: `RCP ${L + 1} STOP`, press: `RCP_STOP_${L}`, color: 0x1d5a2a });
  }

  /* ============ 4: REACTOR CONTROL ============ */
  const firstOutAt = { sec: S4, u: 0.5, v: 1.74 };
  // rod position display (custom canvas)
  const rodFrame = surfaceFrame(S4, 'v', -0.56, 1.6, 0);
  kit.shell.add(box(0.92, 0.43, 0.03), new THREE.Matrix4().makeTranslation(0, 0, 0.015).premultiply(rodFrame), PALETTE.bezel, { ao: false });
  kit.customReadout(new THREE.Matrix4().makeTranslation(0, 0, 0.031).premultiply(rodFrame), 0.88, 0.39, 900, drawRodDisplay, (s) => {
    let k = 0;
    for (let i = 0; i < ROD_BANKS.length; i++) k = k * 229 + Math.round(s.rods[ROD_BANKS[i]]);
    return k;
  });
  kit.labelAt(surfaceFrame(S4, 'v', -0.56, 1.84, 0.004), 'DIGITAL ROD POSITION INDICATION — STEPS WITHDRAWN', 0.72, 0.03, 'white');
  kit.interactables.push(infoBox(rodFrame, 0.46, 0.21, 'ROD POSITIONS', (s) => ROD_BANKS.map((b) => `${b} ${Math.round(s.rods[b])}`).join('  ')));
  kit.meter(S4, 'v', 0.12, 1.43, { title: 'TAVG − TREF', unit: '°F', min: -10, max: 10, ticks: [-10, -5, 0, 5, 10], get: (s) => s.tAvg - s.tRef, zones: [[-10, -3, '#e0b020'], [3, 10, '#e0b020']], fmt: (v) => v.toFixed(1) });
  kit.readout(S4, 'v', 0.4, 1.47, { title: 'ROD SPEED SPM', get: (s) => fmt(s.rodSpeedSpm, 0), color: 'amber', w: 0.1, unit: 'steps/min' });
  kit.readout(S4, 'v', 0.4, 1.36, { title: 'BANK SELECT', get: () => (C().rodBankSelect === 'MANUAL_SEQ' ? 'SEQ' : C().rodBankSelect), color: 'green', w: 0.1 });
  kit.lamp(S4, 'v', 0.6, 1.5, { title: 'ROD\nBOTTOM', color: 'red', get: (s) => s.rodBottomLights, flash: true });
  kit.lamp(S4, 'v', 0.76, 1.5, { title: 'RODS\nMOVING', color: 'white', get: (s) => s.rodsMoving });
  kit.lamp(S4, 'v', 0.92, 1.5, { title: 'ROD CTRL\nIN AUTO', color: 'green', get: () => C().rodMode === 'auto' });
  kit.lamp(S4, 'v', 0.6, 1.33, { title: 'REACTOR\nTRIPPED', color: 'red', get: (s) => s.reactorTripped });
  kit.lamp(S4, 'v', 0.76, 1.33, { title: 'TRIP BKRS\nCLOSED', color: 'green', get: (s) => !s.reactorTripped });
  kit.lamp(S4, 'v', 0.92, 1.33, { title: 'DROPPED\nROD', color: 'amber', get: (s) => s.droppedRods > 0 });

  const banks: (RodBankId | 'MANUAL_SEQ')[] = ['SA', 'SB', 'CA', 'CB', 'CC', 'CD', 'MANUAL_SEQ'];
  kit.groupBox(S4, 'b', -1.0, 0.08, -0.08, 0.62, 'ROD CONTROL');
  kit.switch(S4, 'b', -0.78, 0.4, { id: 'ROD_BANK_SELECT', title: 'BANK SELECTOR', positions: ['SA', 'SB', 'CA', 'CB', 'CC', 'CD', 'SEQ'], angles: [-90, -60, -30, 0, 30, 60, 90], get: (c) => banks.indexOf(c.rodBankSelect), set: (c, i) => (c.rodBankSelect = banks[i]), size: 0.14 });
  kit.switch(S4, 'b', -0.5, 0.4, { id: 'ROD_MODE', title: 'ROD CONTROL MODE', positions: ['MAN', 'AUTO'], get: (c) => (c.rodMode === 'auto' ? 1 : 0), set: (c, i) => (c.rodMode = i ? 'auto' : 'manual') });
  kit.lever(S4, 'b', -0.25, 0.32);
  kit.label(S4, 'b', -0.62, 0.15, 'MANUAL: SELECT BANK, HOLD LEVER\nAUTO: RODS FOLLOW TAVG/TREF', 0.36, 0.05, 'white');
  kit.button(S4, 'b', 0.12, 0.4, { id: 'TRIP_RESET', title: 'TRIP RESET', press: 'TRIP_RESET', color: 0x1c1c1c });
  kit.button(S4, 'b', 0.12, 0.17, { id: 'REACTOR_TRIP_1', title: 'REACTOR\nTRIP', press: 'REACTOR_TRIP', color: 0xb01c14, mushroom: true, guard: true });
  kit.groupBox(S4, 'b', 0.38, 0.3, 0.98, 0.6, 'ANNUNCIATOR');
  kit.button(S4, 'b', 0.52, 0.4, { id: 'ALARM_ACK', title: 'ACK', press: 'ALARM_ACK', color: 0xd6b31c });
  kit.button(S4, 'b', 0.68, 0.4, { id: 'ALARM_RESET', title: 'RESET', press: 'ALARM_RESET', color: 0x1c1c1c });
  kit.button(S4, 'b', 0.84, 0.4, { id: 'ALARM_ACK_2', title: 'SILENCE', press: 'ALARM_ACK', color: 0x2a3a6a });

  /* ============ 5: NUCLEAR INSTRUMENTATION ============ */
  kit.groupBox(S5, 'v', -1.07, 1.6, 0.18, 1.91, 'NIS CHANNELS');
  kit.meter(S5, 'v', -0.92, 1.74, { title: 'SOURCE RANGE', unit: 'CPS', min: 1, max: 1e6, log: true, get: (s) => s.sourceRangeCps, zones: [[1e5, 1e6, '#c82020']], fmt: (v) => fmtExp(v, 1) });
  kit.meter(S5, 'v', -0.72, 1.74, { title: 'INTERMED RANGE', unit: 'AMPS', min: 1e-11, max: 1e-3, log: true, get: (s) => s.intermediateRangeAmps, fmt: (v) => fmtExp(v, 1), tickFmt: (v) => `${Math.round(Math.log10(v))}` });
  kit.meter(S5, 'v', -0.52, 1.74, { title: 'POWER RANGE', unit: '% RTP', min: 0, max: 120, ticks: [0, 20, 40, 60, 80, 100, 120], minor: 1, get: (s) => s.powerRangePct, zones: [[100, 109, '#e0b020'], [109, 120, '#c82020']] });
  kit.meter(S5, 'v', -0.32, 1.74, { title: 'STARTUP RATE', unit: 'DPM', min: -1, max: 5, ticks: [-1, 0, 1, 2, 3, 4, 5], minor: 1, get: (s) => s.startupRateDpm, zones: [[1, 5, '#e0b020']], fmt: (v) => v.toFixed(2) });
  kit.meter(S5, 'v', -0.1, 1.74, { title: 'AXIAL OFFSET', unit: '% ΔI', min: -30, max: 30, ticks: [-30, -15, 0, 15, 30], get: (s) => s.axialOffset, zones: [[-30, -12, '#e0b020'], [12, 30, '#e0b020']] });
  kit.readout(S5, 'v', -0.92, 1.47, { title: 'SR CPS', get: (s) => (s.permissives?.P6 && s.sourceRangeCps <= 0 ? 'HV OFF' : fmtExp(s.sourceRangeCps, 2)), w: 0.13, unit: 'cps' });
  kit.readout(S5, 'v', -0.71, 1.47, { title: 'IR AMPS', get: (s) => fmtExp(s.intermediateRangeAmps, 2), w: 0.13, unit: 'A' });
  kit.readout(S5, 'v', -0.5, 1.47, { title: 'PR % POWER', get: (s) => fmt(s.powerRangePct, 1), w: 0.13, unit: '%' });
  kit.readout(S5, 'v', -0.29, 1.47, { title: 'PERIOD SEC', get: (s) => (Number.isFinite(s.periodSeconds) && Math.abs(s.periodSeconds) < 1e5 ? fmt(s.periodSeconds, 0) : 'INF'), w: 0.13, color: 'amber', unit: 's' });
  kit.readout(S5, 'v', -0.08, 1.47, { title: 'FLUX N/CM²S', get: (s) => fmtExp(s.neutronFlux, 2), w: 0.13, color: 'green' });
  kit.lamp(S5, 'v', -0.88, 1.29, { title: 'SR HV\nON', color: 'green', get: (s) => !s.permissives?.P6 || s.sourceRangeCps > 0 });
  kit.lamp(S5, 'v', -0.7, 1.29, { title: 'P-6\nPERMISSIVE', color: 'white', get: (s) => s.permissives.P6 });
  kit.lamp(S5, 'v', -0.52, 1.29, { title: 'P-10\nPERMISSIVE', color: 'white', get: (s) => s.permissives.P10 });
  kit.lamp(S5, 'v', -0.34, 1.29, { title: 'HI STARTUP\nRATE', color: 'amber', get: (s) => s.startupRateDpm > 1, flash: true });
  kit.lamp(S5, 'v', -0.16, 1.29, { title: 'REACTOR\nCRITICAL', color: 'amber', get: (s) => s.keff >= 0.9999 && !s.reactorTripped });
  // chart recorder
  const chart = new ChartRecorder();
  const chartFrame = surfaceFrame(S5, 'v', 0.62, 1.56, 0);
  kit.shell.add(box(0.4, 0.54, 0.05), new THREE.Matrix4().makeTranslation(0, 0, 0.025).premultiply(chartFrame), 0x2b2e30, { ao: false });
  const chartMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.45), new THREE.MeshLambertMaterial({ map: chart.tex, emissive: 0x222018 }));
  chartMesh.matrixAutoUpdate = false;
  chartMesh.matrix.makeTranslation(0, -0.01, 0.051).premultiply(chartFrame);
  chartMesh.name = 'chart-recorder';
  kit.labelAt(surfaceFrame(S5, 'v', 0.62, 1.86, 0.004), 'NIS RECORDER  RED: IR LOG  BLUE: PR %', 0.4, 0.026, 'black');
  kit.interactables.push(infoBox(chartFrame, 0.2, 0.27, 'NIS STRIP CHART', (s) => `IR ${fmtExp(s.intermediateRangeAmps, 1)} A · PR ${fmt(s.powerRangePct, 1)}% · 1 mm ≈ 2 s`));

  kit.readout(S5, 'b', -0.6, 0.42, { title: 'NEUTRON POWER %', get: (s) => (s.neutronPower < 1e-3 ? fmtExp(s.neutronPower * 100, 2) : fmt(s.neutronPower * 100, 2)), w: 0.16, unit: '%' });
  kit.readout(S5, 'b', -0.2, 0.42, { title: 'THERMAL POWER MWt', get: (s) => fmt(s.thermalPower * 3411, 0), w: 0.16, color: 'amber', unit: 'MWt' });
  kit.readout(S5, 'b', 0.2, 0.42, { title: 'STARTUP RATE DPM', get: (s) => fmt(s.startupRateDpm, 2), w: 0.16, color: 'green', unit: 'dpm' });
  kit.readout(S5, 'b', 0.6, 0.42, { title: 'DECAY HEAT %', get: (s) => fmt(s.decayHeat * 100, 2), w: 0.16, color: 'amber', unit: '%' });
  kit.label(S5, 'b', 0.0, 0.17, 'STARTUP: KEEP SUR < 1 DPM · HI SUR TRIP 5 DPM · P-6 AT 1E-10 A · P-10 AT 10%', 1.4, 0.035, 'yellow');

  /* ============ 6: PLANT COMPUTER ============ */
  const hist = new History(['logPower', 'pr', 'tavg', 'tref', 'press', 'przLvl', 'sgLvl', 'mwe', 'boron', 'rho']);
  const crtA = new CRT('CRT-A', ['MIMIC', 'CORE'], 0, hist);
  const crtB = new CRT('CRT-B', ['TRENDS', 'REACTIVITY', 'ALARMS'], 0.12, hist);
  const displayMeshes: THREE.Mesh[] = [chartMesh];
  for (const [crt, u] of [[crtA, -0.55], [crtB, 0.55]] as [CRT, number][]) {
    const f = surfaceFrame(S6, 'v', u, 1.53, 0);
    kit.shell.add(box(0.66, 0.54, 0.08), new THREE.Matrix4().makeTranslation(0, 0, 0.04).premultiply(f), 0x3a3c3a, { ao: false });
    kit.shell.add(box(0.58, 0.45, 0.01), new THREE.Matrix4().makeTranslation(0, 0, 0.08).premultiply(f), 0x111311, { ao: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.54, 0.405), new THREE.MeshBasicMaterial({ map: crt.tex }));
    (m.material as THREE.MeshBasicMaterial).color.setScalar(1.25);
    m.matrixAutoUpdate = false;
    m.matrix.makeTranslation(0, 0, 0.0865).premultiply(f);
    m.name = crt.name;
    displayMeshes.push(m);
    kit.labelAt(new THREE.Matrix4().makeTranslation(0, -0.245, 0.082).premultiply(f), `${crt.name}  PLANT PROCESS COMPUTER`, 0.36, 0.022, 'black');
    kit.interactables.push(infoBox(f, 0.29, 0.22, crt.name, () => `page ${crt.pages[crt.page]} — change page with the selector below`));
  }
  kit.switch(S6, 'b', -0.55, 0.38, { id: 'CRT_A_PAGE', title: 'CRT-A PAGE', positions: ['MIMIC', 'CORE'], get: () => crtA.page, set: (_c, i) => ((crtA.page = i), (crtA.timer = 0)) });
  kit.switch(S6, 'b', 0.55, 0.38, { id: 'CRT_B_PAGE', title: 'CRT-B PAGE', positions: ['TREND', 'REACT', 'ALARM'], get: () => crtB.page, set: (_c, i) => ((crtB.page = i), (crtB.timer = 0)) });
  // keyboard prop
  const kb = surfaceFrame(S6, 'b', 0, 0.2, 0);
  kit.shell.add(box(0.46, 0.17, 0.03), new THREE.Matrix4().makeTranslation(0, 0, 0.015).premultiply(kb), 0xbab4a0, { ao: false });
  for (let r = 0; r < 4; r++)
    for (let k = 0; k < 13; k++) kit.shell.add(box(0.026, 0.026, 0.012), new THREE.Matrix4().makeTranslation(-0.195 + k * 0.0325, -0.052 + r * 0.035, 0.034).premultiply(kb), r === 0 && k > 9 ? 0xc0503a : 0x4a4a46, { ao: false });
  kit.button(S6, 'b', -0.12, 0.45, { id: 'ALARM_ACK_3', title: 'ALARM ACK', press: 'ALARM_ACK', color: 0xd6b31c });
  kit.button(S6, 'b', 0.12, 0.45, { id: 'ALARM_RESET_2', title: 'ALARM RESET', press: 'ALARM_RESET', color: 0x1c1c1c });

  /* ============ 7: STEAM GENERATORS ============ */
  for (let g = 0; g < 4; g++) {
    const cu = -0.81 + g * 0.54;
    kit.groupBox(S7, 'v', cu - 0.16, 1.54, cu + 0.16, 1.88, `S/G ${sgTitle[g]}`);
    kit.vmeter(S7, 'v', cu - 0.1, 1.7, { title: `SG ${sgTitle[g]} NR LEVEL`, unit: '%', min: 0, max: 100, ticks: [0, 25, 50, 75, 100], get: (s) => s.loops[g].sgLevel, zones: [[0, 17, '#c82020'], [78, 100, '#c82020']] }, 'LEVEL');
    kit.vmeter(S7, 'v', cu - 0.033, 1.7, { title: `SG ${sgTitle[g]} PRESSURE`, unit: 'PSIG', min: 0, max: 1300, ticks: [0, 400, 800, 1200], get: (s) => s.loops[g].sgPressure }, 'PRESS');
    kit.vmeter(S7, 'v', 0.033 + cu, 1.7, { title: `SG ${sgTitle[g]} STEAM FLOW`, unit: '%', min: 0, max: 120, ticks: [0, 40, 80, 120], get: (s) => s.loops[g].steamFlow, get2: (s) => s.loops[g].feedFlow }, 'STM FL');
    kit.vmeter(S7, 'v', cu + 0.1, 1.7, { title: `SG ${sgTitle[g]} FEED FLOW`, unit: '%', min: 0, max: 120, ticks: [0, 40, 80, 120], get: (s) => s.loops[g].feedFlow }, 'FW FL');
    kit.readout(S7, 'v', cu - 0.075, 1.36, { title: 'FRV POS %', get: (s) => fmt(s.loops[g].feedValvePos * 100, 0), w: 0.1, color: 'amber', unit: '%' });
    kit.readout(S7, 'v', cu + 0.075, 1.36, { title: 'WR LEVEL %', get: (s) => fmt(s.loops[g].sgLevelWide, 0), w: 0.1, color: 'green', unit: '%' });
    kit.groupBox(S7, 'b', cu - 0.22, 0.06, cu + 0.22, 0.62, `S/G ${sgTitle[g]} FEED REG VALVE`);
    kit.switch(S7, 'b', cu - 0.1, 0.42, { id: `FRV_MODE_${g}`, title: 'FRV MODE', positions: ['MAN', 'AUTO'], get: (c) => (c.feedMode[g] === 'auto' ? 1 : 0), set: (c, i) => (c.feedMode[g] = i ? 'auto' : 'manual'), size: 0.11 });
    kit.knob(S7, 'b', cu + 0.1, 0.42, { id: `FRV_DEMAND_${g}`, title: 'FRV DEMAND', min: 0, max: 1, step: 0.01, coarse: 0.1, get: (c) => c.feedValveDemand[g], set: (c, v) => (c.feedValveDemand[g] = v), fmt: (v) => `${(v * 100).toFixed(0)} %`, ticks: ['0', '50', '100'] });
    kit.readout(S7, 'b', cu, 0.16, { title: 'AFW FLOW GPM', get: (s) => fmt(s.loops[g].auxFeedFlow, 0), w: 0.12, unit: 'gpm' });
  }

  /* ============ 8: FEEDWATER & STEAM DUMP ============ */
  kit.meter(S8, 'v', -0.88, 1.73, { title: 'STM HDR PRESS', unit: 'PSIG', min: 0, max: 1300, ticks: [0, 400, 800, 1200], get: (s) => s.steamHeaderPressure, fmt: (v) => v.toFixed(0) });
  kit.meter(S8, 'v', -0.68, 1.73, { title: 'COND VACUUM', unit: 'IN HG', min: 0, max: 30, ticks: [0, 10, 20, 30], get: (s) => s.condenserVacuum, zones: [[0, 22, '#e0b020']] });
  kit.meter(S8, 'v', -0.48, 1.73, { title: 'STEAM DUMP DEM', unit: '%', min: 0, max: 100, get: (s) => s.steamDumpDemand * 100 });
  kit.meter(S8, 'v', -0.28, 1.73, { title: 'TOTAL FEED FLOW', unit: '% RATED', min: 0, max: 120, ticks: [0, 40, 80, 120], get: (s) => (s.loops[0].feedFlow + s.loops[1].feedFlow + s.loops[2].feedFlow + s.loops[3].feedFlow) / 4, get2: (s) => (s.loops[0].steamFlow + s.loops[1].steamFlow + s.loops[2].steamFlow + s.loops[3].steamFlow) / 4 });
  kit.meter(S8, 'v', -0.08, 1.73, { title: 'TOTAL AFW FLOW', unit: 'GPM', min: 0, max: 1200, ticks: [0, 400, 800, 1200], get: (s) => s.loops[0].auxFeedFlow + s.loops[1].auxFeedFlow + s.loops[2].auxFeedFlow + s.loops[3].auxFeedFlow, fmt: (v) => v.toFixed(0) });
  kit.label(S8, 'v', -0.28, 1.6, 'RED NEEDLE = STEAM FLOW', 0.2, 0.018, 'white');
  kit.groupBox(S8, 'v', 0.12, 1.58, 1.06, 1.9, 'PUMP STATUS');
  kit.lamp(S8, 'v', 0.25, 1.8, { title: 'MFP A\nRUNNING', color: 'red', get: (s) => s.mainFeedPumpsRunning[0] });
  kit.lamp(S8, 'v', 0.43, 1.8, { title: 'MFP B\nRUNNING', color: 'red', get: (s) => s.mainFeedPumpsRunning[1] });
  kit.lamp(S8, 'v', 0.61, 1.8, { title: 'AFW 1\nMOTOR', color: 'red', get: (s) => s.auxFeedPumpsRunning[0] });
  kit.lamp(S8, 'v', 0.79, 1.8, { title: 'AFW 2\nMOTOR', color: 'red', get: (s) => s.auxFeedPumpsRunning[1] });
  kit.lamp(S8, 'v', 0.97, 1.8, { title: 'AFW 3\nTURB DRIVEN', color: 'red', get: (s) => s.auxFeedPumpsRunning[2] });
  kit.readout(S8, 'v', 0.3, 1.47, { title: 'STM HDR PSIG', get: (s) => fmt(s.steamHeaderPressure, 0), unit: 'psig' });
  kit.readout(S8, 'v', 0.6, 1.47, { title: 'DUMP SETPT PSIG', get: () => fmt(C().steamDumpPressureSetpoint, 0), color: 'amber', unit: 'psig' });
  kit.readout(S8, 'v', 0.9, 1.47, { title: 'DUMP DEMAND %', get: (s) => fmt(s.steamDumpDemand * 100, 0), color: 'green', unit: '%' });
  kit.lamp(S8, 'v', 0.3, 1.29, { title: 'STEAM DUMP\nARMED', color: 'amber', get: () => C().steamDumpMode !== 'off' });
  kit.lamp(S8, 'v', 0.5, 1.29, { title: 'DUMPS\nOPEN', color: 'red', get: (s) => s.steamDumpDemand > 0.02 });

  kit.groupBox(S8, 'b', -1.0, 0.06, 0.02, 0.62, 'FEED PUMPS');
  kit.button(S8, 'b', -0.78, 0.18, { id: 'MFP_A_TOGGLE', title: 'MFP A\nSTART/STOP', press: 'MFP_A_TOGGLE', color: 0x1c1c1c, lamp: (s) => s.mainFeedPumpsRunning[0], lampColor: 'red' });
  kit.button(S8, 'b', -0.42, 0.18, { id: 'MFP_B_TOGGLE', title: 'MFP B\nSTART/STOP', press: 'MFP_B_TOGGLE', color: 0x1c1c1c, lamp: (s) => s.mainFeedPumpsRunning[1], lampColor: 'red' });
  for (let i = 0; i < 3; i++) {
    kit.switch(S8, 'b', -0.82 + i * 0.29, 0.44, { id: `AFW_${i}`, title: i < 2 ? `AFW PUMP ${i + 1}` : 'AFW PUMP 3 TD', positions: ['STOP', 'AUTO', 'START'], get: (c) => OAA.indexOf(c.auxFeedPumps[i]), set: (c, k) => (c.auxFeedPumps[i] = OAA[k]), size: 0.11 });
  }
  kit.groupBox(S8, 'b', 0.12, 0.06, 1.0, 0.62, 'CONDENSER STEAM DUMP');
  const dm = ['off', 'tavg', 'pressure'] as const;
  kit.switch(S8, 'b', 0.33, 0.36, { id: 'STEAM_DUMP_MODE', title: 'STEAM DUMP MODE', positions: ['OFF', 'TAVG', 'PRESS'], get: (c) => dm.indexOf(c.steamDumpMode), set: (c, i) => (c.steamDumpMode = dm[i]) });
  kit.knob(S8, 'b', 0.72, 0.36, { id: 'STEAM_DUMP_SETPT', title: 'DUMP PRESS SETPT', min: 900, max: 1200, step: 5, coarse: 25, get: (c) => c.steamDumpPressureSetpoint, set: (c, v) => (c.steamDumpPressureSetpoint = v), fmt: (v) => `${v.toFixed(0)} psig`, ticks: ['900', '1050', '1200'] });

  /* ============ 9: TURBINE / GENERATOR ============ */
  kit.meter(S9, 'v', -0.86, 1.72, { title: 'TURBINE SPEED', unit: 'RPM', min: 0, max: 2000, size: 0.18, ticks: [0, 500, 1000, 1500, 2000], get: (s) => s.turbineSpeedRpm, zones: [[1850, 1980, '#e0b020'], [1980, 2000, '#c82020']], fmt: (v) => v.toFixed(0) });
  kit.meter(S9, 'v', -0.64, 1.72, { title: 'GENERATOR OUTPUT', unit: 'MWE', min: 0, max: 1300, size: 0.18, ticks: [0, 300, 600, 900, 1200], get: (s) => s.grossMWe, get2: (s) => s.turbineLoadMW, fmt: (v) => v.toFixed(0) });
  // synchroscope
  const syncFrame = surfaceFrame(S9, 'v', -0.4, 1.72, 0);
  kit.shell.add(box(0.18, 0.18, 0.03), new THREE.Matrix4().makeTranslation(0, 0, 0.015).premultiply(syncFrame), PALETTE.bezel, { ao: false });
  let syncAngle = 0;
  let syncLast = -1;
  kit.dialFree(syncFrame, 0.16, drawSyncFace, [
    {
      get: (s) => {
        const now = performance.now() / 1000;
        const dt = syncLast < 0 ? 0 : Math.min(0.1, now - syncLast);
        syncLast = now;
        if (s.generatorBreakerClosed) syncAngle *= 0.8;
        else if (s.turbineSpeedRpm > 1500) {
          const slipHz = Math.max(-2.5, Math.min(2.5, (s.turbineSpeedRpm - 1800) / 30));
          syncAngle -= slipHz * Math.PI * 2 * dt;
        }
        return syncAngle;
      },
      len: 0.065,
      wid: 0.004,
      color: 0x111111,
    },
  ]);
  kit.interactables.push(infoBox(syncFrame, 0.09, 0.09, 'SYNCHROSCOPE', (s) => (s.generatorBreakerClosed ? 'locked (breaker closed)' : s.turbineSpeedRpm > 1500 ? `slip ${(((s.turbineSpeedRpm - 1800) / 30) * 1).toFixed(2)} Hz — close breaker near 12 o'clock, rotating slowly FAST` : 'not in range (<1500 rpm)')));
  kit.label(S9, 'v', -0.4, 1.6, 'SYNCHROSCOPE', 0.16, 0.022);
  kit.readout(S9, 'v', -0.86, 1.47, { title: 'LOAD SETPOINT MW', get: () => fmt(C().turbineLoadSetpointMW, 0), color: 'amber', unit: 'MW' });
  kit.readout(S9, 'v', -0.56, 1.47, { title: 'TURBINE LOAD MW', get: (s) => fmt(s.turbineLoadMW, 0), unit: 'MW' });
  kit.readout(S9, 'v', -0.26, 1.47, { title: 'RAMP MW/MIN', get: () => fmt(C().turbineRampRateMWpm, 0), color: 'amber', unit: 'MW/min' });
  kit.readout(S9, 'v', -0.56, 1.3, { title: 'GROSS MWE', get: (s) => fmt(s.grossMWe, 0), color: 'green', w: 0.16, h: 0.055, unit: 'MWe' });
  kit.groupBox(S9, 'v', 0.05, 1.58, 1.06, 1.9, 'TURBINE / GENERATOR STATUS');
  kit.lamp(S9, 'v', 0.18, 1.8, { title: 'TURBINE\nLATCHED', color: 'white', get: (s) => s.turbineLatched });
  kit.lamp(S9, 'v', 0.36, 1.8, { title: 'TURBINE\nTRIPPED', color: 'red', get: (s) => s.turbineTripped });
  kit.lamp(S9, 'v', 0.54, 1.8, { title: 'GEN BKR\nCLOSED', color: 'red', get: (s) => s.generatorBreakerClosed });
  kit.lamp(S9, 'v', 0.72, 1.8, { title: 'GEN BKR\nOPEN', color: 'green', get: (s) => !s.generatorBreakerClosed });
  kit.lamp(S9, 'v', 0.9, 1.8, { title: 'SYNC\nPERMISSIVE', color: 'white', get: (s) => !s.generatorBreakerClosed && Math.abs(s.turbineSpeedRpm - 1800) < 8 });
  kit.label(S9, 'v', 0.55, 1.4, 'ROLL: LATCH → TURBINE TO 1800 RPM →\nSYNC → CLOSE GEN BKR → RAISE LOAD', 0.8, 0.07, 'white');

  kit.groupBox(S9, 'b', -1.0, 0.06, -0.08, 0.62, 'TURBINE');
  kit.button(S9, 'b', -0.75, 0.42, { id: 'TURBINE_LATCH', title: 'LATCH', press: 'TURBINE_LATCH', color: 0xd8d4c4 });
  kit.button(S9, 'b', -0.75, 0.16, { id: 'TURBINE_TRIP', title: 'TURBINE\nTRIP', press: 'TURBINE_TRIP', color: 0xb01c14, mushroom: true, guard: true });
  kit.knob(S9, 'b', -0.38, 0.4, { id: 'TURB_LOAD_SETPT', title: 'LOAD SETPOINT MW', min: 0, max: 1250, step: 5, coarse: 50, get: (c) => c.turbineLoadSetpointMW, set: (c, v) => (c.turbineLoadSetpointMW = v), fmt: (v) => `${v.toFixed(0)} MW`, ticks: ['0', '625', '1250'] });
  kit.knob(S9, 'b', -0.38, 0.16, { id: 'TURB_RAMP', title: 'RAMP MW/MIN', min: 1, max: 50, step: 1, coarse: 5, get: (c) => c.turbineRampRateMWpm, set: (c, v) => (c.turbineRampRateMWpm = v), fmt: (v) => `${v.toFixed(0)} MW/min`, ticks: ['1', '25', '50'] });
  kit.groupBox(S9, 'b', 0.05, 0.06, 1.0, 0.62, 'GENERATOR BREAKER');
  kit.button(S9, 'b', 0.3, 0.36, { id: 'GEN_BREAKER_CLOSE', title: 'BKR CLOSE', press: 'GEN_BREAKER_CLOSE', color: 0x8c1a14 });
  kit.button(S9, 'b', 0.6, 0.36, { id: 'GEN_BREAKER_OPEN', title: 'BKR OPEN', press: 'GEN_BREAKER_OPEN', color: 0x1d5a2a });

  void bus;
  void DEG;
  return { sections, crtA, crtB, chart, hist, displayMeshes, firstOutAt };
}

/* ------------------------------------------------------------------ */
function infoBox(frame: THREE.Matrix4, hx: number, hy: number, label: string, detail: (s: PlantState) => string) {
  return {
    id: 'info:' + label,
    label,
    kind: 'info' as const,
    inv: frame.clone().invert(),
    half: new THREE.Vector3(hx, hy, 0.08),
    center: new THREE.Vector3().setFromMatrixPosition(frame),
    detail: (s: PlantState) => {
      try {
        return detail(s);
      } catch {
        return '----';
      }
    },
  };
}

function drawSyncFace(ctx: CanvasRenderingContext2D, r: Region): void {
  const { x, y, w, h } = r;
  ctx.fillStyle = '#f1ecdc';
  ctx.fillRect(x, y, w, h);
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.strokeStyle = '#151515';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const l = i % 6 === 0 ? 0.1 : 0.05;
    ctx.lineWidth = i % 6 === 0 ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * w * 0.42, cy + Math.sin(a) * w * 0.42);
    ctx.lineTo(cx + Math.cos(a) * w * (0.42 - l), cy + Math.sin(a) * w * (0.42 - l));
    ctx.stroke();
  }
  ctx.fillStyle = '#c82020';
  ctx.fillRect(cx - 4, cy - w * 0.46, 8, w * 0.1);
  ctx.fillStyle = '#151515';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(w * 0.08)}px ${FONT}`;
  ctx.fillText('SLOW', cx - w * 0.22, cy + w * 0.22);
  ctx.fillText('FAST', cx + w * 0.22, cy + w * 0.22);
  ctx.font = `${Math.round(w * 0.06)}px ${FONT}`;
  ctx.fillText('◄', cx - w * 0.22, cy + w * 0.12);
  ctx.fillText('►', cx + w * 0.22, cy + w * 0.12);
}

function drawRodDisplay(ctx: CanvasRenderingContext2D, r: Region, s: PlantState): void {
  const { x, y, w, h } = r;
  ctx.fillStyle = '#070504';
  ctx.fillRect(x, y, w, h);
  const n = ROD_BANKS.length;
  const colW = w / n;
  const top = y + h * 0.14;
  const bot = y + h * 0.78;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const b = ROD_BANKS[i];
    const v = s.rods?.[b] ?? 0;
    const cx = x + colW * (i + 0.5);
    // bank name
    ctx.fillStyle = '#d8d0b8';
    ctx.font = `bold ${Math.round(h * 0.09)}px ${FONT}`;
    ctx.fillText(b, cx, y + h * 0.07);
    // LED bar column (segments)
    const segs = 19;
    const segH = (bot - top) / segs;
    const lit = Math.round((v / 228) * segs);
    for (let k = 0; k < segs; k++) {
      const on = k < lit;
      ctx.fillStyle = on ? (v >= 225 ? '#3dff6a' : '#ff5a24') : '#2a1208';
      ctx.fillRect(cx - colW * 0.22, bot - (k + 1) * segH + 1.5, colW * 0.44, segH - 3);
    }
    // bottom light
    ctx.fillStyle = v <= 0.5 ? '#ff3020' : '#2a0c08';
    ctx.beginPath();
    ctx.arc(cx, bot + h * 0.04, h * 0.022, 0, Math.PI * 2);
    ctx.fill();
    // step counter
    ctx.fillStyle = '#ffb030';
    ctx.font = `bold ${Math.round(h * 0.11)}px ${MONO}`;
    ctx.fillText(String(Math.round(v)).padStart(3, '0'), cx, y + h * 0.92);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x, top - 2, w, 1);
  ctx.fillRect(x, bot, w, 1);
  void fitText;
}
