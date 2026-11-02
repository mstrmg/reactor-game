/**
 * Annunciator logic. Each window has a condition evaluated against the published PlantState.
 *  - condition comes in   -> window lit, flashing (acknowledged=false), 'alarm' event (horn)
 *  - ALARM_ACK            -> all lit windows acknowledged (steady)
 *  - condition clears     -> window stays lit (active=false) until ALARM_RESET
 *  - ALARM_RESET          -> acknowledged windows whose condition has cleared go dark
 *  - condition returns before reset -> re-flash
 */
import type { Alarm, AlarmSeverity, PlantState } from './types';
import type { ReactorSim } from './ReactorSim';
import { W_STEAM_RATED } from './plant';

interface AlarmDef {
  id: string;
  label: string;
  severity: AlarmSeverity;
  cond: (s: PlantState, sim: ReactorSim) => boolean;
}

const sgDefs: AlarmDef[] = [];
for (let i = 0; i < 4; i++) {
  const n = i + 1;
  sgDefs.push(
    { id: `SG${n}_LEVEL_LO`, label: `SG ${n} LEVEL LO`, severity: 'warning', cond: (s) => s.loops[i].sgLevel < 30 },
    { id: `SG${n}_LEVEL_LOLO`, label: `SG ${n} LEVEL LO-LO`, severity: 'trip', cond: (s) => s.loops[i].sgLevel < 17 },
    { id: `SG${n}_LEVEL_HI`, label: `SG ${n} LEVEL HI`, severity: 'warning', cond: (s) => s.loops[i].sgLevel > 60 },
    { id: `SG${n}_LEVEL_HIHI`, label: `SG ${n} LEVEL HI-HI`, severity: 'alarm', cond: (s) => s.loops[i].sgLevel >= 78 },
    {
      id: `SG${n}_FLOW_MISMATCH`, label: `SG ${n} STM/FW MISMATCH`, severity: 'warning',
      cond: (s) => s.loops[i].steamFlow > 5 && Math.abs(s.loops[i].steamFlow - s.loops[i].feedFlow) > 12,
    },
    { id: `RCP${n}_TRIP`, label: `RCP ${n} TRIP`, severity: 'alarm', cond: (s, sim) => !s.loops[i].rcpRunning && sim.spec.id !== undefined && sim.rcpWasRunning(i) },
    { id: `RCP${n}_BRG_TEMP`, label: `RCP ${n} BEARING TEMP HI`, severity: 'alarm', cond: (_s, sim) => sim.bop.bearingF[i] > 195 },
    { id: `RCP${n}_SEAL`, label: `RCP ${n} SEAL LEAKOFF HI`, severity: 'alarm', cond: (_s, sim) => sim.bop.sealLeak[i] > 6 || sim.bop.sealF[i] > 235 },
    { id: `LOOP${n}_FLOW_LO`, label: `RCS LOOP ${n} FLOW LO`, severity: 'alarm', cond: (s) => s.loops[i].flow < 90 },
  );
}

const DEFS: AlarmDef[] = [
  { id: 'RX_TRIP', label: 'REACTOR TRIP', severity: 'trip', cond: (s) => s.reactorTripped },
  { id: 'TURB_TRIP', label: 'TURBINE TRIP', severity: 'alarm', cond: (s, sim) => s.turbineTripped && sim.turbineWasOnline },
  { id: 'SI_ACT', label: 'SAFETY INJECTION', severity: 'trip', cond: (s) => s.siActuated },
  { id: 'PZR_PRESS_HI', label: 'PZR PRESS HI', severity: 'alarm', cond: (s) => s.rcsPressure > 2310 },
  { id: 'PZR_PRESS_LO', label: 'PZR PRESS LO', severity: 'alarm', cond: (s) => s.rcsPressure < 2185 },
  { id: 'PZR_PRESS_LOLO', label: 'PZR PRESS LO SI', severity: 'trip', cond: (s) => s.rcsPressure < 1807 },
  { id: 'PZR_LEVEL_HI', label: 'PZR LEVEL HI', severity: 'alarm', cond: (s) => s.przLevel > 70 },
  { id: 'PZR_LEVEL_LO', label: 'PZR LEVEL LO', severity: 'alarm', cond: (s) => s.przLevel < 17 },
  { id: 'PZR_LEVEL_DEV', label: 'PZR LEVEL DEV', severity: 'warning', cond: (s) => Math.abs(s.przLevel - s.przLevelProgram) > 5 },
  { id: 'PZR_PORV_OPEN', label: 'PZR PORV OPEN', severity: 'alarm', cond: (s) => s.porvOpen },
  { id: 'PZR_SAFETY_OPEN', label: 'PZR SAFETY VLV OPEN', severity: 'trip', cond: (s) => s.safetyValvesOpen },
  { id: 'PRT_HI', label: 'PRT PRESS/TEMP HI', severity: 'alarm', cond: (s, sim) => sim.prtEnergy > 2e6 || sim.prtRuptured },
  { id: 'PZR_HTR_OFF', label: 'PZR HEATERS OFF', severity: 'warning', cond: (s, sim) => sim.controls.przHeaters === 'off' && s.rcsPressure < 2220 },
  { id: 'TAVG_TREF_DEV', label: 'TAVG/TREF DEVIATION', severity: 'warning', cond: (s) => Math.abs(s.tAvg - s.tRef) > 5 && s.thermalPower > 0.03 },
  { id: 'TAVG_LOLO', label: 'TAVG LO-LO P-12', severity: 'warning', cond: (s) => s.tAvg < 553 },
  { id: 'OTDT_STOP', label: 'OT/OP DT ROD STOP', severity: 'alarm', cond: (_s, sim) => sim.rodStop.C3 || sim.rodStop.C4 },
  { id: 'IR_ROD_STOP', label: 'IR ROD STOP C-1', severity: 'warning', cond: (_s, sim) => sim.rodStop.C1 },
  { id: 'PR_ROD_STOP', label: 'PR HI FLUX ROD STOP', severity: 'warning', cond: (_s, sim) => sim.rodStop.C2 },
  { id: 'PR_HI', label: 'PR HIGH FLUX', severity: 'alarm', cond: (s) => s.powerRangePct > 103 },
  { id: 'SUR_HI', label: 'STARTUP RATE HI', severity: 'alarm', cond: (s) => s.startupRateDpm > 1.5 && !s.permissives.P10 },
  { id: 'SR_HI_SHUTDOWN', label: 'SR HI FLUX AT SHUTDN', severity: 'alarm', cond: (s, sim) => s.reactorTripped && s.sourceRangeCps > sim.srShutdownBaseline * 3 + 50 },
  { id: 'PR_CHANNEL_DEV', label: 'PR CHANNEL DEVIATION', severity: 'warning', cond: (_s, sim) => Math.abs(sim.faults.prBias()) > 2 },
  { id: 'AXIAL_FLUX', label: 'AXIAL FLUX DEVIATION', severity: 'warning', cond: (s) => s.powerRangePct > 50 && (s.axialOffset < -14 || s.axialOffset > 8) },
  { id: 'ROD_BOTTOM', label: 'ROD AT BOTTOM', severity: 'alarm', cond: (s) => s.rodBottomLights },
  { id: 'ROD_DEV', label: 'ROD DEVIATION', severity: 'alarm', cond: (_s, sim) => !!sim.stuckRod && Math.abs(sim.rodPos[sim.stuckRod.bank] - sim.stuckRod.pos) > 12 },
  { id: 'RIL_LO', label: 'ROD INSERTION LIM LO', severity: 'warning', cond: (s, sim) => !s.reactorTripped && s.powerRangePct > 5 && sim.rodSeq < sim.insertionLimit(s.powerRangePct) + 10 },
  { id: 'RIL_LOLO', label: 'ROD INSERT LIM LO-LO', severity: 'alarm', cond: (s, sim) => !s.reactorTripped && s.powerRangePct > 5 && sim.rodSeq < sim.insertionLimit(s.powerRangePct) },
  { id: 'SDM_LO', label: 'SHUTDOWN MARGIN LO', severity: 'alarm', cond: (s) => (s.ext?.shutdownMarginPcm ?? 9999) < 1300 && s.reactorTripped },
  { id: 'BORON_DILUTION', label: 'BORON DILUTION', severity: 'info', cond: (_s, sim) => sim.controls.makeupMode === 'dilute' && sim.controls.makeupRateGpm > 0 },
  { id: 'CHG_FLOW', label: 'CHARGING FLOW HI/LO', severity: 'warning', cond: (s, sim) => !s.siActuated && sim.powerAvailable() && (s.chargingFlowGpm > 140 || s.chargingFlowGpm < 25) },
  { id: 'LETDOWN_ISOL', label: 'LETDOWN ISOLATED', severity: 'warning', cond: (s) => s.letdownFlowGpm < 1 },
  { id: 'RCS_LEAK', label: 'RCS LEAKAGE HI', severity: 'alarm', cond: (s, sim) => s.rcsLeakGpm > 1 || (sim.reliefKgs > 0.5 && !s.porvOpen && !s.safetyValvesOpen) },
  { id: 'SUBCOOL_LO', label: 'SUBCOOLING MARGIN LO', severity: 'alarm', cond: (s) => s.subcoolingMargin < 30 },
  { id: 'CET_HI', label: 'CORE EXIT TEMP HI', severity: 'alarm', cond: (s) => s.coreExitTemp > 660 },
  { id: 'INADEQ_CORE_COOL', label: 'INADEQ CORE COOLING', severity: 'trip', cond: (s) => s.coreExitTemp > 1200 || s.coreUncovered },
  { id: 'DNBR_LO', label: 'DNBR LO', severity: 'alarm', cond: (s) => s.dnbr < 1.5 },
  { id: 'FUEL_FAILURE', label: 'LETDOWN RAD HI FUEL', severity: 'trip', cond: (s) => s.fuelDamage > 0.001 },
  { id: 'CNMT_PRESS_HI', label: 'CNMT PRESS HI', severity: 'alarm', cond: (s) => s.containmentPressure > 1.5 },
  { id: 'CNMT_RAD_HI', label: 'CNMT RAD HI', severity: 'alarm', cond: (s) => s.containmentRadiation > 1 },
  { id: 'CNMT_SPRAY', label: 'CNMT SPRAY ACTUATED', severity: 'trip', cond: (_s, sim) => sim.cont.sprays },
  { id: 'H2_HI', label: 'CNMT HYDROGEN HI', severity: 'alarm', cond: (_s, sim) => sim.cont.h2 > 200 },
  { id: 'MS_RAD_HI', label: 'MAIN STEAM RAD HI', severity: 'alarm', cond: (_s, sim) => sim.tubeLeakKgs > 0.02 },
  { id: 'STEAMLINE_P_LO', label: 'STEAMLINE PRESS LO', severity: 'alarm', cond: (s) => s.loops.some((l) => l.sgPressure < 800) },
  { id: 'MSIV_CLOSED', label: 'MSIV CLOSED', severity: 'alarm', cond: (s) => !!s.ext && s.ext.msivOpen.some((o) => !o) },
  { id: 'SG_PORV_OPEN', label: 'SG PORV/SAFETY OPEN', severity: 'warning', cond: (_s, sim) => sim.sg.some((g) => g.svOpen || (g.wArv > 1 && sim.bop.condenserAvailable())) },
  { id: 'MFP_TRIP', label: 'MAIN FEED PUMP TRIP', severity: 'alarm', cond: (s, sim) => s.mainFeedPumpsRunning.some((r, i) => !r && sim.mfpWasRunning(i)) },
  { id: 'FW_ISOL', label: 'FEEDWATER ISOLATION', severity: 'alarm', cond: (s) => !!s.ext?.fwIsolation },
  { id: 'AFW_RUNNING', label: 'AUX FEED PUMP RUNNING', severity: 'info', cond: (s) => s.auxFeedPumpsRunning.some((r) => r) },
  { id: 'STEAM_DUMP', label: 'STEAM DUMP ARMED/OPEN', severity: 'info', cond: (s) => s.steamDumpDemand > 0.02 },
  { id: 'COND_VAC_LO', label: 'CONDENSER VACUUM LO', severity: 'alarm', cond: (s) => s.condenserVacuum < 24 },
  { id: 'GEN_OVERSPEED', label: 'TURBINE OVERSPEED', severity: 'alarm', cond: (s) => s.turbineSpeedRpm > 1854 },
  { id: 'TURB_VIB', label: 'TURBINE VIBRATION HI', severity: 'alarm', cond: (s, sim) => s.integrity.secondary < 0.9 || sim.bop.vib > 7 },
  { id: 'SG_CARRYOVER', label: 'SG MOISTURE CARRYOVER', severity: 'alarm', cond: (_s, sim) => sim.sg.some((g) => g.carry > 0) },
  { id: 'LOOP', label: 'LOSS OF OFFSITE POWER', severity: 'trip', cond: (s) => !s.offsitePower },
  { id: 'DG_RUNNING', label: 'DIESEL GEN RUNNING', severity: 'info', cond: (s) => s.dieselGeneratorsRunning.some((r) => r) },
  { id: 'ACCUM_INJ', label: 'ACCUMULATOR INJECTING', severity: 'alarm', cond: (_s, sim) => sim.accum.some((a) => !a.isolated && a.water < 23900 && a.water > 0) },
  { id: 'RCS_OVERPRESS', label: 'RCS OVERPRESSURE', severity: 'trip', cond: (s) => s.rcsPressure > 2735 },
  { id: 'VESSEL_LEVEL_LO', label: 'RVLIS LEVEL LO', severity: 'alarm', cond: (s) => (s.ext?.coreLevelPct ?? 100) < 99.5 || (s.ext?.rcsInventoryPct ?? 100) < 75 },
  // ---- balance of plant / auxiliaries
  { id: 'CW_FLOW_LO', label: 'CIRC WATER FLOW LO', severity: 'alarm', cond: (_s, sim) => (sim.bop.nCW() < 2 && sim.turb.wt > 0.3 * W_STEAM_RATED) || (sim.bop.nCW() === 0 && sim.vacuum > 5) },
  { id: 'HOTWELL_LEVEL', label: 'HOTWELL LEVEL HI/LO', severity: 'warning', cond: (_s, sim) => sim.bop.hotwell < 20 || sim.bop.hotwell > 80 },
  { id: 'MFP_SUCTION_LO', label: 'MFP SUCTION PRESS LO', severity: 'alarm', cond: (_s, sim) => sim.mfpRunning.some(Boolean) && sim.bop.suctionPsig < 200 },
  { id: 'FW_HTRS_OOS', label: 'FW HEATERS OUT OF SVC', severity: 'warning', cond: (_s, sim) => sim.turb.breaker && sim.turb.wt > 0.2 * W_STEAM_RATED && !sim.controls.feedwaterHeaters },
  { id: 'TURB_ECCENTRIC', label: 'ROTOR ECCENTRICITY HI', severity: 'warning', cond: (_s, sim) => sim.bop.bow > 0.4 },
  { id: 'TURB_DIFF_EXP', label: 'TURB DIFF EXPANSION HI', severity: 'alarm', cond: (_s, sim) => sim.bop.diffExp > 60 },
  { id: 'TURB_CRIT_SPEED', label: 'TURB AT CRITICAL SPEED', severity: 'warning', cond: (_s, sim) => sim.bop.bandDwell > 20 },
  { id: 'TURN_GEAR_OFF', label: 'TURNING GEAR DISENGAGED', severity: 'warning', cond: (_s, sim) => sim.turb.speed < 2 && !sim.controls.turningGear },
  { id: 'GEN_FIELD_OFF', label: 'GEN FIELD BREAKER OPEN', severity: 'info', cond: (_s, sim) => sim.turb.speed > 1700 && !sim.bop.field },
  { id: 'GEN_PROTECTION', label: 'GENERATOR PROTECT TRIP', severity: 'trip', cond: (_s, sim) => sim.bop.genDamage > 0 },
  { id: 'GEN_MVAR', label: 'GEN MVAR LIMIT', severity: 'warning', cond: (_s, sim) => sim.turb.breaker && Math.abs(sim.bop.mvar) > 450 },
  { id: 'HOUSE_ON_SAT', label: 'AUX LOADS ON SAT', severity: 'warning', cond: (_s, sim) => sim.turb.breaker && sim.turb.mwe > 150 && sim.bop.house === 'SAT' },
  { id: 'CCW_FLOW_LO', label: 'CCW FLOW LO', severity: 'alarm', cond: (_s, sim) => sim.bop.ccwFlowFrac() < 0.3 },
  { id: 'CCW_TEMP_HI', label: 'CCW TEMP HI', severity: 'alarm', cond: (_s, sim) => sim.bop.ccwF > 105 },
  { id: 'SW_FLOW_LO', label: 'SERVICE WATER FLOW LO', severity: 'alarm', cond: (_s, sim) => !sim.bop.swRunning.some(Boolean) },
  { id: 'SEAL_INJ_LO', label: 'SEAL INJECTION FLOW LO', severity: 'alarm', cond: (_s, sim) => sim.bop.sealInjectionTotal() < 20 && sim.rcpOn.some(Boolean) },
  { id: 'LD_HX_TEMP_HI', label: 'LETDOWN HX OUT TEMP HI', severity: 'warning', cond: (_s, sim) => sim.bop.ldHxF > 145 },
  { id: 'MAKEUP_BATCH', label: 'MAKEUP BATCH IN PROG', severity: 'info', cond: (_s, sim) => sim.bop.batch.active },
  { id: 'DG_OVERLOAD', label: 'DIESEL GEN OVERLOAD', severity: 'alarm', cond: (s) => (s.bop?.electrical.dieselLoadPct ?? [0]).some((x) => x > 100) },
  { id: 'P6', label: 'P-6 IR ABOVE 1E-10', severity: 'info', cond: (s) => s.permissives.P6 },
  { id: 'P10', label: 'P-10 PR ABOVE 10%', severity: 'info', cond: (s) => s.permissives.P10 },
  { id: 'SI_BLOCKED', label: 'SI BLOCKED (P-11)', severity: 'info', cond: (_s, sim) => sim.controls.siBlocked },
  ...sgDefs,
];

export class AlarmManager {
  list: Alarm[] = [];
  private byId = new Map<string, Alarm>();

  update(sim: ReactorSim, initial: boolean) {
    const s = sim.state;
    for (const d of DEFS) {
      let on = false;
      try { on = d.cond(s, sim); } catch { on = false; }
      let a = this.byId.get(d.id);
      if (on) {
        if (!a) {
          a = { id: d.id, label: d.label, severity: d.severity, active: true, acknowledged: initial, time: s.t };
          this.byId.set(d.id, a);
          this.list.push(a);
          if (!initial) sim.emit({ type: 'alarm', alarm: { ...a } });
        } else if (!a.active) {
          a.active = true;
          a.acknowledged = initial;
          a.time = s.t;
          if (!initial) sim.emit({ type: 'alarm', alarm: { ...a } });
        }
      } else if (a) a.active = false;
    }
  }
  ack() { for (const a of this.list) a.acknowledged = true; }
  reset() {
    this.list = this.list.filter((a) => a.active || !a.acknowledged);
    this.byId = new Map(this.list.map((a) => [a.id, a]));
  }
}

export const ALARM_IDS = DEFS.map((d) => d.id);
export const ALARM_LABELS = Object.fromEntries(DEFS.map((d) => [d.id, d.label]));
