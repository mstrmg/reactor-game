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

describe('balance of plant', () => {
  it('hot standby: full secondary lineup, turbine warm-up and in-phase synchronisation are reachable', async () => {
    const { scriptedStartup } = await import('./startupScript');
    const sim = new ReactorSim('hot-standby', 1);
    sim.randomFaults = false;
    // the secondary starts shut down
    expect(sim.state.bop!.circWaterRunning.some(Boolean)).toBe(false);
    expect(sim.state.condenserVacuum).toBeLessThan(1);
    expect(sim.state.mainFeedPumpsRunning.some(Boolean)).toBe(false);
    expect(sim.state.bop!.electrical.houseLoadsOn).toBe('SAT');
    const r = scriptedStartup(sim, 4 * 3600);
    expect(r).toBe('ok');
    const b = sim.state.bop!;
    expect(sim.state.generatorBreakerClosed).toBe(true);
    expect(b.generator.damage).toBe(0);
    expect(b.electrical.houseLoadsOn).toBe('UAT');
    expect(sim.state.reactorTripped).toBe(false);
    expect(sim.state.condenserVacuum).toBeGreaterThan(26);
    expect(sim.state.mainFeedPumpsRunning[0]).toBe(true);
  }, 120_000);

  it('closing the generator breaker out of phase damages and trips the generator', () => {
    const sim = new ReactorSim('low-power', 1);
    sim.randomFaults = false;
    sim.bop.rotorF = 545; // pretend the rotor is already warmed
    sim.controls.turbineAccelRpmPerMin = 350;
    sim.controls.turbineSpeedSetpointRpm = 1800;
    sim.press('TURBINE_LATCH');
    advance(sim, 420);
    expect(sim.state.turbineSpeedRpm).toBeGreaterThan(1795);
    sim.press('GEN_FIELD_CLOSE');
    sim.controls.genVoltageSetpointKv = sim.state.bop!.generator.gridKv;
    sim.controls.turbineSpeedSetpointRpm = 1802;
    advance(sim, 30);
    // wait for the synchroscope to be far from 12 o'clock
    advance(sim, 60, (s) => Math.abs(s.state.bop!.generator.syncPhaseDeg) > 120);
    expect(Math.abs(sim.state.bop!.generator.syncPhaseDeg)).toBeGreaterThan(100);
    sim.press('GEN_BREAKER_CLOSE');
    advance(sim, 5);
    expect(sim.state.bop!.generator.damage).toBeGreaterThan(0.5);
    expect(sim.state.generatorBreakerClosed).toBe(false);
    expect(sim.state.turbineTripped).toBe(true);
    expect(sim.state.alarms.some((a) => a.id === 'GEN_PROTECTION' && a.active)).toBe(true);
  }, 60_000);

  it('loss of component cooling water eventually fails an RCP bearing', () => {
    const sim = new ReactorSim('full-power', 1);
    sim.randomFaults = false;
    sim.injectFault('CCW_PUMP_TRIP');
    advance(sim, 60);
    expect(sim.state.alarms.some((a) => a.id === 'CCW_FLOW_LO' && a.active)).toBe(true);
    advance(sim, 1800, (s) => s.bop.seized.some(Boolean));
    expect(sim.bop.seized.some(Boolean)).toBe(true);
    advance(sim, 10);
    expect(sim.state.reactorTripped).toBe(true); // locked rotor → low flow trip
  }, 60_000);

  it('a dilution batch stops itself when the batch integrator is satisfied', () => {
    const sim = new ReactorSim('full-power', 1);
    sim.randomFaults = false;
    sim.controls.makeupBatchGallons = 100;
    sim.controls.makeupMode = 'dilute';
    sim.controls.makeupRateGpm = 60;
    advance(sim, 30);
    expect(sim.bop.batch.active).toBe(false); // not started: valves stay shut
    sim.press('MAKEUP_BATCH_START');
    expect(sim.bop.batch.active).toBe(true);
    advance(sim, 130);
    expect(sim.bop.batch.active).toBe(false);
    expect(sim.controls.makeupMode).toBe('auto');
    expect(sim.bop.batch.deliveredGal).toBeGreaterThanOrEqual(100);
  }, 60_000);

  it('every alarm has a fix guide', async () => {
    const { ALARM_HELP } = await import('./alarmHelp');
    const { ALARM_IDS } = await import('./alarms');
    for (const id of ALARM_IDS) {
      expect(ALARM_HELP[id], id).toBeDefined();
      expect(ALARM_HELP[id].actions.length).toBeGreaterThan(0);
    }
  });
});

describe('grid economics', () => {
  it('full power for an hour: revenue ≈ price × net MW × hours, no release, no emergency', () => {
    const sim = new ReactorSim('full-power', 2);
    sim.randomFaults = false;
    let expected = 0;
    advance(sim, 3605, (s) => {
      const net = s.economy.netMW();
      if (net > 0 && s.state.generatorBreakerClosed) expected += (net * s.state.grid!.pricePerMWh * 0.25) / 3600;
    });
    const g = sim.state.grid!;
    expect(g.revenue).toBeGreaterThan(20_000);
    expect(Math.abs(g.revenue - expected) / expected).toBeLessThan(0.02);
    expect(g.costs).toBeGreaterThan(0);
    expect(g.hourOfDay).toBeGreaterThan(7.9);
    expect(g.ledger.some((e) => e.label.startsWith('Energy sales') && e.amount > 0)).toBe(true);
    expect(g.frequencyHz).toBeGreaterThan(59.9);
    expect(g.frequencyHz).toBeLessThan(60.1);
    const r = sim.state.release!;
    expect(r.emergencyClass).toBe('none');
    expect(r.evacuationRadiusMi).toBe(0);
    expect(r.nobleGasCi + r.iodineCi + r.cesiumCi).toBeLessThan(1e-3);
    expect(r.siteBoundaryDoseRem).toBeLessThan(1e-6);
  }, 120_000);

  it('a reactor trip at load costs money and sags grid frequency, which then recovers', () => {
    const sim = new ReactorSim('full-power', 1);
    sim.randomFaults = false;
    advance(sim, 120);
    const cash0 = sim.state.grid!.cash;
    const money: number[] = [];
    sim.drainEvents();
    sim.press('REACTOR_TRIP');
    let fMin = 60;
    advance(sim, 30, (s) => { fMin = Math.min(fMin, s.state.grid!.frequencyHz); });
    for (const e of sim.drainEvents()) if (e.type === 'money') money.push(e.amount);
    expect(fMin).toBeLessThan(59.9);
    expect(money.some((a) => a <= -500_000)).toBe(true);
    expect(sim.state.grid!.ledger.some((e) => e.amount <= -500_000 && /trip/i.test(e.label))).toBe(true);
    expect(sim.state.grid!.cash).toBeLessThan(cash0 - 500_000);
    advance(sim, 300);
    expect(sim.state.grid!.frequencyHz).toBeGreaterThan(59.95);
  }, 60_000);

  it('the dispatcher issues a load request and it is met when the operator ramps to it', () => {
    const sim = new ReactorSim('full-power', 3);
    sim.randomFaults = false;
    advance(sim, 4000, (s) => !!s.state.grid!.dispatch);
    const r = sim.state.grid!.dispatch!;
    expect(r).toBeTruthy();
    expect(r.status).toBe('pending');
    expect(r.deadline - r.issuedAt).toBeGreaterThanOrEqual(600);
    expect(r.deadline - r.issuedAt).toBeLessThanOrEqual(1800);
    expect(r.reason.length).toBeGreaterThan(10);
    // operator: dial the target into the turbine load set, then trim on net MWe
    sim.controls.turbineRampRateMWpm = 50;
    sim.controls.turbineLoadSetpointMW = r.targetMW + sim.bop.houseMW;
    const cash0 = sim.state.grid!.cash;
    advance(sim, r.deadline - sim.t + 10, (s) => {
      if (!s.state.grid!.dispatch) return true;
      if (Math.abs(s.state.turbineLoadMW - s.controls.turbineLoadSetpointMW) < 1) s.controls.turbineLoadSetpointMW += 0.02 * (r.targetMW - s.economy.netMW());
    });
    const done = sim.state.grid!.dispatchHistory[0];
    expect(done.id).toBe(r.id);
    expect(done.status).toBe('met');
    expect(sim.state.reactorTripped).toBe(false);
    expect(sim.state.grid!.ledger.some((e) => e.label.startsWith(`Dispatch #${r.id} met`) && e.amount === r.bonus)).toBe(true);
    expect(sim.state.grid!.cash).toBeGreaterThan(cash0);
  }, 120_000);
});

describe('radiological release', () => {
  it('station blackout with a small LOCA melts the core: general emergency, dose off site, release keeps evolving', () => {
    const sim = new ReactorSim('full-power', 3);
    sim.randomFaults = false;
    (sim as unknown as { dgReady: () => boolean }).dgReady = () => false;
    sim.injectFault('LOSS_OF_OFFSITE_POWER');
    (sim as unknown as { offsiteRestoreAt: number }).offsiteRestoreAt = -1;
    sim.injectFault('SMALL_LOCA', 1);
    sim.faults.locaArea = 0.005;
    const classes: string[] = [];
    advance(sim, 3600, (s) => {
      for (const e of s.drainEvents()) if (e.type === 'emergency-class') classes.push(e.level);
      return s.state.release!.emergencyClass === 'general-emergency';
    });
    const r1 = { ...sim.state.release! };
    expect(r1.emergencyClass).toBe('general-emergency');
    expect(classes).toContain('general-emergency');
    expect(r1.evacuationRadiusMi).toBeGreaterThanOrEqual(5);
    expect(sim.state.fuelDamage).toBeGreaterThan(0.05);
    expect(r1.containmentCi).toBeGreaterThan(1e5);
    advance(sim, 600);
    const r2 = { ...sim.state.release! };
    expect(r2.siteBoundaryDoseRem).toBeGreaterThan(0);
    expect(r2.siteBoundaryDoseRem).toBeGreaterThan(r1.siteBoundaryDoseRem);
    expect(r2.tenMileDoseRem).toBeGreaterThan(0);
    expect(r2.nobleGasCi).toBeGreaterThan(r1.nobleGasCi);
    expect(Number.isFinite(sim.state.rcsPressure)).toBe(true);
    // the containment then fails: the sim keeps running and the release escalates
    sim.integrity.containment = 0;
    sim.setCatastrophe('containment-failure', 'test');
    advance(sim, 300);
    const r3 = sim.state.release!;
    expect(r3.pathway).toBe('containment-failure');
    expect(r3.rateCiPerS).toBeGreaterThan(r2.rateCiPerS * 10);
    expect(r3.nobleGasCi).toBeGreaterThan(r2.nobleGasCi);
    expect(r3.evacuationRadiusMi).toBe(10);
    expect(Number.isFinite(r3.siteBoundaryDoseRem)).toBe(true);
  }, 180_000);

  it('a steam generator tube rupture releases activity by bypassing containment', () => {
    const sim = new ReactorSim('full-power', 1);
    sim.randomFaults = false;
    sim.injectFault('SG_TUBE_LEAK', 1);
    sim.faults.tubeLeakArea = 3.5e-4;
    const seen = new Set<string>();
    advance(sim, 1800, (s) => { seen.add(s.state.release!.pathway); });
    const r = sim.state.release!;
    expect(seen.has('sg-tube-steam') || seen.has('vent')).toBe(true);
    expect(r.nobleGasCi).toBeGreaterThan(0.01);
    expect(r.siteBoundaryDoseRem).toBeGreaterThan(0);
    expect(['unusual-event', 'alert', 'site-area-emergency', 'general-emergency']).toContain(r.emergencyClass);
  }, 120_000);
});
