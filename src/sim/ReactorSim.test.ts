import { describe, it, expect } from 'vitest';
import { ReactorSim } from './ReactorSim';
import type { ScenarioId } from './types';
import { describeTrip, describeFault } from './describe';
import { ALARM_LABELS } from './alarms';

/** advance the simulation by `seconds` of plant time with the internal fixed step */
function advance(sim: ReactorSim, seconds: number, each?: (sim: ReactorSim) => boolean | void) {
  const n = Math.round(seconds / 0.05);
  for (let i = 0; i < n; i++) {
    sim.step(0.05);
    if (each && i % 5 === 0) {
      sim.publish();
      if (each(sim) === true) break;
    }
  }
  sim.publish();
}

const SCEN: ScenarioId[] = ['hot-standby', 'low-power', 'full-power', 'xenon-challenge'];

describe('scenarios start in a true steady state', () => {
  for (const id of SCEN) {
    it(`${id}: 10 sim-minutes without a trip or drift`, () => {
      const sim = new ReactorSim(id, 1);
      sim.randomFaults = false;
      const s0 = { ...sim.state };
      advance(sim, 600);
      const s = sim.state;
      expect(s.reactorTripped).toBe(false);
      expect(s.siActuated).toBe(false);
      expect(Math.abs(s.tAvg - s0.tAvg)).toBeLessThan(2.5);
      expect(Math.abs(s.rcsPressure - s0.rcsPressure)).toBeLessThan(40);
      expect(Math.abs(s.przLevel - s0.przLevel)).toBeLessThan(5);
      for (let i = 0; i < 4; i++) expect(Math.abs(s.loops[i].sgLevel - s0.loops[i].sgLevel)).toBeLessThan(6);
      if (id === 'hot-standby') {
        expect(s.neutronPower).toBeLessThan(1e-6);
        expect(s.sourceRangeCps).toBeGreaterThan(5);
      } else {
        expect(Math.abs(s.thermalPower - s0.thermalPower)).toBeLessThan(0.03);
      }
      if (id === 'full-power') {
        expect(s.grossMWe).toBeGreaterThan(1100);
        expect(s.thermalPower).toBeGreaterThan(0.97);
      }
    }, 60_000);
  }
});

describe('reactor trip', () => {
  it('manual trip from full power drops neutron power below 5 % within seconds; decay heat remains', () => {
    const sim = new ReactorSim('full-power', 1);
    sim.randomFaults = false;
    sim.press('REACTOR_TRIP');
    advance(sim, 6);
    expect(sim.state.reactorTripped).toBe(true);
    expect(sim.state.firstOut).toBe('MANUAL');
    expect(sim.state.neutronPower).toBeLessThan(0.05);
    // decay heat: ~6 % just after shutdown, falling to ~1–2 % after an hour
    expect(sim.state.decayHeat).toBeGreaterThan(0.03);
    advance(sim, 3600);
    expect(sim.state.decayHeat).toBeGreaterThan(0.007);
    expect(sim.state.decayHeat).toBeLessThan(0.025);
    expect(sim.state.neutronPower).toBeLessThan(1e-6);
    // AFW and dumps hold the plant near no-load temperature
    expect(sim.state.tAvg).toBeGreaterThan(540);
    expect(sim.state.tAvg).toBeLessThan(575);
    expect(sim.state.fuelDamage).toBe(0);
  }, 60_000);
});

describe('startup', () => {
  it('withdrawing control banks from hot standby reaches criticality', () => {
    const sim = new ReactorSim('hot-standby', 1);
    sim.randomFaults = false;
    sim.controls.rodBankSelect = 'MANUAL_SEQ';
    let critical = false;
    advance(sim, 3600, (s) => {
      const st = s.state;
      // withdraw while the startup rate is low; hold once a positive period is established
      s.controls.rodMotion = st.startupRateDpm < 0.5 ? 1 : 0;
      if (st.reactivity.total > 0 && st.startupRateDpm > 0.3 && st.intermediateRangeAmps > 1e-10) {
        critical = true;
        return true;
      }
    });
    expect(critical).toBe(true);
    expect(sim.state.reactorTripped).toBe(false);
    // estimated critical position: control bank D somewhere around 130 steps
    expect(sim.state.rods.CD).toBeGreaterThan(40);
    expect(sim.state.rods.CD).toBeLessThan(228);
  }, 60_000);
});

describe('emergent accidents', () => {
  it('stuck-open PORV eventually causes safety injection', () => {
    const sim = new ReactorSim('full-power', 1);
    sim.randomFaults = false;
    sim.injectFault('PZR_PORV_STUCK_OPEN');
    advance(sim, 3600, (s) => s.state.siActuated);
    expect(sim.state.siActuated).toBe(true);
    expect(sim.state.reactorTripped).toBe(true);
  }, 60_000);

  it('loss of all feedwater with no AFW eventually damages the fuel', () => {
    const sim = new ReactorSim('full-power', 1);
    sim.randomFaults = false;
    sim.controls.auxFeedPumps = ['off', 'off', 'off'];
    sim.injectFault('MFP_TRIP', 0);
    sim.injectFault('MFP_TRIP', 1);
    advance(sim, 4 * 3600, (s) => s.state.fuelDamage > 0.01);
    expect(sim.state.fuelDamage).toBeGreaterThan(0.01);
    expect(Number.isFinite(sim.state.cladTemp)).toBe(true);
  }, 120_000);
});

describe('numerical robustness', () => {
  it('no NaN at timeScale 30 through a full-power trip transient', () => {
    const sim = new ReactorSim('full-power', 7);
    sim.randomFaults = true;
    sim.controls.timeScale = 30;
    let bad = '';
    const check = () => {
      const s = sim.state as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(s)) if (typeof v === 'number' && Number.isNaN(v)) bad = k;
      for (const l of sim.state.loops) for (const [k, v] of Object.entries(l)) if (typeof v === 'number' && !Number.isFinite(v)) bad = 'loop.' + k;
    };
    for (let i = 0; i < 600; i++) {
      // 1/30 s real frames → 1 s plant time each
      sim.update(1 / 30);
      if (i === 120) sim.press('REACTOR_TRIP');
      check();
      if (bad) break;
    }
    expect(bad).toBe('');
    expect(sim.state.t).toBeGreaterThan(590);
  }, 60_000);
});

describe('descriptions and labels', () => {
  it('describes trips/faults and keeps alarm labels short', () => {
    expect(describeTrip('OTDT').length).toBeGreaterThan(10);
    expect(describeFault('SMALL_LOCA').length).toBeGreaterThan(10);
    for (const label of Object.values(ALARM_LABELS) as string[]) {
      expect(label.length).toBeLessThanOrEqual(24);
      expect(label).toBe(label.toUpperCase());
    }
  });
});
