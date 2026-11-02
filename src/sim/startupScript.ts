/**
 * Scripted "good operator" startup from hot standby to the generator on line. Used by the tests
 * (and handy for debugging); not used by the game itself.
 */
import type { ReactorSim } from './ReactorSim';

export interface StartupLog { t: number; step: string }

export function scriptedStartup(sim: ReactorSim, maxSeconds = 4 * 3600, log: (l: StartupLog) => void = () => {}): string {
  const c = sim.controls;
  let phase = 'secondary';
  const say = (s: string) => log({ t: sim.t, step: s });
  c.rodBankSelect = 'MANUAL_SEQ';
  c.rodMode = 'manual';
  c.circWaterPumps = [true, true, true];
  c.condenserAirRemoval = 'hogging';
  say('CW pumps started, hogging pumps on');
  let nTarget = 3e-4; // IR ~ 6e-8 A
  const steps = Math.round(maxSeconds / 0.05);
  for (let k = 0; k < steps; k++) {
    sim.step(0.05);
    if (k % 10 !== 0) continue;
    sim.publish();
    const s = sim.state;
    const b = s.bop!;
    if (s.reactorTripped || b.generator.damage > 0) return 'failed: ' + (s.firstOut ?? 'generator damage');
    // ---- reactor power controller (manual rods, gentle): keep SUR modest, approach nTarget
    if (!sim.turb.breaker || s.grossMWe < 150) {
      const n = s.neutronPower;
      if (n < nTarget * 0.8) c.rodMotion = s.startupRateDpm < 0.6 ? 1 : s.startupRateDpm > 1.0 ? -1 : 0;
      else if (n > nTarget * 1.2) c.rodMotion = s.startupRateDpm > -0.3 ? -1 : 0;
      else c.rodMotion = s.startupRateDpm > 0.15 ? -1 : s.startupRateDpm < -0.15 ? 1 : 0;
      if (sim.turb.breaker) {
        // on line: hold Tavg near Tref with rods (auto above C-5, 15 % turbine load)
        const dev = s.tAvg - s.tRef;
        c.rodMotion = s.startupRateDpm > 0.8 ? 0 : dev > 0.5 ? -1 : dev < -0.5 ? 1 : 0;
      }
    }
    if (sim.turb.breaker && s.grossMWe > 0.16 * 1150 && c.rodMode !== 'auto') {
      c.rodMode = 'auto';
      say('rods to AUTO above C-5');
    }
    // ---- secondary lineup
    if (c.condenserAirRemoval === 'hogging' && s.condenserVacuum > 19) { c.condenserAirRemoval = 'sjae'; say('SJAEs in service'); }
    if (phase === 'secondary' && s.condenserVacuum > 24) {
      c.sgArvSetpointPsig = 1125;
      c.condensatePumps = [true, true, false];
      phase = 'feed';
      say('vacuum established; ARVs reset to 1125; condensate pumps started');
    }
    if (phase === 'feed' && b.mfpSuctionPsig > 250) {
      c.mainFeedPumps = [true, false];
      phase = 'afw';
      say('MFP A started');
    }
    if (phase === 'afw' && s.mainFeedPumpsRunning[0] && sim.t > 60) {
      c.auxFeedPumps = ['off', 'off', 'off'];
      phase = 'heatup';
      nTarget = 0.04;
      say('AFW secured, raising power to ~4 %');
    }
    if (phase === 'heatup' && s.thermalPower > 0.03) {
      c.auxFeedPumps = ['auto', 'auto', 'auto'];
      c.turningGear = true;
      c.turbineAccelRpmPerMin = 200;
      c.turbineSpeedSetpointRpm = 500;
      sim.press('TURBINE_LATCH');
      nTarget = 0.07;
      phase = 'soak';
      say('turbine latched, rolling to 500 rpm for warm-up');
    }
    if (phase === 'soak' && s.turbineSpeedRpm > 490 && b.turbine.rotorTempF > b.turbine.steamInletTempF - 120) {
      c.turbineAccelRpmPerMin = 350;
      c.turbineSpeedSetpointRpm = 1800;
      phase = 'roll';
      say('rotor warm, rolling to 1800 rpm');
    }
    if (phase === 'roll' && s.turbineSpeedRpm > 1795) {
      sim.press('GEN_FIELD_CLOSE');
      c.genVoltageSetpointKv = b.generator.gridKv;
      c.turbineSpeedSetpointRpm = 1801.5;
      phase = 'sync';
      say('field closed, matching voltage, speed slightly high for a slow synchroscope');
    }
    if (phase === 'sync') {
      c.genVoltageSetpointKv = b.generator.gridKv;
      if (Math.abs(b.generator.terminalKv - b.generator.gridKv) < 0.3 && Math.abs(b.generator.syncPhaseDeg) < 4) {
        sim.press('GEN_BREAKER_CLOSE');
        if (sim.turb.breaker) {
          sim.press('HOUSE_XFER_UAT');
          c.feedwaterHeaters = true;
          c.steamDumpMode = 'tavg';
          c.turbineLoadSetpointMW = 120;
          c.turbineRampRateMWpm = 5;
          phase = 'load';
          say('synchronised, house loads to UAT, loading to 120 MW');
        }
      }
    }
    if (phase === 'load' && s.grossMWe > 110) { say('on line at ' + s.grossMWe.toFixed(0) + ' MWe'); return 'ok'; }
  }
  return 'timeout in phase ' + phase;
}
