/** Dev-only harness: a fake sim so the UI/audio can be exercised before the
 *  real sim lands. Open /src/ui/dev/dev.html. Not imported by the game. */
import type { PlantState, PlantControls, ReactorSimApi, SimEvent, ScenarioId, ButtonId } from '../../sim/types';
import { createUI } from '../index';
import { createAudio } from '../../audio';
import { bus } from '../../core/bus';

function mkState(): PlantState {
  const loop = () => ({ rcpRunning: true, rcpSpeed: 1, flow: 100, tHot: 618, tCold: 558, sgLevel: 50, sgLevelWide: 70, sgPressure: 1000, feedFlow: 100, steamFlow: 100, feedValvePos: 0.7, auxFeedFlow: 0 });
  return {
    t: 0, scenario: 'hot-standby', thermalPower: 0.004, neutronPower: 1e-9, decayHeat: 0.004,
    sourceRangeCps: 120, intermediateRangeAmps: 1e-11, powerRangePct: 0, startupRateDpm: 0, periodSeconds: Infinity,
    neutronFlux: 3e4, axialOffset: -2,
    reactivity: { total: -6000, rods: -7000, boron: -1200, doppler: 0, moderator: 0, xenon: 0, samarium: -800 },
    keff: 0.95, rods: { SA: 0, SB: 0, CA: 0, CB: 0, CC: 0, CD: 0 }, rodsMoving: false, rodSpeedSpm: 0, droppedRods: 0, rodBottomLights: false,
    boronPpm: 1200, xenonPcm: 0, iodine: 0, xenon: 0,
    fuelTempCenterline: 560, cladTemp: 558, tAvg: 557, tRef: 557, deltaT: 0, dnbr: Infinity, coreExitTemp: 558, subcoolingMargin: 90,
    rcsPressure: 2235, przLevel: 25, przLevelProgram: 25, przTemp: 653, przHeaterKW: 200, przSprayPos: 0, porvOpen: false, safetyValvesOpen: false,
    chargingFlowGpm: 87, letdownFlowGpm: 75, rcsLeakGpm: 0, loops: [loop(), loop(), loop(), loop()],
    steamHeaderPressure: 1092, turbineSpeedRpm: 0, turbineLatched: false, turbineTripped: true, generatorBreakerClosed: false, grossMWe: 0,
    turbineLoadMW: 0, steamDumpDemand: 0.05, condenserVacuum: 28, mainFeedPumpsRunning: [false, false], auxFeedPumpsRunning: [true, false, false],
    reactorTripped: true, tripSignals: [], firstOut: null, permissives: { P6: false, P7: false, P8: false, P9: false, P10: false, P11: true },
    siActuated: false, siFlowGpm: 0, accumulatorsInjected: false, containmentPressure: 0, containmentRadiation: 0.01, offsitePower: true,
    dieselGeneratorsRunning: [false, false], fuelDamage: 0, coreUncovered: false, coreStatus: 'ok',
    integrity: { rcs: 1, secondary: 1, containment: 1 }, catastrophe: null, alarms: [], faults: [],
    score: { mwhGenerated: 0, trips: 0, timeAtPowerS: 0 },
  };
}

class MockSim implements ReactorSimApi {
  state = mkState();
  controls: PlantControls = {
    rodMode: 'manual', rodBankSelect: 'SA', rodMotion: 0, makeupMode: 'auto', makeupRateGpm: 0, chargingFlowDemand: 50, chargingMode: 'auto',
    letdownIsolated: false, przHeaters: 'auto', przSprayMode: 'auto', przSprayDemand: 0, porvMode: 'auto', porvBlockValveOpen: true,
    feedMode: ['auto', 'auto', 'auto', 'auto'], feedValveDemand: [0, 0, 0, 0], mainFeedPumps: [false, false], auxFeedPumps: ['auto', 'auto', 'auto'],
    turbineLoadSetpointMW: 0, turbineRampRateMWpm: 5, steamDumpMode: 'tavg', steamDumpPressureSetpoint: 1092, siBlocked: false, timeScale: 1, paused: false,
  };
  randomFaults = true;
  ev: SimEvent[] = [];
  update(dt: number) {
    const s = this.state;
    const d = dt * this.controls.timeScale;
    s.t += d;
    // slow fake approach to criticality via SA withdraw
    if (!s.reactorTripped) {
      for (const b of ['SA', 'SB', 'CA', 'CB'] as const) {
        if (s.rods[b] < 228) { const before = Math.floor(s.rods[b]); s.rods[b] = Math.min(228, s.rods[b] + d * 1.2); if (Math.floor(s.rods[b]) > before) this.ev.push({ type: 'rod-step', bank: b, dir: 1 }); break; }
      }
      s.keff = 0.95 + 0.05 * (s.rods.SA + s.rods.SB + s.rods.CA + s.rods.CB * 0.5) / (228 * 3.5);
      s.sourceRangeCps = Math.min(1e5, 120 / Math.max(0.002, 1 - s.keff));
      s.startupRateDpm = s.keff > 0.999 ? 0.4 : 0.02;
    }
  }
  press(b: ButtonId) {
    if (b === 'TRIP_RESET') { this.state.reactorTripped = false; this.ev.push({ type: 'message', text: 'Reactor trip breakers closed' }); }
    if (b === 'ALARM_ACK') this.state.alarms.forEach((a) => (a.acknowledged = true));
    if (b === 'REACTOR_TRIP') this.trip();
  }
  trip() {
    const s = this.state; s.reactorTripped = true; s.firstOut = 'PZR_PRESS_LO'; s.score.trips++;
    const a = { id: 'RX_TRIP', label: 'REACTOR TRIP', severity: 'trip' as const, active: true, acknowledged: false, time: s.t };
    s.alarms.push(a); this.ev.push({ type: 'alarm', alarm: a }, { type: 'trip', reason: 'PZR_PRESS_LO' });
  }
  drainEvents() { const e = this.ev; this.ev = []; return e; }
  reset(sc: ScenarioId) { this.state = mkState(); this.state.scenario = sc; }
  injectFault() {}
}

const sim = new MockSim();
const ui = createUI(document.getElementById('ui-root')!, sim);
const audio = createAudio(sim);
bus.on('press', (b) => sim.press(b));
bus.on('start-game', ({ scenario, randomFaults }) => { sim.reset(scenario); sim.randomFaults = randomFaults; sim.controls.paused = false; void audio.start(); });
bus.on('pause-changed', (p) => { sim.controls.paused = p; });
(window as any).__game = { sim, ui, audio, bus };
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!sim.controls.paused) sim.update(dt);
  for (const e of sim.drainEvents()) bus.emit('sim', e);
  ui.update(dt); audio.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
