/**
 * Alarm response help for the E panel.
 * Lookup order: the sim's ALARM_HELP (src/sim/alarmHelp.ts), then the entries below, then a pattern match (SG n / RCP n / LOOP n), then a generic text.
 * Board names match the placards: SAFETY SYSTEMS & ELECTRICAL, CVCS / BORON CONTROL,
 * PRESSURIZER, REACTOR COOLANT SYSTEM, REACTOR CONTROL, NUCLEAR INSTRUMENTATION,
 * PLANT COMPUTER, STEAM GENERATORS, FEEDWATER & STEAM DUMP, TURBINE / GENERATOR.
 */
import type { FaultId, PlantControls, PlantState, TripId } from '../sim/types';

export interface AlarmHelpEntry {
  meaning: string;
  causes: string[];
  actions: string[];
}

// ---- sim-provided help ----
import { ALARM_HELP } from '../sim/alarmHelp';
import { describeTrip, describeFault } from '../sim/describe';
const SIM_HELP: Record<string, Partial<AlarmHelpEntry>> = ALARM_HELP;
export const hasSimHelp = true;
const describe = { describeTrip, describeFault };

// ---- local entries ----
const H: Record<string, AlarmHelpEntry> = {
  PZR_PRESS_LO: {
    meaning: 'Reactor coolant pressure is below 2185 psig. At 1865 psig the reactor trips; at 1807 psig safety injection fires.',
    causes: ['Pressurizer spray stuck or left open', 'PORV open or leaking', 'Heaters off or in OFF', 'Fast cooldown (steam dumps, steam leak, big load increase)', 'Coolant leak (LOCA, SG tube leak)'],
    actions: [
      'PRESSURIZER board: BACKUP HEATERS to ON.',
      'PRESSURIZER board: SPRAY CONTROL to MAN, SPRAY DEMAND to 0 %. Check the SPRAY VALVE meter actually closes.',
      'PRESSURIZER board: if the PORV OPEN lamp is lit, PORV PCV-455A to CLOSE. If it stays open, PORV BLOCK VLV to CLOSE.',
      'FEEDWATER & STEAM DUMP board: check STEAM DUMP DEM; if dumps are wide open, the RCS is being overcooled.',
      'If pressure keeps falling with everything closed, you have a leak: watch PZR level, trip the reactor before 1865 psig.',
    ],
  },
  PZR_PRESS_LOLO: {
    meaning: 'Pressure is below the safety injection setpoint (1807 psig). SI and a reactor trip follow unless blocked.',
    causes: ['Loss of coolant', 'Stuck-open PORV or spray', 'Severe overcooling'],
    actions: [
      'Verify reactor tripped and SI flowing (SAFETY SYSTEMS & ELECTRICAL board, SI FLOW meter).',
      'Isolate any open PORV: PRESSURIZER board, PORV BLOCK VLV to CLOSE.',
      'Keep at least one RCP running while subcooling margin is above 30 °F.',
      'Do not reset SI until pressure is recovering and PZR level is back on scale.',
    ],
  },
  PZR_PRESS_HI: {
    meaning: 'Pressure is above 2310 psig. The PORV lifts at 2335, the reactor trips at 2385, code safeties lift at 2485.',
    causes: ['Heat-up: turbine load dropped faster than reactor power', 'Heaters stuck on or switched to ON', 'Spray in manual and closed', 'Insurge from Tavg rising'],
    actions: [
      'PRESSURIZER board: BACKUP HEATERS to AUTO (or OFF).',
      'PRESSURIZER board: SPRAY CONTROL AUTO, or MAN with SPRAY DEMAND 50–100 % until pressure turns.',
      'REACTOR CONTROL board: if Tavg is above Tref, insert rods (hold right mouse on ROD MOTION).',
      'Check the turbine is still carrying load and steam dumps are armed.',
    ],
  },
  PZR_HTR_OFF: {
    meaning: 'Backup heaters are switched OFF while pressure is below normal.',
    causes: ['BACKUP HEATERS switch left in OFF'],
    actions: ['PRESSURIZER board: BACKUP HEATERS to AUTO.'],
  },
  PZR_PORV_OPEN: {
    meaning: 'A pressurizer power-operated relief valve is open, venting steam to the relief tank.',
    causes: ['Pressure reached 2335 psig (normal response)', 'Valve stuck open (fault)', 'PORV switch in OPEN'],
    actions: [
      'PRESSURIZER board: PORV PCV-455A to AUTO or CLOSE once pressure is below 2300 psig.',
      'If the PORV OPEN lamp stays lit with pressure falling: PORV BLOCK VLV to CLOSE.',
      'Watch the PRT alarm: the relief tank ruptures if the PORV keeps blowing.',
    ],
  },
  PZR_SAFETY_OPEN: {
    meaning: 'A pressurizer code safety valve has lifted (2485 psig). It cannot be isolated.',
    causes: ['Severe overpressure: loss of heat sink, rods withdrawn with turbine off, heaters on'],
    actions: [
      'Trip the reactor if not already tripped (REACTOR CONTROL, REACTOR TRIP).',
      'Restore heat removal: steam dumps (FEEDWATER & STEAM DUMP) or AFW to the SGs.',
      'PRESSURIZER board: SPRAY to MAN 100 %, HEATERS OFF until pressure falls below 2335.',
    ],
  },
  PRT_HI: {
    meaning: 'The pressurizer relief tank is hot or pressurized from relief valve discharge. Its rupture disk opens into containment.',
    causes: ['PORV or safety valve discharging'],
    actions: ['Stop the discharge: PRESSURIZER board, close the PORV or its BLOCK VLV.', 'Lower RCS pressure with spray if a safety valve is lifting.'],
  },
  PZR_LEVEL_HI: {
    meaning: 'Pressurizer level above 70 %. Above P-7 the reactor trips at 92 %; a solid pressurizer can relieve water through the valves.',
    causes: ['Charging in manual set too high', 'Letdown isolated', 'Tavg rising (insurge)', 'Safety injection flow'],
    actions: [
      'CVCS / BORON CONTROL board: CHARGING CTRL to AUTO, or reduce CHARGING DEMAND.',
      'CVCS / BORON CONTROL board: LETDOWN ISOL to NORM if letdown is isolated.',
      'If Tavg is high, bring it back to Tref (rods in or more turbine load).',
    ],
  },
  PZR_LEVEL_LO: {
    meaning: 'Pressurizer level below 17 %. Letdown isolates and heaters cut out to protect themselves.',
    causes: ['Coolant leak', 'Charging lost or in manual set low', 'Cooldown (outsurge)'],
    actions: [
      'CVCS / BORON CONTROL board: CHARGING CTRL AUTO, or MAN with CHARGING DEMAND up.',
      'Check LETDOWN ISOL; isolate letdown to save inventory.',
      'If level keeps falling with full charging, suspect a leak: check RCS LEAKAGE GPM on SAFETY SYSTEMS & ELECTRICAL.',
    ],
  },
  PZR_LEVEL_DEV: {
    meaning: 'Pressurizer level is more than 5 % away from its program.',
    causes: ['Charging in manual', 'Temperature transient', 'Letdown isolated'],
    actions: ['CVCS / BORON CONTROL board: CHARGING CTRL to AUTO.', 'Check LETDOWN ISOL is NORM.'],
  },
  TAVG_TREF_DEV: {
    meaning: 'Average coolant temperature is more than 5 °F away from the program for the current turbine load.',
    causes: ['Rods in manual during a load change', 'Boron change', 'Xenon building or burning out', 'Turbine load changing faster than rods follow'],
    actions: [
      'REACTOR CONTROL board: watch TAVG − TREF. Tavg high: hold right mouse on ROD MOTION (insert). Tavg low: hold left (withdraw).',
      'Above 15 % load, ROD CONTROL MODE to AUTO lets the rods follow.',
      'TURBINE / GENERATOR board: slow the RAMP MW/MIN while rods catch up.',
    ],
  },
  TAVG_LOLO: {
    meaning: 'Tavg below 553 °F (P-12): steam dumps are blocked to stop a cooldown and the moderator is adding positive reactivity.',
    causes: ['Overcooling: steam dumps, steam leak, too much feed or AFW', 'Low power with load on the turbine'],
    actions: [
      'FEEDWATER & STEAM DUMP board: check STEAM DUMP DEM and DUMP PRESS SETPT (1092 psig normal).',
      'STEAM GENERATORS board: throttle feed (FRV DEMAND) if levels are high.',
      'Reduce turbine load or raise reactor power to restore 557 °F.',
    ],
  },
  SUR_HI: {
    meaning: 'Startup rate above 1.5 decades per minute. The reactor trips at 5 dpm below P-10.',
    causes: ['Rods withdrawn too far or too fast near criticality', 'Dilution still running', 'Cooldown adding reactivity'],
    actions: [
      'REACTOR CONTROL board: release the ROD MOTION lever. If SUR keeps rising, hold right mouse (insert) a few steps.',
      'CVCS / BORON CONTROL board: MAKEUP MODE to AUTO to stop any dilution.',
      'Aim for a steady 0.3–1 dpm and wait.',
    ],
  },
  IR_ROD_STOP: {
    meaning: 'Intermediate-range current is above the C-1 rod stop: withdrawal is blocked until power comes down or P-10 is reached.',
    causes: ['Power raised in the intermediate range faster than expected'],
    actions: ['Let power settle; continue raising power with the turbine and steam dumps, not rods, until P-10.'],
  },
  PR_ROD_STOP: {
    meaning: 'Power range above 103 % (C-2): rod withdrawal is blocked.',
    causes: ['Overpower from a load swing or xenon burnout'],
    actions: ['REACTOR CONTROL board: insert rods slightly or borate to bring power below 100 %.', 'TURBINE / GENERATOR: lower LOAD SETPOINT a little.'],
  },
  PR_HI: {
    meaning: 'Power range above 103 %. The reactor trips at 109 %.',
    causes: ['Rod withdrawal', 'Dilution', 'Overcooling (steam demand above reactor power)'],
    actions: ['Lower TURBINE / GENERATOR LOAD SETPOINT by 20–50 MW.', 'REACTOR CONTROL: insert rods until under 100 %.', 'CVCS / BORON CONTROL: stop dilution (MAKEUP MODE AUTO).'],
  },
  OTDT_STOP: {
    meaning: 'Loop ΔT is close to the overtemperature or overpower trip: rods are blocked and turbine load is being run back.',
    causes: ['Power too high for current pressure or Tavg', 'Low pressure lowers the OTΔT setpoint', 'Axial flux out of band'],
    actions: ['Reduce turbine load 5–10 %.', 'Restore PZR pressure to 2235 psig (PRESSURIZER board).', 'Bring axial offset back into band (rods).'],
  },
  AXIAL_FLUX: {
    meaning: 'Axial flux difference is outside its target band; the core power is tilted top or bottom.',
    causes: ['Control bank D too deep or too high', 'Xenon redistribution after a power change'],
    actions: ['REACTOR CONTROL board: rods in pushes flux to the bottom (negative), rods out pushes it up. Make small moves and compensate with boron.'],
  },
  ROD_BOTTOM: {
    meaning: 'A rod is fully inserted while its bank is not demanded in: a dropped rod.',
    causes: ['Dropped rod (gripper failure)'],
    actions: [
      'REACTOR CONTROL board: ROD CONTROL MODE to MAN so the other banks do not withdraw to compensate.',
      'Reduce turbine load to match the lost power.',
      'Watch axial and quadrant flux; above 50 % a dropped rod usually means a controlled shutdown.',
    ],
  },
  ROD_DEV: {
    meaning: 'A rod is out of step with its bank: it is stuck.',
    causes: ['Stuck rod (mechanical binding)'],
    actions: ['REACTOR CONTROL board: stop moving rods (ROD CONTROL MODE MAN).', 'Hold power steady with boron. A stuck rod may not fall on a trip, so keep extra shutdown margin (borate).'],
  },
  RIL_LO: {
    meaning: 'Control banks are close to the rod insertion limit for this power.',
    causes: ['Xenon building in', 'Power reduced with rods instead of boron'],
    actions: ['CVCS / BORON CONTROL board: MAKEUP MODE DIL, MAKEUP RATE 20–40 gpm. Rods in AUTO will withdraw as boron comes out. Return to AUTO when banks are above the limit.'],
  },
  RIL_LOLO: {
    meaning: 'Control banks are below the rod insertion limit: shutdown margin is not guaranteed.',
    causes: ['Rods driven in to compensate for xenon or power changes'],
    actions: ['Dilute (CVCS / BORON CONTROL, MAKEUP MODE DIL) or reduce power until rods are back above the limit.'],
  },
  SDM_LO: {
    meaning: 'With the reactor tripped, the shutdown margin is below 1300 pcm: the core is too close to critical.',
    causes: ['Xenon decaying after a trip', 'Cooldown', 'Stuck rod', 'Dilution'],
    actions: ['CVCS / BORON CONTROL board: MAKEUP MODE BOR, MAKEUP RATE 60–120 gpm until the alarm clears.', 'Stop any cooldown (steam dumps, feed).'],
  },
  SR_HI_SHUTDOWN: {
    meaning: 'Source range counts are rising while the reactor is shut down: you may be approaching criticality unintentionally.',
    causes: ['Boron dilution', 'Cooldown', 'Xenon decay'],
    actions: ['CVCS / BORON CONTROL board: stop dilution, then BORATE.', 'Stop any cooldown.'],
  },
  BORON_DILUTION: {
    meaning: 'Primary-grade water is being added: boron is going down and reactivity is going up.',
    causes: ['MAKEUP MODE in DIL'],
    actions: ['Watch SUR and Tavg. Return CVCS / BORON CONTROL MAKEUP MODE to AUTO when the batch is done.'],
  },
  LETDOWN_ISOL: {
    meaning: 'Letdown flow is isolated: PZR level will rise and boron changes slow down.',
    causes: ['LETDOWN ISOL switch in ISOL', 'Low PZR level automatic isolation', 'Safety injection'],
    actions: ['CVCS / BORON CONTROL board: once PZR level is above 17 %, LETDOWN ISOL to NORM.'],
  },
  CHG_FLOW: {
    meaning: 'Charging flow is outside its normal range.',
    causes: ['Charging in manual', 'Pressurizer level far from program'],
    actions: ['CVCS / BORON CONTROL board: CHARGING CTRL to AUTO.'],
  },
  SUBCOOL_LO: {
    meaning: 'Coolant is within 30 °F of boiling at the core exit.',
    causes: ['Pressure falling (leak, PORV, spray)', 'Core exit temperature rising (loss of heat sink)'],
    actions: ['Restore pressure: PRESSURIZER heaters ON, close spray and PORV.', 'Restore heat sink: feed the SGs (FEEDWATER & STEAM DUMP, STEAM GENERATORS).', 'Below 0 °F margin, stop the RCPs only if safety injection is flowing.'],
  },
  CET_HI: {
    meaning: 'Core exit thermocouples above 660 °F.',
    causes: ['Loss of heat sink', 'Low flow (RCP trip)', 'Overpower'],
    actions: ['Trip the reactor if at power.', 'Get feedwater to the SGs and steam out (dumps or SG PORVs).'],
  },
  DNBR_LO: {
    meaning: 'Departure-from-nucleate-boiling ratio below 1.5. Below 1.0 fuel cladding overheats.',
    causes: ['Low pressure', 'Low flow', 'High power or high Tavg', 'Axial tilt'],
    actions: ['Reduce power (turbine load down, rods in).', 'Restore PZR pressure to 2235 psig.', 'Trip the reactor if DNBR keeps falling.'],
  },
  SG_LEVEL_LO: {
    meaning: 'Steam generator narrow-range level below 30 %. Lo-lo at 17 % trips the reactor.',
    causes: ['Feed pump trip', 'Feed regulating valve failed closed or in manual', 'Steam flow above feed flow'],
    actions: [
      'STEAM GENERATORS board: that SG’s FRV MODE to MAN and raise FRV DEMAND, or back to AUTO if it was in manual.',
      'FEEDWATER & STEAM DUMP board: check MFP A / MFP B running; start one if needed.',
      'If level cannot be held, reduce turbine load. AFW pumps start automatically at lo-lo.',
    ],
  },
  SG_LEVEL_LOLO: {
    meaning: 'Steam generator level below 17 %: the reactor trips and aux feed starts.',
    causes: ['Loss of feedwater'],
    actions: ['Verify AFW flow on the STEAM GENERATORS board (AFW FLOW GPM).', 'FEEDWATER & STEAM DUMP: AFW PUMP switches to START if not running.', 'Restore main feed once levels recover.'],
  },
  SG_LEVEL_HI: {
    meaning: 'Steam generator level above 60 %. At 78 % the turbine trips and feed isolates to protect it from water.',
    causes: ['FRV failed open or in manual set high', 'Swell during a load increase'],
    actions: ['STEAM GENERATORS board: FRV MODE MAN and lower FRV DEMAND, then back to AUTO.', 'Stop or throttle AFW if running.'],
  },
  SG_LEVEL_HIHI: {
    meaning: 'Steam generator level 78 % or more: turbine trip and feedwater isolation (P-14). Water may reach the steam lines.',
    causes: ['Overfeeding'],
    actions: ['STEAM GENERATORS board: FRV DEMAND to 0 % in MAN.', 'FEEDWATER & STEAM DUMP: stop AFW pumps feeding that SG once level is falling.'],
  },
  SG_FLOW_MISMATCH: {
    meaning: 'Steam flow and feed flow on this SG differ by more than 12 %.',
    causes: ['FRV not following', 'Steam leak'],
    actions: ['STEAM GENERATORS board: check FRV POS and MODE; put it in AUTO or adjust manually.'],
  },
  MFP_TRIP: {
    meaning: 'A main feed pump has tripped. One pump cannot feed more than about 60 % power.',
    causes: ['Pump fault', 'Loss of power'],
    actions: ['TURBINE / GENERATOR board: reduce LOAD SETPOINT below ~600 MW quickly.', 'FEEDWATER & STEAM DUMP board: restart the pump (MFP START/STOP) or start the other.', 'Watch SG levels: AFW starts at lo-lo.'],
  },
  FW_ISOL: {
    meaning: 'Feedwater isolation: regulating valves are shut.',
    causes: ['SG level hi-hi', 'Safety injection', 'Reactor trip with low Tavg'],
    actions: ['Feed with AFW (FEEDWATER & STEAM DUMP, AFW PUMP switches).', 'Clear the cause, then reset.'],
  },
  STEAMLINE_P_LO: {
    meaning: 'A steam line is below 800 psig. At 600 psig safety injection actuates.',
    causes: ['Steam line break', 'Steam dumps stuck wide open', 'Large cooldown'],
    actions: ['FEEDWATER & STEAM DUMP board: STEAM DUMP MODE to OFF if dumps are open.', 'Trip the reactor and turbine if pressure is falling fast.'],
  },
  COND_VAC_LO: {
    meaning: 'Condenser vacuum below 24 inHg. The turbine trips at 20 and the steam dumps become unavailable.',
    causes: ['Loss of circulating water', 'Air in-leakage', 'Too much steam dumped'],
    actions: ['Reduce turbine load and steam dump flow.', 'Prepare for a turbine trip.'],
  },
  TURB_TRIP: {
    meaning: 'The main turbine has tripped. Above P-9 (50 %) that trips the reactor; below it, steam dumps take the steam.',
    causes: ['Reactor trip', 'Low vacuum', 'SG hi-hi level', 'Overspeed', 'Spurious trip'],
    actions: ['FEEDWATER & STEAM DUMP board: verify steam dumps are holding Tavg / pressure.', 'Below P-9: reduce reactor power with rods to 5–10 %.', 'Fix the cause, then TURBINE / GENERATOR LATCH and resync.'],
  },
  GEN_OVERSPEED: {
    meaning: 'Turbine above 1854 rpm. It trips at 1980.',
    causes: ['Load rejected with valves still open (breaker opened)'],
    actions: ['TURBINE / GENERATOR board: press TURBINE TRIP if speed keeps rising.'],
  },
  SI_ACT: {
    meaning: 'Safety injection has actuated: ECCS pumps inject borated water, the reactor and turbine trip, feed isolates.',
    causes: ['PZR pressure below 1807 psig', 'Steam line pressure below 600 psig', 'Containment pressure above 3.5 psig', 'Manual'],
    actions: [
      'Verify reactor tripped, SI FLOW on SAFETY SYSTEMS & ELECTRICAL board.',
      'Verify AFW flow to the SGs.',
      'Find the cause: leak (PZR level, CTMT PRESSURE), steam break (steam line pressure), stuck PORV.',
      'Once pressure is stable above 2000 psig and PZR level returns, press SI RESET.',
    ],
  },
  RX_TRIP: {
    meaning: 'The reactor trip breakers are open and all rods have fallen in.',
    causes: [],
    actions: [
      'Confirm power is falling: NUCLEAR INSTRUMENTATION, SUR negative (about −1/3 dpm).',
      'Confirm the turbine tripped and steam dumps / AFW are holding Tavg near 557 °F.',
      'Press ACK on REACTOR CONTROL to silence, then find the first-out cause below and fix it.',
      'Once no trip signal remains: REACTOR CONTROL, TRIP RESET. Then restart from the procedure binder (Tab).',
    ],
  },
  LOOP: {
    meaning: 'Offsite power lost: RCPs, main feed pumps and condenser circulating water stop. Diesels carry the safety buses.',
    causes: ['Grid disturbance'],
    actions: ['Verify DG A / DG B RUNNING on SAFETY SYSTEMS & ELECTRICAL.', 'Verify AFW flow; natural circulation will cool the core.', 'Do not try to restart RCPs until power returns.'],
  },
  RCP_TRIP: {
    meaning: 'A reactor coolant pump has stopped. Loop flow drops and reverses; above P-8 one loop low flow trips the reactor.',
    causes: ['Pump or motor fault', 'Loss of power'],
    actions: ['Above 48 %: expect a reactor trip; follow RX_TRIP actions.', 'Below 48 %: reduce power below 40 %. REACTOR COOLANT SYSTEM board, try RCP START once.'],
  },
  LOOP_FLOW_LO: {
    meaning: 'Reactor coolant loop flow below 90 %.',
    causes: ['RCP tripped or coasting down'],
    actions: ['REACTOR COOLANT SYSTEM board: check the RCP RUN lamps; restart a stopped pump with RCP START.'],
  },
  CNMT_PRESS_HI: {
    meaning: 'Containment pressure is rising: steam or water is escaping inside containment.',
    causes: ['LOCA', 'Steam line break inside containment', 'PRT rupture disk blown'],
    actions: ['Trip the reactor; expect SI at 3.5 psig and sprays at 28 psig.', 'Isolate the source: PORV BLOCK VLV, steam dumps.'],
  },
  MS_RAD_HI: {
    meaning: 'Radiation detected in main steam: primary coolant is leaking into a steam generator.',
    causes: ['SG tube leak'],
    actions: ['Reduce power. Find the SG whose level rises with feed flow low.', 'Cool down and depressurize below that SG’s pressure to stop the leak.'],
  },
  RCS_LEAK: {
    meaning: 'Reactor coolant leakage above 1 gpm.',
    causes: ['Pipe crack (small LOCA)', 'Valve seat leakage', 'SG tube leak'],
    actions: ['Watch PZR level and charging flow. Charging in AUTO will make up small leaks.', 'If PZR level falls with full charging, shut down.'],
  },
};

/** Specific advice by first-out trip. */
const TRIP_FIX: Partial<Record<TripId, string>> = {
  MANUAL: 'You tripped it. Stabilize, then reset when ready.',
  PR_HIGH_FLUX_HI: 'Power overshot 109 %. Next time keep turbine load ramps slow and watch for xenon burnout.',
  PR_HIGH_FLUX_LO: 'Power exceeded 25 % below P-10. Raise power slowly through 10 % so P-10 lights before 25 %.',
  PR_POS_RATE: 'Power rose too fast. Withdraw rods in shorter pulls.',
  IR_HIGH_FLUX: 'Intermediate range high flux below P-10. Slow the power increase through the intermediate range.',
  SR_HIGH_FLUX: 'Source range reached 1e5 cps before P-6. Pull rods in shorter pulls and let counts settle.',
  OTDT: 'Overtemperature ΔT: power was too high for the pressure and temperature. Hold pressure at 2235 and Tavg on program.',
  OPDT: 'Overpower ΔT: too much power. Keep below 100 %.',
  PZR_PRESS_LO: 'Pressure fell below 1865 psig. Find what dropped it: spray, PORV, heaters off or a leak.',
  PZR_PRESS_HI: 'Pressure exceeded 2385 psig. Keep heaters and spray in AUTO and avoid heat-ups without load.',
  PZR_LEVEL_HI: 'Pressurizer level reached 92 %. Keep charging in AUTO and letdown in service.',
  RCS_FLOW_LO: 'Coolant flow lost in a loop. Check RCPs on REACTOR COOLANT SYSTEM.',
  RCP_UNDERVOLTAGE: 'Pump bus voltage lost. Check offsite power.',
  SG_LEVEL_LOLO: 'A steam generator boiled down to 17 %. Check main feed pumps and FRVs; AFW should now be feeding.',
  TURBINE_TRIP: 'The turbine tripped above 50 % power. Find why the turbine tripped (vacuum, SG level, overspeed).',
  SAFETY_INJECTION: 'SI fired. See the SAFETY INJECTION alarm for the cause.',
  STARTUP_RATE: 'SUR exceeded 5 dpm. Near criticality, pull in short pulls and wait for SUR to settle under 1 dpm.',
};

const FAULT_FIX: Partial<Record<FaultId, string[]>> = {
  STUCK_ROD: ['REACTOR CONTROL: ROD CONTROL MODE to MAN.', 'Control power with boron; borate extra margin before any planned shutdown.'],
  DROPPED_ROD: ['REACTOR CONTROL: ROD CONTROL MODE to MAN.', 'Reduce turbine load to match. Watch axial offset.'],
  RCP_TRIP: ['Above 48 % power the reactor trips. Below that, reduce power under 40 % and try RCP START on REACTOR COOLANT SYSTEM.'],
  MFP_TRIP: ['Reduce load below ~600 MW now (TURBINE / GENERATOR LOAD SETPOINT).', 'FEEDWATER & STEAM DUMP: restart a main feed pump.'],
  FEED_VALVE_FAIL: ['STEAM GENERATORS: the failed SG level will drift. Switch that FRV MODE to MAN; if it does not respond, use AFW and reduce power.'],
  PZR_PORV_STUCK_OPEN: ['PRESSURIZER: PORV BLOCK VLV to CLOSE.'],
  PZR_SPRAY_STUCK_OPEN: ['PRESSURIZER: BACKUP HEATERS ON. If pressure keeps falling, trip the reactor and stop the RCP feeding the spray line.'],
  SG_TUBE_LEAK: ['Reduce power. Identify the SG with rising level. Cool down below its pressure.'],
  SMALL_LOCA: ['Charging to max (CVCS MAN 100 %). Trip before pressure reaches 1865 psig; verify SI.'],
  LOSS_OF_OFFSITE_POWER: ['Verify diesels running and AFW feeding. Natural circulation cools the core.'],
  TURBINE_TRIP_SPURIOUS: ['Below 50 %: steam dumps take the load; reduce power, re-latch and resync. Above 50 %: the reactor trips.'],
  STEAM_LINE_BREAK: ['Trip reactor and turbine. Steam dumps OFF. Isolate AFW to the faulted SG once identified.'],
  CCW_PUMP_TRIP: ['Start the standby component cooling pump. Without cooling, RCP seals and bearings overheat: reduce power and be ready to stop RCPs.'],
  CIRC_WATER_PUMP_TRIP: ['Condenser vacuum will fall: reduce turbine load and steam dump flow. Restart the circ water pump if possible.'],
  CONDENSATE_PUMP_TRIP: ['MFP suction pressure falls: start the standby condensate pump and reduce load.'],
  INSTRUMENT_FAIL: ['Compare redundant indications (meters vs CRT). Put the affected controller in MAN.'],
};

export function tripAdvice(id: TripId | null | undefined): string {
  if (!id) return '';
  const d = describe.describeTrip?.(id) ?? '';
  const fix = TRIP_FIX[id] ?? '';
  return [d, fix].filter(Boolean).join(' ');
}

export function faultHelp(id: FaultId, description: string): AlarmHelpEntry {
  return {
    meaning: description || describe.describeFault?.(id) || id,
    causes: [],
    actions: FAULT_FIX[id] ?? ['Find which indications are wrong and put that system in manual.'],
  };
}

/** Normalise SG3_LEVEL_LO -> SG_LEVEL_LO etc. Returns [genericId, unitNumber|null]. */
function generic(id: string): [string, number | null] {
  const m = id.match(/^(SG|RCP|LOOP)(\d)_(.+)$/);
  if (!m) return [id, null];
  const n = Number(m[2]);
  if (m[1] === 'RCP') return [`RCP_${m[3]}`, n];
  if (m[1] === 'LOOP') return [`LOOP_${m[3]}`, n];
  return [`SG_${m[3]}`, n];
}

export function alarmHelp(id: string, severity: string): AlarmHelpEntry {
  const sim = SIM_HELP[id];
  const [gid, n] = generic(id);
  const local = H[id] ?? H[gid];
  const simG = SIM_HELP[gid];
  const pick = (k: keyof AlarmHelpEntry) => (sim?.[k] as never) ?? (simG?.[k] as never) ?? (local?.[k] as never);
  const meaning: string | undefined = pick('meaning');
  const causes: string[] | undefined = pick('causes');
  const actions: string[] | undefined = pick('actions');
  const unit = n ? ` (unit ${n})` : '';
  return {
    meaning: meaning ? meaning + (n && !sim ? unit : '') : genericMeaning(severity),
    causes: causes ?? [],
    actions:
      actions ?? [
        'Look at the annunciator panel and the board named in the alarm label.',
        'Press ACK on REACTOR CONTROL to silence, then stabilize power, pressure, Tavg and levels.',
      ],
  };
}

function genericMeaning(sev: string): string {
  if (sev === 'info') return 'Status indication: normal for some plant conditions.';
  if (sev === 'warning') return 'A parameter is drifting outside its normal band. Not urgent yet.';
  return 'A parameter has crossed an alarm setpoint. Act before it reaches a trip.';
}

// ---------------- live values ----------------
type Row = [string, string];
type Rel = (s: PlantState, c: PlantControls, n: number | null) => Row[];
const f0 = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '—');
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const exp = (v: number) => (Number.isFinite(v) && v > 0 ? v.toExponential(1) : '0');

const PZR: Rel = (s, c) => [
  ['PZR pressure', `${f0(s.rcsPressure)} psig (normal 2235)`],
  ['Backup heaters', `${c.przHeaters.toUpperCase()} · ${f0(s.przHeaterKW)} kW`],
  ['Spray', `${c.przSprayMode.toUpperCase()} · ${f0(s.przSprayPos * 100)} % open`],
  ['PORV', `${c.porvMode.toUpperCase()} · ${s.porvOpen ? 'OPEN' : 'shut'} · block ${c.porvBlockValveOpen ? 'open' : 'CLOSED'}`],
  ['Safety valves', s.safetyValvesOpen ? 'LIFTING' : 'shut'],
];
const LEVEL: Rel = (s, c) => [
  ['PZR level', `${f1(s.przLevel)} % (program ${f1(s.przLevelProgram)} %)`],
  ['Charging', `${c.chargingMode.toUpperCase()} · ${f0(s.chargingFlowGpm)} gpm`],
  ['Letdown', `${c.letdownIsolated ? 'ISOLATED' : 'normal'} · ${f0(s.letdownFlowGpm)} gpm`],
  ['Tavg', `${f1(s.tAvg)} °F`],
];
const TEMP: Rel = (s, c) => [
  ['Tavg / Tref', `${f1(s.tAvg)} / ${f1(s.tRef)} °F (${(s.tAvg - s.tRef >= 0 ? '+' : '') + f1(s.tAvg - s.tRef)})`],
  ['Rod control', `${c.rodMode.toUpperCase()} · bank ${c.rodBankSelect === 'MANUAL_SEQ' ? 'SEQ' : c.rodBankSelect}`],
  ['Power', `${f1(s.powerRangePct)} % · ${f0(s.grossMWe)} MWe`],
  ['Steam dumps', `${c.steamDumpMode.toUpperCase()} · ${f0(s.steamDumpDemand * 100)} %`],
];
const NUC: Rel = (s, c) => [
  ['Startup rate', `${f1(s.startupRateDpm * 100) === '—' ? '—' : s.startupRateDpm.toFixed(2)} dpm`],
  ['Source range', `${exp(s.sourceRangeCps)} cps`],
  ['Intermediate', `${exp(s.intermediateRangeAmps)} A`],
  ['Power range', `${f1(s.powerRangePct)} %`],
  ['Control banks', `CA ${f0(s.rods.CA)} CB ${f0(s.rods.CB)} CC ${f0(s.rods.CC)} CD ${f0(s.rods.CD)}`],
  ['Makeup', `${c.makeupMode.toUpperCase()} · ${f0(c.makeupRateGpm)} gpm · ${f0(s.boronPpm)} ppm`],
];
const RODS: Rel = (s, c) => [
  ['Banks', `SA ${f0(s.rods.SA)} SB ${f0(s.rods.SB)} · CA ${f0(s.rods.CA)} CB ${f0(s.rods.CB)} CC ${f0(s.rods.CC)} CD ${f0(s.rods.CD)}`],
  ['Rod control', `${c.rodMode.toUpperCase()}`],
  ['Boron', `${f0(s.boronPpm)} ppm · makeup ${c.makeupMode.toUpperCase()}`],
  ['Axial offset', `${f1(s.axialOffset)} %`],
  ['Power', `${f1(s.powerRangePct)} %`],
];
const SG: Rel = (s, c, n) => {
  const rows: Row[] = [];
  const idx = n ? [n - 1] : [0, 1, 2, 3];
  for (const i of idx) {
    const l = s.loops[i];
    if (!l) continue;
    rows.push([`SG ${i + 1}`, `level ${f0(l.sgLevel)} % · feed ${f0(l.feedFlow)} % · steam ${f0(l.steamFlow)} % · FRV ${c.feedMode[i]?.toUpperCase()} ${f0(l.feedValvePos * 100)} %`]);
  }
  rows.push(['Main feed pumps', s.mainFeedPumpsRunning.map((r, i) => `${'AB'[i]} ${r ? 'RUN' : 'off'}`).join(' · ')]);
  rows.push(['AFW', `${s.auxFeedPumpsRunning.filter(Boolean).length} pumps · ${f0(s.loops.reduce((a, l) => a + l.auxFeedFlow, 0))} gpm`]);
  return rows;
};
const STEAM: Rel = (s, c) => [
  ['Steam header', `${f0(s.steamHeaderPressure)} psig`],
  ['Steam dumps', `${c.steamDumpMode.toUpperCase()} · demand ${f0(s.steamDumpDemand * 100)} % · setpoint ${f0(c.steamDumpPressureSetpoint)}`],
  ['Condenser vacuum', `${f1(s.condenserVacuum)} inHg`],
  ['SG pressures', s.loops.map((l) => f0(l.sgPressure)).join(' / ') + ' psig'],
];
const TURB: Rel = (s, c) => [
  ['Turbine', `${f0(s.turbineSpeedRpm)} rpm · ${s.turbineLatched ? 'latched' : 'TRIPPED'}`],
  ['Generator', `${s.generatorBreakerClosed ? 'on grid' : 'breaker OPEN'} · ${f0(s.grossMWe)} MWe`],
  ['Load setpoint', `${f0(c.turbineLoadSetpointMW)} MW at ${f0(c.turbineRampRateMWpm)} MW/min`],
  ['Condenser vacuum', `${f1(s.condenserVacuum)} inHg`],
  ['Power', `${f1(s.powerRangePct)} %`],
];
const CORE: Rel = (s) => [
  ['RCS pressure', `${f0(s.rcsPressure)} psig`],
  ['Subcooling', `${f0(s.subcoolingMargin)} °F`],
  ['Core exit', `${f0(s.coreExitTemp)} °F`],
  ['DNBR', Number.isFinite(s.dnbr) ? s.dnbr.toFixed(2) : '∞'],
  ['SI flow', `${f0(s.siFlowGpm)} gpm${s.siActuated ? ' (SI ACTUATED)' : ''}`],
  ['RCPs running', `${s.loops.filter((l) => l.rcpRunning).length}/4`],
  ['Containment', `${f1(s.containmentPressure)} psig · ${exp(s.containmentRadiation)} R/hr`],
];
const RCP: Rel = (s) => s.loops.map((l, i) => [`Loop ${i + 1}`, `RCP ${l.rcpRunning ? 'RUN' : 'STOPPED'} · flow ${f0(l.flow)} %`] as Row);
const CVCS: Rel = (s, c) => [
  ['Boron', `${f0(s.boronPpm)} ppm`],
  ['Makeup', `${c.makeupMode.toUpperCase()} · ${f0(c.makeupRateGpm)} gpm`],
  ['Charging / letdown', `${f0(s.chargingFlowGpm)} / ${f0(s.letdownFlowGpm)} gpm`],
  ['PZR level', `${f1(s.przLevel)} %`],
];
const TRIP: Rel = (s) => [
  ['First out', s.firstOut ?? '—'],
  ['Trip signals now', s.tripSignals.length ? s.tripSignals.join(', ') : 'none (TRIP RESET allowed)'],
  ['Power', `${f1(s.powerRangePct)} % · SUR ${s.startupRateDpm.toFixed(2)} dpm`],
  ['Tavg', `${f1(s.tAvg)} °F`],
  ['PZR pressure', `${f0(s.rcsPressure)} psig`],
  ['SG levels', s.loops.map((l) => f0(l.sgLevel)).join(' / ') + ' %'],
];

const COND: Rel = (s, c) => {
  const b = s.bop;
  if (!b) return STEAM(s, c, null);
  return [
    ['Condenser vacuum', `${f1(s.condenserVacuum)} inHg · air removal ${b.condenserAirRemoval.toUpperCase()}`],
    ['Circ water pumps', b.circWaterRunning.map((r) => (r ? 'RUN' : 'off')).join(' · ')],
    ['Condensate pumps', b.condensateRunning.map((r) => (r ? 'RUN' : 'off')).join(' · ')],
    ['MFP suction', `${f0(b.mfpSuctionPsig)} psig`],
    ['Hotwell level', `${f0(b.hotwellLevelPct)} %`],
    ['Feedwater', `${f0(b.feedwaterTempF)} °F · heaters ${b.feedwaterHeatersInService ? 'in service' : 'OUT'}`],
  ];
};
const TURB2: Rel = (s, c) => {
  const b = s.bop;
  const rows = TURB(s, c, null);
  if (!b) return rows;
  const t = b.turbine;
  return [
    rows[0],
    ['Speed target', `${f0(t.speedSetpointRpm)} rpm at ${f0(c.turbineAccelRpmPerMin ?? 0)} rpm/min${t.inCriticalBand ? ' · IN CRITICAL BAND' : ''}`],
    ['Rotor / steam', `${f0(t.rotorTempF)} / ${f0(t.steamInletTempF)} °F`],
    ['Diff expansion', `${f0(t.diffExpansionPct)} %`],
    ['Vibration', `${f1(t.vibrationMils)} mils (trip 14) · eccentricity ${f1(t.eccentricityMils)}`],
    ['Turning gear', t.turningGearEngaged ? 'engaged' : 'off'],
  ];
};
const GEN: Rel = (s) => {
  const g = s.bop?.generator;
  if (!g) return [];
  return [
    ['Field breaker', g.fieldBreakerClosed ? 'CLOSED' : 'open'],
    ['Gen / grid kV', `${f1(g.terminalKv)} / ${f1(g.gridKv)} kV`],
    ['Slip', `${g.slipHz.toFixed(3)} Hz · synchroscope ${f0(g.syncPhaseDeg)}°`],
    ['Output', `${f0(s.grossMWe)} MWe gross · ${f0(g.netMWe)} net · ${f0(g.mvar)} MVAR`],
    ['Generator breaker', s.generatorBreakerClosed ? 'CLOSED' : 'open'],
  ];
};
const ELEC: Rel = (s) => {
  const b = s.bop;
  if (!b) return [];
  return [
    ['House loads', `${b.electrical.houseLoadsOn} · ${f0(b.electrical.houseLoadMW)} MW`],
    ['CCW pumps', b.ccw.pumpsRunning.map((r) => (r ? 'RUN' : 'off')).join(' · ') + ` · ${f0(b.ccw.supplyTempF)} °F · flow ${f0(b.ccw.flowPct)} %`],
    ['Service water', b.ccw.serviceWaterRunning.map((r) => (r ? 'RUN' : 'off')).join(' · ')],
    ['Diesels', `${s.dieselGeneratorsRunning.map((r) => (r ? 'RUN' : 'off')).join(' · ')} · load ${b.electrical.dieselLoadPct.map(f0).join(' / ')} %`],
    ['Offsite power', s.offsitePower ? 'available' : 'LOST'],
  ];
};
const RCPAUX: Rel = (s, c) => {
  const b = s.bop;
  if (!b) return RCP(s, c, null);
  const r = b.rcpAux;
  return [
    ...s.loops.map((l, i) => [`RCP ${i + 1}`, `${r.seized[i] ? 'SEIZED' : l.rcpRunning ? 'RUN' : 'stopped'} · brg ${f0(r.bearingTempF[i])} °F · seal ${f0(r.sealTempF[i])} °F · leakoff ${f1(r.sealLeakoffGpm[i])} gpm`] as Row),
    ['Seal injection', `${f1(r.sealInjectionGpm)} gpm (set ${f0(c.sealInjectionGpm ?? 32)})`],
    ['CCW', `${b.ccw.pumpsRunning.filter(Boolean).length} pump(s) · ${f0(b.ccw.supplyTempF)} °F`],
  ];
};
const CVCS2: Rel = (s, c) => {
  const b = s.bop;
  const rows = CVCS(s, c, null);
  if (!b) return rows;
  return [
    ...rows,
    ['Batch', `${b.makeupBatch.active ? 'RUNNING' : 'idle'} · ${f0(b.makeupBatch.deliveredGal)} / ${f0(b.makeupBatch.targetGal)} gal`],
    ['Seal injection', `${f1(b.rcpAux.sealInjectionGpm)} gpm`],
    ['Letdown HX outlet', `${f0(b.letdownHxOutletTempF)} °F`],
  ];
};

const REL_RULES: [RegExp, Rel][] = [
  [/^(CW_|HOTWELL|MFP_SUCTION|FW_HTRS)/, COND],
  [/^(TURB_ECC|TURB_DIFF|TURB_CRIT|TURN_GEAR|TURB_VIB)/, TURB2],
  [/^(GEN_FIELD|GEN_PROT|GEN_MVAR)/, GEN],
  [/^(HOUSE_|CCW_|SW_|DG_)/, ELEC],
  [/^RCP\d_(BRG|SEAL)/, RCPAUX],
  [/^(SEAL_INJ|LD_HX|MAKEUP_BATCH)/, CVCS2],
  [/^RX_TRIP$/, TRIP],
  [/^(PZR_PRESS|PZR_HTR|PZR_PORV|PZR_SAFETY|PRT_|RCS_OVERPRESS)/, PZR],
  [/^PZR_LEVEL|^CHG_FLOW|^LETDOWN/, LEVEL],
  [/^TAVG|^OTDT/, TEMP],
  [/^(SUR_|SR_|IR_|PR_|P6|P10)/, NUC],
  [/^(ROD_|RIL_|SDM_|AXIAL)/, RODS],
  [/^BORON/, CVCS],
  [/^SG\d|^MFP|^FW_|^AFW/, SG],
  [/^(STEAM|COND_|MSIV|SG_PORV|MS_RAD)/, STEAM],
  [/^(TURB|GEN_)/, TURB],
  [/^(RCP\d|LOOP\d)/, RCP],
  [/^(SUBCOOL|CET|INADEQ|DNBR|FUEL|VESSEL|ACCUM|SI_|CNMT|H2|RCS_LEAK|LOOP$|DG_)/, CORE],
];

export function relatedValues(id: string, s: PlantState, c: PlantControls): Row[] {
  const [, n] = generic(id);
  for (const [re, fn] of REL_RULES) {
    if (re.test(id)) {
      try {
        return fn(s, c, n);
      } catch {
        return [];
      }
    }
  }
  return [];
}
