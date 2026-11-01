/** Normal operating procedure, as auto-ticking steps. Steps latch once met so
 *  the player can see progress; the "running checks" are live. */
import type { PlantState, PlantControls } from '../sim/types';

export interface ProcStep {
  id: string;
  text: string;
  hint: string;
  /** current value string shown at the right */
  value?: (s: PlantState, c: PlantControls) => string;
  done: (s: PlantState, c: PlantControls) => boolean;
}

const fx = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const rcpCount = (s: PlantState) => s.loops.filter((l) => l.rcpRunning).length;
const minRod = (s: PlantState, banks: (keyof PlantState['rods'])[]) => Math.min(...banks.map((b) => s.rods[b]));

export const STARTUP: { section: string; steps: ProcStep[] }[] = [
  {
    section: 'Prerequisites (Mode 3, hot standby)',
    steps: [
      {
        id: 'rcp',
        text: 'All four reactor coolant pumps running',
        hint: 'RCP switches on the RCS panel.',
        value: (s) => `${rcpCount(s)}/4`,
        done: (s) => rcpCount(s) === 4,
      },
      {
        id: 'press',
        text: 'Pressurizer pressure at 2235 psig',
        hint: 'Heaters raise pressure, spray lowers it. Leave both in auto.',
        value: (s) => `${fx(s.rcsPressure)} psig`,
        done: (s) => s.rcsPressure > 2200 && s.rcsPressure < 2270,
      },
      {
        id: 'tavg',
        text: 'Tavg at no-load 557 °F',
        hint: 'Steam dumps in Tavg or pressure mode hold no-load temperature.',
        value: (s) => `${fx(s.tAvg, 1)} °F`,
        done: (s) => s.tAvg > 550,
      },
      {
        id: 'tripreset',
        text: 'Reactor trip breakers closed',
        hint: 'Press TRIP RESET once no trip signal is present.',
        value: (s) => (s.reactorTripped ? 'OPEN' : 'CLOSED'),
        done: (s) => !s.reactorTripped,
      },
    ],
  },
  {
    section: 'Approach to criticality',
    steps: [
      {
        id: 'sd',
        text: 'Shutdown banks A and B withdrawn to 228 steps',
        hint: 'Select bank SA, then SB, and withdraw. Watch the source range count rate.',
        value: (s) => `SA ${fx(s.rods.SA)} / SB ${fx(s.rods.SB)}`,
        done: (s) => minRod(s, ['SA', 'SB']) >= 225,
      },
      {
        id: 'ctl',
        text: 'Control banks withdrawn in sequence',
        hint: 'MANUAL SEQ moves CA→CD with overlap. Stop and wait if SUR exceeds 1 dpm.',
        value: (s) => `CA ${fx(s.rods.CA)} · CD ${fx(s.rods.CD)}`,
        done: (s) => s.rods.CA >= 150 || s.rods.CB >= 100,
      },
      {
        id: 'crit',
        text: 'Reactor critical',
        hint: 'Positive startup rate that holds with rods stopped. Dilute boron if rods run out.',
        value: (s) => `k ${s.keff.toFixed(4)} · ${fx(s.startupRateDpm, 2)} dpm`,
        done: (s) => s.keff >= 0.9998 && s.startupRateDpm > 0.05 && !s.reactorTripped,
      },
      {
        id: 'p6',
        text: 'Above P-6, source range blocked',
        hint: 'Intermediate range takes over. Keep SUR under 1 dpm.',
        value: (s) => (s.permissives.P6 ? 'P-6 ON' : 'below'),
        done: (s) => s.permissives.P6,
      },
      {
        id: 'pah',
        text: 'Power stabilized at 1–3%',
        hint: 'Point of adding heat: Tavg starts to rise and feedback pushes back.',
        value: (s) => `${fx(s.powerRangePct, 1)} %`,
        done: (s) => s.powerRangePct >= 1,
      },
    ],
  },
  {
    section: 'Power ascension',
    steps: [
      {
        id: 'mfp',
        text: 'Main feed pump running, SG levels in auto',
        hint: 'Start a main feed pump; put feed regulating valves in auto.',
        value: (s) => `${s.mainFeedPumpsRunning.filter(Boolean).length} MFP`,
        done: (s) => s.mainFeedPumpsRunning.some(Boolean),
      },
      {
        id: 'latch',
        text: 'Turbine latched',
        hint: 'Press TURBINE LATCH. Needs steam pressure and condenser vacuum.',
        value: (s) => (s.turbineLatched ? 'LATCHED' : 'tripped'),
        done: (s) => s.turbineLatched,
      },
      {
        id: 'rpm',
        text: 'Turbine at 1800 rpm',
        hint: 'Turbine rolls up on its own once latched.',
        value: (s) => `${fx(s.turbineSpeedRpm)} rpm`,
        done: (s) => s.turbineSpeedRpm > 1780,
      },
      {
        id: 'sync',
        text: 'Generator synchronized to the grid',
        hint: 'Close the generator breaker at speed.',
        value: (s) => (s.generatorBreakerClosed ? 'CLOSED' : 'open'),
        done: (s) => s.generatorBreakerClosed,
      },
      {
        id: 'p10',
        text: 'Power above 10% (P-10)',
        hint: 'Raise turbine load setpoint. Rods in auto follow Tavg to Tref.',
        value: (s) => `${fx(s.powerRangePct, 1)} %`,
        done: (s) => s.powerRangePct >= 10 && s.generatorBreakerClosed,
      },
      {
        id: 'p30',
        text: 'Power above 30%',
        hint: 'Ramp no faster than ~5 MW/min while xenon builds in.',
        value: (s) => `${fx(s.grossMWe)} MWe`,
        done: (s) => s.powerRangePct >= 30 && s.generatorBreakerClosed,
      },
      {
        id: 'p50',
        text: 'Power above 50% (P-9, turbine trip now trips the reactor)',
        hint: 'Second feed pump before 60%.',
        value: (s) => `${fx(s.powerRangePct, 1)} %`,
        done: (s) => s.powerRangePct >= 50 && s.generatorBreakerClosed,
      },
      {
        id: 'p100',
        text: '100% power',
        hint: 'About 1150 MWe. Hold it there.',
        value: (s) => `${fx(s.powerRangePct, 1)} %`,
        done: (s) => s.powerRangePct >= 98 && s.generatorBreakerClosed,
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
    text: 'PZR level within 5% of program',
    value: (s) => `${s.przLevel.toFixed(0)} / ${s.przLevelProgram.toFixed(0)} %`,
    ok: (s) => Math.abs(s.przLevel - s.przLevelProgram) <= 5,
  },
  {
    text: 'SG levels 40–60% narrow range',
    value: (s) => s.loops.map((l) => l.sgLevel.toFixed(0)).join(' '),
    ok: (s) => s.loops.every((l) => l.sgLevel >= 40 && l.sgLevel <= 60),
  },
  { text: 'Axial flux difference ±5%', value: (s) => `${s.axialOffset.toFixed(1)} %`, ok: (s) => Math.abs(s.axialOffset) <= 5 },
  { text: 'DNBR above 1.3', value: (s) => (Number.isFinite(s.dnbr) ? s.dnbr.toFixed(2) : '∞'), ok: (s) => !(s.dnbr < 1.3) },
  { text: 'Subcooling margin above 20 °F', value: (s) => `${s.subcoolingMargin.toFixed(0)} °F`, ok: (s) => s.subcoolingMargin >= 20 },
];
