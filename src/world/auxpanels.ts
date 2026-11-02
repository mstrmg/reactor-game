/**
 * Working hardware on the four auxiliary cabinets that close the horseshoe ends:
 *   left  (next to SAFETY & ELECTRICAL): ELECTRICAL DISTRIBUTION, COMPONENT COOLING / SERVICE WATER
 *   right (next to TURBINE / GENERATOR): CIRC WATER / CONDENSER VACUUM, CONDENSATE / FW HEATERS
 * Each cabinet face is a flat pseudo-section: u = metres from the cabinet centre, v = height above floor.
 */
import type { PlantControls, PlantState, ReactorSimApi } from '../sim/types';
import { PanelKit, Section } from './panel';
import { fmt } from './util';

const RUN = ['STOP', 'RUN'];
/** write one element of an optional boolean array control, creating it if the sim has not */
function setArr(c: PlantControls, key: 'circWaterPumps' | 'condensatePumps' | 'ccwPumps' | 'serviceWaterPumps', n: number, i: number, on: boolean): void {
  const cur = c[key];
  const arr = Array.isArray(cur) ? cur : new Array<boolean>(n).fill(false);
  arr[i] = on;
  c[key] = arr;
}
const getArr = (c: PlantControls, key: 'circWaterPumps' | 'condensatePumps' | 'ccwPumps' | 'serviceWaterPumps', i: number): number => (c[key]?.[i] ? 1 : 0);

export function buildAuxPanels(kit: PanelKit, sim: ReactorSimApi, panels: Section[]): void {
  const C = () => sim.controls;
  const [EL, CC, CW, CD] = panels;
  if (!EL || !CC || !CW || !CD) return;
  const ABC = ['A', 'B', 'C'];
  // common rows (heights above the floor)
  const yMeter = 1.78;
  const yLamp = 1.5;
  const ySw = 1.22;
  const yNote = 1.03;

  /* ============ ELECTRICAL DISTRIBUTION ============ */
  {
    const P = EL;
    kit.groupBox(P, 'v', -0.56, 1.1, 0.0, 1.95, 'AUX (HOUSE) LOAD SUPPLY');
    kit.meter(P, 'v', -0.4, yMeter, { title: 'HOUSE LOAD', unit: 'MW', min: 0, max: 100, ticks: [0, 25, 50, 75, 100], get: (s) => s.bop?.electrical.houseLoadMW ?? 0, fmt: (v) => v.toFixed(1) });
    kit.readout(P, 'v', -0.16, 1.82, { title: 'NET MWE', get: (s) => fmt(s.bop?.generator.netMWe ?? 0, 0), color: 'green', unit: 'MWe', w: 0.11 });
    kit.readout(P, 'v', -0.16, 1.68, { title: 'HOUSE LOAD MW', get: (s) => fmt(s.bop?.electrical.houseLoadMW ?? 0, 1), unit: 'MW', w: 0.11 });
    kit.lamp(P, 'v', -0.46, yLamp, { title: 'ON STARTUP\nXFMR (SAT)', hover: 'HOUSE LOADS ON STARTUP TRANSFORMER (offsite)', color: 'white', get: (s) => (s.bop?.electrical.houseLoadsOn ?? 'SAT') === 'SAT' });
    kit.lamp(P, 'v', -0.32, yLamp, { title: 'ON UNIT AUX\nXFMR (UAT)', hover: 'HOUSE LOADS ON UNIT AUXILIARY TRANSFORMER (generator)', color: 'white', get: (s) => s.bop?.electrical.houseLoadsOn === 'UAT' });
    kit.lamp(P, 'v', -0.18, yLamp, { title: 'OFFSITE PWR\nAVAILABLE', color: 'green', get: (s) => s.offsitePower });
    kit.lamp(P, 'v', -0.05, yLamp, { title: 'GEN BKR\nCLOSED', color: 'red', get: (s) => s.generatorBreakerClosed });
    kit.button(P, 'v', -0.4, ySw, { id: 'HOUSE_XFER_SAT', title: 'XFER TO SAT', hover: 'HOUSE LOAD TRANSFER TO STARTUP XFMR (SAT)', press: 'HOUSE_XFER_SAT', color: 0x1c1c1c, lamp: (s) => (s.bop?.electrical.houseLoadsOn ?? 'SAT') === 'SAT', lampColor: 'white' });
    kit.button(P, 'v', -0.16, ySw, { id: 'HOUSE_XFER_UAT', title: 'XFER TO UAT', hover: 'HOUSE LOAD TRANSFER TO UNIT AUX XFMR (UAT, needs gen on line)', press: 'HOUSE_XFER_UAT', color: 0x8c1a14, lamp: (s) => s.bop?.electrical.houseLoadsOn === 'UAT', lampColor: 'white' });

    kit.groupBox(P, 'v', 0.06, 1.1, 0.56, 1.95, 'EMERGENCY DIESELS / SAFETY BUSES');
    for (let i = 0; i < 2; i++) {
      const u = 0.19 + i * 0.24;
      kit.meter(P, 'v', u, yMeter, { title: `DG ${ABC[i]} LOAD`, unit: '% RATED', min: 0, max: 150, ticks: [0, 50, 100, 150], get: (s) => s.bop?.electrical.dieselLoadPct[i] ?? 0, zones: [[100, 150, '#c82020']], fmt: (v) => v.toFixed(0) });
      kit.lamp(P, 'v', u - 0.06, yLamp, { title: `DG ${ABC[i]}\nRUNNING`, color: 'red', get: (s) => !!s.dieselGeneratorsRunning?.[i] });
      kit.lamp(P, 'v', u + 0.06, yLamp, { title: `SAFETY BUS\n${ABC[i]} ENERG`, hover: `SAFETY BUS ${ABC[i]} ENERGIZED`, color: 'white', get: (s) => !!s.bop?.electrical.safetyBusesEnergised[i] });
      kit.readout(P, 'v', u, ySw + 0.02, { title: `DG ${ABC[i]} LOAD %`, get: (s) => fmt(s.bop?.electrical.dieselLoadPct[i] ?? 0, 0), color: 'amber', unit: '%', w: 0.11 });
    }
    kit.label(P, 'v', 0, yNote, 'XFER TO UAT ONLY WITH GEN BKR CLOSED · GEN TRIP = AUTO FAST XFER TO SAT · DIESELS CARRY SAFETY BUSES ON LOSS OF OFFSITE PWR', 1.1, 0.036, 'black');
  }

  /* ============ COMPONENT COOLING / SERVICE WATER ============ */
  {
    const P = CC;
    kit.groupBox(P, 'v', -0.56, 1.1, 0.0, 1.95, 'COMPONENT COOLING WATER (CCW)');
    kit.meter(P, 'v', -0.4, yMeter, { title: 'CCW SUPPLY TEMP', unit: '°F', min: 50, max: 200, ticks: [50, 100, 150, 200], get: (s) => s.bop?.ccw.supplyTempF ?? 0, zones: [[105, 200, '#e0b020']], fmt: (v) => v.toFixed(0) });
    kit.meter(P, 'v', -0.17, yMeter, { title: 'CCW FLOW', unit: '% NORMAL', min: 0, max: 200, ticks: [0, 50, 100, 150, 200], get: (s) => s.bop?.ccw.flowPct ?? 0, zones: [[0, 30, '#c82020']], fmt: (v) => v.toFixed(0) });
    for (let i = 0; i < 2; i++) {
      const u = -0.4 + i * 0.23;
      kit.lamp(P, 'v', u - 0.05, yLamp, { title: `CCW ${ABC[i]}\nRUNNING`, hover: `CCW PUMP ${ABC[i]} RUNNING`, color: 'red', get: (s) => !!s.bop?.ccw.pumpsRunning[i] });
      kit.lamp(P, 'v', u + 0.05, yLamp, { title: 'STOPPED', hover: `CCW PUMP ${ABC[i]} STOPPED`, color: 'green', get: (s) => !s.bop?.ccw.pumpsRunning[i] });
      kit.switch(P, 'v', u, ySw, { id: `CCW_PUMP_${i}`, title: `CCW PUMP ${ABC[i]}`, positions: RUN, get: (c) => getArr(c, 'ccwPumps', i), set: (c, k) => setArr(c, 'ccwPumps', 2, i, k === 1) });
    }
    kit.groupBox(P, 'v', 0.06, 1.1, 0.56, 1.95, 'SERVICE WATER (SW)');
    kit.readout(P, 'v', 0.31, 1.84, { title: 'CCW SUPPLY °F', get: (s) => fmt(s.bop?.ccw.supplyTempF ?? 0, 1), unit: '°F (alarm 105)', w: 0.12 });
    kit.readout(P, 'v', 0.31, 1.7, { title: 'CCW FLOW %', get: (s) => fmt(s.bop?.ccw.flowPct ?? 0, 0), color: 'green', unit: '%', w: 0.12 });
    for (let i = 0; i < 2; i++) {
      const u = 0.19 + i * 0.24;
      kit.lamp(P, 'v', u - 0.05, yLamp, { title: `SW ${ABC[i]}\nRUNNING`, hover: `SERVICE WATER PUMP ${ABC[i]} RUNNING`, color: 'red', get: (s) => !!s.bop?.ccw.serviceWaterRunning[i] });
      kit.lamp(P, 'v', u + 0.05, yLamp, { title: 'STOPPED', hover: `SERVICE WATER PUMP ${ABC[i]} STOPPED`, color: 'green', get: (s) => !s.bop?.ccw.serviceWaterRunning[i] });
      kit.switch(P, 'v', u, ySw, { id: `SW_PUMP_${i}`, title: `SW PUMP ${ABC[i]}`, positions: RUN, get: (c) => getArr(c, 'serviceWaterPumps', i), set: (c, k) => setArr(c, 'serviceWaterPumps', 2, i, k === 1) });
    }
    kit.label(P, 'v', 0, yNote, 'NORMAL: 1 CCW + 1 SW PUMP RUNNING · CCW COOLS RCP BEARINGS, THERMAL BARRIERS, LETDOWN HX · STANDBY CCW PUMP DOES NOT AUTO-START (EXCEPT ON SI)', 1.1, 0.036, 'black');
  }

  /* ============ CIRC WATER / CONDENSER VACUUM ============ */
  {
    const P = CW;
    kit.groupBox(P, 'v', -0.56, 1.1, 0.0, 1.95, 'CIRCULATING WATER PUMPS');
    kit.meter(P, 'v', -0.4, yMeter, { title: 'COND VACUUM', unit: 'IN HG', min: 0, max: 30, size: 0.16, ticks: [0, 10, 20, 30], get: (s) => s.condenserVacuum, zones: [[0, 19, '#c82020'], [19, 24, '#e0b020']], fmt: (v) => v.toFixed(1) });
    kit.meter(P, 'v', -0.16, yMeter, { title: 'MAIN STM HDR', unit: 'PSIG', min: 0, max: 1300, ticks: [0, 400, 800, 1200], get: (s) => s.steamHeaderPressure, zones: [[0, 150, '#e0b020']], fmt: (v) => v.toFixed(0) });
    for (let i = 0; i < 3; i++) {
      const u = -0.44 + i * 0.18;
      kit.lamp(P, 'v', u, yLamp, { title: `CW ${ABC[i]}\nRUNNING`, hover: `CIRC WATER PUMP ${ABC[i]} RUNNING`, color: 'red', get: (s) => !!s.bop?.circWaterRunning[i] });
      kit.switch(P, 'v', u, ySw, { id: `CW_PUMP_${i}`, title: `CW PUMP ${ABC[i]}`, positions: RUN, get: (c) => getArr(c, 'circWaterPumps', i), set: (c, k) => setArr(c, 'circWaterPumps', 3, i, k === 1) });
    }
    kit.groupBox(P, 'v', 0.06, 1.1, 0.56, 1.95, 'CONDENSER AIR REMOVAL');
    kit.readout(P, 'v', 0.31, 1.84, { title: 'VACUUM IN HG', get: (s) => fmt(s.condenserVacuum, 1), color: 'green', unit: 'in Hg', w: 0.12 });
    kit.readout(P, 'v', 0.31, 1.7, { title: 'STM HDR PSIG', get: (s) => fmt(s.steamHeaderPressure, 0), unit: 'psig (SJAE needs > 150)', w: 0.12 });
    const ar = ['off', 'hogging', 'sjae'] as const;
    const mode = (s: PlantState) => s.bop?.condenserAirRemoval ?? C().condenserAirRemoval ?? 'off';
    kit.lamp(P, 'v', 0.17, yLamp, { title: 'AIR REMOVAL\nOFF', color: 'green', get: (s) => mode(s) === 'off' });
    kit.lamp(P, 'v', 0.31, yLamp, { title: 'HOGGING\nPUMPS ON', color: 'amber', get: (s) => mode(s) === 'hogging' });
    kit.lamp(P, 'v', 0.45, yLamp, { title: 'SJAE IN\nSERVICE', color: 'red', get: (s) => mode(s) === 'sjae' });
    kit.switch(P, 'v', 0.31, ySw, { id: 'AIR_REMOVAL', title: 'AIR REMOVAL', positions: ['OFF', 'HOG', 'SJAE'], get: (c) => Math.max(0, ar.indexOf(c.condenserAirRemoval ?? 'off')), set: (c, i) => (c.condenserAirRemoval = ar[i]) });
    kit.label(P, 'v', 0, yNote, 'PULL VACUUM: START ≥ 1 CW PUMP → HOGGING (0 → ~20 IN HG, 10–15 MIN) → SJAE ABOVE ~19 IN HG (NEEDS STEAM > 150 PSIG) · RUN 3 CW PUMPS > 60 % LOAD', 1.1, 0.036, 'black');
  }

  /* ============ CONDENSATE / FW HEATERS ============ */
  {
    const P = CD;
    kit.groupBox(P, 'v', -0.56, 1.1, 0.0, 1.95, 'CONDENSATE PUMPS');
    kit.meter(P, 'v', -0.4, yMeter, { title: 'HOTWELL LEVEL', unit: '%', min: 0, max: 100, ticks: [0, 25, 50, 75, 100], get: (s) => s.bop?.hotwellLevelPct ?? 0, zones: [[0, 20, '#e0b020'], [80, 100, '#e0b020']], fmt: (v) => v.toFixed(0) });
    kit.meter(P, 'v', -0.16, yMeter, { title: 'MFP SUCTION', unit: 'PSIG', min: 0, max: 400, ticks: [0, 100, 200, 300, 400], get: (s) => s.bop?.mfpSuctionPsig ?? 0, zones: [[0, 100, '#c82020'], [100, 250, '#e0b020']], fmt: (v) => v.toFixed(0) });
    for (let i = 0; i < 3; i++) {
      const u = -0.44 + i * 0.18;
      kit.lamp(P, 'v', u, yLamp, { title: `COND ${ABC[i]}\nRUNNING`, hover: `CONDENSATE PUMP ${ABC[i]} RUNNING`, color: 'red', get: (s) => !!s.bop?.condensateRunning[i] });
      kit.switch(P, 'v', u, ySw, { id: `COND_PUMP_${i}`, title: `COND PUMP ${ABC[i]}`, positions: RUN, get: (c) => getArr(c, 'condensatePumps', i), set: (c, k) => setArr(c, 'condensatePumps', 3, i, k === 1) });
    }
    kit.groupBox(P, 'v', 0.06, 1.1, 0.56, 1.95, 'FEEDWATER HEATERS');
    kit.meter(P, 'v', 0.2, yMeter, { title: 'FINAL FW TEMP', unit: '°F', min: 0, max: 500, ticks: [0, 100, 200, 300, 400, 500], get: (s) => s.bop?.feedwaterTempF ?? 0, fmt: (v) => v.toFixed(0) });
    kit.readout(P, 'v', 0.44, 1.84, { title: 'FW TEMP °F', get: (s) => fmt(s.bop?.feedwaterTempF ?? 0, 0), color: 'amber', unit: '°F', w: 0.1 });
    kit.readout(P, 'v', 0.44, 1.7, { title: 'MFP SUCT PSIG', get: (s) => fmt(s.bop?.mfpSuctionPsig ?? 0, 0), unit: 'psig', w: 0.1 });
    kit.lamp(P, 'v', 0.24, yLamp, { title: 'HEATERS IN\nSERVICE', color: 'red', get: (s) => !!s.bop?.feedwaterHeatersInService });
    kit.lamp(P, 'v', 0.4, yLamp, { title: 'HEATERS\nBYPASSED', color: 'green', get: (s) => !s.bop?.feedwaterHeatersInService });
    kit.switch(P, 'v', 0.31, ySw, { id: 'FW_HEATERS', title: 'FW HEATERS', positions: ['OUT', 'IN'], get: (c) => (c.feedwaterHeaters ? 1 : 0), set: (c, i) => (c.feedwaterHeaters = i === 1) });
    kit.label(P, 'v', 0, yNote, 'START CONDENSATE PUMPS AFTER VACUUM > 24 IN HG · MFP NEEDS SUCTION > 250 PSIG (TRIPS < 100) · HEATERS IN AFTER SYNC (> 8 % LOAD) · 3 PUMPS AT FULL POWER', 1.1, 0.036, 'black');
  }
  void C;
}
