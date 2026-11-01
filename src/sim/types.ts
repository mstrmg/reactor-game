/**
 * SHARED CONTRACT between the simulation (src/sim), the 3D control room
 * (src/world), the DOM overlay UI (src/ui) and audio (src/audio).
 *
 * The plant is a 4-loop Westinghouse-style PWR, ~3411 MWt / ~1150 MWe.
 * Units are the ones an American control room would display:
 *   temperatures °F, pressures psig, flows % of rated (or gpm where noted),
 *   boron ppm, rod position in steps withdrawn (0 = fully inserted, 228 = fully out).
 *
 * Rules:
 *  - Only src/sim writes PlantState. Everyone else reads it.
 *  - Panels write continuous settings into `PlantControls` (switch positions,
 *    setpoints, valve demands) and fire momentary actions via `ReactorSim.press()`.
 *  - Changing this file means updating every module that uses it.
 */

export type ScenarioId =
  | 'full-power' // 100% power, steady state, generator online. Default quick-play.
  | 'hot-standby' // Mode 3: rods in, 557°F, 2235 psig, turbine offline. Do a full startup.
  | 'low-power' // ~5% power, rods partly out, turbine offline, ready to roll turbine.
  | 'xenon-challenge'; // 50% power 6 h after a fast down-power: xenon is building in.

export type RodBankId = 'SA' | 'SB' | 'CA' | 'CB' | 'CC' | 'CD';
export const ROD_BANKS: RodBankId[] = ['SA', 'SB', 'CA', 'CB', 'CC', 'CD'];
export const ROD_STEPS_MAX = 228;

export type SwitchAuto = 'auto' | 'manual';
export type OnOffAuto = 'off' | 'on' | 'auto';

/** Things the operator can set and that persist. Panels read AND write these. */
export interface PlantControls {
  /** Rod control */
  rodMode: SwitchAuto; // auto = Tavg/Tref program moves control banks
  rodBankSelect: RodBankId | 'MANUAL_SEQ'; // MANUAL_SEQ = control banks in overlap sequence
  rodMotion: -1 | 0 | 1; // held lever: -1 insert, 0 hold, +1 withdraw (panel sets while key/mouse held)

  /** Chemical & volume control (CVCS) */
  makeupMode: 'auto' | 'dilute' | 'borate' | 'off';
  makeupRateGpm: number; // 0..120 for dilute/borate batch
  chargingFlowDemand: number; // % 0..100, used when chargingMode is manual
  chargingMode: SwitchAuto; // auto = maintains pressurizer level program
  letdownIsolated: boolean;

  /** Pressurizer */
  przHeaters: OnOffAuto; // backup heaters; proportional heaters always follow auto unless 'off'
  przSprayMode: SwitchAuto;
  przSprayDemand: number; // 0..1 when manual
  porvMode: 'closed' | 'open' | 'auto';
  porvBlockValveOpen: boolean;

  /** Reactor coolant pumps (4 loops) — true = running. Set via press('RCP_START_n'/'RCP_STOP_n'). */

  /** Feedwater, per steam generator (index 0..3) */
  feedMode: SwitchAuto[]; // auto = 3-element level control
  feedValveDemand: number[]; // 0..1 when manual
  mainFeedPumps: boolean[]; // 2 pumps (A,B)
  auxFeedPumps: OnOffAuto[]; // 3 pumps: 2 motor, 1 turbine-driven; auto starts on low SG level / trip

  /** Turbine / generator */
  turbineLoadSetpointMW: number; // target electrical MW
  turbineRampRateMWpm: number; // MW per minute, 1..50
  steamDumpMode: 'off' | 'tavg' | 'pressure'; // condenser steam dumps
  steamDumpPressureSetpoint: number; // psig, used in pressure mode (default 1092)

  /** Safety injection: manual block of low-pressurizer-pressure SI (allowed below P-11, ~1915 psig) */
  siBlocked: boolean;

  /** Simulation */
  timeScale: number; // 1, 2, 5, 10, 30 — set by UI
  paused: boolean;
}

/** Momentary actions. */
export type ButtonId =
  | 'REACTOR_TRIP' // manual trip
  | 'TRIP_RESET' // reset reactor trip breakers (only works if no trip signal present)
  | 'SI_ACTUATE'
  | 'SI_RESET'
  | 'TURBINE_TRIP'
  | 'TURBINE_LATCH' // reset turbine so it can be rolled
  | 'GEN_BREAKER_CLOSE' // sync to grid (needs turbine at ~1800 rpm)
  | 'GEN_BREAKER_OPEN'
  | 'ALARM_ACK' // silence horns, stop flashing
  | 'ALARM_RESET' // clear acknowledged alarms whose condition has cleared
  | `RCP_START_${0 | 1 | 2 | 3}`
  | `RCP_STOP_${0 | 1 | 2 | 3}`
  | 'MFP_A_TOGGLE'
  | 'MFP_B_TOGGLE';

export type AlarmSeverity = 'info' | 'warning' | 'alarm' | 'trip';

export interface Alarm {
  id: string; // stable id, e.g. 'PZR_PRESS_HI'
  label: string; // annunciator tile text, ≤ 24 chars, uppercase, e.g. 'PZR PRESS HI'
  severity: AlarmSeverity;
  active: boolean; // condition currently present
  acknowledged: boolean;
  /** sim time the alarm last came in */
  time: number;
}

export type TripId =
  | 'MANUAL'
  | 'PR_HIGH_FLUX_HI' // power range high flux, high setpoint (109%)
  | 'PR_HIGH_FLUX_LO' // power range high flux, low setpoint (25%) — active below P-10
  | 'PR_POS_RATE' // power range positive rate
  | 'IR_HIGH_FLUX'
  | 'SR_HIGH_FLUX' // source range 1e5 cps, active below P-6
  | 'OTDT' // overtemperature ΔT
  | 'OPDT' // overpower ΔT
  | 'PZR_PRESS_LO'
  | 'PZR_PRESS_HI'
  | 'PZR_LEVEL_HI'
  | 'RCS_FLOW_LO'
  | 'RCP_UNDERVOLTAGE'
  | 'SG_LEVEL_LOLO'
  | 'TURBINE_TRIP' // above P-9 (~50% power)
  | 'SAFETY_INJECTION'
  | 'STARTUP_RATE'; // gameplay-friendly: SUR > 5 dpm in IR

export type FaultId =
  | 'STUCK_ROD' // one rod stuck — won't move, won't scram fully
  | 'DROPPED_ROD'
  | 'RCP_TRIP' // one RCP trips
  | 'MFP_TRIP' // a main feed pump trips
  | 'FEED_VALVE_FAIL' // one SG feed reg valve fails (open or closed)
  | 'PZR_PORV_STUCK_OPEN'
  | 'PZR_SPRAY_STUCK_OPEN'
  | 'SG_TUBE_LEAK'
  | 'SMALL_LOCA'
  | 'LOSS_OF_OFFSITE_POWER'
  | 'TURBINE_TRIP_SPURIOUS'
  | 'STEAM_LINE_BREAK'
  | 'INSTRUMENT_FAIL'; // one channel of an instrument fails high/low

export interface ActiveFault {
  id: FaultId;
  /** which loop / SG / rod / channel, if relevant */
  target?: number | string;
  startedAt: number;
  /** player-visible once diagnosed by an alarm; description for the debrief */
  description: string;
}

export interface LoopState {
  rcpRunning: boolean;
  rcpSpeed: number; // 0..1 (coastdown)
  flow: number; // % of rated loop flow
  tHot: number; // °F
  tCold: number; // °F
  sgLevel: number; // % narrow range
  sgLevelWide: number; // % wide range
  sgPressure: number; // psig
  feedFlow: number; // % of rated (per SG)
  steamFlow: number; // % of rated (per SG)
  feedValvePos: number; // 0..1 actual
  auxFeedFlow: number; // gpm
}

export interface PlantState {
  t: number; // sim seconds since scenario start
  scenario: ScenarioId;

  // ---------- Nuclear ----------
  /** total thermal power fraction of rated (fission + decay), 1.0 = 3411 MWt */
  thermalPower: number;
  /** fission (neutron) power fraction of rated; ~1e-9 at shutdown source level */
  neutronPower: number;
  decayHeat: number; // fraction of rated
  /** Displayed nuclear instruments */
  sourceRangeCps: number; // valid ~1 .. 1e6, de-energised above P-6
  intermediateRangeAmps: number; // 1e-11 .. 1e-3
  powerRangePct: number; // 0..120 (% rated)
  startupRateDpm: number; // decades per minute
  periodSeconds: number; // reactor period (Infinity when steady)
  /** average thermal neutron flux in core, n/cm²/s (≈3e13 at 100%) */
  neutronFlux: number;
  /** Axial flux difference (%), a "delta-I" target-band game */
  axialOffset: number;

  /** Reactivity breakdown, pcm (1 pcm = 1e-5 Δk/k). Sum = total. */
  reactivity: {
    total: number;
    rods: number;
    boron: number;
    doppler: number; // fuel temp feedback
    moderator: number; // MTC feedback
    xenon: number;
    samarium: number;
  };
  keff: number;

  rods: Record<RodBankId, number>; // steps withdrawn 0..228 (bank average)
  rodsMoving: boolean;
  rodSpeedSpm: number; // steps per minute currently
  droppedRods: number; // count of dropped rods
  rodBottomLights: boolean; // any rod at bottom with bank not demanded in

  boronPpm: number;
  xenonPcm: number; // xenon worth, negative number (also in reactivity.xenon)
  iodine: number; // relative (1.0 = equilibrium at 100%)
  xenon: number; // relative concentration (1.0 = equilibrium at 100%)

  // ---------- Thermal / core ----------
  fuelTempCenterline: number; // °F
  cladTemp: number; // °F
  tAvg: number; // °F (average of loops)
  tRef: number; // °F program Tavg for current turbine load
  deltaT: number; // °F core ΔT (Thot - Tcold, average)
  dnbr: number; // minimum DNB ratio; < 1.3 = trouble, < 1.0 = clad damage accrues
  coreExitTemp: number; // °F (thermocouples)
  subcoolingMargin: number; // °F (saturation temp at RCS pressure − core exit temp)

  // ---------- Reactor Coolant System ----------
  rcsPressure: number; // psig (pressurizer pressure)
  przLevel: number; // %
  przLevelProgram: number; // % setpoint for current Tavg
  przTemp: number; // °F
  przHeaterKW: number; // actual heater output (0..1800 kW)
  przSprayPos: number; // 0..1 actual
  porvOpen: boolean;
  safetyValvesOpen: boolean;
  chargingFlowGpm: number;
  letdownFlowGpm: number;
  rcsLeakGpm: number; // known leakage (fault-driven)
  loops: LoopState[]; // length 4

  // ---------- Secondary ----------
  steamHeaderPressure: number; // psig
  turbineSpeedRpm: number; // 1800 nominal
  turbineLatched: boolean;
  turbineTripped: boolean;
  generatorBreakerClosed: boolean;
  grossMWe: number;
  turbineLoadMW: number; // current turbine load demand actually being followed
  steamDumpDemand: number; // 0..1
  condenserVacuum: number; // inHg (≈ 28 normal)
  mainFeedPumpsRunning: boolean[]; // 2
  auxFeedPumpsRunning: boolean[]; // 3

  // ---------- Safety systems ----------
  reactorTripped: boolean; // trip breakers open
  tripSignals: TripId[]; // currently present trip conditions
  firstOut: TripId | null; // first trip of the current event
  /** Permissives (P-6, P-7, P-8, P-9, P-10, P-11) — true = active */
  permissives: { P6: boolean; P7: boolean; P8: boolean; P9: boolean; P10: boolean; P11: boolean };
  siActuated: boolean;
  siFlowGpm: number;
  accumulatorsInjected: boolean;
  containmentPressure: number; // psig
  containmentRadiation: number; // R/hr
  offsitePower: boolean;
  dieselGeneratorsRunning: boolean[]; // 2

  // ---------- Consequences ----------
  /** 0..1 fraction of fuel with clad damage. >0 is bad, game ends at core melt. */
  fuelDamage: number;
  coreUncovered: boolean;
  /** 'ok' normal, 'damaged' some fuel failure, 'meltdown' = game over */
  coreStatus: 'ok' | 'damaged' | 'meltdown';
  /** Structural integrity, 0..1 (1 = intact). Driven by physics, not scripts:
   *  RCS overpressure (> ~3200 psig) or prompt-critical power excursions damage the
   *  vessel/piping; SG overfill or steam-line water hammer damages the secondary;
   *  containment over design pressure (~60 psig) damages containment. */
  integrity: { rcs: number; secondary: number; containment: number };
  /** Set once, when the plant is lost. Game over. Emergent from physics. */
  catastrophe: null | {
    kind: 'meltdown' | 'steam-explosion' | 'vessel-rupture' | 'containment-failure' | 'turbine-missile';
    t: number;
    description: string; // one-paragraph debrief of what physically happened
  };

  alarms: Alarm[];
  faults: ActiveFault[];

  /** Gameplay scoring */
  score: {
    mwhGenerated: number;
    trips: number;
    timeAtPowerS: number;
  };
}

/** Events the sim emits each step (drain with ReactorSim.drainEvents()). */
export type SimEvent =
  | { type: 'alarm'; alarm: Alarm } // new alarm came in
  | { type: 'trip'; reason: TripId }
  | { type: 'fault'; fault: ActiveFault }
  | { type: 'si' }
  | { type: 'rod-step'; bank: RodBankId; dir: -1 | 1 } // for clicky rod sounds
  | { type: 'breaker'; closed: boolean }
  | { type: 'turbine-trip' }
  | { type: 'catastrophe'; kind: NonNullable<PlantState['catastrophe']>['kind'] }
  | { type: 'meltdown' }
  | { type: 'message'; text: string }; // generic operator log line

/** Public API of src/sim/ReactorSim.ts */
export interface ReactorSimApi {
  readonly state: PlantState;
  readonly controls: PlantControls;
  /** advance real seconds; internally multiplies by controls.timeScale and substeps */
  update(realDtSeconds: number): void;
  press(button: ButtonId): void;
  drainEvents(): SimEvent[];
  reset(scenario: ScenarioId): void;
  /** fault injection; random faults are scheduled internally when enabled */
  injectFault(id: FaultId, target?: number | string): void;
  randomFaults: boolean;
}
