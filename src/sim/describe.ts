/** Plain-English one-liners for the UI (trip first-out panel, fault log, debrief). */
import type { FaultId, TripId } from './types';

const TRIPS: Record<TripId, string> = {
  MANUAL: 'The operator tripped the reactor manually from the control board.',
  PR_HIGH_FLUX_HI: 'Power-range neutron flux exceeded 109 % of rated power.',
  PR_HIGH_FLUX_LO: 'Power-range flux exceeded 25 % while below the P-10 permissive (low-power setpoint not blocked).',
  PR_POS_RATE: 'Power-range flux rose by more than 5 % of rated power within about 2 seconds.',
  IR_HIGH_FLUX: 'Intermediate-range detector current exceeded the equivalent of 25 % power below P-10.',
  SR_HIGH_FLUX: 'Source-range count rate exceeded 100,000 cps while below the P-6 permissive.',
  OTDT: 'Overtemperature ΔT: loop ΔT exceeded the setpoint that protects against departure from nucleate boiling (depends on Tavg, pressure and axial flux).',
  OPDT: 'Overpower ΔT: loop ΔT exceeded the setpoint that protects the fuel against excessive linear heat rate (fuel centreline melting).',
  PZR_PRESS_LO: 'Pressurizer pressure fell below 1865 psig with power above P-7.',
  PZR_PRESS_HI: 'Pressurizer pressure exceeded 2385 psig.',
  PZR_LEVEL_HI: 'Pressurizer level exceeded 92 % above P-7 (protects against water relief through the safety valves).',
  RCS_FLOW_LO: 'Reactor coolant loop flow fell below 90 % (one loop above P-8, two loops between P-7 and P-8).',
  RCP_UNDERVOLTAGE: 'Undervoltage on the reactor coolant pump buses above P-7 (pumps will coast down).',
  SG_LEVEL_LOLO: 'A steam generator narrow-range level fell below 17 % — the heat sink is being lost.',
  TURBINE_TRIP: 'The turbine tripped while reactor power was above the P-9 permissive (50 %).',
  SAFETY_INJECTION: 'Safety injection actuated, which always trips the reactor.',
  STARTUP_RATE: 'Startup rate exceeded 5 decades per minute below P-10 (reactor period shorter than ~5 s).',
};

const FAULTS: Record<FaultId, string> = {
  STUCK_ROD: 'A control rod is mechanically stuck and will not move or insert on a trip',
  DROPPED_ROD: 'A control rod has dropped fully into the core, tilting the flux and inserting negative reactivity',
  RCP_TRIP: 'A reactor coolant pump tripped and is coasting down; its loop flow will reverse',
  MFP_TRIP: 'A main feedwater pump tripped; the remaining pump cannot supply full-power feed flow',
  FEED_VALVE_FAIL: 'A steam generator feedwater regulating valve failed and no longer responds to its controller',
  PZR_PORV_STUCK_OPEN: 'A pressurizer power-operated relief valve stuck open, venting reactor coolant to the relief tank (close its block valve)',
  PZR_SPRAY_STUCK_OPEN: 'A pressurizer spray valve stuck open, condensing the steam bubble and lowering RCS pressure',
  SG_TUBE_LEAK: 'Reactor coolant is leaking through steam generator tubes into the secondary side',
  SMALL_LOCA: 'A small-break loss-of-coolant accident: reactor coolant is escaping into containment through a pipe break',
  LOSS_OF_OFFSITE_POWER: 'Offsite power was lost: RCPs, main feed pumps and condenser circulating water stop; diesels must carry the safety loads',
  TURBINE_TRIP_SPURIOUS: 'The main turbine tripped spuriously because of a control system fault',
  STEAM_LINE_BREAK: 'A main steam line broke, blowing down a steam generator and over-cooling the reactor coolant system',
  INSTRUMENT_FAIL: 'An instrument channel failed, feeding a false signal to its indicator and automatic controller',
};

export function describeTrip(id: TripId): string { return TRIPS[id] ?? id; }
export function describeFault(id: FaultId): string { return FAULTS[id] ?? id; }
