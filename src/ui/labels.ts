/** Human-readable names for sim identifiers. Local to the UI so it never
 *  depends on another module being finished. */
import type { FaultId, PlantState, ScenarioId, TripId } from '../sim/types';

export const TRIP_LABEL: Record<TripId, string> = {
  MANUAL: 'Manual reactor trip',
  PR_HIGH_FLUX_HI: 'Power range high flux (high setpoint, 109%)',
  PR_HIGH_FLUX_LO: 'Power range high flux (low setpoint, 25%)',
  PR_POS_RATE: 'Power range positive flux rate',
  IR_HIGH_FLUX: 'Intermediate range high flux',
  SR_HIGH_FLUX: 'Source range high flux (10⁵ cps)',
  OTDT: 'Overtemperature ΔT',
  OPDT: 'Overpower ΔT',
  PZR_PRESS_LO: 'Pressurizer pressure low',
  PZR_PRESS_HI: 'Pressurizer pressure high',
  PZR_LEVEL_HI: 'Pressurizer level high',
  RCS_FLOW_LO: 'Reactor coolant flow low',
  RCP_UNDERVOLTAGE: 'RCP bus undervoltage',
  SG_LEVEL_LOLO: 'Steam generator level low-low',
  TURBINE_TRIP: 'Turbine trip (above P-9)',
  SAFETY_INJECTION: 'Safety injection actuated',
  STARTUP_RATE: 'Startup rate high (> 5 dpm)',
};

export const TRIP_SHORT: Record<TripId, string> = {
  MANUAL: 'MANUAL',
  PR_HIGH_FLUX_HI: 'PR HI FLUX',
  PR_HIGH_FLUX_LO: 'PR LO SP FLUX',
  PR_POS_RATE: 'PR POS RATE',
  IR_HIGH_FLUX: 'IR HI FLUX',
  SR_HIGH_FLUX: 'SR HI FLUX',
  OTDT: 'OTΔT',
  OPDT: 'OPΔT',
  PZR_PRESS_LO: 'PZR PRESS LO',
  PZR_PRESS_HI: 'PZR PRESS HI',
  PZR_LEVEL_HI: 'PZR LVL HI',
  RCS_FLOW_LO: 'RCS FLOW LO',
  RCP_UNDERVOLTAGE: 'RCP UV',
  SG_LEVEL_LOLO: 'SG LVL LO-LO',
  TURBINE_TRIP: 'TURB TRIP',
  SAFETY_INJECTION: 'SI',
  STARTUP_RATE: 'SUR HI',
};

export const FAULT_LABEL: Partial<Record<FaultId, string>> = {
  STUCK_ROD: 'Stuck control rod',
  DROPPED_ROD: 'Dropped control rod',
  RCP_TRIP: 'Reactor coolant pump trip',
  MFP_TRIP: 'Main feed pump trip',
  FEED_VALVE_FAIL: 'Feed regulating valve failure',
  PZR_PORV_STUCK_OPEN: 'Pressurizer PORV stuck open',
  PZR_SPRAY_STUCK_OPEN: 'Pressurizer spray valve stuck open',
  SG_TUBE_LEAK: 'Steam generator tube leak',
  SMALL_LOCA: 'Small-break loss of coolant',
  LOSS_OF_OFFSITE_POWER: 'Loss of offsite power',
  TURBINE_TRIP_SPURIOUS: 'Spurious turbine trip',
  STEAM_LINE_BREAK: 'Steam line break',
  INSTRUMENT_FAIL: 'Instrument channel failure',
  CCW_PUMP_TRIP: 'Component cooling water pump trip',
  CIRC_WATER_PUMP_TRIP: 'Circulating water pump trip',
  CONDENSATE_PUMP_TRIP: 'Condensate pump trip',
};

export function tripLabel(id: TripId | null | undefined): string {
  if (!id) return 'Unknown';
  return TRIP_LABEL[id] ?? String(id);
}
export function faultLabel(id: FaultId): string {
  return FAULT_LABEL[id] ?? String(id);
}

export interface ScenarioInfo {
  id: ScenarioId;
  name: string;
  blurb: string;
  length: string;
}

export const SCENARIOS: ScenarioInfo[] = [
  {
    id: 'hot-standby',
    name: 'Hot standby startup',
    blurb:
      'Rods on the bottom, coolant hot and pressurized. Pull rods, dilute to criticality, roll the turbine and sync to the grid.',
    length: 'Full experience, 1 h+',
  },
  {
    id: 'low-power',
    name: 'Low-power turbine roll',
    blurb: 'Critical at about 5% with the turbine offline. Latch, roll to 1800 rpm, close the breaker and ramp up.',
    length: 'About 30 min',
  },
  {
    id: 'full-power',
    name: 'Full power, steady state',
    blurb: 'Take the shift at 100% with the generator online. Keep it there while equipment misbehaves.',
    length: 'Quick play',
  },
  {
    id: 'xenon-challenge',
    name: 'Xenon challenge',
    blurb: 'At 50%, six hours after a fast down-power. Xenon is building in and will drag power down unless you fight it.',
    length: 'Hard',
  },
];

export const CATASTROPHE_TITLE: Record<NonNullable<PlantState['catastrophe']>['kind'], string> = {
  meltdown: 'Core melt',
  'steam-explosion': 'Steam explosion',
  'vessel-rupture': 'Reactor vessel rupture',
  'containment-failure': 'Containment failure',
  'turbine-missile': 'Turbine missile',
};
