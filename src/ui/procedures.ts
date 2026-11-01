/**
 * OP-2.1 Plant startup, as data. Each step names the board (placard text), the control,
 * what to do, the target, and a live value. Steps latch once met.
 * To add a step: insert an object into the right phase of STARTUP. Keep `title` short;
 * `where` is the placard name, `control` the engraved control name.
 */
import type { PlantState, PlantControls } from '../sim/types';

export interface ProcStep {
  id: string;
  /** short line for the list */
  title: string;
  /** board section placard, e.g. 'REACTOR CONTROL' */
  where: string;
  /** control(s) on that board and the position, e.g. 'BANK SELECTOR → SEQ' */
  control: string;
  /** what to do, imperative */
  action: string;
  /** what "done" looks like */
  target: string;
  /** current value string */
  value: (s: PlantState, c: PlantControls) => string;
  done: (s: PlantState, c: PlantControls) => boolean;
  /** a trap to avoid */
  gotcha?: string;
}

export interface ProcPhase {
  name: string;
  steps: ProcStep[];
}

const fx = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const rcpCount = (s: PlantState) => s.loops.filter((l) => l.rcpRunning).length;
const sci = (v: number) => (Number.isFinite(v) && v > 0 ? v.toExponential(1) : '0');

/** bop helpers: when an older sim has no `bop`, the step counts as satisfied. */
const B = (s: PlantState) => s.bop;
const nOn = (a?: boolean[]) => (a ? a.filter(Boolean).length : 0);
const onOff = (v: boolean) => (v ? 'ON' : 'off');

export const STARTUP: ProcPhase[] = [
  {
    name: 'A. Check the reactor plant',
    steps: [
      {
        id: 'tripreset',
        title: 'Reactor trip breakers closed',
        where: 'REACTOR CONTROL',
        control: 'TRIP RESET pushbutton (black)',
        action: 'Press TRIP RESET. The green TRIP BKRS CLOSED lamp lights.',
        target: 'Breakers CLOSED',
        value: (s) => (s.reactorTripped ? 'OPEN' : 'CLOSED'),
        done: (s) => !s.reactorTripped,
        gotcha: 'Reset only works when no trip signal is present. If it refuses, press E for the trip alarm help.',
      },
      {
        id: 'ccw',
        title: 'Component cooling and service water running',
        where: 'SAFETY SYSTEMS & ELECTRICAL',
        control: 'CCW PUMP A/B and SW PUMP A/B switches',
        action: 'At least one CCW pump and one service water pump must run: they cool the RCP bearings and seals.',
        target: '1 CCW + 1 SW running',
        value: (s) => (B(s) ? `CCW ${nOn(B(s)!.ccw.pumpsRunning)} · SW ${nOn(B(s)!.ccw.serviceWaterRunning)}` : 'n/a'),
        done: (s) => !B(s) || (nOn(B(s)!.ccw.pumpsRunning) >= 1 && nOn(B(s)!.ccw.serviceWaterRunning) >= 1),
        gotcha: 'The standby CCW pump does not start by itself. If the running one trips, start the other before RCP bearings pass 195 °F.',
      },
      {
        id: 'rcp',
        title: 'All four RCPs running',
        where: 'REACTOR COOLANT SYSTEM',
        control: 'RCP 1–4 START pushbuttons',
        action: 'Check each RUN lamp is lit. Press START on any pump that is stopped.',
        target: '4 of 4 running',
        value: (s) => `${rcpCount(s)} of 4`,
        done: (s) => rcpCount(s) === 4,
      },
      {
        id: 'press',
        title: 'Pressurizer at 2235 psig',
        where: 'PRESSURIZER',
        control: 'BACKUP HEATERS → AUTO, SPRAY CONTROL → AUTO',
        action: 'Leave heaters and spray in AUTO and let them hold pressure.',
        target: '2200–2270 psig',
        value: (s) => `${fx(s.rcsPressure)} psig`,
        done: (s) => s.rcsPressure > 2200 && s.rcsPressure < 2270,
      },
      {
        id: 'sd',
        title: 'Shutdown banks fully out',
        where: 'REACTOR CONTROL',
        control: 'BANK SELECTOR → SA, then SB · ROD MOTION lever',
        action: 'Select each shutdown bank and hold left mouse on the ROD MOTION lever until it reads 228 steps.',
        target: 'SA and SB at 228',
        value: (s) => `SA ${fx(s.rods.SA)} · SB ${fx(s.rods.SB)}`,
        done: (s) => Math.min(s.rods.SA, s.rods.SB) >= 225,
      },
    ],
  },
  {
    name: 'B. Pull a condenser vacuum',
    steps: [
      {
        id: 'cw',
        title: 'Circulating water pumps on',
        where: 'FEEDWATER & STEAM DUMP',
        control: 'CIRC WATER PUMP 1, 2, 3 switches → ON',
        action: 'Start at least two circulating water pumps. They cool the condenser; without them there is no vacuum.',
        target: '2 or 3 running',
        value: (s) => (B(s) ? `${nOn(B(s)!.circWaterRunning)} of 3` : 'n/a'),
        done: (s) => !B(s) || nOn(B(s)!.circWaterRunning) >= 2,
      },
      {
        id: 'hog',
        title: 'Hogging pumps to ~19 inHg',
        where: 'FEEDWATER & STEAM DUMP',
        control: 'AIR REMOVAL selector → HOGGING',
        action: 'Mechanical hogging pumps pull vacuum from zero. Takes 10–15 minutes: use time ×10 and do the next steps meanwhile.',
        target: 'Vacuum ≥ 19 inHg',
        value: (s, c) => `${(c.condenserAirRemoval ?? '—').toUpperCase()} · ${fx(s.condenserVacuum, 1)} inHg`,
        done: (s, c) => !B(s) || s.condenserVacuum >= 19 || c.condenserAirRemoval === 'sjae',
      },
      {
        id: 'sjae',
        title: 'Switch to steam jet air ejectors',
        where: 'FEEDWATER & STEAM DUMP',
        control: 'AIR REMOVAL selector → SJAE',
        action: 'At about 19 inHg switch to SJAE. They hold 28 inHg. Above 22 inHg the condenser steam dumps become available.',
        target: 'SJAE, vacuum ≥ 22 inHg',
        value: (s, c) => `${(c.condenserAirRemoval ?? '—').toUpperCase()} · ${fx(s.condenserVacuum, 1)} inHg`,
        done: (s, c) => !B(s) || (c.condenserAirRemoval === 'sjae' && s.condenserVacuum >= 22),
        gotcha: 'SJAEs are very slow below 18 inHg. Do not switch too early.',
      },
      {
        id: 'dumps',
        title: 'Steam dumps take the heat',
        where: 'STEAM GENERATORS · FEEDWATER & STEAM DUMP',
        control: 'SG ARV SETPOINT → 1125 psig · STEAM DUMP MODE → PRESS (1092 psig)',
        action: 'Raise the SG atmospheric relief setpoint so the condenser dumps, not the ARVs, carry the decay heat.',
        target: 'ARV 1125 psig, dumps armed',
        value: (s, c) => `ARV ${fx(c.sgArvSetpointPsig ?? 1125)} · dumps ${c.steamDumpMode.toUpperCase()}`,
        done: (s, c) => (c.sgArvSetpointPsig ?? 1125) >= 1115 && c.steamDumpMode !== 'off' && s.tAvg > 550,
      },
    ],
  },
  {
    name: 'C. Main feedwater',
    steps: [
      {
        id: 'cond',
        title: 'Two condensate pumps on',
        where: 'FEEDWATER & STEAM DUMP',
        control: 'CONDENSATE PUMP 1, 2 switches → ON',
        action: 'Condensate pumps supply suction to the main feed pumps. Wait for MFP suction above 250 psig.',
        target: '2 running, suction > 250 psig',
        value: (s) => (B(s) ? `${nOn(B(s)!.condensateRunning)} of 3 · ${fx(B(s)!.mfpSuctionPsig)} psig` : 'n/a'),
        done: (s) => !B(s) || (nOn(B(s)!.condensateRunning) >= 2 && B(s)!.mfpSuctionPsig > 250),
      },
      {
        id: 'feed',
        title: 'Start MFP A, feed valves in AUTO',
        where: 'FEEDWATER & STEAM DUMP · STEAM GENERATORS',
        control: 'MFP A START/STOP · FRV MODE → AUTO on all four SGs',
        action: 'Start main feed pump A and put all four feed regulating valves in AUTO.',
        target: 'MFP A running, 4 FRVs AUTO',
        value: (s, c) => `${s.mainFeedPumpsRunning.filter(Boolean).length} MFP · ${c.feedMode.filter((m) => m === 'auto').length}/4 AUTO`,
        done: (s, c) => s.mainFeedPumpsRunning.some(Boolean) && c.feedMode.every((m) => m === 'auto'),
      },
      {
        id: 'afw',
        title: 'Aux feed back to AUTO',
        where: 'FEEDWATER & STEAM DUMP',
        control: 'AFW PUMP 1, 2, 3 switches → AUTO',
        action: 'With main feed holding SG levels, take the AFW pumps out of START. In AUTO they still restart on low level.',
        target: 'No AFW switch in START',
        value: (_s, c) => c.auxFeedPumps.map((m) => m.toUpperCase()).join(' · '),
        done: (s, c) => s.mainFeedPumpsRunning.some(Boolean) && c.auxFeedPumps.every((m) => m !== 'on'),
      },
    ],
  },
  {
    name: 'D. Take the reactor critical',
    steps: [
      {
        id: 'seq',
        title: 'Rods in manual, bank select SEQ',
        where: 'REACTOR CONTROL',
        control: 'ROD CONTROL MODE → MAN · BANK SELECTOR → SEQ',
        action: 'Put rod control in manual and turn the bank selector fully clockwise to SEQ so banks A→D move in overlap.',
        target: 'MAN and SEQ',
        value: (_s, c) => `${c.rodMode.toUpperCase()} · ${c.rodBankSelect === 'MANUAL_SEQ' ? 'SEQ' : c.rodBankSelect}`,
        done: (_s, c) => c.rodMode === 'manual' && c.rodBankSelect === 'MANUAL_SEQ',
      },
      {
        id: 'ctl',
        title: 'Pull control banks toward critical',
        where: 'REACTOR CONTROL',
        control: 'ROD MOTION lever (hold left mouse = OUT)',
        action:
          'Pull in pulls of 10–20 seconds, then let go. Watch SOURCE RANGE on NUCLEAR INSTRUMENTATION and listen to the clicks. Counts jump, then level off: wait for them to stop rising before the next pull.',
        target: 'Critical near CD ≈ 130 steps',
        value: (s) => `CA ${fx(s.rods.CA)} CB ${fx(s.rods.CB)} CC ${fx(s.rods.CC)} CD ${fx(s.rods.CD)} · ${fx(s.sourceRangeCps)} cps`,
        done: (s) => s.rods.CD >= 60 || (s.keff >= 0.9998 && s.startupRateDpm > 0.05),
        gotcha:
          'If bank D passes ~200 steps and counts still level off, dilute: CVCS / BORON CONTROL, MAKEUP MODE → DIL, set BATCH GALLONS and press MAKEUP BATCH START. The batch stops by itself.',
      },
      {
        id: 'crit',
        title: 'Reactor critical',
        where: 'NUCLEAR INSTRUMENTATION',
        control: 'STARTUP RATE meter, REACTOR CRITICAL lamp',
        action: 'Near critical, pull only a few steps at a time. You are critical when counts keep climbing with the lever released and SUR holds steady.',
        target: 'SUR +0.3 to +1.0 dpm, steady, lever released',
        value: (s) => `SUR ${s.startupRateDpm >= 0 ? '+' : ''}${fx(s.startupRateDpm, 2)} dpm · k ${s.keff.toFixed(4)}`,
        done: (s) => !s.reactorTripped && ((s.keff >= 0.9998 && s.startupRateDpm > 0.05) || s.permissives.P6),
        gotcha: 'Keep SUR under 1 dpm. Above 1.5 dpm an alarm sounds; at 5 dpm the reactor trips. If SUR climbs, hold right mouse (IN) a few steps.',
      },
      {
        id: 'p6',
        title: 'Above P-6 (source range off)',
        where: 'NUCLEAR INSTRUMENTATION',
        control: 'P-6 PERMISSIVE lamp',
        action: 'Let power climb on its own. Above 1e-10 A in the intermediate range the source range switches off and goes quiet. Level off around 1e-8 A.',
        target: 'P-6 lit',
        value: (s) => `IR ${sci(s.intermediateRangeAmps)} A`,
        done: (s) => s.permissives.P6,
      },
      {
        id: 'pah',
        title: 'Point of adding heat (1–3 %)',
        where: 'NUCLEAR INSTRUMENTATION / REACTOR CONTROL',
        control: 'POWER RANGE meter · ROD MOTION lever',
        action: 'Let power rise to 1–3 %. Tavg starts to rise and STEAM DUMP DEM opens: the reactor is now making real heat. Insert a few steps if SUR is still above 0.5 dpm.',
        target: 'Power range 1–3 %, SUR ≈ 0',
        value: (s) => `${fx(s.powerRangePct, 1)} % · SUR ${fx(s.startupRateDpm, 2)}`,
        done: (s) => s.powerRangePct >= 1,
      },
      {
        id: 'p5',
        title: 'Raise power to 3–8 %',
        where: 'REACTOR CONTROL',
        control: 'ROD MOTION lever (short pulls)',
        action: 'Pull rods slowly. The steam dumps carry the extra steam and hold Tavg.',
        target: 'Power 3–8 %',
        value: (s) => `${fx(s.powerRangePct, 1)} %`,
        done: (s) => s.powerRangePct >= 3,
      },
    ],
  },
  {
    name: 'E. Warm up and roll the turbine',
    steps: [
      {
        id: 'tg',
        title: 'Turning gear engaged, rotor straight',
        where: 'TURBINE / GENERATOR',
        control: 'TURNING GEAR switch → ENGAGE · ECCENTRICITY meter',
        action: 'The stopped rotor must be turning slowly or it bows. Check eccentricity is low before rolling.',
        target: 'Engaged (or rolling), eccentricity < 3 mils',
        value: (s) => (B(s) ? `${B(s)!.turbine.turningGearEngaged ? 'ENGAGED' : 'off'} · ${fx(B(s)!.turbine.eccentricityMils, 1)} mils` : 'n/a'),
        done: (s) => !B(s) || ((B(s)!.turbine.turningGearEngaged || s.turbineSpeedRpm > 50) && B(s)!.turbine.eccentricityMils < 3),
      },
      {
        id: 'latch',
        title: 'Latch, roll to 500 rpm to warm up',
        where: 'TURBINE / GENERATOR',
        control: 'SPEED TARGET → 500 rpm · ACCEL → 200 rpm/min · LATCH pushbutton',
        action: 'Set the speed target and acceleration first, then press LATCH. The turbine rolls to 500 rpm and soaks.',
        target: 'Latched, ~500 rpm',
        value: (s, c) => `${s.turbineLatched ? 'LATCHED' : 'tripped'} · ${fx(s.turbineSpeedRpm)} → ${fx(c.turbineSpeedSetpointRpm ?? 1800)} rpm`,
        done: (s) => s.turbineLatched && s.turbineSpeedRpm > 400,
        gotcha: 'Latch needs condenser vacuum above 20 inHg and no reactor trip.',
      },
      {
        id: 'soak',
        title: 'Soak until the rotor is warm',
        where: 'TURBINE / GENERATOR',
        control: 'ROTOR TEMP and STEAM INLET TEMP meters · DIFF EXPANSION meter',
        action: 'Hold 500 rpm (time ×10 helps) until rotor temperature is within 120 °F of the steam. Watch differential expansion stays under 60 %.',
        target: 'Steam − rotor ≤ 120 °F',
        value: (s) => (B(s) ? `Δ ${fx(B(s)!.turbine.steamInletTempF - B(s)!.turbine.rotorTempF)} °F · diff exp ${fx(B(s)!.turbine.diffExpansionPct)} %` : 'n/a'),
        done: (s) => !B(s) || (s.turbineLatched && B(s)!.turbine.steamInletTempF - B(s)!.turbine.rotorTempF <= 120) || s.turbineSpeedRpm > 1700,
      },
      {
        id: 'rpm',
        title: 'Roll to 1800 rpm',
        where: 'TURBINE / GENERATOR',
        control: 'ACCEL → 300+ rpm/min, then SPEED TARGET → 1800',
        action: 'Raise acceleration first so the rotor passes the 1000–1300 rpm critical band quickly, then set 1800.',
        target: '1795–1805 rpm',
        value: (s, c) => `${fx(s.turbineSpeedRpm)} rpm · accel ${fx(c.turbineAccelRpmPerMin ?? 0)}`,
        done: (s) => s.turbineSpeedRpm > 1780 || s.generatorBreakerClosed,
        gotcha: 'Never stop in the critical band (lamp lit): vibration builds and trips the turbine at 14 mils.',
      },
    ],
  },
  {
    name: 'F. Synchronize to the grid',
    steps: [
      {
        id: 'field',
        title: 'Close the field breaker',
        where: 'TURBINE / GENERATOR',
        control: 'FIELD BKR CLOSE pushbutton',
        action: 'Excite the generator. Only above 1700 rpm.',
        target: 'Field breaker closed',
        value: (s) => (B(s) ? (B(s)!.generator.fieldBreakerClosed ? 'CLOSED' : 'open') : 'n/a'),
        done: (s) => !B(s) || B(s)!.generator.fieldBreakerClosed || s.generatorBreakerClosed,
      },
      {
        id: 'kv',
        title: 'Match generator voltage to the grid',
        where: 'TURBINE / GENERATOR',
        control: 'VOLTAGE SETPOINT knob (kV)',
        action: 'Turn the voltage setpoint until GENERATOR kV reads the same as GRID kV.',
        target: 'Within 1 % of grid kV',
        value: (s) => (B(s) ? `gen ${fx(B(s)!.generator.terminalKv, 1)} · grid ${fx(B(s)!.generator.gridKv, 1)} kV` : 'n/a'),
        done: (s) => !B(s) || s.generatorBreakerClosed || (B(s)!.generator.fieldBreakerClosed && Math.abs(B(s)!.generator.terminalKv - B(s)!.generator.gridKv) <= 0.01 * B(s)!.generator.gridKv),
      },
      {
        id: 'slip',
        title: 'Make the synchroscope turn slowly',
        where: 'TURBINE / GENERATOR',
        control: 'SPEED TARGET → 1801–1803 rpm',
        action: 'Set speed slightly above 1800 so the synchroscope needle turns slowly clockwise (one turn every 10–30 s).',
        target: 'Slip +0.02 to +0.1 Hz',
        value: (s) => (B(s) ? `slip ${B(s)!.generator.slipHz >= 0 ? '+' : ''}${B(s)!.generator.slipHz.toFixed(3)} Hz` : 'n/a'),
        done: (s) => !B(s) || s.generatorBreakerClosed || (B(s)!.generator.slipHz > 0.01 && B(s)!.generator.slipHz < 0.15),
      },
      {
        id: 'sync',
        title: 'Close the breaker at 12 o’clock',
        where: 'TURBINE / GENERATOR',
        control: 'BKR CLOSE pushbutton (red) · SYNCHROSCOPE',
        action: 'Press BKR CLOSE just before the needle reaches 12 o’clock. The unit picks up about 57 MW block load.',
        target: 'Needle within ±10°, GEN BKR CLOSED',
        value: (s) => (s.generatorBreakerClosed ? `CLOSED · ${fx(s.grossMWe)} MWe` : B(s) ? `needle ${fx(B(s)!.generator.syncPhaseDeg)}°` : 'open'),
        done: (s) => s.generatorBreakerClosed,
        gotcha: 'Closing out of phase damages the generator and trips the unit. Block load pulls steam: pull rods to keep TAVG − TREF near 0.',
      },
    ],
  },
  {
    name: 'G. Load the unit',
    steps: [
      {
        id: 'uat',
        title: 'House loads to the unit transformer',
        where: 'SAFETY SYSTEMS & ELECTRICAL',
        control: 'HOUSE XFER → UAT pushbutton',
        action: 'Move plant auxiliary loads onto the generator’s own transformer.',
        target: 'UAT lamp lit',
        value: (s) => (B(s) ? B(s)!.electrical.houseLoadsOn : 'n/a'),
        done: (s) => !B(s) || B(s)!.electrical.houseLoadsOn === 'UAT',
      },
      {
        id: 'htrs',
        title: 'Feed heaters in, dumps to TAVG',
        where: 'FEEDWATER & STEAM DUMP',
        control: 'FW HEATERS switch → ON · STEAM DUMP MODE → TAVG',
        action: 'Put the feedwater heaters in service and switch the steam dumps to Tavg mode for load changes.',
        target: 'Heaters ON, dumps TAVG',
        value: (_s, c) => `heaters ${onOff(c.feedwaterHeaters ?? true)} · dumps ${c.steamDumpMode.toUpperCase()}`,
        done: (_s, c) => (c.feedwaterHeaters ?? true) && c.steamDumpMode === 'tavg',
      },
      {
        id: 'ramp',
        title: 'Start raising load',
        where: 'TURBINE / GENERATOR',
        control: 'RAMP MW/MIN → 10–20 · LOAD SETPOINT MW → 150',
        action: 'Set a slow ramp, then raise the load setpoint. Keep TAVG − TREF (REACTOR CONTROL) near 0 by pulling rods as load rises.',
        target: 'Load above 100 MW',
        value: (s, c) => `${fx(s.grossMWe)} MWe → set ${fx(c.turbineLoadSetpointMW)} MW`,
        done: (s) => s.grossMWe >= 100 && s.generatorBreakerClosed,
      },
      {
        id: 'p10',
        title: 'Above P-10 (10 %)',
        where: 'NUCLEAR INSTRUMENTATION',
        control: 'P-10 PERMISSIVE lamp',
        action: 'The low-power trips block automatically.',
        target: 'P-10 lit',
        value: (s) => `${fx(s.powerRangePct, 1)} %`,
        done: (s) => s.permissives.P10 && s.generatorBreakerClosed,
      },
      {
        id: 'auto',
        title: 'Rods to AUTO (above 15 %)',
        where: 'REACTOR CONTROL',
        control: 'ROD CONTROL MODE → AUTO',
        action: 'With Tavg within 1–2 °F of Tref, switch to AUTO. Rods now follow the turbine.',
        target: 'AUTO, power above 15 %',
        value: (s, c) => `${c.rodMode.toUpperCase()} · ${fx(s.powerRangePct, 1)} %`,
        done: (s, c) => c.rodMode === 'auto' && s.powerRangePct >= 15,
      },
      {
        id: 'mfpb',
        title: 'Second feed pump before 50 %',
        where: 'FEEDWATER & STEAM DUMP',
        control: 'MFP B START/STOP',
        action: 'Start MFP B. One pump cannot feed much more than half power.',
        target: 'MFP A and B running',
        value: (s) => `${s.mainFeedPumpsRunning.filter(Boolean).length} of 2`,
        done: (s) => s.mainFeedPumpsRunning.every(Boolean),
      },
      {
        id: 'p50',
        title: 'Above 50 % (P-9)',
        where: 'TURBINE / GENERATOR',
        control: 'LOAD SETPOINT MW → 600+',
        action: 'From here a turbine trip also trips the reactor.',
        target: 'Power above 50 %',
        value: (s) => `${fx(s.powerRangePct, 1)} %`,
        done: (s) => s.powerRangePct >= 50 && s.generatorBreakerClosed,
      },
      {
        id: 'third',
        title: 'Third condensate and CW pump before 90 %',
        where: 'FEEDWATER & STEAM DUMP',
        control: 'CONDENSATE PUMP 3 and CIRC WATER PUMP 3 → ON',
        action: 'Two condensate pumps cannot supply full feed flow, and full load needs all three circ water pumps for vacuum.',
        target: '3 condensate + 3 CW running',
        value: (s) => (B(s) ? `cond ${nOn(B(s)!.condensateRunning)}/3 · CW ${nOn(B(s)!.circWaterRunning)}/3` : 'n/a'),
        done: (s) => !B(s) || (nOn(B(s)!.condensateRunning) === 3 && nOn(B(s)!.circWaterRunning) === 3),
      },
      {
        id: 'p100',
        title: 'Full power',
        where: 'TURBINE / GENERATOR',
        control: 'LOAD SETPOINT MW → 1150',
        action: 'Raise load to about 1150 MWe and hold it there.',
        target: 'Power 98–100 %',
        value: (s) => `${fx(s.powerRangePct, 1)} % · ${fx(s.grossMWe)} MWe`,
        done: (s) => s.powerRangePct >= 98 && s.generatorBreakerClosed,
        gotcha: 'Xenon builds for hours after a power change. Keep bank D above the insertion limit with dilution batches (CVCS / BORON CONTROL).',
      },
    ],
  },
];

export interface LiveCheck {
  text: string;
  value: (s: PlantState) => string;
  ok: (s: PlantState) => boolean;
}

export const RUNNING_CHECKS: LiveCheck[] = [
  { text: 'Tavg within 3 °F of Tref', value: (s) => `${(s.tAvg - s.tRef).toFixed(1)} °F`, ok: (s) => Math.abs(s.tAvg - s.tRef) <= 3 },
  { text: 'PZR pressure 2210–2260 psig', value: (s) => `${s.rcsPressure.toFixed(0)}`, ok: (s) => s.rcsPressure >= 2210 && s.rcsPressure <= 2260 },
  {
    text: 'PZR level within 5 % of program',
    value: (s) => `${s.przLevel.toFixed(0)} / ${s.przLevelProgram.toFixed(0)} %`,
    ok: (s) => Math.abs(s.przLevel - s.przLevelProgram) <= 5,
  },
  {
    text: 'SG levels 40–60 % narrow range',
    value: (s) => s.loops.map((l) => l.sgLevel.toFixed(0)).join(' '),
    ok: (s) => s.loops.every((l) => l.sgLevel >= 40 && l.sgLevel <= 60),
  },
  { text: 'Axial flux difference ±5 %', value: (s) => `${s.axialOffset.toFixed(1)} %`, ok: (s) => Math.abs(s.axialOffset) <= 5 },
  { text: 'DNBR above 1.3', value: (s) => (Number.isFinite(s.dnbr) ? s.dnbr.toFixed(2) : '∞'), ok: (s) => !(s.dnbr < 1.3) },
  {
    text: 'RCP bearings below 195 °F',
    value: (s) => (s.bop ? s.bop.rcpAux.bearingTempF.map((t) => t.toFixed(0)).join(' ') : '—'),
    ok: (s) => !s.bop || s.bop.rcpAux.bearingTempF.every((t) => t < 195),
  },
  { text: 'Subcooling margin above 20 °F', value: (s) => `${s.subcoolingMargin.toFixed(0)} °F`, ok: (s) => s.subcoolingMargin >= 20 },
];
