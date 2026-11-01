/**
 * Balance of plant and auxiliary systems: circulating water and condenser vacuum, condensate and
 * MFP suction, feedwater heaters, turbine warm-up/vibration, generator excitation and
 * synchronisation, house electrical loads, component cooling / service water, RCP bearings and
 * seals, letdown heat exchanger, and the CVCS batch integrator.
 *
 * Units here are mostly the board's units (°F, psig, in.Hg, mils, kV, MW) because nothing in this
 * file feeds back into the thermal-hydraulic integrals except through clear hooks
 * (vacuum, feedwater temperature, MFP trips, RCP seizure, seal leakage).
 */
import type { BopState, PlantControls } from './types';
import type { ReactorSim } from './ReactorSim';
import { cToF, tsat, GPM_TO_KGS } from './steam';
import { CL } from './plant';
import * as K from './plant';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (x: number, a: number, b: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const relax = (x: number, target: number, dt: number, tau: number) => x + (target - x) * Math.min(1, dt / Math.max(tau, 1e-6));

export type Lineup = 'cold' | 'partial' | 'full';

export function defaultBopControls(): Required<Pick<PlantControls,
  'circWaterPumps' | 'condenserAirRemoval' | 'condensatePumps' | 'feedwaterHeaters' | 'turbineSpeedSetpointRpm' |
  'turbineAccelRpmPerMin' | 'turningGear' | 'genVoltageSetpointKv' | 'sealInjectionGpm' | 'ccwPumps' |
  'serviceWaterPumps' | 'makeupBatchGallons' | 'sgArvSetpointPsig'>> {
  return {
    circWaterPumps: [true, true, true], condenserAirRemoval: 'sjae', condensatePumps: [true, true, true],
    feedwaterHeaters: true, turbineSpeedSetpointRpm: 1800, turbineAccelRpmPerMin: 200, turningGear: false,
    genVoltageSetpointKv: 22, sealInjectionGpm: 32, ccwPumps: [true, false], serviceWaterPumps: [true, false],
    makeupBatchGallons: 0, sgArvSetpointPsig: 1125,
  };
}

export class Bop {
  // condenser
  cwRunning = [true, true, true];
  hotwell = 50;
  // condensate / feed
  condRunning = [true, true, true];
  suctionPsig = 300;
  suctionLowTimer = [0, 0];
  // turbine
  rotorF = 550;
  bow = 0;
  bandDwell = 0;
  vib = 1;
  vibHighTimer = 0;
  diffExp = 0;
  // generator
  field = true;
  kv = 22;
  gridKv = 22;
  phase = 0;
  genDamage = 0;
  mvar = 0;
  house: 'SAT' | 'UAT' = 'UAT';
  houseMW = 0;
  // CCW / SW
  ccwRunning = [true, false];
  swRunning = [true, false];
  ccwF = 95;
  // RCP auxiliaries
  bearingF = [160, 160, 160, 160];
  sealF = [130, 130, 130, 130];
  sealLeak = [3, 3, 3, 3];
  sealHotTimer = [0, 0, 0, 0];
  sealFailed = [false, false, false, false];
  seized = [false, false, false, false];
  bearingHotTimer = [0, 0, 0, 0];
  ldHxF = 110;
  batch = { active: false, targetGal: 0, deliveredGal: 0 };

  constructor(private sim: ReactorSim) {}

  get c() { return this.sim.controls; }

  /** scenario lineup. 'full' = at power; 'partial' = low power; 'cold' = hot standby, secondary shut down */
  init(lineup: Lineup) {
    const c = this.c;
    Object.assign(c, defaultBopControls());
    this.batch = { active: false, targetGal: 0, deliveredGal: 0 };
    this.sealFailed = [false, false, false, false];
    this.seized = [false, false, false, false];
    this.sealHotTimer = [0, 0, 0, 0];
    this.bearingHotTimer = [0, 0, 0, 0];
    this.suctionLowTimer = [0, 0];
    this.genDamage = 0;
    this.bow = 0; this.bandDwell = 0; this.vibHighTimer = 0;
    this.phase = this.sim.rng.range(-180, 180);
    this.ccwF = 95; this.ldHxF = 110; this.hotwell = 50;
    this.bearingF = [160, 160, 160, 160];
    this.sealF = [130, 130, 130, 130];
    this.sealLeak = [3, 3, 3, 3];
    if (lineup === 'full') {
      this.field = true; this.house = 'UAT'; this.rotorF = cToF(tsat(this.sim.Ph));
      c.condensatePumps = [true, true, true];
    } else if (lineup === 'partial') {
      c.circWaterPumps = [true, true, false];
      c.condenserAirRemoval = 'sjae';
      c.condensatePumps = [true, true, false];
      c.turbineSpeedSetpointRpm = 0;
      c.turningGear = true;
      this.field = false; this.house = 'SAT'; this.rotorF = 320;
    } else {
      c.circWaterPumps = [false, false, false];
      c.condenserAirRemoval = 'off';
      c.condensatePumps = [false, false, false];
      c.feedwaterHeaters = false;
      c.turbineSpeedSetpointRpm = 0;
      c.turningGear = true;
      c.sgArvSetpointPsig = 1085;
      this.field = false; this.house = 'SAT'; this.rotorF = 200;
    }
    this.cwRunning = [...(c.circWaterPumps ?? [])];
    this.condRunning = [...(c.condensatePumps ?? [])];
    this.ccwRunning = [...(c.ccwPumps ?? [])];
    this.swRunning = [...(c.serviceWaterPumps ?? [])];
    this.sim.vacuum = lineup === 'cold' ? 0 : 28.3;
    this.kv = this.field ? 22 : 0;
  }

  nonSafetyPower() { return this.sim.offsite; }
  nCW() { return this.cwRunning.filter(Boolean).length; }
  nCond() { return this.condRunning.filter(Boolean).length; }
  ccwFlowFrac() { return this.sim.powerAvailable() ? Math.min(1, this.ccwRunning.filter(Boolean).length) : 0; }

  // ---------------------------------------------------------------- hooks used by ReactorSim
  /** condenser vacuum dynamics; `load` = steam to the condenser as a fraction of rated */
  stepVacuum(dt: number, load: number): number {
    const sim = this.sim;
    const n = this.nCW();
    const mode = this.c.condenserAirRemoval ?? 'sjae';
    const steamForSjae = sim.Ph > 1.0;
    const air = mode === 'hogging' ? 20.5 : mode === 'sjae' && steamForSjae ? 28.8 : 0;
    const L3 = n > 0 ? (load * 3) / n : 0;
    const cool = n > 0 ? 28.8 - 0.8 * L3 - 2.5 * Math.max(0, L3 - 1) ** 2 : load > 0.005 ? 0 : 29;
    const target = clamp(Math.min(air, cool), 0, 29);
    let v = sim.vacuum;
    if (target < v) v = relax(v, target, dt, n === 0 && load > 0.005 ? 12 : cool < v ? 40 : 600);
    else {
      // pull-down: hogging pumps are fast at low vacuum, ejectors are slow until vacuum is established
      const tau = mode === 'hogging' ? 420 : v < 18 ? 1800 : 180;
      v = relax(v, target, dt, tau);
    }
    sim.vacuum = v;
    return v;
  }
  /** C-9: condenser available for steam dumps */
  condenserAvailable() { return this.sim.vacuum > 22 && this.nCW() > 0; }

  feedTempTargetC(load: number): number {
    const tb = this.sim.turb;
    const extraction = tb.breaker && tb.wt > 0.08 * K.W_STEAM_RATED;
    const lp = 38 + 22 * Math.pow(clamp(load, 0, 1), 0.8); // condensate pump/LP drain heat only
    if (!(this.c.feedwaterHeaters ?? true) || !extraction) return lp;
    return 38 + 189 * Math.pow(clamp(load, 0, 1), 0.8);
  }

  mfpStartBlock(): string | null {
    if (this.nCond() === 0) return 'no condensate pump running (no suction pressure)';
    if (this.suctionPsig < 150) return `MFP suction pressure low (${this.suctionPsig.toFixed(0)} psig)`;
    return null;
  }

  /** extra (abnormal) RCP seal leakage, kg/s, leaving the RCS to containment */
  sealLossKgs(i: number) { return Math.max(0, this.sealLeak[i] - 3) * GPM_TO_KGS; }

  turbineVibTrip() { return this.vib >= 14; }

  // ---------------------------------------------------------------- operator actions
  press(b: string): boolean {
    const sim = this.sim;
    const tb = sim.turb;
    switch (b) {
      case 'GEN_FIELD_CLOSE':
        if (this.field) return true;
        if (tb.speed < 1700) { sim.msg(`Field breaker close blocked: turbine at ${tb.speed.toFixed(0)} rpm (need > 1700).`); return true; }
        if (this.genDamage >= 1) { sim.msg('Field breaker close blocked: generator stator damaged — out of service.'); return true; }
        this.field = true; sim.msg('Generator field breaker closed — AVR building terminal voltage.');
        return true;
      case 'GEN_FIELD_OPEN':
        if (!this.field) return true;
        if (tb.breaker) sim.openBreaker('Generator breaker opened on loss of field');
        this.field = false; sim.msg('Generator field breaker opened.');
        return true;
      case 'HOUSE_XFER_UAT':
        if (this.house === 'UAT') return true;
        if (!tb.breaker) { sim.msg('House load transfer blocked: generator not on line (UAT de-energised).'); return true; }
        this.house = 'UAT'; sim.msg('House loads transferred to the unit auxiliary transformers.');
        return true;
      case 'HOUSE_XFER_SAT':
        if (this.house === 'SAT') return true;
        if (!sim.offsite) { sim.msg('House load transfer blocked: startup transformer de-energised.'); return true; }
        this.house = 'SAT'; sim.msg('House loads transferred to the startup transformers.');
        return true;
      case 'MAKEUP_BATCH_START': {
        const c = this.c;
        if (c.makeupMode !== 'dilute' && c.makeupMode !== 'borate') { sim.msg('Batch start blocked: select MAKEUP DILUTE or BORATE first.'); return true; }
        const g = c.makeupBatchGallons ?? 0;
        if (g <= 0) { sim.msg('Batch start blocked: set the batch integrator (gallons) first.'); return true; }
        this.batch = { active: true, targetGal: g, deliveredGal: 0 };
        sim.msg(`${c.makeupMode === 'dilute' ? 'Dilution' : 'Boration'} batch of ${g.toFixed(0)} gal started at ${c.makeupRateGpm.toFixed(0)} gpm.`);
        return true;
      }
      case 'MAKEUP_BATCH_STOP':
        if (this.batch.active) { this.batch.active = false; this.c.makeupMode = 'auto'; sim.msg('Makeup batch stopped by operator; makeup returned to AUTO.'); }
        return true;
    }
    const m = /^MSIV_(OPEN|CLOSE)_(\d)$/.exec(b);
    if (m) {
      const i = +m[2];
      const s = sim.sg[i];
      if (!s) return true;
      if (m[1] === 'CLOSE') { if (s.msivOpen) { s.msivOpen = false; sim.msg(`MSIV ${i + 1} closed.`); } }
      else if (!s.msivOpen) {
        if (sim.siSignals.some((x) => /STEAM|CNMT/.test(x)) || sim.cont.P > 0.1 + 0.124) sim.msg(`MSIV ${i + 1} open blocked: steam line isolation signal present.`);
        else if (Math.abs(s.P - sim.Ph) > 0.7 && sim.sg.some((o, k) => k !== i && o.msivOpen)) sim.msg(`MSIV ${i + 1} open blocked: ΔP across valve ${((s.P - sim.Ph) * 145).toFixed(0)} psi — equalise first.`);
        else if (sim.faults.has('STEAM_LINE_BREAK', i)) sim.msg(`MSIV ${i + 1} open blocked: steam line ${i + 1} is faulted.`);
        else { s.msivOpen = true; sim.msg(`MSIV ${i + 1} opened.`); }
      }
      return true;
    }
    return false;
  }

  /** generator breaker close checks; returns true if the close was handled (accepted or rejected) */
  tryCloseBreaker(): 'ok' | 'blocked' | 'damaged' {
    const sim = this.sim;
    const tb = sim.turb;
    if (this.genDamage >= 1) { sim.msg('Breaker close blocked: generator damaged.'); return 'blocked'; }
    if (!this.field || this.kv < 5) { sim.msg('Breaker close blocked: generator not excited (close the FIELD BREAKER).'); return 'blocked'; }
    const dv = Math.abs(this.kv - this.gridKv) / this.gridKv;
    const ph = Math.abs(this.phase);
    if (ph <= 12 && dv <= 0.05) return 'ok';
    // out-of-phase / voltage-mismatched closure: torque transient, protective relays trip the unit
    let dmg = 0;
    if (ph > 12) dmg += clamp((ph - 12) / 150, 0, 1.2);
    if (dv > 0.05) dmg += clamp((dv - 0.05) * 4, 0, 0.5);
    this.genDamage = clamp(this.genDamage + dmg, 0, 1);
    this.vib = Math.max(this.vib, 6 + 20 * dmg);
    sim.integrity.secondary = Math.max(0, sim.integrity.secondary - 0.3 * dmg);
    sim.msg(`GENERATOR BREAKER CLOSED OUT OF SYNCHRONISM (${this.phase.toFixed(0)}°, ΔV ${(dv * 100).toFixed(1)} %) — ` +
      `violent torque transient, generator differential relay tripped the unit.${this.genDamage >= 1 ? ' Stator windings destroyed.' : ''}`);
    sim.emit({ type: 'breaker', closed: true });
    sim.emit({ type: 'breaker', closed: false });
    sim.tripTurbine('Turbine trip: generator protection (out-of-phase synchronisation)');
    this.field = false;
    return 'damaged';
  }

  onBreakerOpened() {
    if (this.house === 'UAT') {
      if (this.sim.offsite) { this.house = 'SAT'; this.sim.msg('House loads fast-transferred to the startup transformers.'); }
    }
  }

  // ---------------------------------------------------------------- integration
  step(dt: number) {
    const sim = this.sim;
    const c = this.c;
    const live = !sim.settling;
    const ns = this.nonSafetyPower();
    const tb = sim.turb;

    // ---- pumps follow switches when their bus is energised
    for (let i = 0; i < 3; i++) {
      const want = !!c.circWaterPumps?.[i];
      if (want && !this.cwRunning[i] && live && sim.faults.has('CIRC_WATER_PUMP_TRIP', i)) { c.circWaterPumps![i] = false; sim.msg(`CW pump ${i + 1} start blocked: motor tripped (fault).`); }
      this.cwRunning[i] = !!c.circWaterPumps?.[i] && ns;
      const wantC = !!c.condensatePumps?.[i];
      if (wantC && !this.condRunning[i] && live && sim.faults.has('CONDENSATE_PUMP_TRIP', i)) { c.condensatePumps![i] = false; sim.msg(`Condensate pump ${i + 1} start blocked: motor tripped (fault).`); }
      if (wantC && !this.condRunning[i] && live && this.hotwell < 8) { c.condensatePumps![i] = false; sim.msg(`Condensate pump ${i + 1} start blocked: hotwell level low.`); }
      this.condRunning[i] = !!c.condensatePumps?.[i] && ns;
    }
    const safe = sim.powerAvailable();
    for (let i = 0; i < 2; i++) {
      if (sim.siActuated && live) { if (c.ccwPumps) c.ccwPumps[i] = c.ccwPumps[i] || !sim.faults.has('CCW_PUMP_TRIP'); if (c.serviceWaterPumps) c.serviceWaterPumps[i] = true; }
      this.ccwRunning[i] = !!c.ccwPumps?.[i] && safe;
      this.swRunning[i] = !!c.serviceWaterPumps?.[i] && safe;
    }

    // ---- hotwell (auto makeup / reject limited to ±40 kg/s)
    let wFeed = 0;
    for (const s of sim.sg) wFeed += s.wFeed;
    const wCond = tb.wt + sim.dumpPos * K.C_DUMP * sim.Ph;
    const net = wCond - wFeed;
    const auto = clamp(-(this.hotwell - 50) * 4, -40, 40);
    this.hotwell = clamp(this.hotwell + ((net + auto) * dt) / 3000, 0, 100);
    if (live && this.hotwell < 5) {
      for (let i = 0; i < 3; i++) if (this.condRunning[i]) { c.condensatePumps![i] = false; this.condRunning[i] = false; sim.msg(`Condensate pump ${i + 1} tripped on low hotwell level.`); }
    }

    // ---- MFP suction
    const nC = this.nCond();
    const ff = wFeed / K.W_STEAM_RATED;
    this.suctionPsig = nC === 0 ? 0 : clamp(380 * (1 - (ff / (0.6 * nC)) ** 2), 0, 380);
    for (let i = 0; i < 2; i++) {
      if (sim.mfpRunning[i] && this.suctionPsig < 100) {
        this.suctionLowTimer[i] += dt;
        if (live && this.suctionLowTimer[i] > 15) {
          sim.mfpRunning[i] = false; c.mainFeedPumps[i] = false; this.suctionLowTimer[i] = 0;
          sim.msg(`Main feed pump ${'AB'[i]} tripped on low suction pressure (${this.suctionPsig.toFixed(0)} psig) — start another condensate pump.`);
        }
      } else this.suctionLowTimer[i] = 0;
    }

    // ---- turbine: turning gear, rotor warm-up, bow, vibration
    const spd = tb.speed;
    const sf = clamp(spd / 1800, 0, 1);
    const steamF = cToF(tsat(Math.max(sim.Ph, 0.1)));
    const rolling = tb.latched && !tb.tripped && spd > 30;
    if (rolling) this.rotorF = relax(this.rotorF, steamF, dt, 900 / (0.25 + 0.75 * sf + (tb.breaker ? 1 : 0)));
    else this.rotorF = relax(this.rotorF, 200, dt, 40000);
    const tgOn = !!c.turningGear && spd < 6 && (!tb.latched || tb.tripped);
    if (tgOn && spd < 3) tb.speed = Math.min(3, spd + dt);
    if (spd < 2 && !tgOn) this.bow = clamp(this.bow + dt / 2400, 0, 1);
    else if (tgOn) this.bow = clamp(this.bow - dt / 1800, 0, 1);
    else if (spd > 300) this.bow = clamp(this.bow - dt / 900, 0, 1);
    const stress = Math.max(0, steamF - this.rotorF) / 350;
    this.diffExp = clamp(100 * stress * (0.2 + 0.8 * sf), 0, 150);
    const inBand = spd > 1000 && spd < 1300;
    this.bandDwell = inBand ? this.bandDwell + dt : 0;
    let vibT = spd > 30 ? 0.8 + 0.6 * sf : 0.2;
    if (spd > 30) vibT += this.bow * 6 * (spd < 1000 ? 1 : 0.5);
    if (inBand) vibT += 2 + 10 * smooth(this.bandDwell, 30, 150);
    vibT += 12 * Math.max(0, this.diffExp / 100 - 0.3);
    vibT += (1 - sim.integrity.secondary) * 6 + this.genDamage * 4;
    this.vib = relax(this.vib, vibT, dt, 4);

    // ---- generator voltage / phase / reactive power
    this.gridKv = 22 + 0.25 * Math.sin(sim.t / 700) + 0.1 * Math.sin(sim.t / 97);
    const vset = clamp(c.genVoltageSetpointKv ?? 22, 18, 26);
    if (tb.breaker) {
      this.kv = relax(this.kv, this.gridKv + 0.05 * (vset - this.gridKv), dt, 1);
      this.mvar = 300 * (vset - this.gridKv);
      this.phase = 0;
    } else {
      const kvT = this.field ? vset * sf : 0.4 * sf;
      this.kv = relax(this.kv, kvT, dt, 3);
      this.mvar = 0;
      const slip = ((spd - 1800) / 1800) * 60;
      this.phase += 360 * slip * dt;
      this.phase = ((((this.phase + 180) % 360) + 360) % 360) - 180;
    }

    // ---- house loads
    let mw = 12;
    for (let i = 0; i < 4; i++) mw += 6.5 * sim.rcpSpeed[i] ** 3;
    for (let i = 0; i < 2; i++) mw += sim.mfpRunning[i] ? 7 : 0;
    mw += this.nCW() * 3.5 + nC * 1.2 + this.ccwRunning.filter(Boolean).length * 0.6 + this.swRunning.filter(Boolean).length * 0.8;
    mw += sim.heaterKW / 1000;
    this.houseMW = mw;

    // ---- CCW temperature
    const ccwFlow = this.ccwFlowFrac();
    const nSW = this.swRunning.filter(Boolean).length;
    let qIn = 8000; // misc loads, kW
    for (let i = 0; i < 4; i++) qIn += sim.rcpOn[i] ? 500 : 100;
    qIn += sim.letdownKgs * 4.2 * Math.max(0, (this.ldHxRegenOutF() - 115) / 1.8);
    const ua = ccwFlow > 0 ? 1100 * Math.sqrt(nSW) : 0;
    const tswF = 75;
    if (ccwFlow > 0) this.ccwF += ((qIn - ua * ((this.ccwF - tswF) / 1.8)) / 6e5) * 1.8 * dt;
    else this.ccwF = relax(this.ccwF, 110, dt, 3000);
    this.ccwF = clamp(this.ccwF, 60, 210);

    // ---- letdown HX outlet
    const ldT = ccwFlow > 0 ? this.ccwF + 15 : this.ldHxRegenOutF();
    this.ldHxF = relax(this.ldHxF, sim.letdownKgs > 0.1 ? ldT : this.ccwF, dt, 60);

    // ---- RCP bearings and seals
    const injPer = this.sealInjectionTotal() / 4;
    for (let i = 0; i < 4; i++) {
      const on = sim.rcpOn[i] || sim.rcpSpeed[i] > 0.2;
      const bT = on ? (ccwFlow > 0.3 ? 150 + 0.9 * (this.ccwF - 95) : 330) : ccwFlow > 0.3 ? 110 : 160;
      this.bearingF[i] = relax(this.bearingF[i], bT, dt, on ? 150 : 600);
      if (live && sim.rcpOn[i] && this.bearingF[i] > 230) {
        this.bearingHotTimer[i] += dt;
        if (this.bearingHotTimer[i] > 20 && !this.seized[i]) {
          this.seized[i] = true;
          sim.rcpOn[i] = false; sim.rcpSpeed[i] = 0;
          sim.msg(`RCP ${i + 1} BEARING FAILURE — shaft seized (locked rotor). Pump cannot be restarted.`);
        }
      } else this.bearingHotTimer[i] = 0;
      const tcF = cToF(sim.T[CL(i)]);
      const sT = injPer >= 5 ? 130 : ccwFlow > 0.3 ? 185 : tcF;
      this.sealF[i] = relax(this.sealF[i], sT, dt, 240);
      if (this.sealF[i] > 400) this.sealHotTimer[i] += dt; else this.sealHotTimer[i] = Math.max(0, this.sealHotTimer[i] - dt);
      if (live && !this.sealFailed[i] && this.sealHotTimer[i] > 300 && sim.P > 1) {
        this.sealFailed[i] = true;
        sim.msg(`RCP ${i + 1} #1 SEAL FAILURE — seal package overheated; reactor coolant leaking past the seals.`);
      }
      const dpScale = Math.sqrt(clamp(sim.P / 15.5, 0, 1.2));
      const leak = this.sealFailed[i] ? (sim.rcpOn[i] ? 180 : 70) * dpScale : (3 + Math.max(0, this.sealF[i] - 250) * 0.12) * dpScale;
      this.sealLeak[i] = leak;
    }

    // ---- makeup batch integrator
    if (this.batch.active) {
      if (c.makeupMode === 'dilute' || c.makeupMode === 'borate') {
        this.batch.deliveredGal += (clamp(c.makeupRateGpm, 0, 120) * dt) / 60;
        if (this.batch.deliveredGal >= this.batch.targetGal) {
          this.batch.active = false;
          c.makeupMode = 'auto';
          if (live) sim.msg(`Batch integrator complete: ${this.batch.targetGal.toFixed(0)} gal delivered — makeup returned to AUTO.`);
        }
      } else this.batch.active = false;
    }

    // ---- turbine vibration trip timer
    this.vibHighTimer = this.vib >= 14 ? this.vibHighTimer + dt : 0;
  }

  ldHxRegenOutF() { return cToF(this.sim.T[CL(K.LETDOWN_LOOP)]) - 270; }
  sealInjectionTotal() {
    const sim = this.sim;
    const avail = sim.powerAvailable() && sim.P < 18.6;
    return avail ? clamp(this.c.sealInjectionGpm ?? 32, 0, 40) : 0;
  }
  /** makeup flow permitted by the batch integrator */
  makeupAllowed(): boolean {
    const g = this.c.makeupBatchGallons ?? 0;
    return g <= 0 || this.batch.active;
  }

  publish(): BopState {
    const sim = this.sim;
    const tb = sim.turb;
    const c = this.c;
    const mwe = tb.mwe;
    const s = Math.hypot(mwe, this.mvar);
    const dgLoad = (i: number) => {
      if (sim.dgTimer[i] < 10) return 0;
      let kw = 600; // vital loads
      if (sim.afwRunning[i]) kw += 700;
      if (this.ccwRunning[i]) kw += 600;
      if (this.swRunning[i]) kw += 800;
      if (sim.siActuated) kw += 2200;
      if (!sim.offsite) kw += 300 + sim.heaterKW / 2;
      return clamp((kw / 6000) * 100, 0, 150);
    };
    return {
      circWaterRunning: [...this.cwRunning],
      condenserAirRemoval: c.condenserAirRemoval ?? 'sjae',
      hotwellLevelPct: this.hotwell,
      condensateRunning: [...this.condRunning],
      mfpSuctionPsig: this.suctionPsig,
      feedwaterTempF: cToF(sim.tFeed),
      feedwaterHeatersInService: !!c.feedwaterHeaters && tb.breaker && tb.wt > 0.08 * K.W_STEAM_RATED,
      turbine: {
        speedSetpointRpm: c.turbineSpeedSetpointRpm ?? 1800,
        rotorTempF: this.rotorF,
        steamInletTempF: cToF(tsat(Math.max(sim.Ph, 0.1))),
        diffExpansionPct: this.diffExp,
        vibrationMils: this.vib,
        eccentricityMils: this.bow * 6 + 0.5,
        turningGearEngaged: !!c.turningGear && tb.speed < 6 && (!tb.latched || tb.tripped),
        inCriticalBand: tb.speed > 1000 && tb.speed < 1300,
      },
      generator: {
        fieldBreakerClosed: this.field,
        terminalKv: this.kv,
        gridKv: this.gridKv,
        voltageSetpointKv: c.genVoltageSetpointKv ?? 22,
        slipHz: tb.breaker ? 0 : ((tb.speed - 1800) / 1800) * 60,
        syncPhaseDeg: this.phase,
        mvar: this.mvar,
        powerFactor: s > 1 ? mwe / s : 1,
        damage: this.genDamage,
        netMWe: tb.breaker ? mwe - this.houseMW : -this.houseMW,
      },
      electrical: {
        houseLoadsOn: this.house,
        houseLoadMW: this.houseMW,
        safetyBusesEnergised: [sim.offsite || sim.dgTimer[0] >= 10, sim.offsite || sim.dgTimer[1] >= 10],
        dieselLoadPct: [dgLoad(0), dgLoad(1)],
      },
      ccw: {
        pumpsRunning: [...this.ccwRunning],
        serviceWaterRunning: [...this.swRunning],
        supplyTempF: this.ccwF,
        flowPct: this.ccwRunning.filter(Boolean).length * 100 * (sim.powerAvailable() ? 1 : 0) / 1,
      },
      rcpAux: {
        bearingTempF: [...this.bearingF],
        sealTempF: [...this.sealF],
        sealLeakoffGpm: [...this.sealLeak],
        sealInjectionGpm: this.sealInjectionTotal(),
        seized: [...this.seized],
      },
      letdownHxOutletTempF: this.ldHxF,
      makeupBatch: { ...this.batch },
      sgArvSetpointPsig: c.sgArvSetpointPsig ?? 1125,
    };
  }
}
