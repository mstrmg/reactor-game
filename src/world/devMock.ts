/**
 * DEV ONLY: a crude mock of ReactorSimApi so the world can be developed and
 * screenshotted before/without the real sim. Not used by the game.
 */
import type { Alarm, ButtonId, FaultId, PlantControls, PlantState, ReactorSimApi, ScenarioId, SimEvent } from '../sim/types';

export class MockSim implements ReactorSimApi {
  state: PlantState;
  controls: PlantControls;
  randomFaults = false;
  private events: SimEvent[] = [];
  constructor(scenario: ScenarioId = 'full-power') {
    this.controls = {
      rodMode: 'manual',
      rodBankSelect: 'CD',
      rodMotion: 0,
      makeupMode: 'auto',
      makeupRateGpm: 20,
      chargingFlowDemand: 50,
      chargingMode: 'auto',
      letdownIsolated: false,
      przHeaters: 'auto',
      przSprayMode: 'auto',
      przSprayDemand: 0,
      porvMode: 'auto',
      porvBlockValveOpen: true,
      feedMode: ['auto', 'auto', 'auto', 'auto'],
      feedValveDemand: [0.5, 0.5, 0.5, 0.5],
      mainFeedPumps: [true, true],
      auxFeedPumps: ['auto', 'auto', 'auto'],
      turbineLoadSetpointMW: 1150,
      turbineRampRateMWpm: 10,
      steamDumpMode: 'tavg',
      steamDumpPressureSetpoint: 1092,
      siBlocked: false,
      timeScale: 1,
      paused: false,
    };
    this.state = this.make(scenario);
  }
  private make(scenario: ScenarioId): PlantState {
    const loop = () => ({ rcpRunning: true, rcpSpeed: 1, flow: 100, tHot: 618, tCold: 558, sgLevel: 50, sgLevelWide: 62, sgPressure: 985, feedFlow: 100, steamFlow: 100, feedValvePos: 0.62, auxFeedFlow: 0 });
    const alarms: Alarm[] = [
      { id: 'PZR_PRESS_HI', label: 'PZR PRESS HI', severity: 'alarm', active: false, acknowledged: true, time: 0 },
      { id: 'PZR_LEVEL_DEV', label: 'PZR LEVEL DEVIATION', severity: 'warning', active: true, acknowledged: false, time: 3 },
      { id: 'SG_A_LEVEL_LO', label: 'SG A LEVEL LO', severity: 'warning', active: true, acknowledged: true, time: 4 },
      { id: 'ROD_INSERTION_LIMIT', label: 'ROD BANK LO INSERTION LIMIT', severity: 'alarm', active: false, acknowledged: false, time: 5 },
      { id: 'TURB_VIB', label: 'TURBINE VIBRATION HI', severity: 'info', active: true, acknowledged: true, time: 1 },
      { id: 'CTMT_RAD_HI', label: 'CTMT RAD HI', severity: 'alarm', active: false, acknowledged: true, time: 0 },
      { id: 'RX_TRIP', label: 'REACTOR TRIP', severity: 'trip', active: false, acknowledged: true, time: 0 },
      { id: 'SR_HI_FLUX', label: 'SR HI FLUX AT SHUTDOWN', severity: 'trip', active: false, acknowledged: true, time: 0 },
      { id: 'BORON_DILUTION', label: 'BORON DILUTION IN PROGRESS', severity: 'info', active: false, acknowledged: true, time: 0 },
      { id: 'FW_FLOW_MISMATCH', label: 'FEED/STEAM FLOW MISMATCH', severity: 'warning', active: false, acknowledged: true, time: 0 },
      { id: 'RCP_VIB', label: 'RCP 2 VIBRATION HI', severity: 'warning', active: true, acknowledged: false, time: 6 },
    ];
    return {
      t: 0,
      scenario,
      thermalPower: 1,
      neutronPower: 1,
      decayHeat: 0.065,
      sourceRangeCps: 0,
      intermediateRangeAmps: 3e-4,
      powerRangePct: 100,
      startupRateDpm: 0,
      periodSeconds: Infinity,
      neutronFlux: 3e13,
      axialOffset: -3,
      reactivity: { total: 0, rods: -150, boron: -1300, doppler: -1100, moderator: -900, xenon: -2700, samarium: -800 },
      keff: 1.0,
      rods: { SA: 228, SB: 228, CA: 228, CB: 228, CC: 228, CD: 200 },
      rodsMoving: false,
      rodSpeedSpm: 0,
      droppedRods: 0,
      rodBottomLights: false,
      boronPpm: 1050,
      xenonPcm: -2700,
      iodine: 1,
      xenon: 1,
      fuelTempCenterline: 2100,
      cladTemp: 650,
      tAvg: 588,
      tRef: 588,
      deltaT: 60,
      dnbr: 2.1,
      coreExitTemp: 622,
      subcoolingMargin: 30,
      rcsPressure: 2235,
      przLevel: 60,
      przLevelProgram: 60,
      przTemp: 652.7,
      przHeaterKW: 300,
      przSprayPos: 0.05,
      porvOpen: false,
      safetyValvesOpen: false,
      chargingFlowGpm: 87,
      letdownFlowGpm: 75,
      rcsLeakGpm: 0.1,
      loops: [loop(), loop(), loop(), loop()],
      steamHeaderPressure: 985,
      turbineSpeedRpm: 1800,
      turbineLatched: true,
      turbineTripped: false,
      generatorBreakerClosed: true,
      grossMWe: 1150,
      turbineLoadMW: 1150,
      steamDumpDemand: 0,
      condenserVacuum: 28,
      mainFeedPumpsRunning: [true, true],
      auxFeedPumpsRunning: [false, false, false],
      reactorTripped: false,
      tripSignals: [],
      firstOut: null,
      permissives: { P6: true, P7: true, P8: true, P9: true, P10: true, P11: false },
      siActuated: false,
      siFlowGpm: 0,
      accumulatorsInjected: false,
      containmentPressure: 0.3,
      containmentRadiation: 0.05,
      offsitePower: true,
      dieselGeneratorsRunning: [false, false],
      fuelDamage: 0,
      coreUncovered: false,
      coreStatus: 'ok',
      integrity: { rcs: 1, secondary: 1, containment: 1 },
      catastrophe: null,
      alarms,
      faults: [],
      score: { mwhGenerated: 0, trips: 0, timeAtPowerS: 0 },
    };
  }
  update(dt: number): void {
    const s = this.state;
    const c = this.controls;
    const sdt = dt * c.timeScale;
    s.t += sdt;
    // rods
    if (c.rodMotion !== 0 && c.rodBankSelect !== 'MANUAL_SEQ' && !s.reactorTripped) {
      s.rods[c.rodBankSelect] = Math.max(0, Math.min(228, s.rods[c.rodBankSelect] + c.rodMotion * 72 * (sdt / 60)));
      s.rodsMoving = true;
      s.rodSpeedSpm = 72;
    } else {
      s.rodsMoving = false;
      s.rodSpeedSpm = 0;
    }
    if (s.reactorTripped) for (const b of Object.keys(s.rods) as (keyof typeof s.rods)[]) s.rods[b] = Math.max(0, s.rods[b] - 300 * sdt);
    const rodFrac = (s.rods.CD + s.rods.CC) / 456;
    const target = s.reactorTripped ? 1e-8 : Math.max(1e-8, 0.4 + 0.65 * rodFrac + (c.makeupMode === 'dilute' ? 0.05 : 0));
    s.neutronPower += (target - s.neutronPower) * Math.min(1, sdt * 0.3);
    s.thermalPower = s.neutronPower * 0.93 + s.decayHeat;
    s.powerRangePct = s.neutronPower * 100 + Math.sin(s.t * 3) * 0.2;
    s.intermediateRangeAmps = Math.max(1e-11, 3e-4 * s.neutronPower);
    s.sourceRangeCps = s.neutronPower < 1e-5 ? 1e6 * s.neutronPower * 1e5 : 0;
    s.neutronFlux = 3e13 * s.neutronPower;
    s.startupRateDpm = (target > s.neutronPower ? 0.3 : -0.3) * Math.min(1, Math.abs(target - s.neutronPower) * 10);
    s.tAvg = 557 + 31 * s.thermalPower + Math.sin(s.t * 0.4) * 0.3;
    s.tRef = 557 + 31 * (c.turbineLoadSetpointMW / 1150);
    for (const l of s.loops) {
      l.tHot = s.tAvg + 30 * s.thermalPower;
      l.tCold = s.tAvg - 30 * s.thermalPower;
      l.steamFlow = 100 * s.thermalPower;
      l.feedFlow = l.steamFlow + Math.sin(s.t) * 1.5;
    }
    s.deltaT = 60 * s.thermalPower;
    s.rcsPressure = 2235 + Math.sin(s.t * 0.2) * 6;
    s.grossMWe = s.generatorBreakerClosed ? 1150 * Math.min(1, s.thermalPower) : 0;
    s.reactivity.rods = -150 - (228 - s.rods.CD) * 4;
    s.reactivity.total = (target - s.neutronPower) * 100;
    s.keff = 1 + s.reactivity.total * 1e-5;
    s.periodSeconds = Math.abs(s.reactivity.total) < 0.5 ? Infinity : 80 / (s.reactivity.total / 100);
    s.permissives.P10 = s.powerRangePct > 10;
    s.alarms[1].active = Math.sin(s.t * 0.3) > 0;
  }
  press(b: ButtonId): void {
    const s = this.state;
    if (b === 'REACTOR_TRIP') {
      s.reactorTripped = true;
      s.firstOut = 'MANUAL';
      s.tripSignals = ['MANUAL'];
      s.alarms[6].active = true;
      s.alarms[6].acknowledged = false;
      this.events.push({ type: 'trip', reason: 'MANUAL' });
    } else if (b === 'TRIP_RESET') {
      s.reactorTripped = false;
      s.firstOut = null;
      s.tripSignals = [];
    } else if (b === 'ALARM_ACK') for (const a of s.alarms) a.acknowledged = true;
    else if (b === 'ALARM_RESET') s.alarms = s.alarms.filter((a) => a.active || !a.acknowledged).concat(s.alarms.filter((a) => !a.active && a.acknowledged));
    else if (b === 'GEN_BREAKER_OPEN') s.generatorBreakerClosed = false;
    else if (b === 'GEN_BREAKER_CLOSE') s.generatorBreakerClosed = true;
    else if (b.startsWith('RCP_STOP_')) s.loops[+b.slice(-1)].rcpRunning = false;
    else if (b.startsWith('RCP_START_')) s.loops[+b.slice(-1)].rcpRunning = true;
  }
  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
  reset(scenario: ScenarioId): void {
    this.state = this.make(scenario);
  }
  injectFault(_id: FaultId): void {}
  /** dev helper: force a catastrophe look */
  catastrophe(): void {
    this.state.catastrophe = { kind: 'steam-explosion', t: this.state.t, description: 'mock' };
    this.state.coreStatus = 'meltdown';
    this.events.push({ type: 'catastrophe', kind: 'steam-explosion' });
  }
}
