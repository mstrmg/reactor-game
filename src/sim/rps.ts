/**
 * Reactor Protection System, Engineered Safety Features actuation, permissives and rod stops.
 * Setpoints are typical Westinghouse 4-loop values (see README).
 */
import type { TripId } from './types';
import type { ReactorSim } from './ReactorSim';
import { mpaToPsig, cToF } from './steam';
import { HL, CL } from './plant';
import { W_STEAM_RATED } from './plant';

export interface RpsMemory {
  prSlow: number;
  tavgLag: number[];
  tavgRate: number[];
  lastTurbineTripped: boolean;
}
export const newRpsMemory = (): RpsMemory => ({ prSlow: 0, tavgLag: [0, 0, 0, 0], tavgRate: [0, 0, 0, 0], lastTurbineTripped: true });

export const SETPOINTS = {
  PR_HI: 109, PR_LO: 25, PR_RATE: 5, IR_HI_AMPS: 5e-5, SR_HI_CPS: 1e5, SUR_DPM: 5,
  PZR_P_LO: 1865, PZR_P_HI: 2385, PZR_L_HI: 92, FLOW_LO: 90, SG_LOLO: 17,
  SI_PZR_P: 1807, SI_STM_P: 600, SI_CNMT: 3.5, MSIV_CNMT: 18,
  P6_AMPS: 1e-10, P10_PCT: 10, P8_PCT: 48, P9_PCT: 50, P11_PSIG: 1915, P13_FRAC: 0.1, C5_FRAC: 0.15,
  C1_AMPS: 4e-5, C2_PCT: 103,
  DT0_F: 62.6, TAVG0_F: 584.7, K1: 1.15, K2: 0.0182, K3: 0.00083, K4: 1.09, K5: 0.2, K6: 0.0015,
};
const S = SETPOINTS;

export function evaluateRps(sim: ReactorSim, dt: number) {
  const m = sim.rpsMem;
  const n = sim.kin.n;
  const pr = n * 100 + sim.faults.prBias();
  const prTrue = n * 100;
  const ir = 2e-4 * n;
  const sr = n * 1e11;
  const Ppsig = mpaToPsig(sim.P);
  const lvl = (sim.pzr.liquidV / 51) * 100;
  const turbFrac = sim.turb.wt / W_STEAM_RATED;
  const pm = sim.permissives;

  // ---- permissives (2/4 coincidence assumed satisfied; hysteresis)
  pm.P6 = pm.P6 ? ir > 0.6 * S.P6_AMPS : ir > S.P6_AMPS;
  pm.P10 = pm.P10 ? prTrue > S.P10_PCT - 1 : prTrue >= S.P10_PCT;
  const p13 = turbFrac > S.P13_FRAC;
  pm.P7 = pm.P10 || p13;
  pm.P8 = pm.P8 ? prTrue > S.P8_PCT - 1 : prTrue >= S.P8_PCT;
  pm.P9 = pm.P9 ? prTrue > S.P9_PCT - 1 : prTrue >= S.P9_PCT;
  pm.P11 = pm.P11 ? Ppsig > S.P11_PSIG - 15 : Ppsig >= S.P11_PSIG;

  // ---- OTΔT / OPΔT setpoints (°C internally for comparison with loop ΔT)
  m.prSlow += (pr - m.prSlow) * Math.min(1, dt / 2);
  let otMargin = Infinity, opMargin = Infinity;
  let otTrip = false, opTrip = false;
  let otSp = 99, opSp = 99;
  const ao = sim.axialOffset();
  const dI = (ao * Math.max(0, prTrue)) / 100;
  const fdi = dI < -30 ? 0.02 * (-30 - dI) : dI > 10 ? 0.02 * (dI - 10) : 0;
  for (let i = 0; i < 4; i++) {
    const th = cToF(sim.T[HL(i)]), tc = cToF(sim.T[CL(i)]);
    const dT = th - tc;
    const tavg = 0.5 * (th + tc);
    if (m.tavgLag[i] === 0) m.tavgLag[i] = tavg;
    const rate = (tavg - m.tavgLag[i]) / 10; // °F/s (lead-lag)
    m.tavgLag[i] += (tavg - m.tavgLag[i]) * Math.min(1, dt / 10);
    const ot = S.DT0_F * (S.K1 - S.K2 * (tavg - S.TAVG0_F) * (1 + 0) - S.K2 * Math.max(0, rate) * 10 + S.K3 * (Ppsig - 2235) - fdi);
    const op = S.DT0_F * (S.K4 - S.K5 * Math.max(0, rate) - S.K6 * Math.max(0, tavg - S.TAVG0_F) - fdi * 0.5);
    otSp = Math.min(otSp, ot); opSp = Math.min(opSp, op);
    otMargin = Math.min(otMargin, ot - dT);
    opMargin = Math.min(opMargin, op - dT);
    if (dT > ot) otTrip = true;
    if (dT > op) opTrip = true;
  }
  sim.otdtSetpoint = otSp / 1.8;
  sim.opdtSetpoint = opSp / 1.8;

  // ---- trip signals
  const sig: TripId[] = [];
  if (sim.manualTripPending) { sig.push('MANUAL'); sim.manualTripPending = false; }
  if (pr >= S.PR_HI) sig.push('PR_HIGH_FLUX_HI');
  if (!pm.P10 && pr >= S.PR_LO) sig.push('PR_HIGH_FLUX_LO');
  if (pr - m.prSlow > S.PR_RATE) sig.push('PR_POS_RATE');
  if (!pm.P10 && ir >= S.IR_HI_AMPS) sig.push('IR_HIGH_FLUX');
  if (!pm.P6 && !pm.P10 && sr >= S.SR_HI_CPS) sig.push('SR_HIGH_FLUX');
  const surDpm = (sim.sur * 60) / Math.LN10;
  if (!pm.P10 && surDpm > S.SUR_DPM && n > 1e-9) sig.push('STARTUP_RATE');
  if (otTrip && prTrue > 1) sig.push('OTDT');
  if (opTrip && prTrue > 1) sig.push('OPDT');
  if (pm.P7 && Ppsig + sim.faults.pzrPressureBias() * 0 < S.PZR_P_LO) sig.push('PZR_PRESS_LO');
  if (Ppsig > S.PZR_P_HI) sig.push('PZR_PRESS_HI');
  if (pm.P7 && lvl > S.PZR_L_HI) sig.push('PZR_LEVEL_HI');
  const lowFlowLoops = sim.wn.filter((w) => w * 100 < S.FLOW_LO).length;
  if ((pm.P8 && lowFlowLoops >= 1) || (pm.P7 && !pm.P8 && lowFlowLoops >= 2)) sig.push('RCS_FLOW_LO');
  if (pm.P7 && !sim.offsite) sig.push('RCP_UNDERVOLTAGE');
  if (sim.sg.some((s) => s.nr < S.SG_LOLO)) sig.push('SG_LEVEL_LOLO');
  if (pm.P9 && sim.turb.tripped) sig.push('TURBINE_TRIP');
  if (sim.siActuated) sig.push('SAFETY_INJECTION');
  sim.tripSignals = sig;

  // ---- rod stops
  sim.rodStop.C1 = !pm.P10 && ir >= S.C1_AMPS;
  sim.rodStop.C2 = pr >= S.C2_PCT;
  sim.rodStop.C3 = otMargin < 0.03 * S.DT0_F && prTrue > 1;
  sim.rodStop.C4 = opMargin < 0.03 * S.DT0_F && prTrue > 1;
  sim.rodStop.C5 = turbFrac < S.C5_FRAC;

  // ---- ESFAS
  const siBlock = sim.controls.siBlocked && !pm.P11;
  const si: string[] = [];
  if (!siBlock && Ppsig < S.SI_PZR_P) si.push('PZR PRESS LO');
  const lowSteam = sim.sg.some((s) => mpaToPsig(s.P) < S.SI_STM_P);
  if (!siBlock && lowSteam) si.push('STEAMLINE PRESS LO');
  const cnmt = mpaToPsig(sim.cont.P);
  if (cnmt > S.SI_CNMT) si.push('CNMT PRESS HI-1');
  sim.siSignals = si;

  if (sim.settling) return;

  if (si.length && !sim.siActuated) sim.actuateSI(si[0]);
  // main steam isolation
  if ((!siBlock && lowSteam) || cnmt > S.MSIV_CNMT) {
    if (sim.sg.some((s) => s.msivOpen)) {
      for (const s of sim.sg) s.msivOpen = false;
      sim.msg(`Main steam line isolation (${cnmt > S.MSIV_CNMT ? 'containment HI-2' : 'steamline pressure low'}): MSIVs closed.`);
    }
  }
  // reactor trip
  if (sig.length && !sim.reactorTripped) sim.reactorTrip(sig[0]);
}
