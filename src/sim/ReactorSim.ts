/**
 * ReactorSim — physics model of a 4-loop Westinghouse-style PWR (3411 MWt / ~1150 MWe).
 *
 * See src/sim/README.md for the model description. Internal units are SI-ish
 * (MPa abs, °C, kg, kJ, kW); PlantState is published in control-room units (psig, °F, %).
 */
import type {
  ActiveFault, ButtonId, FaultId, PlantControls, PlantState, ReactorSimApi, RodBankId,
  ScenarioId, SimEvent, TripId,
} from './types';
import { ROD_BANKS, ROD_STEPS_MAX } from './types';
import {
  props, tsat, hf, hg, vf, vg, hfT, tOfH, psat, containerPressure, type ContainerOut,
  psigToMPa, mpaToPsig, fToC, cToF, GPM_TO_KGS, KGS_TO_GPM, ATM_MPA, rhogT, tOfRhog,
} from './steam';
import { PointKinetics, DecayHeat, Poisons, DH_TOTAL, BETA } from './kinetics';
import { bankRho, CONTROL_BANKS, seqToPositions, positionsToSeq, integralFraction, SEQ_MAX } from './rods';
import * as K from './plant';
import { UP, LP, CORE, HL, S1, S2, CL, NN, NODE_V, VFRAC, V_LOOPS, V_PZR } from './plant';
import { SCENARIOS, type ScenarioSpec } from './scenarios';
import { evaluateRps, type RpsMemory, newRpsMemory } from './rps';
import { AlarmManager } from './alarms';
import { FaultManager } from './faults';
import { Rng } from './rng';

export const DT = 0.05; // s, fixed physics step
const MAX_STEPS_PER_UPDATE = 1200;

export interface SgInternal {
  M: number; U: number; P: number; dPdt: number; voidV: number; liquidV: number;
  nr: number; wr: number; carry: number; fwet: number; Q: number;
  fwPos: number; fwInt: number; wFeed: number; wAux: number; wSteam: number; wLine: number;
  wArv: number; wSv: number; svOpen: boolean; wBreak: number; wTubeLeak: number;
  msivOpen: boolean; T: number;
}

const newSg = (): SgInternal => ({
  M: 0, U: 0, P: 7.6, dPdt: 0, voidV: 0, liquidV: 0, nr: 44, wr: 60, carry: 0, fwet: 1, Q: 0,
  fwPos: 0, fwInt: 0, wFeed: 0, wAux: 0, wSteam: 0, wLine: 0, wArv: 0, wSv: 0, svOpen: false,
  wBreak: 0, wTubeLeak: 0, msivOpen: true, T: 285,
});

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (x: number, a: number, b: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function defaultControls(): PlantControls {
  return {
    rodMode: 'manual', rodBankSelect: 'MANUAL_SEQ', rodMotion: 0,
    makeupMode: 'auto', makeupRateGpm: 40, chargingFlowDemand: 58, chargingMode: 'auto', letdownIsolated: false,
    przHeaters: 'auto', przSprayMode: 'auto', przSprayDemand: 0, porvMode: 'auto', porvBlockValveOpen: true,
    feedMode: ['auto', 'auto', 'auto', 'auto'], feedValveDemand: [0, 0, 0, 0],
    mainFeedPumps: [true, false], auxFeedPumps: ['auto', 'auto', 'auto'],
    turbineLoadSetpointMW: 0, turbineRampRateMWpm: 10, steamDumpMode: 'pressure', steamDumpPressureSetpoint: 1092,
    siBlocked: false, timeScale: 1, paused: false,
  };
}

export class ReactorSim implements ReactorSimApi {
  state!: PlantState;
  controls: PlantControls = defaultControls();
  randomFaults = false;

  // ------------------------------------------------------------ internals (public for helper modules)
  events: SimEvent[] = [];
  rng: Rng;
  spec!: ScenarioSpec;
  settling = false;
  t = 0;
  acc = 0; // un-simulated time carry

  kin = new PointKinetics();
  dh = new DecayHeat();
  poi = new Poisons();
  rhoFuel = K.RHO_FUEL;
  rho = { total: 0, rods: 0, boron: 0, doppler: 0, moderator: 0, void: 0, xenon: 0, samarium: 0 };
  lnPrev = 0;
  sur = 0; // 1/s filtered d ln n / dt
  /** fission power held fixed (settling) */
  holdPower: number | null = null;

  // primary
  h = new Float64Array(NN);
  bor = new Float64Array(NN);
  T = new Float64Array(NN);
  X = new Float64Array(NN);
  Vs = new Float64Array(NN); // specific volume
  ML = 0;
  P = psigToMPa(2235);
  W0 = 4450; // rated loop flow kg/s (calibrated at reset)
  w = new Float64Array(4); // loop flows kg/s (signed)
  wn = new Float64Array(4); // normalised
  coreFlowN = 1;
  rcpOn = [true, true, true, true];
  rcpSpeed = [1, 1, 1, 1];
  pzr = { M: 0, U: 0, B: 0, liquidV: 0, x: 0, T: 345, solid: false };
  pzrOut: ContainerOut = { P: 0, x: 0, liquidVolume: 0, T: 0, solid: false };
  sgOut: ContainerOut = { P: 0, x: 0, liquidVolume: 0, T: 0, solid: false };
  przHeaterBackupOn = false;
  porvValveOpen = false;
  pzrSvPos = 0;
  pzrSvOpen = false;
  chargingInt = 0;
  chargingKgs = 0;
  letdownKgs = 0;
  letdownAutoIsolated = false;
  vctBoron = 0;
  sprayKgs = 0;
  reliefKgs = 0;
  prtEnergy = 0; // kJ absorbed in pressurizer relief tank
  prtRuptured = false;
  breakKgs = 0;
  tubeLeakKgs = 0;
  vaporVolume = 0;
  coreLevel = 1;
  rcsH2 = 0;
  rcsReleasedMass = 0;

  // core regions [bulk, hot]
  Tf = [300, 300];
  Tc = [290, 290];
  ox = [0.003, 0.003];
  fail = [0, 0];
  melt = [0, 0];
  tfRate = [0, 0];
  uncov = [0, 0];
  dnbr = 9.99;
  dnbrBulk = 9.99;
  chfC0 = 1;
  qCoolKW = 0;
  oxHeatKW = 0;

  // secondary
  sg: SgInternal[] = [newSg(), newSg(), newSg(), newSg()];
  Ph = 7.6;
  tFeed = 38;
  turb = { latched: false, tripped: true, speed: 0, gv: 0, wt: 0, loadRef: 0, mwe: 0, breaker: false, mwInt: 0, breakerTripTimer: -1 };
  dumpPos = 0;
  vacuum = 28;
  mfpRunning = [true, false];
  afwRunning = [false, false, false];
  afwAutoLatched = [false, false, false];
  fwIsolation = false; // P-14 / SI feed isolation (MFPs trip, FRVs shut)
  fwRegClosedP4 = false; // reactor trip + low Tavg closes FRVs
  rodSeq = 0;
  rodPos: Record<RodBankId, number> = { SA: 0, SB: 0, CA: 0, CB: 0, CC: 0, CD: 0 };
  rodDrop: { active: boolean; t: number; p0: Record<RodBankId, number> } = { active: false, t: 0, p0: { SA: 0, SB: 0, CA: 0, CB: 0, CC: 0, CD: 0 } };
  rodStepAcc = 0;
  rodSpeed = 0;
  stuckRod: { bank: RodBankId; pos: number } | null = null;
  droppedRod: { bank: RodBankId } | null = null;
  aoXe = 0;

  // electrical / ECCS
  offsite = true;
  offsiteRestoreAt = -1;
  dgTimer = [-1, -1]; // seconds since start (-1 = stopped)
  dgStopTimer = 0;
  siActuated = false;
  siTimer = 0;
  siKgs = 0;
  accum = [0, 0, 0, 0].map(() => ({ water: K.ACC_WATER, gasV: K.ACC_GAS_V0, isolated: false }));
  accumulatorsInjected = false;

  // containment
  cont = { mv: 0, Tw: 49, h2: 0, theta: 0, pAir0: 0.1, sprays: false, P: ATM_MPA, T: 49, rad: 0.01, src: 0 };

  // protection
  reactorTripped = false;
  firstOut: TripId | null = null;
  manualTripPending = false;
  rpsMem: RpsMemory = newRpsMemory();
  tripSignals: TripId[] = [];
  siSignals: string[] = [];
  permissives = { P6: false, P7: false, P8: false, P9: false, P10: false, P11: true };
  rodStop = { C1: false, C2: false, C3: false, C4: false, C5: true };
  otdtSetpoint = 99;
  opdtSetpoint = 99;
  integrity = { rcs: 1, secondary: 1, containment: 1 };
  vesselBreakArea = 0;
  catastrophe: PlantState['catastrophe'] = null;

  alarms = new AlarmManager();
  faults: FaultManager;

  // instruments
  srCps = 0;
  prHistory: number[] = [];
  tavgPrev = 0;
  tavgRate = 0;

  constructor(scenario: ScenarioId = 'hot-standby', seed?: number) {
    this.rng = new Rng(seed ?? ((Math.random() * 2 ** 32) >>> 0));
    this.faults = new FaultManager(this);
    this.calibrateChf();
    this.reset(scenario);
  }

  // =================================================================== public API
  update(realDtSeconds: number): void {
    if (this.controls.paused) return;
    const ts = clamp(this.controls.timeScale || 1, 0.1, 60);
    this.acc += Math.max(0, realDtSeconds) * ts;
    let n = Math.floor(this.acc / DT);
    if (n > MAX_STEPS_PER_UPDATE) { n = MAX_STEPS_PER_UPDATE; this.acc = 0; }
    else this.acc -= n * DT;
    for (let i = 0; i < n; i++) this.step(DT);
    this.publish();
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  emit(e: SimEvent) { if (!this.settling) this.events.push(e); }
  msg(text: string) { this.emit({ type: 'message', text }); }

  injectFault(id: FaultId, target?: number | string): void { this.faults.inject(id, target); }

  press(button: ButtonId): void {
    const b = button as string;
    switch (button) {
      case 'REACTOR_TRIP': this.manualTripPending = true; break;
      case 'TRIP_RESET': {
        const present = this.tripSignals.filter((s) => s !== 'MANUAL');
        if (!this.reactorTripped) { this.msg('Reactor trip breakers already closed.'); break; }
        if (present.length) { this.msg(`Trip reset blocked: ${present.join(', ')} signal present.`); break; }
        this.reactorTripped = false;
        this.firstOut = null;
        this.rodDrop.active = false;
        this.rodSeq = positionsToSeq(this.rodPos);
        if (this.droppedRod) { this.droppedRod = null; this.faults.clear('DROPPED_ROD'); }
        this.fwRegClosedP4 = false;
        this.msg('Reactor trip breakers closed. Rods may be withdrawn.');
        break;
      }
      case 'SI_ACTUATE': this.actuateSI('MANUAL'); break;
      case 'SI_RESET': {
        if (!this.siActuated) break;
        if (this.siTimer < 60) { this.msg('SI reset blocked: 60 s timer not expired.'); break; }
        if (this.siSignals.length) { this.msg(`SI reset blocked: ${this.siSignals.join(', ')} present.`); break; }
        this.siActuated = false;
        this.fwIsolation = false;
        for (let i = 0; i < 4; i++) if (!this.faults.has('STEAM_LINE_BREAK', i)) this.sg[i].msivOpen = true;
        this.msg('Safety injection reset. SI pumps stopped; MSIVs on intact lines reopened.');
        break;
      }
      case 'TURBINE_TRIP': this.tripTurbine('Manual turbine trip'); break;
      case 'TURBINE_LATCH': {
        const why = this.turbineTripConditions();
        if (why) { this.msg(`Turbine latch blocked: ${why}.`); break; }
        if (this.turb.latched) break;
        this.turb.latched = true; this.turb.tripped = false; this.turb.gv = 0;
        this.msg('Turbine latched. Rolling to 1800 rpm.');
        break;
      }
      case 'GEN_BREAKER_CLOSE': {
        const tb = this.turb;
        if (tb.breaker) break;
        if (!tb.latched || tb.tripped) { this.msg('Breaker close blocked: turbine not latched.'); break; }
        if (Math.abs(tb.speed - 1800) > 8) { this.msg(`Breaker close blocked: turbine at ${tb.speed.toFixed(0)} rpm (need 1800 ± 8).`); break; }
        if (!this.offsite) { this.msg('Breaker close blocked: no grid voltage.'); break; }
        tb.breaker = true;
        tb.loadRef = Math.max(57, Math.min(this.controls.turbineLoadSetpointMW, 57));
        tb.mwInt = 0;
        this.emit({ type: 'breaker', closed: true });
        this.msg('Generator breaker closed — unit synchronised, 5 % block load picked up.');
        break;
      }
      case 'GEN_BREAKER_OPEN': {
        if (!this.turb.breaker) break;
        this.openBreaker('Generator breaker opened by operator');
        break;
      }
      case 'ALARM_ACK': this.alarms.ack(); break;
      case 'ALARM_RESET': this.alarms.reset(); break;
      case 'MFP_A_TOGGLE': case 'MFP_B_TOGGLE': {
        const i = button === 'MFP_A_TOGGLE' ? 0 : 1;
        this.setMfp(i, !this.mfpRunning[i]);
        break;
      }
      default: {
        const m = /^RCP_(START|STOP)_(\d)$/.exec(b);
        if (m) {
          const i = +m[2];
          if (m[1] === 'STOP') {
            if (this.rcpOn[i]) { this.rcpOn[i] = false; this.msg(`RCP ${i + 1} stopped.`); }
          } else if (!this.rcpOn[i]) {
            if (!this.offsite) this.msg(`RCP ${i + 1} start blocked: no offsite power to the 6.9 kV bus.`);
            else if (mpaToPsig(this.P) < 325) this.msg(`RCP ${i + 1} start blocked: RCS pressure below 325 psig (seal ΔP).`);
            else if (this.faults.has('RCP_TRIP', i)) this.msg(`RCP ${i + 1} start blocked: breaker tripped on overcurrent (fault).`);
            else { this.rcpOn[i] = true; this.msg(`RCP ${i + 1} started.`); }
          }
        }
      }
    }
  }

  setMfp(i: number, on: boolean) {
    if (on === this.mfpRunning[i]) return;
    if (on) {
      if (!this.offsite) { this.msg(`MFP ${'AB'[i]} start blocked: no offsite power.`); this.controls.mainFeedPumps[i] = false; return; }
      if (this.fwIsolation) { this.msg(`MFP ${'AB'[i]} start blocked: feedwater isolation signal present.`); this.controls.mainFeedPumps[i] = false; return; }
      if (this.vacuum < 20) { this.msg(`MFP ${'AB'[i]} start blocked: condenser vacuum low.`); this.controls.mainFeedPumps[i] = false; return; }
      if (this.faults.has('MFP_TRIP', i)) { this.msg(`MFP ${'AB'[i]} start blocked: tripped on fault, needs maintenance.`); this.controls.mainFeedPumps[i] = false; return; }
      this.mfpRunning[i] = true;
      this.msg(`Main feed pump ${'AB'[i]} started.`);
    } else {
      this.mfpRunning[i] = false;
      this.msg(`Main feed pump ${'AB'[i]} stopped.`);
    }
    this.controls.mainFeedPumps[i] = on;
  }

  // =================================================================== reset / initialisation
  reset(scenario: ScenarioId): void {
    const spec = SCENARIOS[scenario];
    this.spec = spec;
    const keepTimeScale = this.controls?.timeScale ?? 1;
    this.controls = defaultControls();
    this.controls.timeScale = keepTimeScale;
    this.events = [];
    this.t = 0; this.acc = 0;
    this.alarms = new AlarmManager();
    this.faults = new FaultManager(this);
    this.catastrophe = null;
    this.integrity = { rcs: 1, secondary: 1, containment: 1 };
    this.vesselBreakArea = 0;
    this.reactorTripped = false; this.firstOut = null; this.manualTripPending = false;
    this.rpsMem = newRpsMemory();
    this.siActuated = false; this.siTimer = 0;
    this.offsite = true; this.offsiteRestoreAt = -1; this.dgTimer = [-1, -1];
    this.accum = [0, 0, 0, 0].map(() => ({ water: K.ACC_WATER, gasV: K.ACC_GAS_V0, isolated: false }));
    this.accumulatorsInjected = false;
    this.fail = [0, 0]; this.melt = [0, 0]; this.ox = [0.003, 0.003]; this.tfRate = [0, 0];
    this.stuckRod = null; this.droppedRod = null;
    this.prtEnergy = 0; this.prtRuptured = false; this.rcsH2 = 0; this.rcsReleasedMass = 0;
    this.fwIsolation = false; this.fwRegClosedP4 = false;
    this.letdownAutoIsolated = false;
    this.rcpOn = [true, true, true, true]; this.rcpSpeed = [1, 1, 1, 1]; this.rcpVoidTimer = [0, 0, 0, 0];
    this.afwRunning = [false, false, false]; this.afwAutoLatched = [false, false, false];
    this.aoXe = 0;
    this.rcpEverRan = [true, true, true, true];
    this.mfpEverRan = [...spec.mainFeedPumps];
    this.turbineWasOnline = spec.turbine === 'online';
    this.srShutdownBaseline = 1e9;
    this.score = { mwhGenerated: 0, trips: 0, timeAtPowerS: 0 };

    const c = this.controls;
    c.rodMode = spec.rodMode;
    c.steamDumpMode = spec.steamDumpMode;
    c.mainFeedPumps = [...spec.mainFeedPumps];
    this.mfpRunning = [...spec.mainFeedPumps];
    c.turbineLoadSetpointMW = spec.turbineMW;

    // rods
    this.rodPos.SA = spec.shutdownBanksOut ? ROD_STEPS_MAX : 0;
    this.rodPos.SB = spec.shutdownBanksOut ? ROD_STEPS_MAX : 0;
    const seq0 = spec.subcritical ? spec.subcritical.ecpSeq : spec.rodSeq;
    this.rodSeq = seq0;
    seqToPositions(seq0, this.rodPos);
    this.rodDrop.active = false;

    // ---- design-point calibration of loop flow
    const Thot = fToC(616.3), Tcold = fToC(553.7);
    const pFP = psigToMPa(2235);
    this.W0 = K.Q_RATED / 4 / (hfT(Thot) - hfT(Tcold));
    // SG heat-transfer coefficient so that full power gives 985 psig steam pressure (two tube nodes)
    {
      const ts = tsat(psigToMPa(985));
      const N = 2 * (Math.sqrt((Thot - ts) / (Tcold - ts)) - 1);
      const cp = (hfT(Thot) - hfT(Tcold)) / (Thot - Tcold);
      this.uaHalf = (N * this.W0 * cp) / 2;
    }

    // ---- initial thermal state guess
    const p = spec.power ?? 0;
    const tavgF = 557 + 27.7 * clamp(spec.turbine === 'online' ? spec.turbineMW / 1150 : 0, 0, 1);
    const dT = (p * 62.6 * 5) / 9; // °C core ΔT
    const tavg = fToC(tavgF);
    const th = tavg + dT / 2, tc = tavg - dT / 2;
    this.P = pFP;
    for (let i = 0; i < NN; i++) this.h[i] = hfT(tavg);
    this.h[UP] = hfT(th); this.h[CORE] = hfT(th); this.h[LP] = hfT(tc);
    for (let i = 0; i < 4; i++) {
      this.h[HL(i)] = hfT(th); this.h[S1(i)] = hfT(tavg); this.h[S2(i)] = hfT(tc); this.h[CL(i)] = hfT(tc);
    }
    this.updateNodeProps();
    let vbar = 0;
    for (let i = 0; i < NN; i++) vbar += VFRAC[i] * this.Vs[i];
    this.ML = V_LOOPS / vbar;
    // pressurizer at program level
    this.initPzr(this.pzrProgram(cToF(tavg)));
    // SGs
    const steamP = psigToMPa(spec.turbine === 'online' ? 1092 - 107 * clamp(spec.turbineMW / 1150, 0, 1) : 1092);
    for (const s of this.sg) this.initSg(s, steamP, 0.44, p);
    this.Ph = steamP;
    this.tFeed = 38 + 189 * Math.pow(clamp(spec.turbine === 'online' ? spec.turbineMW / 1150 : 0, 0, 1), 0.8);
    // fuel
    for (let r = 0; r < 2; r++) { this.Tf[r] = tavg + 300 * p * K.REGION_SHARE[r] / K.REGION_VFRAC[r]; this.Tc[r] = tavg + 15 * p; }
    // turbine
    const tb = this.turb;
    if (spec.turbine === 'online') {
      Object.assign(tb, { latched: true, tripped: false, speed: 1800, breaker: true, loadRef: spec.turbineMW, mwInt: 0, breakerTripTimer: -1 });
      tb.gv = spec.turbineMW / (K.MW_PER_KGS * K.C_TURB * steamP * 0.95);
    } else {
      Object.assign(tb, { latched: false, tripped: true, speed: 0, gv: 0, breaker: false, loadRef: 0, mwInt: 0, breakerTripTimer: -1 });
    }
    this.vacuum = 28;
    // SG level controllers: preset integrator to steady feed
    // poisons and decay heat
    const xs = spec.xenon;
    if (xs.kind === 'equilibrium') this.poi.setEquilibrium(xs.power);
    else if (xs.kind === 'shutdown') this.poi.setAfterShutdown(xs.power, xs.hoursAgo * 3600);
    else {
      this.poi.setEquilibrium(xs.from);
      const steps = Math.round((xs.hoursAgo * 3600) / 10);
      for (let i = 0; i < steps; i++) {
        const tt = i * 10;
        const pw = tt < 3600 ? xs.from + (xs.to - xs.from) * (tt / 3600) : xs.to; // 1 h ramp down
        this.poi.step(pw, 10);
      }
    }
    if (spec.decay.kind === 'equilibrium') this.dh.setEquilibrium(spec.decay.power);
    else this.dh.setAfterShutdown(spec.decay.power, spec.decay.hoursAgo * 3600);
    // boron placeholder
    this.setBoronEverywhere(1000);
    // containment
    const cont = this.cont;
    cont.Tw = 49; cont.T = 49; cont.h2 = 0; cont.theta = 0; cont.sprays = false; cont.src = 0; cont.rad = 0.01;
    cont.mv = 0.5 * rhogT(49) * K.V_CONT;
    const pv = (cont.mv / K.V_CONT) * 461.5 * (49 + 273.15) / 1e6;
    cont.pAir0 = psigToMPa(0.3) - pv;
    cont.P = psigToMPa(0.3);

    // ---- settle with fission power held
    this.settle(spec);
    this.publish();
    this.alarms.update(this, true);
    this.events = [];
  }

  private initPzr(levelPct: number) {
    const P = this.P;
    const Vl = (levelPct / 100) * V_PZR;
    const ml = Vl / vf(P), mg = (V_PZR - Vl) / vg(P);
    this.pzr.M = ml + mg;
    this.pzr.U = ml * (hf(P) - 1000 * P * vf(P)) + mg * (hg(P) - 1000 * P * vg(P));
    this.pzr.liquidV = Vl;
  }

  private initSg(s: SgInternal, P: number, nr: number, power: number) {
    s.P = P;
    s.voidV = K.SG_VOID_FP * Math.pow(Math.max(0, power), 0.75) * Math.sqrt(6.9 / P);
    const Vmix = K.SG_NR_V0 + nr * K.SG_NR_SPAN;
    const Vl = Vmix - s.voidV;
    const ml = Vl / vf(P), mg = (K.V_SG - Vl) / vg(P);
    s.M = ml + mg;
    s.U = ml * (hf(P) - 1000 * P * vf(P)) + mg * (hg(P) - 1000 * P * vg(P));
    s.liquidV = Vl; s.nr = nr * 100; s.msivOpen = true; s.fwPos = 0; s.fwInt = 0;
    s.svOpen = false; s.wBreak = 0; s.wTubeLeak = 0; s.dPdt = 0;
  }

  setBoronEverywhere(ppm: number) {
    for (let i = 0; i < NN; i++) this.bor[i] = ppm;
    this.pzr.B = ppm;
    this.vctBoron = ppm;
  }

  private settle(spec: ScenarioSpec) {
    this.settling = true;
    const pTarget = spec.power ?? 0;
    this.holdPower = Math.max(pTarget, 1e-9);
    this.kin.setEquilibrium(this.holdPower);
    let nInt = this.holdPower;
    const run = (seconds: number, dt: number) => {
      const steps = Math.round(seconds / dt);
      for (let k = 0; k < steps; k++) {
        if (spec.powerFollowsTurbine) {
          const e = this.tavgF() - this.trefF();
          nInt = clamp(nInt - 0.0004 * e * dt, 0.01, 1.2);
          this.holdPower = clamp(nInt - 0.01 * e, 0.01, 1.2);
        }
        this.step(dt);
      }
    };
    run(1500, 0.2);
    run(90, DT);
    // final power
    const pFinal = this.holdPower;
    this.holdPower = null;
    this.kin.setEquilibrium(pFinal);
    this.computeReactivity();
    // choose boron for criticality at the reference rod position
    const crit = () => {
      // ρ = ρ_fuel + rods + doppler + xe + sm + void + B*(BORON_WORTH + MTC_A1*F)
      const F = this.mtcIntegral();
      const rest = this.rho.total - this.rho.boron - this.rho.moderator + K.MTC_A0 * F;
      return rest / -(K.BORON_WORTH + K.MTC_A1 * F);
    };
    const B = crit();
    this.setBoronEverywhere(B);
    this.computeReactivity();
    if (spec.subcritical) {
      this.rodSeq = spec.subcritical.startSeq;
      seqToPositions(this.rodSeq, this.rodPos);
      this.computeReactivity();
      const rho = this.rho.total * 1e-5;
      const n = (this.kin.source * 2e-5) / Math.max(1e-5, -rho);
      this.kin.setEquilibrium(n);
    }
    this.lnPrev = Math.log(this.kin.n);
    this.srCps = this.kin.n * 1e11 + 0.5;
    this.nominalInventory = this.ML + this.pzr.M;
    this.sur = 0;
    this.t = 0;
    this.tavgPrev = this.tavgF();
    this.prHistory = [];
    this.settling = false;
  }

  // =================================================================== helpers
  pzrProgram(tavgF: number) { return clamp(25 + ((61.5 - 25) * (tavgF - 557)) / (584.7 - 557), 25, 61.5); }
  tavgF() {
    let s = 0;
    for (let i = 0; i < 4; i++) s += 0.5 * (this.T[HL(i)] + this.T[CL(i)]);
    return cToF(s / 4);
  }
  tavgAuctF() {
    let m = -1e9;
    for (let i = 0; i < 4; i++) m = Math.max(m, 0.5 * (this.T[HL(i)] + this.T[CL(i)]));
    return cToF(m);
  }
  trefF() { return 557 + 27.7 * clamp(this.turb.wt / K.W_STEAM_RATED, 0, 1); }
  mtcIntegral() {
    const tm = cToF(0.5 * (this.T[LP] + this.T[CORE]));
    return K.MTC_SCALE_F * (Math.exp((tm - K.T_REF_F) / K.MTC_SCALE_F) - 1);
  }
  powerAvailable() { return this.offsite || this.dgReady(); }
  dgReady() { return this.dgTimer[0] >= 10 || this.dgTimer[1] >= 10; }
  hbarV() { let s = 0; for (let i = 0; i < NN; i++) s += VFRAC[i] * this.h[i]; return s; }

  updateNodeProps() {
    const P = this.P;
    for (let i = 0; i < NN; i++) {
      const pr = props(this.h[i], P);
      this.T[i] = pr.T; this.X[i] = pr.x; this.Vs[i] = pr.v;
    }
  }

  /** add mass dm (kg, may be negative = removal at node enthalpy) at node i with enthalpy hin & boron */
  addMass(i: number, dm: number, hin: number, boron: number, hbar: number) {
    if (dm === 0) return;
    const mi = this.ML * VFRAC[i];
    if (dm > 0) {
      this.h[i] += (dm * (hin - hbar)) / mi;
      this.bor[i] += (dm * (boron - this.bor[i])) / (mi + dm);
    } else {
      this.h[i] += (-dm * (hbar - this.h[i])) / mi; // removal at node enthalpy, see README
    }
    this.ML += dm;
  }

  // =================================================================== reactivity
  computeReactivity() {
    const r = this.rho;
    let rods = 0;
    for (const b of ROD_BANKS) rods += bankRho(b, this.rodPos[b]);
    if (this.stuckRod) {
      const sb = this.stuckRod;
      rods += 800 * (integralFraction(sb.pos / ROD_STEPS_MAX) - integralFraction(this.rodPos[sb.bank] / ROD_STEPS_MAX));
    }
    if (this.droppedRod) rods -= 250 * integralFraction(this.rodPos[this.droppedRod.bank] / ROD_STEPS_MAX) + 60;
    r.rods = rods;
    const B = this.bor[CORE] * 0.5 + this.bor[LP] * 0.5;
    r.boron = K.BORON_WORTH * B;
    const F = this.mtcIntegral();
    r.moderator = (K.MTC_A0 + K.MTC_A1 * B) * F;
    const tfK = K.REGION_SHARE[0] * this.Tf[0] + K.REGION_SHARE[1] * this.Tf[1] + 273.15;
    r.doppler = -K.DOPPLER_K * (Math.sqrt(tfK) - Math.sqrt(fToC(K.T_REF_F) + 273.15));
    // core void fraction (homogeneous, slip 1.5)
    const x = this.X[CORE];
    let alpha = 0;
    if (x > 0) { const vl = vf(this.P), vv = vg(this.P); alpha = (x * vv) / (x * vv + 1.5 * (1 - x) * vl); }
    alpha = Math.max(alpha, 1 - this.coreLevel);
    r.void = K.VOID_COEF * 100 * alpha;
    r.xenon = this.poi.xenonPcm;
    r.samarium = this.poi.samariumPcm;
    r.total = this.rhoFuel + r.rods + r.boron + r.moderator + r.doppler + r.void + r.xenon + r.samarium;
  }

  // =================================================================== main step
  step(dt: number) {
    this.t += dt;
    if (!this.settling) {
      this.faults.step(dt);
      this.electrical(dt);
    }
    this.updateNodeProps();
    this.rpsAndLogic(dt);
    this.rodControl(dt);
    this.neutronics(dt);
    this.hydraulics(dt);
    this.secondarySide(dt);
    this.primaryEnergy(dt);
    this.massSources(dt);
    this.pressurizerAndPressure(dt);
    this.containment(dt);
    if (!this.settling) {
      this.damage(dt);
      this.score.mwhGenerated += (this.turb.mwe * dt) / 3600;
      if (this.kin.n > 0.05) this.score.timeAtPowerS += dt;
      this.trackHistory();
      this.alarmTimer += dt;
      if (this.alarmTimer >= 0.25) { this.alarmTimer = 0; this.publish(); this.alarms.update(this, false); }
    }
  }
  alarmTimer = 0;
  score = { mwhGenerated: 0, trips: 0, timeAtPowerS: 0 };

  // ------------------------------------------------------------------ electrical
  electrical(dt: number) {
    if (!this.offsite && this.offsiteRestoreAt > 0 && this.t >= this.offsiteRestoreAt) {
      this.offsite = true;
      this.offsiteRestoreAt = -1;
      this.faults.clear('LOSS_OF_OFFSITE_POWER');
      this.msg('Offsite power restored to the switchyard. Restart RCPs and main feed pumps as required.');
    }
    const needDg = !this.offsite || this.siActuated;
    for (let i = 0; i < 2; i++) {
      if (needDg && this.dgTimer[i] < 0) {
        this.dgTimer[i] = 0;
        this.msg(`Emergency diesel generator ${'AB'[i]} starting.`);
      }
      if (this.dgTimer[i] >= 0) {
        const before = this.dgTimer[i];
        this.dgTimer[i] += dt;
        if (before < 10 && this.dgTimer[i] >= 10) this.msg(`Diesel generator ${'AB'[i]} at speed and voltage — vital bus energised.`);
      }
    }
    if (!needDg && this.dgTimer[0] >= 0) {
      this.dgStopTimer += dt;
      if (this.dgStopTimer > 300) { this.dgTimer = [-1, -1]; this.dgStopTimer = 0; this.msg('Diesel generators unloaded and stopped.'); }
    } else this.dgStopTimer = 0;

    if (!this.offsite) {
      for (let i = 0; i < 4; i++) this.rcpOn[i] = false;
      for (let i = 0; i < 2; i++) if (this.mfpRunning[i]) { this.mfpRunning[i] = false; this.controls.mainFeedPumps[i] = false; }
      if (this.turb.breaker) this.openBreaker('Generator breaker opened — switchyard de-energised');
      if (!this.turb.tripped) this.tripTurbine('Turbine trip on loss of offsite power');
    }
    // RCPs pumping a highly voided mixture cavitate; seal/vibration protection trips them
    for (let i = 0; i < 4; i++) {
      const xcl = this.X[CL(i)];
      const alpha = xcl > 0 ? (xcl * 30) / (1 + xcl * 30) : 0;
      if (this.rcpOn[i] && alpha > 0.85) {
        this.rcpVoidTimer[i] += dt;
        if (this.rcpVoidTimer[i] > 90) {
          this.rcpOn[i] = false;
          this.rcpVoidTimer[i] = 0;
          this.msg(`RCP ${i + 1} tripped on high shaft vibration (pump cavitating in two-phase coolant).`);
        }
      } else this.rcpVoidTimer[i] = Math.max(0, this.rcpVoidTimer[i] - dt);
    }
  }
  rcpVoidTimer = [0, 0, 0, 0];

  // ------------------------------------------------------------------ protection & plant logic
  rpsAndLogic(dt: number) {
    evaluateRps(this, dt);
    const c = this.controls;
    // operator MFP toggles via controls array too
    for (let i = 0; i < 2; i++) if (c.mainFeedPumps[i] !== this.mfpRunning[i]) this.setMfp(i, c.mainFeedPumps[i]);

    // SI logic
    if (this.siActuated) this.siTimer += dt;

    // P-14 high-high SG level → turbine trip + feedwater isolation
    const p14 = this.sg.some((s) => s.nr >= 78);
    if (p14 && !this.settling) {
      if (!this.fwIsolation) this.msg('SG level HI-HI (P-14): turbine trip and feedwater isolation.');
      this.fwIsolation = true;
      this.tripTurbine('Turbine trip on SG level HI-HI (P-14)');
    } else if (!this.siActuated && this.fwIsolation && !p14) {
      this.fwIsolation = false;
    }
    if (this.fwIsolation) {
      for (let i = 0; i < 2; i++) if (this.mfpRunning[i]) { this.mfpRunning[i] = false; c.mainFeedPumps[i] = false; }
    }
    // P-4 + low Tavg closes FRVs
    if (this.reactorTripped && this.tavgF() < 564) {
      if (!this.fwRegClosedP4 && !this.settling) this.msg('Reactor trip with Tavg < 564 °F: feedwater regulating valves closed.');
      this.fwRegClosedP4 = true;
    }

    // turbine automatic trips
    if (!this.turb.tripped && !this.settling) {
      const why = this.turbineTripConditions();
      if (why) this.tripTurbine(`Turbine trip: ${why}`);
    }
    // breaker opens after turbine trip (anti-motoring)
    const tb = this.turb;
    if (tb.tripped && tb.breaker) {
      if (tb.breakerTripTimer < 0) tb.breakerTripTimer = 0;
      tb.breakerTripTimer += dt;
      if (tb.breakerTripTimer > 1.0) this.openBreaker('Generator breaker opened (turbine tripped)');
    }

    // AFW automatic start
    const loLo = this.sg.filter((s) => s.nr < 17).length;
    const bothMfpOff = !this.mfpRunning[0] && !this.mfpRunning[1] && (this.spec.mainFeedPumps[0] || this.t > 1);
    const mdStart = loLo >= 1 || this.siActuated || (bothMfpOff && this.turb.mwe > 0) || !this.offsite;
    const tdStart = loLo >= 2 || !this.offsite;
    if (!this.settling) {
      for (let k = 0; k < 3; k++) {
        const sig = k < 2 ? mdStart : tdStart;
        if (sig && c.auxFeedPumps[k] === 'auto' && !this.afwAutoLatched[k]) {
          this.afwAutoLatched[k] = true;
          this.msg(`Auxiliary feed pump ${['A (motor)', 'B (motor)', 'C (turbine)'][k]} auto-start.`);
        }
        if (c.auxFeedPumps[k] === 'off') this.afwAutoLatched[k] = false;
      }
    }
    for (let k = 0; k < 3; k++) {
      const mode = c.auxFeedPumps[k];
      const want = mode === 'on' || (mode === 'auto' && this.afwAutoLatched[k]);
      const avail = k < 2 ? this.powerAvailable() && (this.offsite || this.dgReady()) : this.sg.some((s) => s.P > 0.8);
      this.afwRunning[k] = want && avail;
    }

    // SI block (allowed only below P-11)
    if (c.siBlocked && this.permissives.P11) c.siBlocked = false;

    // letdown auto isolation on low pressurizer level
    const lvl = (this.pzr.liquidV / V_PZR) * 100;
    if (lvl < 17 && !this.letdownAutoIsolated) { this.letdownAutoIsolated = true; if (!this.settling) this.msg('Pressurizer level < 17 %: letdown isolated, heaters off.'); }
    if (lvl > 22 && this.letdownAutoIsolated) this.letdownAutoIsolated = false;
  }

  turbineTripConditions(): string | null {
    if (this.reactorTripped) return 'reactor tripped (P-4)';
    if (this.vacuum < 20) return 'condenser vacuum low';
    if (this.sg.some((s) => s.nr >= 78)) return 'SG level HI-HI (P-14)';
    if (this.siActuated) return 'safety injection';
    if (this.turb.speed > 1980) return 'overspeed';
    if (this.integrity.secondary < 0.6) return 'turbine vibration high (water induction)';
    if (!this.offsite) return 'loss of offsite power';
    if (this.faults.has('TURBINE_TRIP_SPURIOUS')) return 'spurious EHC low fluid pressure';
    return null;
  }

  tripTurbine(reason: string) {
    const tb = this.turb;
    if (tb.tripped) return;
    tb.tripped = true; tb.latched = false; tb.gv = 0;
    this.emit({ type: 'turbine-trip' });
    this.msg(reason);
  }

  openBreaker(reason: string) {
    const tb = this.turb;
    if (!tb.breaker) return;
    tb.breaker = false; tb.breakerTripTimer = -1;
    // load rejection: overspeed in proportion to the load dropped (OPC limits it)
    if (!tb.tripped) tb.speed += Math.min(120, (tb.mwe / 1150) * 110);
    tb.loadRef = 0;
    this.emit({ type: 'breaker', closed: false });
    this.msg(reason);
  }

  reactorTrip(reason: TripId) {
    if (this.reactorTripped) return;
    this.reactorTripped = true;
    if (!this.firstOut) this.firstOut = reason;
    this.rodDrop = { active: true, t: 0, p0: { ...this.rodPos } };
    this.score.trips++;
    this.emit({ type: 'trip', reason });
    this.msg(`REACTOR TRIP — first out: ${reason}`);
  }

  actuateSI(reason: string) {
    if (this.siActuated) return;
    this.siActuated = true;
    this.siTimer = 0;
    this.fwIsolation = true;
    this.controls.letdownIsolated = true;
    this.emit({ type: 'si' });
    this.msg(`SAFETY INJECTION actuated (${reason}). Phase A isolation, feedwater isolation, diesels starting.`);
  }

  // ------------------------------------------------------------------ rods
  rodControl(dt: number) {
    const c = this.controls;
    // gravity drop after trip
    if (this.rodDrop.active) {
      const rd = this.rodDrop;
      rd.t += dt;
      const f = Math.min(1, (rd.t / 2.0) ** 2);
      for (const b of ROD_BANKS) this.rodPos[b] = rd.p0[b] * (1 - f);
      if (f >= 1) { rd.active = false; for (const b of ROD_BANKS) this.rodPos[b] = 0; }
      this.rodSpeed = 0;
      return;
    }
    if (this.reactorTripped || this.settling) { this.rodSpeed = 0; return; }
    let dir = 0;
    let spm = 0;
    const auto = c.rodMode === 'auto';
    if (auto) {
      const err = this.tavgAuctF() - this.trefF() + this.faults.tavgBias();
      const a = Math.abs(err);
      if (a > 1.5) { spm = a >= 5 ? 72 : 8 + ((a - 1.5) / 3.5) * 64; dir = err > 0 ? -1 : 1; }
      if (dir > 0 && this.rodStop.C5) dir = 0; // C-5: no auto withdrawal below 15 % turbine load
    } else {
      dir = c.rodMotion;
      spm = 48;
    }
    if (dir > 0 && (this.rodStop.C1 || this.rodStop.C2 || this.rodStop.C3 || this.rodStop.C4)) dir = 0;
    if (dir === 0) { this.rodSpeed = 0; this.rodStepAcc = 0; return; }
    this.rodSpeed = spm;
    this.rodStepAcc += (spm / 60) * dt;
    while (this.rodStepAcc >= 1) {
      this.rodStepAcc -= 1;
      const sel = auto ? 'MANUAL_SEQ' : c.rodBankSelect;
      if (sel === 'MANUAL_SEQ') {
        const target = clamp(this.rodSeq + dir, 0, SEQ_MAX);
        if (target === this.rodSeq) break;
        this.rodSeq = target;
        const tp: Record<RodBankId, number> = { ...this.rodPos };
        seqToPositions(this.rodSeq, tp);
        let lead: RodBankId | null = null;
        for (const b of CONTROL_BANKS) {
          const d = tp[b] - this.rodPos[b];
          if (d !== 0) {
            this.rodPos[b] = clamp(this.rodPos[b] + Math.sign(d), 0, ROD_STEPS_MAX);
            if (!lead || dir > 0) lead = b;
          }
        }
        if (lead) this.emit({ type: 'rod-step', bank: lead, dir: dir as 1 | -1 });
      } else {
        const b = sel as RodBankId;
        const np = clamp(this.rodPos[b] + dir, 0, ROD_STEPS_MAX);
        if (np !== this.rodPos[b]) {
          this.rodPos[b] = np;
          this.emit({ type: 'rod-step', bank: b, dir: dir as 1 | -1 });
        }
        this.rodSeq = positionsToSeq(this.rodPos);
      }
    }
  }

  // ------------------------------------------------------------------ neutronics
  neutronics(dt: number) {
    this.computeReactivity();
    let integral: number;
    const n0 = this.kin.n;
    if (this.holdPower !== null) {
      this.kin.setEquilibrium(this.holdPower);
      integral = this.holdPower * dt;
    } else {
      let rho = this.rho.total * 1e-5;
      const hs = Math.min(dt, PointKinetics.maxStableDt(rho));
      if (hs >= dt) integral = this.kin.step(rho, dt);
      else {
        // prompt-critical excursion: substep with adiabatic Doppler feedback
        integral = 0;
        let rem = dt;
        const tfAdd = [0, 0];
        let guard = 0;
        while (rem > 1e-12 && guard++ < 20000) {
          const h = Math.min(rem, PointKinetics.maxStableDt(rho));
          const e = this.kin.step(rho, h);
          integral += e;
          rem -= h;
          for (let r = 0; r < 2; r++) tfAdd[r] += (e * (1 - DH_TOTAL) * K.Q_RATED * K.REGION_SHARE[r]) / (K.FUEL_C * K.REGION_VFRAC[r]);
          const tfK = K.REGION_SHARE[0] * (this.Tf[0] + tfAdd[0]) + K.REGION_SHARE[1] * (this.Tf[1] + tfAdd[1]) + 273.15;
          const dop = -K.DOPPLER_K * (Math.sqrt(tfK) - Math.sqrt(fToC(K.T_REF_F) + 273.15));
          rho = (this.rho.total - this.rho.doppler + dop) * 1e-5;
        }
      }
    }
    const n = this.kin.n;
    // startup rate (filtered d ln n / dt)
    const ln = Math.log(Math.max(n, 1e-14));
    const raw = (ln - this.lnPrev) / dt;
    this.lnPrev = ln;
    this.sur += (raw - this.sur) * Math.min(1, dt / 1.0);
    if (!this.settling) {
      this.poi.step(n, dt);
      this.dh.step(integral / dt, dt);
    }
    this.fissionAvg = integral / dt;
    void n0;
  }
  fissionAvg = 0;

  // ------------------------------------------------------------------ flows
  hydraulics(dt: number) {
    // pump speeds
    for (let i = 0; i < 4; i++) {
      const s = this.rcpSpeed[i];
      if (this.rcpOn[i]) this.rcpSpeed[i] = Math.min(1, s + dt / 8);
      else this.rcpSpeed[i] = s > 0.005 ? s - ((s * s) / K.RCP_COAST_TAU) * dt - 0.0005 * dt : 0;
    }
    const H = [0, 0, 0, 0], Rr = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const s = this.rcpSpeed[i];
      const xcl = this.X[CL(i)];
      const alphaCl = xcl > 0 ? Math.min(1, (xcl * 30) / (1 + xcl * 30)) : 0;
      const rhoUp = (1 / this.Vs[CORE] + 1 / this.Vs[UP] + 1 / this.Vs[HL(i)] + 1 / this.Vs[S1(i)]) / 4;
      const rhoDn = (1 / this.Vs[S2(i)] + 1 / this.Vs[CL(i)] + 1 / this.Vs[LP]) / 3;
      const blocked = this.X[S1(i)] > 0.15 || this.X[HL(i)] > 0.5;
      const B = blocked ? 0 : K.NC_COEF * (rhoDn - rhoUp);
      H[i] = s * s * (1 - 0.85 * alphaCl) + B;
      Rr[i] = K.R_LOOP * (s < 0.05 ? K.R_REVERSE_LOCKED : 1);
    }
    const wOf = (i: number, dp: number) => {
      const D = H[i] - dp;
      return D >= 0 ? Math.sqrt(D / K.R_LOOP) : -Math.sqrt(-D / Rr[i]);
    };
    const g = (dp: number) => {
      let s = 0;
      for (let i = 0; i < 4; i++) s += wOf(i, dp);
      return s - Math.sign(dp) * Math.sqrt(Math.abs(dp) / K.R_CORE);
    };
    let lo = -2, hi = 2;
    for (let it = 0; it < 48; it++) {
      const mid = 0.5 * (lo + hi);
      if (g(mid) > 0) lo = mid; else hi = mid;
    }
    const dp = 0.5 * (lo + hi);
    let core = 0;
    for (let i = 0; i < 4; i++) {
      this.wn[i] = wOf(i, dp);
      this.w[i] = this.wn[i] * this.W0;
      core += this.wn[i];
    }
    this.coreFlowN = core / 4;
  }

  // ------------------------------------------------------------------ core heat transfer & primary energy
  coolantSide(r: number) {
    return r === 0 ? 0.5 * (this.T[LP] + this.T[CORE]) : this.T[CORE];
  }

  primaryEnergy(dt: number) {
    const P = this.P;
    const Ts = tsat(P);
    // ---- core uncovery estimate from vapour inventory
    let vvap = 0;
    const vgP = vg(P);
    for (let i = 0; i < NN; i++) {
      const m = this.ML * VFRAC[i];
      if (this.X[i] > 0) vvap += this.X[i] >= 1 ? m * this.Vs[i] : m * this.X[i] * vgP;
    }
    this.vaporVolume = vvap;
    const alphaSys = vvap / V_LOOPS;
    const pumped = Math.max(...this.rcpSpeed) > 0.3 && alphaSys < 0.7;
    let level = 1;
    if (!pumped) {
      const collapsed = clamp(1 - (vvap - K.V_ABOVE_CORE) / K.V_CORE_WATER, 0, 1);
      const boiling = this.X[CORE] > 0 ? 0.3 : 0.1;
      level = collapsed <= 0 ? 0 : Math.min(1, collapsed / (1 - boiling));
    } else if (alphaSys > 0.5) level = 1 - (alphaSys - 0.5) * 2; // froth thinning
    this.coreLevel += (level - this.coreLevel) * Math.min(1, dt / 2);
    const L = this.coreLevel;
    this.uncov[0] = clamp((0.7 - L) / 0.7, 0, 1);
    this.uncov[1] = clamp((1 - L) / 0.3, 0, 1);

    // ---- DNBR (hot channel)
    this.computeDnbr();

    // ---- fuel / clad regions (implicit)
    const pth = (1 - DH_TOTAL) * this.fissionAvg + this.dh.total; // thermal power fraction
    const G = Math.abs(this.coreFlowN);
    const hfc = K.H_FC0 * Math.pow(Math.max(G, 0.03), 0.8);
    const nbK = 22.65 * Math.exp(-P / 8.7);
    let qcool = 0, qox = 0;
    for (let r = 0; r < 2; r++) {
      const vfr = K.REGION_VFRAC[r];
      const Cf = K.FUEL_C * vfr, Cc = K.CLAD_C * vfr, UA = K.UA_FC * vfr, A = K.A_HT * vfr;
      const Qg = pth * K.Q_RATED * K.REGION_SHARE[r];
      const Tcool = this.coolantSide(r);
      const u = this.uncov[r];
      const dnbr = r === 1 ? this.dnbr : this.dnbrBulk;
      const fd = clamp((1 - dnbr) / 0.5, 0, 1);
      const qf = (Tc: number) => {
        const qfc = hfc * (Tc - Tcool);
        const sup = Tc - Ts;
        const qnb = sup > 0 ? Math.min(3000, 1000 * (sup / nbK) * (sup / nbK)) : 0;
        const qwet = Math.max(qfc, qnb);
        const rad = 3.97e-11 * ((Tc + 273.15) ** 4 - (Ts + 273.15) ** 4);
        const qfilm = 0.6 * (Tc - Ts) + rad;
        const qdry = 0.03 * (Tc - Ts) + rad;
        return (1 - u) * ((1 - fd) * qwet + fd * qfilm) + u * qdry;
      };
      const Tc0 = this.Tc[r];
      const q0 = qf(Tc0);
      const dq = Math.max(0.01, (qf(Tc0 + 0.5) - q0) / 0.5);
      // zircaloy–steam oxidation (Baker–Just parabolic law), explicit
      const TcK = Tc0 + 273.15;
      let dox = 0;
      if (Tc0 > 700) {
        const Kp = 243 * Math.exp(-22900 / TcK);
        dox = Math.min(1 - this.ox[r], (Kp / (2 * Math.max(this.ox[r], 0.003))) * dt);
      }
      const Qox = (dox / dt) * K.ZR_MASS * vfr * 6500;
      this.ox[r] += dox;
      this.rcsH2 += dox * K.ZR_MASS * vfr * 0.0442;
      const a11 = Cf / dt + UA, a12 = -UA, b1 = (Cf / dt) * this.Tf[r] + Qg;
      const a21 = -UA, a22 = Cc / dt + UA + A * dq, b2 = (Cc / dt) * Tc0 + Qox - A * (q0 - dq * Tc0);
      const det = a11 * a22 - a12 * a21;
      let tf = (b1 * a22 - a12 * b2) / det;
      const tc = (a11 * b2 - a21 * b1) / det;
      // melting
      if (tf > K.T_FUEL_MELT && this.melt[r] < 1) {
        const excess = (tf - K.T_FUEL_MELT) * Cf;
        this.melt[r] = Math.min(1, this.melt[r] + excess / (K.UO2_LATENT * K.UO2_MASS * vfr));
        tf = K.T_FUEL_MELT;
      }
      const rate = (tf - this.Tf[r]) / dt;
      this.tfRate[r] += (rate - this.tfRate[r]) * Math.min(1, dt / 0.5);
      this.Tf[r] = tf;
      this.Tc[r] = tc;
      qcool += A * (q0 + dq * (tc - Tc0));
      qox += Qox;
    }
    this.qCoolKW = qcool;
    this.oxHeatKW = qox;

    // ---- coolant transport (explicit upwind)
    const h = this.h;
    const dE = this.dEbuf;
    dE.fill(0);
    let coreW = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.w[i];
      coreW += w;
      const aw = Math.abs(w);
      if (w >= 0) {
        dE[HL(i)] += aw * (h[UP] - h[HL(i)]);
        dE[S1(i)] += aw * (h[HL(i)] - h[S1(i)]);
        dE[S2(i)] += aw * (h[S1(i)] - h[S2(i)]);
        dE[CL(i)] += aw * (h[S2(i)] - h[CL(i)]);
        dE[LP] += aw * (h[CL(i)] - h[LP]);
      } else {
        dE[CL(i)] += aw * (h[LP] - h[CL(i)]);
        dE[S2(i)] += aw * (h[CL(i)] - h[S2(i)]);
        dE[S1(i)] += aw * (h[S2(i)] - h[S1(i)]);
        dE[HL(i)] += aw * (h[S1(i)] - h[HL(i)]);
        dE[UP] += aw * (h[HL(i)] - h[UP]);
      }
    }
    if (coreW >= 0) {
      dE[CORE] += coreW * (h[LP] - h[CORE]);
      dE[UP] += coreW * (h[CORE] - h[UP]);
    } else {
      dE[CORE] += -coreW * (h[UP] - h[CORE]);
      dE[LP] += -coreW * (h[CORE] - h[LP]);
    }
    // a little conductive/turbulent mixing so stagnant nodes don't diverge numerically
    const mixW = 40; // kg/s
    dE[CORE] += mixW * (h[UP] - h[CORE]) + mixW * (h[LP] - h[CORE]);
    dE[UP] += mixW * (h[CORE] - h[UP]);
    dE[LP] += mixW * (h[CORE] - h[LP]);
    // heat sources
    dE[CORE] += this.qCoolKW;
    for (let i = 0; i < 4; i++) {
      const s = this.rcpSpeed[i];
      dE[CL(i)] += K.RCP_HEAT * s * s * s;
      // SG heat transfer (computed in secondarySide)
      dE[S1(i)] -= this.qS1[i];
      dE[S2(i)] -= this.qS2[i];
      dE[UP] -= this.qReflux[i];
    }
    // heat losses (insulation) ~ 1 MW total
    dE[UP] -= 1000 * clamp((this.T[UP] - 50) / 250, 0, 1.5);
    for (let i = 0; i < NN; i++) {
      const m = this.ML * VFRAC[i];
      h[i] += (dE[i] * dt) / m;
    }
    // boron transport (same upwind scheme)
    const b = this.bor;
    const dB = this.dBbuf;
    dB.fill(0);
    for (let i = 0; i < 4; i++) {
      const w = this.w[i], aw = Math.abs(w);
      if (w >= 0) {
        dB[HL(i)] += aw * (b[UP] - b[HL(i)]); dB[S1(i)] += aw * (b[HL(i)] - b[S1(i)]);
        dB[S2(i)] += aw * (b[S1(i)] - b[S2(i)]); dB[CL(i)] += aw * (b[S2(i)] - b[CL(i)]);
        dB[LP] += aw * (b[CL(i)] - b[LP]);
      } else {
        dB[CL(i)] += aw * (b[LP] - b[CL(i)]); dB[S2(i)] += aw * (b[CL(i)] - b[S2(i)]);
        dB[S1(i)] += aw * (b[S2(i)] - b[S1(i)]); dB[HL(i)] += aw * (b[S1(i)] - b[HL(i)]);
        dB[UP] += aw * (b[HL(i)] - b[UP]);
      }
    }
    if (coreW >= 0) { dB[CORE] += coreW * (b[LP] - b[CORE]); dB[UP] += coreW * (b[CORE] - b[UP]); }
    else { dB[CORE] += -coreW * (b[UP] - b[CORE]); dB[LP] += -coreW * (b[CORE] - b[LP]); }
    dB[CORE] += mixW * (b[UP] - b[CORE]) + mixW * (b[LP] - b[CORE]);
    dB[UP] += mixW * (b[CORE] - b[UP]);
    dB[LP] += mixW * (b[CORE] - b[LP]);
    for (let i = 0; i < NN; i++) b[i] += (dB[i] * dt) / (this.ML * VFRAC[i]);
  }
  dEbuf = new Float64Array(NN);
  dBbuf = new Float64Array(NN);
  qS1 = [0, 0, 0, 0];
  qS2 = [0, 0, 0, 0];
  qReflux = [0, 0, 0, 0];

  computeDnbr() {
    const P = this.P;
    const Ppsia = P * 145.0377;
    const fP = Math.max(0.15, 1 - ((Ppsia - 1300) / 2400) ** 2);
    const G = Math.abs(this.coreFlowN);
    const gG = Math.max(0.12, Math.sqrt(G));
    const hin = this.h[LP], hout = this.h[CORE];
    const hex = hin + 1.45 * Math.max(0, hout - hin);
    const hl = hf(P), hv = hg(P);
    const xe = (hex - hl) / (hv - hl);
    const s = xe < 0 ? 1 + 2.6 * Math.min(0.5, -xe) : Math.max(0.08, 1 - 3.5 * xe);
    const chf = this.chfC0 * fP * gG * s * (1 - 0.8 * this.uncov[1]);
    const pth = (1 - DH_TOTAL) * this.fissionAvg + this.dh.total;
    const ao = this.axialOffset();
    const penalty = 1 + 0.008 * Math.max(0, Math.abs(ao + 2) - 6) + (this.droppedRod ? 0.08 : 0);
    const q = Math.max(1e-4, pth * penalty);
    this.dnbr = Math.min(9.99, chf / q);
    this.dnbrBulk = Math.min(9.99, (chf * 1.8) / q);
  }

  calibrateChf() {
    const P = psigToMPa(2235);
    const Ppsia = P * 145.0377;
    const fP = 1 - ((Ppsia - 1300) / 2400) ** 2;
    const hin = hfT(fToC(553.7)), hout = hfT(fToC(616.3));
    const hex = hin + 1.45 * (hout - hin);
    const xe = (hex - hf(P)) / (hg(P) - hf(P));
    const s = xe < 0 ? 1 + 2.6 * Math.min(0.5, -xe) : Math.max(0.08, 1 - 3.5 * xe);
    this.chfC0 = 2.05 / (fP * s);
  }

  axialOffset() {
    const ins = (b: RodBankId) => ROD_STEPS_MAX - this.rodPos[b];
    const aoRods = -0.11 * ins('CD') - 0.05 * ins('CC') - 0.02 * ins('CB');
    return clamp(-2 + aoRods * Math.min(1, this.kin.n * 4 + 0.2) + this.aoXe, -60, 40);
  }

  // ------------------------------------------------------------------ mass sources & sinks
  massSources(dt: number) {
    const c = this.controls;
    const P = this.P;
    const Ppsig = mpaToPsig(P);
    let hbar = this.hbarV();
    const B = this.bor;
    const power = this.powerAvailable();
    // ---- letdown
    const ldIso = c.letdownIsolated || this.letdownAutoIsolated || this.siActuated || !power;
    let ld = 0;
    if (!ldIso && P > 0.8) ld = 75 * GPM_TO_KGS * Math.min(1.1, Math.sqrt(P / 15.5));
    this.letdownKgs = ld;
    // ---- charging (auto level control)
    const lvl = (this.pzr.liquidV / V_PZR) * 100;
    const prog = this.pzrProgram(this.tavgF());
    let chGpm = 0;
    const ccpAvail = power && !this.siActuated && P < psigToMPa(2700);
    if (ccpAvail) {
      if (c.chargingMode === 'auto') {
        const e = prog - lvl;
        this.chargingInt = clamp(this.chargingInt + 0.15 * e * dt, -80, 80);
        chGpm = clamp(87 + 15 * e + this.chargingInt, 20, 150);
      } else {
        chGpm = clamp(c.chargingFlowDemand, 0, 100) * 1.5;
        this.chargingInt = clamp(chGpm - 87, -80, 80);
      }
      // pump head: falls off near shutoff
      chGpm *= Math.sqrt(clamp(1 - Ppsig / 2750, 0, 1) / (1 - 2235 / 2750));
      chGpm = Math.min(chGpm, 180);
    }
    const ch = chGpm * GPM_TO_KGS;
    this.chargingKgs = ch;
    // net seal leak-off: 12 gpm of charging returns to the VCT
    const chIn = Math.max(0, ch - 12 * GPM_TO_KGS * (ccpAvail ? 1 : 0));
    // ---- VCT / makeup boron
    let mu = 0, cmu = this.vctBoron;
    if (c.makeupMode === 'dilute') { mu = c.makeupRateGpm * GPM_TO_KGS; cmu = 0; }
    else if (c.makeupMode === 'borate') { mu = c.makeupRateGpm * GPM_TO_KGS; cmu = K.BORIC_ACID_PPM; }
    mu = clamp(mu, 0, 120 * GPM_TO_KGS);
    if (!power) mu = 0;
    const bLd = B[CL(K.LETDOWN_LOOP)];
    const ldIn = Math.max(0, ld - mu);
    this.vctBoron += ((mu * (cmu - this.vctBoron) + ldIn * (bLd - this.vctBoron)) / K.VCT_MASS) * dt;
    if (ld === 0 && mu === 0) this.vctBoron += 0; // stagnant
    // ---- charging enthalpy (regenerative heat exchanger)
    const tLd = this.T[CL(K.LETDOWN_LOOP)];
    const tCh = 54 + (tLd - 54) * 0.85 * clamp(ld / Math.max(ch, 0.1), 0, 1);
    const hCh = hfT(tCh);
    this.addMass(CL(K.CHARGING_LOOP), chIn * dt, hCh, this.vctBoron, hbar);
    hbar = this.hbarV();
    this.addMass(CL(K.LETDOWN_LOOP), -ld * dt, 0, 0, hbar);

    // ---- safety injection
    let si = 0;
    if (this.siActuated && power) {
      const seqDelay = this.offsite ? 2 : 12;
      if (this.siTimer > seqDelay) {
        const ccp = 2 * 275 * Math.sqrt(clamp(1 - Ppsig / 2650, 0, 1));
        const sip = 2 * 650 * Math.sqrt(clamp(1 - Ppsig / 1520, 0, 1));
        const rhr = 2 * 4000 * Math.sqrt(clamp(1 - Ppsig / 180, 0, 1));
        si = (ccp + sip + rhr) * GPM_TO_KGS;
      }
    }
    this.siKgs = si;
    if (si > 0) {
      const hrw = hfT(38);
      for (let i = 0; i < 4; i++) { hbar = this.hbarV(); this.addMass(CL(i), (si / 4) * dt, hrw, K.RWST_PPM, hbar); }
    }
    // ---- accumulators
    for (let i = 0; i < 4; i++) {
      const a = this.accum[i];
      if (a.isolated || a.water <= 0) continue;
      const pAcc = psigToMPa(K.ACC_P0_PSIG) * (K.ACC_GAS_V0 / a.gasV);
      if (pAcc > P) {
        let wa = K.ACC_K * Math.sqrt(pAcc - P);
        wa = Math.min(wa, a.water / dt, 2500);
        a.water -= wa * dt;
        a.gasV += (wa * dt) / 1000;
        if (!this.accumulatorsInjected && !this.settling) { this.accumulatorsInjected = true; this.msg('Accumulator check valves open — cold-leg accumulators injecting.'); }
        hbar = this.hbarV();
        this.addMass(CL(i), wa * dt, hfT(38), 2600, hbar);
        if (a.water <= 0) { a.isolated = true; }
      }
    }
    // ---- breaks (LOCA, SG tube leak, vessel/piping rupture)
    this.breakKgs = 0;
    const brk = this.faults.breakArea() + this.vesselBreakArea;
    if (brk > 0) {
      const node = this.faults.breakNode();
      const pr = props(this.h[node], P);
      const W = this.criticalFlow(this.h[node], P, this.cont.P) * brk * 0.6;
      const dm = Math.min(W * dt, this.ML * 0.02);
      this.breakKgs = dm / dt;
      this.toContainment(dm, this.h[node]);
      hbar = this.hbarV();
      this.addMass(node, -dm, 0, 0, hbar);
      void pr;
    }
    // SG tube leak/rupture: primary → secondary
    this.tubeLeakKgs = 0;
    for (const f of this.faults.active) {
      if (f.id !== 'SG_TUBE_LEAK') continue;
      const i = Number(f.target ?? 0);
      const a = this.faults.tubeLeakArea;
      const node = S2(i);
      const dp = Math.max(0, P - this.sg[i].P);
      const v = this.Vs[node];
      let W = 0.6 * a * Math.sqrt((2 * dp * 1e6) / v);
      W = Math.min(W * dt, this.ML * 0.01) / dt;
      this.tubeLeakKgs += W;
      this.sg[i].wTubeLeak = W;
      this.sg[i].M += W * dt;
      this.sg[i].U += W * dt * this.h[node];
      hbar = this.hbarV();
      this.addMass(node, -W * dt, 0, 0, hbar);
    }
  }

  /** critical (choked) mass flux, kg/m²s, from a node with enthalpy h at pressure P into back pressure Pb */
  criticalFlow(h: number, P: number, Pb: number): number {
    const pr = props(h, P);
    const dpTot = Math.max(0, P - Pb);
    if (dpTot <= 0) return 0;
    if (pr.x <= 0) {
      const ps = psat(pr.T);
      const dpl = Math.max(0, P - Math.max(ps, Pb));
      const rho = 1 / pr.v;
      const gl = Math.sqrt(2 * rho * dpl * 1e6);
      const gs = 0.6 * Math.sqrt(Math.min(ps, dpTot) * 1e6 * rho) * 0.55;
      return gl + gs;
    }
    const rho = 1 / pr.v;
    return 0.66 * Math.sqrt(Math.min(P, 2 * dpTot) * 1e6 * rho);
  }

  toContainment(dm: number, h: number) {
    if (dm <= 0) return;
    const Pc = this.cont.P;
    const hl = hf(Pc), hv = hg(Pc);
    const x = clamp((h - hl) / (hv - hl), 0, 1);
    this.cont.mv += dm * x;
    this.rcsReleasedMass += dm;
    // radioactivity source (coolant activity rises enormously with failed fuel)
    const act = 1 + 1e5 * this.fuelDamage();
    this.cont.src += (dm / 1000) * act;
    // hydrogen escapes with the release
    if (this.rcsH2 > 0) {
      const frac = Math.min(1, dm / Math.max(1, this.ML * 0.02));
      const hh = this.rcsH2 * frac;
      this.rcsH2 -= hh;
      this.cont.h2 += hh;
    }
  }

  fuelDamage() {
    let d = 0;
    for (let r = 0; r < 2; r++) d += K.REGION_VFRAC[r] * Math.max(this.fail[r], this.melt[r]);
    return clamp(d, 0, 1);
  }

  // ------------------------------------------------------------------ pressurizer & RCS pressure
  pressurizerAndPressure(dt: number) {
    const c = this.controls;
    const pz = this.pzr;
    let P = this.P;
    const Ppsig = mpaToPsig(P);
    const power = this.powerAvailable();
    const lvl = (pz.liquidV / V_PZR) * 100;
    const prog = this.pzrProgram(this.tavgF());
    const ctlPsig = Ppsig + this.faults.pzrPressureBias();
    // ---- heaters
    let q = 0;
    if (c.przHeaters !== 'off' && power && lvl > 17 && !this.letdownAutoIsolated) {
      let prop = clamp((2250 - ctlPsig) / 30, 0, 1);
      if (c.przHeaters === 'on') prop = 1;
      if (ctlPsig < 2210 || lvl > prog + 5 || c.przHeaters === 'on') this.przHeaterBackupOn = true;
      else if (ctlPsig > 2217 && lvl < prog + 4) this.przHeaterBackupOn = false;
      q = prop * K.PZR_HEATER_PROP + (this.przHeaterBackupOn ? K.PZR_HEATER_BACKUP : 0);
      if (!this.offsite) q *= 0.5;
    } else this.przHeaterBackupOn = false;
    this.heaterKW = q;
    pz.U += (q - K.PZR_HEAT_LOSS) * dt;
    // ---- spray (driven by RCP ΔP in loops 1 & 2)
    let pos = c.przSprayMode === 'auto' ? clamp((ctlPsig - 2260) / 50, 0, 1) : clamp(c.przSprayDemand, 0, 1);
    if (this.faults.has('PZR_SPRAY_STUCK_OPEN')) pos = Math.max(pos, 0.6);
    this.sprayPos = pos;
    const drive = Math.sqrt(0.5 * (this.rcpSpeed[0] ** 2 + this.rcpSpeed[1] ** 2));
    const ws = (pos * K.PZR_SPRAY_MAX + K.PZR_SPRAY_BYPASS) * drive;
    this.sprayKgs = ws;
    let hbar = this.hbarV();
    if (ws > 0) {
      const dm = ws * dt;
      const hs = this.h[CL(0)];
      pz.B += (dm * (this.bor[CL(0)] - pz.B)) / (pz.M + dm);
      pz.M += dm; pz.U += dm * hs;
      this.addMass(CL(0), -dm, 0, 0, hbar);
    }
    // ---- PORV & code safeties
    const porvAuto = c.porvMode === 'auto';
    if (c.porvMode === 'open') this.porvValveOpen = true;
    else if (c.porvMode === 'closed') this.porvValveOpen = false;
    else if (porvAuto) {
      if (ctlPsig >= 2335) this.porvValveOpen = true;
      else if (ctlPsig < 2315) this.porvValveOpen = false;
    }
    if (this.faults.has('PZR_PORV_STUCK_OPEN')) this.porvValveOpen = true;
    if (Ppsig >= 2485) this.pzrSvOpen = true;
    if (this.pzrSvOpen) this.pzrSvPos = clamp((Ppsig - 2410) / 150, 0.15, 1);
    if (Ppsig < 2410) { this.pzrSvOpen = false; this.pzrSvPos = 0; }
    const area = (this.porvValveOpen && c.porvBlockValveOpen ? K.PORV_AREA : 0) + this.pzrSvPos * K.PZR_SV_AREA;
    this.reliefKgs = 0;
    if (area > 0 && pz.M > 1) {
      const lvlTop = pz.liquidV / V_PZR;
      const htop = lvlTop > 0.97 ? hf(P) : lvlTop > 0.9 ? 0.5 * (hf(P) + hg(P)) : pz.liquidV < 0.05 ? this.pzrDryH(P) : hg(P);
      const Pprt = this.prtRuptured ? this.cont.P : this.cont.P + 0.1 + this.prtEnergy / 4e7;
      let W = this.criticalFlow(htop, P, Pprt) * area;
      W = Math.min(W, (pz.M * 0.05) / dt);
      const dm = W * dt;
      pz.M -= dm; pz.U -= dm * htop;
      this.reliefKgs = W;
      if (!this.prtRuptured) {
        this.prtEnergy += dm * (htop - 200);
        if (this.prtEnergy > 1.5e7) { this.prtRuptured = true; if (!this.settling) this.msg('PRESSURIZER RELIEF TANK rupture disk burst — relief now discharging to containment.'); }
      } else this.toContainment(dm, htop);
    }
    this.prtEnergy = Math.max(0, this.prtEnergy - 30 * dt);

    // ---- surge: find mass transfer dm (loops → pzr) that satisfies volume & pressure equilibrium
    this.updateNodeProps();
    hbar = this.hbarV();
    const sl = HL(K.SURGE_LOOP);
    const out = this.pzrOut;
    const f = (dm: number) => {
      const Mp = pz.M + dm;
      let hs: number;
      if (dm >= 0) hs = this.h[sl];
      else hs = pz.liquidV > 0.05 ? hf(P) : this.pzrDryH(P);
      const Pp = containerPressure(Mp, pz.U + dm * hs, V_PZR, P, out);
      const ml = this.ML - dm;
      let vol = 0;
      for (let i = 0; i < NN; i++) vol += VFRAC[i] * props(this.h[i], Pp).v;
      return vol * ml - V_LOOPS;
    };
    // bracket & solve (Illinois)
    let a = 0, fa = f(0);
    const v0 = Math.max(1e-4, this.Vs[sl]);
    let b = fa / v0;
    const lim = -pz.M * 0.999;
    if (b < lim) b = lim;
    let fb = f(b);
    let guard = 0;
    while (fa * fb > 0 && guard++ < 30) {
      const step = (b - a) * 2 || (fa > 0 ? 10 : -10);
      a = b; fa = fb;
      b = Math.max(lim, b + step);
      fb = f(b);
      if (b === lim && fa * fb > 0) break;
    }
    let dmSol = b;
    if (fa * fb <= 0) {
      let side = 0;
      for (let it = 0; it < 40; it++) {
        dmSol = (a * fb - b * fa) / (fb - fa);
        const fs = f(dmSol);
        if (Math.abs(fs) < 1e-5 || Math.abs(b - a) < 1e-4) break;
        if (fs * fb > 0) { b = dmSol; fb = fs; if (side === -1) fa *= 0.5; side = -1; }
        else { a = dmSol; fa = fs; if (side === 1) fb *= 0.5; side = 1; }
      }
    }
    // apply
    const dm = dmSol;
    const hs = dm >= 0 ? this.h[sl] : pz.liquidV > 0.05 ? hf(P) : this.pzrDryH(P);
    if (dm >= 0) pz.B += (dm * (this.bor[sl] - pz.B)) / Math.max(1, pz.M + dm);
    else this.bor[sl] += (-dm * (pz.B - this.bor[sl])) / (this.ML * VFRAC[sl]);
    pz.M += dm; pz.U += dm * hs;
    // loops: remove/add at surge enthalpy with the uniform-distribution energy correction
    this.h[sl] += (-dm * (hs - hbar)) / (this.ML * VFRAC[sl]);
    this.ML -= dm;
    this.surgeKgs = dm / dt;
    P = containerPressure(pz.M, pz.U, V_PZR, P, out);
    pz.liquidV = out.liquidVolume; pz.x = out.x; pz.T = out.T; pz.solid = out.solid;
    this.P = clamp(P, 0.0105, 60);
    this.updateNodeProps();
  }
  /** specific enthalpy of an all-vapour (possibly superheated) pressurizer */
  pzrDryH(P: number): number {
    const pz = this.pzr;
    return pz.M > 1 ? Math.max(hg(P), (pz.U + 1000 * P * V_PZR) / pz.M) : hg(P);
  }
  heaterKW = 0;
  sprayPos = 0;
  surgeKgs = 0;

  // ------------------------------------------------------------------ secondary side
  secondarySide(dt: number) {
    const c = this.controls;
    const tb = this.turb;
    // ---- condenser
    const circ = this.offsite;
    const load = (tb.wt + this.dumpPos * K.C_DUMP * this.Ph) / K.W_STEAM_RATED;
    const vacT = circ ? 28 - 8 * Math.max(0, load - 1.05) : 0;
    this.vacuum += (vacT - this.vacuum) * Math.min(1, dt / (circ ? 20 : 45));
    const c9 = this.vacuum > 22 && circ;
    // ---- steam dumps
    let dump = 0;
    const tavg = this.tavgF();
    if (c.steamDumpMode === 'pressure') dump = clamp((mpaToPsig(this.Ph) - c.steamDumpPressureSetpoint) / 30, 0, 1);
    else if (c.steamDumpMode === 'tavg' && tavg >= 553) {
      // plant-trip controller, with a steam-pressure floor so it cannot cool the plant far below no-load
      if (this.reactorTripped) dump = Math.min(clamp((tavg - 557) / 25, 0, 1), clamp((mpaToPsig(this.Ph) - 1005) / 60, 0, 1));
      else if (tb.tripped || !tb.breaker || tavg - this.trefF() > 5) dump = clamp((tavg - this.trefF() - 3) / 20, 0, 1);
    }
    if (!c9) dump = 0;
    this.dumpPos += clamp(dump - this.dumpPos, -dt / 3, dt / 3);
    // ---- turbine
    this.turbine(dt);
    // ---- steam header pressure: Σ line flows = demand
    const demandCoef = this.dumpPos * K.C_DUMP + (tb.breaker ? K.C_TURB * tb.gv : 0);
    const rollFlow = !tb.breaker ? tb.wt : 0;
    const sgs = this.sg;
    const lineFlow = (i: number, ph: number) => {
      const s = sgs[i];
      if (!s.msivOpen) return 0;
      const d = s.P - ph;
      // turbulent ΔP ∝ w², linearised below 0.02 MPa so tiny pressure differences cannot chatter
      return (K.K_STEAMLINE * d) / Math.sqrt(Math.max(Math.abs(d), 0.02));
    };
    const anyOpen = sgs.some((s) => s.msivOpen);
    if (anyOpen) {
      let lo = 0.05, hi = 0.05;
      for (const s of sgs) if (s.msivOpen) hi = Math.max(hi, s.P);
      const g = (ph: number) => {
        let s = 0;
        for (let i = 0; i < 4; i++) s += lineFlow(i, ph);
        return s - demandCoef * ph - rollFlow;
      };
      if (g(hi) >= 0) this.Ph = hi;
      else {
        for (let it = 0; it < 40; it++) { const m = 0.5 * (lo + hi); if (g(m) > 0) lo = m; else hi = m; }
        this.Ph = 0.5 * (lo + hi);
      }
    } else this.Ph = Math.max(0.05, this.Ph - this.Ph * (dt / 60));
    tb.wt = tb.breaker ? K.C_TURB * tb.gv * this.Ph : rollFlow;
    if (!anyOpen) tb.wt = 0;
    tb.mwe = tb.breaker ? K.MW_PER_KGS * tb.wt * clamp(this.vacuum / 28, 0.5, 1.0) : 0;
    // ---- feedwater temperature
    const tfwT = 38 + 189 * Math.pow(clamp(tb.wt / K.W_STEAM_RATED, 0, 1), 0.8);
    this.tFeed += (tfwT - this.tFeed) * Math.min(1, dt / 120);
    const hFw = hfT(this.tFeed);
    const hAfw = hfT(38);
    const nMfp = (this.mfpRunning[0] ? 1 : 0) + (this.mfpRunning[1] ? 1 : 0);
    // AFW supply per SG
    const afwPer = [0, 0, 0, 0];
    if (this.afwRunning[0]) { afwPer[0] += K.AFW_MD_KGS / 2; afwPer[1] += K.AFW_MD_KGS / 2; }
    if (this.afwRunning[1]) { afwPer[2] += K.AFW_MD_KGS / 2; afwPer[3] += K.AFW_MD_KGS / 2; }
    if (this.afwRunning[2]) for (let i = 0; i < 4; i++) afwPer[i] += K.AFW_TD_KGS / 4;
    const afwThrottled = c.auxFeedPumps.every((m) => m !== 'on');

    for (let i = 0; i < 4; i++) {
      const s = sgs[i];
      // ---- primary → secondary heat transfer
      const fl = Math.max(Math.abs(this.wn[i]), 0.02);
      const uflow = 1 / (0.65 + 0.35 * Math.pow(fl, -0.8));
      // sink: boiling water, or (dry generator) the superheated steam itself
      const Ts = Math.max(tsat(s.P), s.liquidV > 0.05 ? 0 : s.T);
      const ua = this.uaHalf * uflow * s.fwet;
      this.qS1[i] = ua * (this.T[S1(i)] - Ts);
      this.qS2[i] = ua * (this.T[S2(i)] - Ts);
      // reflux condensation when natural circulation is interrupted by steam in the U-tubes
      this.qReflux[i] = this.X[UP] > 0 && this.X[S1(i)] > 0.15 ? Math.max(0, 3000 * s.fwet * (this.T[UP] - Ts)) : 0;
      const Q = this.qS1[i] + this.qS2[i] + this.qReflux[i];
      s.Q = Q;
      // ---- feed regulating valve
      const wmax = K.MFP_CAP_PER_SG * nMfp * Math.sqrt(clamp(1 - s.P / 10.5, 0, 1) / (1 - 6.99 / 10.5));
      let posT: number;
      const fail = this.faults.feedValveFailure(i);
      if (c.feedMode[i] === 'auto') {
        const lvlMeas = s.nr + this.faults.sgLevelBias(i);
        const e = K.SG_LEVEL_SP - lvlMeas;
        const wdem = s.wSteam + 8 * e + s.fwInt;
        posT = wmax > 1 ? wdem / wmax : 0;
        const sat = (posT >= 1 && e > 0) || (posT <= 0 && e < 0);
        if (!sat) s.fwInt = clamp(s.fwInt + 0.12 * e * dt, -300, 300);
      } else posT = clamp(c.feedValveDemand[i], 0, 1);
      if (this.fwIsolation || this.fwRegClosedP4) posT = 0;
      if (fail === 'open') posT = 1;
      else if (fail === 'closed') posT = 0;
      posT = clamp(posT, 0, 1);
      s.fwPos += clamp(posT - s.fwPos, -0.1 * dt, 0.1 * dt);
      s.wFeed = s.fwPos * wmax;
      // ---- aux feed
      let wa = afwPer[i] * Math.sqrt(clamp(1 - s.P / 9.6, 0, 1) / (1 - 7.6 / 9.6));
      if (afwThrottled) wa *= clamp(0.5 + (50 - s.nr) / 10, 0, 1);
      s.wAux = wa;
      // ---- relief: ARV (1125 psig) & safeties (1185–1235)
      const ps = mpaToPsig(s.P);
      const arvPos = clamp((ps - 1125) / 50, 0, 1);
      s.wArv = arvPos * K.C_ARV * s.P;
      if (ps >= 1185) s.svOpen = true;
      if (ps < 1140) s.svOpen = false;
      s.wSv = s.svOpen ? clamp((ps - 1150) / 85, 0.1, 1) * K.C_SGSV * s.P : 0;
      // ---- steam line break
      const bArea = this.faults.steamBreakArea(i);
      s.wBreak = bArea > 0 ? 0.66 * bArea * Math.sqrt(s.P * 1e6 / vg(s.P)) * (1 + 2 * s.carry) : 0;
      s.wLine = lineFlow(i, this.Ph);
      s.wSteam = Math.max(0, s.wLine) + s.wArv + s.wSv + s.wBreak;
      // ---- mass & energy balance
      const dry = s.liquidV < 0.05;
      const hOut = dry ? (s.U + 1000 * s.P * K.V_SG) / s.M : hg(s.P) - s.carry * (hg(s.P) - hf(s.P)) * 0.8;
      const hIn = hg(this.Ph);
      let wOut = Math.max(0, s.wLine) + s.wArv + s.wSv + s.wBreak;
      // cannot draw more steam than the generator holds
      const avail = Math.max(0, s.M - 20) / dt;
      if (wOut > avail) {
        const f = avail / wOut;
        wOut = avail; s.wArv *= f; s.wSv *= f; s.wBreak *= f; if (s.wLine > 0) s.wLine *= f;
        s.wSteam = Math.max(0, s.wLine) + s.wArv + s.wSv + s.wBreak;
      }
      const wInLine = Math.max(0, -s.wLine);
      const dM = (s.wFeed + s.wAux + wInLine - wOut) * dt;
      s.M = Math.max(20, s.M + dM);
      s.U += (Q + s.wFeed * hFw + s.wAux * hAfw + wInLine * hIn - wOut * hOut) * dt;
      if (s.wBreak > 0) this.toContainmentSteam(s.wBreak * dt, hOut);
      const Pold = s.P;
      s.P = containerPressure(s.M, s.U, K.V_SG, s.P, this.sgOut);
      s.T = this.sgOut.T;
      s.liquidV = this.sgOut.liquidVolume;
      s.dPdt += ((s.P - Pold) / dt - s.dPdt) * Math.min(1, dt / 2);
      // ---- level (shrink & swell)
      const qf = Math.max(0, Q) / (K.Q_RATED / 4);
      const voidT = clamp(K.SG_VOID_FP * Math.pow(qf, 0.75) * Math.sqrt(6.9 / Math.max(s.P, 0.5)) - 60 * s.dPdt, -8, 45);
      s.voidV += (voidT - s.voidV) * Math.min(1, dt / 3);
      const vmix = s.liquidV + s.voidV;
      s.nr = clamp(((vmix - K.SG_NR_V0) / K.SG_NR_SPAN) * 100, 0, 100);
      s.wr = clamp((vmix / K.SG_WR_SPAN) * 100, 0, 100);
      s.carry = clamp((vmix - 125) / 20, 0, 1);
      // wetted tube fraction; a dry bundle only transfers heat by steam convection/radiation
      s.fwet = s.liquidV > 0.05 ? clamp(s.liquidV / 40, 0.03, 1) : 0.003;
    }
  }
  uaHalf = 23000;

  toContainmentSteam(dm: number, h: number) {
    const Pc = this.cont.P;
    const x = clamp((h - hf(Pc)) / (hg(Pc) - hf(Pc)), 0, 1);
    this.cont.mv += dm * x;
  }

  turbine(dt: number) {
    const tb = this.turb;
    const c = this.controls;
    if (!tb.latched || tb.tripped) {
      tb.gv = 0; tb.wt = 0;
      tb.speed = Math.max(0, tb.speed - (tb.speed / 900 + 0.05) * dt * 1);
      return;
    }
    if (!tb.breaker) {
      const steamOK = this.Ph > 3.0 && this.vacuum > 22 && this.sg.some((s) => s.msivOpen);
      if (steamOK) {
        if (tb.speed > 1801) tb.speed = Math.max(1800, tb.speed - (600 / 60) * dt);
        else tb.speed = Math.min(1800, tb.speed + (300 / 60) * dt);
        tb.wt = 0.025 * K.W_STEAM_RATED * (0.25 + 0.75 * (tb.speed / 1800) ** 2);
      } else {
        tb.wt = 0;
        tb.speed = Math.max(0, tb.speed - (tb.speed / 600) * dt);
      }
      tb.gv = tb.wt / (K.C_TURB * Math.max(this.Ph, 0.5));
      tb.mwe = 0;
      return;
    }
    // on the grid
    tb.speed = 1800;
    const sp = clamp(c.turbineLoadSetpointMW, 0, 1250);
    const rate = (clamp(c.turbineRampRateMWpm, 1, 50) / 60) * dt;
    if (this.rodStop.C3 || this.rodStop.C4) {
      // OTΔT / OPΔT runback
      tb.loadRef = Math.max(0, tb.loadRef - (200 / 60) * dt);
      c.turbineLoadSetpointMW = Math.min(c.turbineLoadSetpointMW, tb.loadRef);
    } else tb.loadRef += clamp(sp - tb.loadRef, -rate, rate);
    const ff = tb.loadRef / (K.MW_PER_KGS * K.C_TURB * Math.max(this.Ph, 0.5) * clamp(this.vacuum / 28, 0.5, 1));
    const e = tb.loadRef - tb.mwe;
    tb.mwInt = clamp(tb.mwInt + 0.00002 * e * dt * 60, -0.15, 0.15);
    const gvT = clamp(ff + tb.mwInt, 0, 1);
    tb.gv += clamp(gvT - tb.gv, -0.08 * dt, 0.08 * dt);
  }

  // ------------------------------------------------------------------ containment
  containment(dt: number) {
    const ct = this.cont;
    // hydrogen burn when flammable
    const nAir = ((ct.pAir0 * 1e6 * K.V_CONT) / (8.314 * 322.15));
    const nH2 = ct.h2 / 0.002016;
    const nV = ct.mv / 0.018;
    const yH2 = nH2 / (nAir + nH2 + nV);
    if (yH2 > 0.08 && this.rng.next() < dt / 30) {
      const E = ct.h2 * 120000;
      ct.theta += E / (nAir * 0.029 * 0.718 + ct.mv * 1.4 + 1);
      ct.mv += ct.h2 * 9;
      ct.h2 = 0;
      this.msg('HYDROGEN DEFLAGRATION in containment — pressure spike.');
    }
    ct.theta *= Math.exp(-dt / 20);
    const rhoV = ct.mv / K.V_CONT;
    const Tsat = tOfRhog(rhoV);
    const T = Math.max(ct.Tw, Tsat, 49);
    ct.T = T;
    const saturated = Tsat >= Math.max(ct.Tw, 49) - 0.01;
    const pv = saturated ? psat(Tsat) : (rhoV * 461.5 * (T + 273.15)) / 1e6;
    const pH2 = (ct.h2 * 4124 * (T + 273.15)) / K.V_CONT / 1e6;
    const pAir = (ct.pAir0 * (T + ct.theta + 273.15)) / 322.15;
    ct.P = pAir + pv + pH2;
    const Pc = mpaToPsig(ct.P);
    // heat removal
    if (Pc > 28 && !ct.sprays && this.powerAvailable()) { ct.sprays = true; this.msg('Containment pressure HI-3: containment spray actuated.'); }
    if (ct.sprays && Pc < 4) ct.sprays = false;
    let q = 0;
    if (saturated && Tsat > ct.Tw) q += K.CONT_UA_WALL * (Tsat - ct.Tw);
    const fans = this.powerAvailable() ? K.CONT_UA_FAN * (this.siActuated ? 1 : 0.3) : 0;
    if (saturated) q += fans * Math.max(0, Tsat - 30);
    if (ct.sprays) q += K.CONT_UA_SPRAY * Math.max(0, T - 30);
    const hfg = 2300;
    const cond = Math.min((q / hfg) * dt, Math.max(0, ct.mv - 0.3 * rhogT(49) * K.V_CONT));
    ct.mv -= cond;
    ct.Tw += ((K.CONT_UA_WALL * Math.max(0, Tsat - ct.Tw) * (saturated ? 1 : 0)) / K.CONT_C_WALL) * dt;
    ct.Tw += ((49 - ct.Tw) / 36000) * dt;
    // radiation
    ct.src *= Math.exp(-dt / 7200);
    ct.rad = 0.01 + 0.05 * ct.src + 2e4 * this.fuelDamage() * (this.integrity.rcs < 1 || this.breakKgs > 0 ? 1 : 0.01);
    // integrity
    if (Pc > 60 && !this.settling) {
      this.integrity.containment = Math.max(0, this.integrity.containment - ((Pc - 60) / 60) ** 2 * 0.03 * dt);
    }
    if (this.integrity.containment <= 0) {
      ct.pAir0 = Math.max(0.08, ct.pAir0 - ct.pAir0 * dt / 30);
      ct.mv *= Math.exp(-dt / 30);
    }
  }

  // ------------------------------------------------------------------ damage & catastrophes
  damage(dt: number) {
    for (let r = 0; r < 2; r++) {
      const tc = this.Tc[r];
      let f = Math.max(this.fail[r], 0.95 * smooth(tc, K.T_CLAD_FAIL_START, K.T_CLAD_FAIL_FULL));
      const d = r === 1 ? this.dnbr : this.dnbrBulk;
      if (d < 1) f += (1 - d) * 0.01 * dt;
      f = Math.max(f, Math.min(1, this.ox[r] / 0.17 > 0.1 ? this.ox[r] / 0.17 : 0));
      f = Math.max(f, this.melt[r]);
      this.fail[r] = clamp(f, 0, 1);
    }
    const Ppsig = mpaToPsig(this.P);
    // RCS overpressure → structural damage → rupture (LOCA)
    if (Ppsig > 3200) {
      this.integrity.rcs = Math.max(0, this.integrity.rcs - ((Ppsig - 3000) / 800) ** 2 * dt);
    }
    if (this.integrity.rcs < 0.75) {
      const want = (0.75 - this.integrity.rcs) * 0.6; // m² up to ~0.45 m² (large-break)
      if (want > this.vesselBreakArea) {
        if (this.vesselBreakArea === 0) this.msg('RCS PRESSURE BOUNDARY FAILURE — primary coolant escaping to containment.');
        this.vesselBreakArea = want;
      }
    }
    // secondary: water carry-over into steam lines / turbine
    for (const s of this.sg) {
      if (s.carry > 0 && s.wSteam > 1) {
        const turbFrac = this.turb.wt / K.W_STEAM_RATED;
        this.integrity.secondary = Math.max(0, this.integrity.secondary - s.carry * (0.05 * turbFrac + 0.004 * (s.wSteam / K.W_STEAM_RATED_SG)) * dt);
      }
    }
    // catastrophes
    if (!this.catastrophe) {
      const molten = K.REGION_VFRAC[0] * this.melt[0] + K.REGION_VFRAC[1] * this.melt[1];
      const fast = Math.max(this.tfRate[0], this.tfRate[1]);
      if (fast > 900 && Math.max(this.Tf[0], this.Tf[1]) > 2200 && this.coreLevel > 0.5) {
        this.vesselBreakArea = Math.max(this.vesselBreakArea, 0.6);
        this.integrity.rcs = 0;
        this.setCatastrophe('steam-explosion',
          `A prompt-critical power excursion deposited energy in the fuel faster than it could conduct away: fuel temperature climbed at ${fast.toFixed(0)} °C/s until the pellets melted and fragmented. ` +
          'Molten UO₂ dispersed into the surrounding water, flashing it to steam in milliseconds. The resulting pressure pulse (a fuel–coolant interaction or "steam explosion") ' +
          'ruptured the reactor vessel and the core has been destroyed. Doppler feedback could not turn the excursion around in time because reactivity exceeded prompt critical (β ≈ 650 pcm).');
      } else if (this.integrity.rcs <= 0) {
        this.setCatastrophe('vessel-rupture',
          `RCS pressure reached ${Ppsig.toFixed(0)} psig, far beyond the 2485 psig design pressure, because heat input or inventory expansion exceeded what the pressurizer PORVs and code safety valves could relieve. ` +
          'The reactor coolant pressure boundary failed: the vessel/primary piping ruptured and the plant suffered a large-break loss of coolant accident.');
      } else if (molten > 0.2) {
        this.setCatastrophe('meltdown',
          `Decay heat was not removed from the core. With the coolant boiled away or not circulating, the fuel rods uncovered and heated up; above ~2200 °F the zirconium cladding reacted ` +
          `exothermically with steam (${(100 * (this.ox[0] * 0.7 + this.ox[1] * 0.3)).toFixed(0)} % of the clad oxidised, generating hydrogen), accelerating the heatup until the UO₂ fuel reached its ~5100 °F melting point. ` +
          `About ${(molten * 100).toFixed(0)} % of the core has melted and is relocating toward the bottom of the reactor vessel. This is a core meltdown.`);
        this.emit({ type: 'meltdown' });
      } else if (this.integrity.containment <= 0) {
        this.setCatastrophe('containment-failure',
          `Containment pressure reached ${mpaToPsig(this.cont.P).toFixed(0)} psig, well above the ~60 psig design pressure, as steam${this.cont.h2 > 0 ? ' and hydrogen' : ''} from the reactor coolant system accumulated faster than the fan coolers, sprays and structures could condense it. ` +
          'The containment building failed, opening a path for radioactive material to the environment.');
      } else if (this.integrity.secondary <= 0.05 && this.turb.speed > 1200) {
        this.setCatastrophe('turbine-missile',
          'A steam generator was overfilled and slugs of water were carried over at high velocity into the main steam lines and the spinning turbine. ' +
          'Water induction destroyed the turbine blading; the unbalanced rotor disintegrated and ejected fragments ("turbine missiles") through the casing.');
      }
    }
    if (this.melt[0] + this.melt[1] > 0 && this.coreStatusPrev !== 'meltdown') { /* noop */ }
  }
  coreStatusPrev: 'ok' | 'damaged' | 'meltdown' = 'ok';

  setCatastrophe(kind: NonNullable<PlantState['catastrophe']>['kind'], description: string) {
    if (this.catastrophe) return;
    this.catastrophe = { kind, t: this.t, description };
    this.emit({ type: 'catastrophe', kind });
    this.msg(`CATASTROPHE: ${kind.toUpperCase()}`);
  }

  // =================================================================== publishing PlantState
  publish() {
    if (!this.state) this.state = this.blankState();
    const s = this.state;
    const n = this.kin.n;
    s.t = this.t;
    s.scenario = this.spec.id;
    s.neutronPower = n;
    s.decayHeat = this.dh.total;
    s.thermalPower = (1 - DH_TOTAL) * n + this.dh.total;
    // nuclear instruments
    const ir = Math.max(1e-11, 2e-4 * n + 1e-11 * 0.5);
    s.intermediateRangeAmps = ir;
    const srOn = !this.permissives.P6 && !this.permissives.P10;
    const counts = n * 1e11 + 0.5;
    if (srOn) {
      const noise = this.settling ? 0 : this.rng.gauss() / Math.sqrt(Math.max(1, counts * 2));
      this.srCps += (counts * (1 + noise) - this.srCps) * 0.5;
      s.sourceRangeCps = Math.max(0, Math.min(1e6, this.srCps));
    } else { this.srCps = counts; s.sourceRangeCps = 0; }
    s.powerRangePct = clamp(n * 100 + this.faults.prBias(), 0, 200);
    s.startupRateDpm = (this.sur * 60) / Math.LN10;
    s.periodSeconds = Math.abs(this.sur) < 1e-4 ? Infinity : 1 / this.sur;
    s.neutronFlux = n * 3.2e13 + 3e3;
    s.axialOffset = this.axialOffset();
    const r = this.rho;
    s.reactivity.total = r.total; s.reactivity.rods = r.rods; s.reactivity.boron = r.boron;
    s.reactivity.doppler = r.doppler; s.reactivity.moderator = r.moderator + r.void;
    s.reactivity.xenon = r.xenon; s.reactivity.samarium = r.samarium;
    s.keff = 1 / (1 - r.total * 1e-5);
    for (const b of ROD_BANKS) s.rods[b] = Math.round(this.rodPos[b] * 10) / 10;
    if (this.stuckRod) { const sb = this.stuckRod.bank; s.rods[sb] = Math.round(((this.rodPos[sb] * 7 + this.stuckRod.pos) / 8) * 10) / 10; }
    s.rodsMoving = this.rodSpeed > 0 || this.rodDrop.active;
    s.rodSpeedSpm = this.rodDrop.active ? 6000 : this.rodSpeed;
    s.droppedRods = this.droppedRod ? 1 : 0;
    s.rodBottomLights = !!this.droppedRod || this.reactorTripped;
    let bsum = 0;
    for (let i = 0; i < NN; i++) bsum += VFRAC[i] * this.bor[i];
    s.boronPpm = bsum;
    s.xenonPcm = this.poi.xenonPcm;
    s.iodine = this.poi.iodine;
    s.xenon = this.poi.xenon;
    // core thermal
    const tcHot = this.Tc[1], tfHot = this.Tf[1];
    s.fuelTempCenterline = cToF(tcHot + (tfHot - tcHot) * 2.1);
    s.cladTemp = cToF(Math.max(this.Tc[0], this.Tc[1]));
    s.tAvg = this.tavgF();
    s.tRef = this.trefF();
    let dts = 0;
    for (let i = 0; i < 4; i++) dts += this.T[HL(i)] - this.T[CL(i)];
    s.deltaT = (dts / 4) * 1.8;
    s.dnbr = this.dnbr;
    const cet = this.T[CORE] + this.uncov[1] * Math.max(0, this.Tc[1] - this.T[CORE]) * 0.6;
    s.coreExitTemp = cToF(cet);
    s.subcoolingMargin = cToF(tsat(this.P)) - cToF(cet);
    // RCS
    s.rcsPressure = mpaToPsig(this.P);
    s.przLevel = clamp((this.pzr.liquidV / V_PZR) * 100, 0, 100);
    s.przLevelProgram = this.pzrProgram(s.tAvg);
    s.przTemp = cToF(this.pzr.T);
    s.przHeaterKW = this.heaterKW;
    s.przSprayPos = this.sprayPos;
    s.porvOpen = this.porvValveOpen;
    s.safetyValvesOpen = this.pzrSvOpen;
    s.chargingFlowGpm = this.chargingKgs * KGS_TO_GPM;
    s.letdownFlowGpm = this.letdownKgs * KGS_TO_GPM;
    s.rcsLeakGpm = (this.breakKgs + this.tubeLeakKgs) * KGS_TO_GPM;
    for (let i = 0; i < 4; i++) {
      const L = s.loops[i], g = this.sg[i];
      L.rcpRunning = this.rcpOn[i];
      L.rcpSpeed = this.rcpSpeed[i];
      L.flow = this.wn[i] * 100;
      L.tHot = cToF(this.T[HL(i)]);
      L.tCold = cToF(this.T[CL(i)]);
      L.sgLevel = g.nr;
      L.sgLevelWide = g.wr;
      L.sgPressure = mpaToPsig(g.P);
      L.feedFlow = ((g.wFeed + g.wAux) / K.W_STEAM_RATED_SG) * 100;
      L.steamFlow = (g.wSteam / K.W_STEAM_RATED_SG) * 100;
      L.feedValvePos = g.fwPos;
      L.auxFeedFlow = g.wAux * KGS_TO_GPM;
    }
    // secondary
    const tb = this.turb;
    s.steamHeaderPressure = mpaToPsig(this.Ph);
    s.turbineSpeedRpm = tb.speed;
    s.turbineLatched = tb.latched;
    s.turbineTripped = tb.tripped;
    s.generatorBreakerClosed = tb.breaker;
    s.grossMWe = tb.mwe;
    s.turbineLoadMW = tb.loadRef;
    s.steamDumpDemand = this.dumpPos;
    s.condenserVacuum = this.vacuum;
    s.mainFeedPumpsRunning = [...this.mfpRunning];
    s.auxFeedPumpsRunning = [...this.afwRunning];
    // safety
    s.reactorTripped = this.reactorTripped;
    s.tripSignals = [...this.tripSignals];
    s.firstOut = this.firstOut;
    s.permissives = { ...this.permissives };
    s.siActuated = this.siActuated;
    s.siFlowGpm = this.siKgs * KGS_TO_GPM;
    s.accumulatorsInjected = this.accumulatorsInjected;
    s.containmentPressure = mpaToPsig(this.cont.P);
    s.containmentRadiation = this.cont.rad;
    s.offsitePower = this.offsite;
    s.dieselGeneratorsRunning = [this.dgTimer[0] >= 0, this.dgTimer[1] >= 0];
    // consequences
    s.fuelDamage = this.fuelDamage();
    s.coreUncovered = this.coreLevel < 0.995;
    s.coreStatus = this.catastrophe?.kind === 'meltdown' ? 'meltdown' : s.fuelDamage > 0.001 ? 'damaged' : 'ok';
    s.integrity = { ...this.integrity };
    s.catastrophe = this.catastrophe;
    s.alarms = this.alarms.list;
    s.faults = this.faults.active;
    s.score = { ...this.score };
    // extras (additive contract)
    s.ext = {
      tavgProgramDeviation: s.tAvg - s.tRef,
      steamDumpsAvailable: this.vacuum > 22 && this.offsite,
      coreLevelPct: this.coreLevel * 100,
      rcsInventoryPct: ((this.ML + this.pzr.M) / this.nominalInventory) * 100,
      hydrogenKg: this.cont.h2 + this.rcsH2,
      siSignals: [...this.siSignals],
      rodStops: { ...this.rodStop },
      otdtSetpoint: this.otdtSetpoint * 1.8,
      opdtSetpoint: this.opdtSetpoint * 1.8,
      msivOpen: this.sg.map((g) => g.msivOpen),
      vctBoronPpm: this.vctBoron,
      fwIsolation: this.fwIsolation || this.fwRegClosedP4,
      clad: { maxTempF: cToF(Math.max(this.Tc[0], this.Tc[1])), oxidationPct: 100 * (0.7 * this.ox[0] + 0.3 * this.ox[1]) },
      prtRuptured: this.prtRuptured,
      shutdownMarginPcm: this.shutdownMargin(),
    };
  }
  nominalInventory = 260000;
  rcpEverRan = [true, true, true, true];
  mfpEverRan = [false, false];
  turbineWasOnline = false;
  srShutdownBaseline = 1e9;
  rcpWasRunning(i: number) { return this.rcpEverRan[i]; }
  mfpWasRunning(i: number) { return this.mfpEverRan[i]; }
  /** rod insertion limit as a control-bank sequence counter, vs power % */
  insertionLimit(prPct: number) { return 356 + 1.88 * clamp(prPct, 0, 100); }
  trackHistory() {
    for (let i = 0; i < 4; i++) if (this.rcpOn[i]) this.rcpEverRan[i] = true;
    for (let i = 0; i < 2; i++) if (this.mfpRunning[i]) this.mfpEverRan[i] = true;
    if (this.turb.latched) this.turbineWasOnline = true;
    if (this.reactorTripped) this.srShutdownBaseline = Math.min(this.srShutdownBaseline, this.kin.n * 1e11 + 0.5);
    else this.srShutdownBaseline = 1e9;
  }

  shutdownMargin(): number {
    // reactivity if all rods were inserted now (minus the most reactive rod: stuck rod assumption)
    let allIn = 0;
    for (const b of ROD_BANKS) allIn += bankRho(b, 0) - bankRho(b, this.rodPos[b]);
    return -(this.rho.total + allIn + 800 * (this.stuckRod ? 1 : 0));
  }

  blankState(): PlantState {
    const loops = [0, 1, 2, 3].map(() => ({
      rcpRunning: true, rcpSpeed: 1, flow: 100, tHot: 557, tCold: 557, sgLevel: 44, sgLevelWide: 60, sgPressure: 1092,
      feedFlow: 0, steamFlow: 0, feedValvePos: 0, auxFeedFlow: 0,
    }));
    return {
      t: 0, scenario: 'hot-standby', thermalPower: 0, neutronPower: 0, decayHeat: 0,
      sourceRangeCps: 0, intermediateRangeAmps: 1e-11, powerRangePct: 0, startupRateDpm: 0, periodSeconds: Infinity,
      neutronFlux: 0, axialOffset: 0,
      reactivity: { total: 0, rods: 0, boron: 0, doppler: 0, moderator: 0, xenon: 0, samarium: 0 }, keff: 1,
      rods: { SA: 0, SB: 0, CA: 0, CB: 0, CC: 0, CD: 0 }, rodsMoving: false, rodSpeedSpm: 0, droppedRods: 0, rodBottomLights: false,
      boronPpm: 0, xenonPcm: 0, iodine: 0, xenon: 0,
      fuelTempCenterline: 557, cladTemp: 557, tAvg: 557, tRef: 557, deltaT: 0, dnbr: 9.99, coreExitTemp: 557, subcoolingMargin: 0,
      rcsPressure: 2235, przLevel: 25, przLevelProgram: 25, przTemp: 653, przHeaterKW: 0, przSprayPos: 0, porvOpen: false,
      safetyValvesOpen: false, chargingFlowGpm: 0, letdownFlowGpm: 0, rcsLeakGpm: 0, loops,
      steamHeaderPressure: 1092, turbineSpeedRpm: 0, turbineLatched: false, turbineTripped: true, generatorBreakerClosed: false,
      grossMWe: 0, turbineLoadMW: 0, steamDumpDemand: 0, condenserVacuum: 28, mainFeedPumpsRunning: [false, false],
      auxFeedPumpsRunning: [false, false, false], reactorTripped: false, tripSignals: [], firstOut: null,
      permissives: { P6: false, P7: false, P8: false, P9: false, P10: false, P11: true }, siActuated: false, siFlowGpm: 0,
      accumulatorsInjected: false, containmentPressure: 0, containmentRadiation: 0.01, offsitePower: true,
      dieselGeneratorsRunning: [false, false], fuelDamage: 0, coreUncovered: false, coreStatus: 'ok',
      integrity: { rcs: 1, secondary: 1, containment: 1 }, catastrophe: null, alarms: [], faults: [],
      score: { mwhGenerated: 0, trips: 0, timeAtPowerS: 0 },
    } as PlantState;
  }
}

export type { ActiveFault };
