/**
 * Scenario initial-condition descriptors. ReactorSim.reset() turns one of these into a fully
 * settled steady state (it integrates the thermal-hydraulics with neutron power held, then
 * computes the critical boron concentration so that the start is a true equilibrium).
 */
import type { ScenarioId } from './types';

export interface ScenarioSpec {
  id: ScenarioId;
  title: string;
  /** target fission power fraction (null = source level / subcritical) */
  power: number | null;
  /** if true, settle by adjusting power until Tavg = Tref (turbine-driven plants) */
  powerFollowsTurbine: boolean;
  /** control bank sequence counter (0..612). For subcritical: the ECP sequence position. */
  rodSeq: number;
  shutdownBanksOut: boolean;
  rodMode: 'auto' | 'manual';
  /** turbine: 'off' (tripped, at turning gear), 'online' (breaker closed at turbineMW) */
  turbine: 'off' | 'online';
  turbineMW: number;
  steamDumpMode: 'off' | 'tavg' | 'pressure';
  mainFeedPumps: [boolean, boolean];
  /** poisons: either equilibrium at a power or a power history */
  xenon: { kind: 'equilibrium'; power: number } | { kind: 'shutdown'; power: number; hoursAgo: number }
    | { kind: 'downpower'; from: number; to: number; hoursAgo: number };
  /** decay heat history */
  decay: { kind: 'equilibrium'; power: number } | { kind: 'shutdown'; power: number; hoursAgo: number };
  /** for subcritical scenarios: boron so that criticality occurs at rodSeq (estimated critical position) */
  subcritical?: { ecpSeq: number; startSeq: number };
  description: string;
}

export const SCENARIOS: Record<ScenarioId, ScenarioSpec> = {
  'hot-standby': {
    id: 'hot-standby',
    title: 'Reactor Startup from Hot Standby',
    power: null,
    powerFollowsTurbine: false,
    rodSeq: 0,
    shutdownBanksOut: true,
    rodMode: 'manual',
    turbine: 'off',
    turbineMW: 0,
    steamDumpMode: 'pressure',
    mainFeedPumps: [false, false],
    xenon: { kind: 'shutdown', power: 1, hoursAgo: 110 },
    decay: { kind: 'shutdown', power: 1, hoursAgo: 110 },
    // ECP: critical with CD around 130 steps (seq 384 + 130)
    subcritical: { ecpSeq: 3 * 128 + 130, startSeq: 0 },
    description:
      'Mode 3, 557 °F, 2235 psig. Shutdown banks withdrawn, control banks fully inserted, xenon-free. ' +
      'Estimated critical position: Control Bank D ≈ 130 steps. Take the reactor critical, ' +
      'heat up to the point of adding heat, roll the turbine, synchronise and load the unit. The secondary ' +
      'plant is shut down: decay heat goes out through the SG atmospheric relief valves and the motor-driven AFW ' +
      'pumps feed the SGs. Establish circulating water and condenser vacuum, start condensate and a main feed ' +
      'pump, warm the turbine on the turning gear / at 500 rpm, excite the generator and synchronise in phase.',
  },
  'low-power': {
    id: 'low-power',
    title: 'Low Power (≈5 %), Ready to Roll Turbine',
    power: 0.05,
    powerFollowsTurbine: false,
    rodSeq: 3 * 128 + 150,
    shutdownBanksOut: true,
    rodMode: 'manual',
    turbine: 'off',
    turbineMW: 0,
    steamDumpMode: 'pressure',
    mainFeedPumps: [true, false],
    xenon: { kind: 'equilibrium', power: 0.05 },
    decay: { kind: 'equilibrium', power: 0.05 },
    description:
      'Reactor critical at about 5 % power, steam dumps carrying the load in steam-pressure mode. ' +
      'Latch and roll the turbine to 1800 rpm, close the generator breaker and raise load.',
  },
  'full-power': {
    id: 'full-power',
    title: '100 % Power',
    power: 1.0,
    powerFollowsTurbine: true,
    rodSeq: 3 * 128 + 215,
    shutdownBanksOut: true,
    rodMode: 'auto',
    turbine: 'online',
    turbineMW: 1150,
    steamDumpMode: 'tavg',
    mainFeedPumps: [true, true],
    xenon: { kind: 'equilibrium', power: 1.0 },
    decay: { kind: 'equilibrium', power: 1.0 },
    description: 'Full power, equilibrium xenon, rods in automatic, generator on line at ≈1150 MWe.',
  },
  'xenon-challenge': {
    id: 'xenon-challenge',
    title: 'Xenon Transient at 50 %',
    power: 0.5,
    powerFollowsTurbine: true,
    rodSeq: 3 * 128 + 190,
    shutdownBanksOut: true,
    rodMode: 'manual',
    turbine: 'online',
    turbineMW: 575,
    steamDumpMode: 'tavg',
    mainFeedPumps: [true, true],
    xenon: { kind: 'downpower', from: 1.0, to: 0.5, hoursAgo: 2 },
    decay: { kind: 'equilibrium', power: 0.6 },
    description:
      'Two hours ago the unit was ramped from 100 % to 50 %. Xenon is still building in and will peak ' +
      'in a few hours: hold Tavg on program with rods and boron dilution without violating rod insertion ' +
      'limits or axial flux limits.',
  },
};
