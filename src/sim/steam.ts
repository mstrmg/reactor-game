/**
 * Water / steam properties for the plant model.
 *
 * Internally the thermal-hydraulic model works in SI-ish units:
 *   pressure MPa (absolute), temperature °C, enthalpy kJ/kg, specific volume m³/kg,
 *   internal energy kJ/kg, mass kg, energy kJ, power kW.
 * Displays and setpoints are converted to psig / °F at the edges (see conversions below).
 *
 * The tables in steamTables.ts are generated from IAPWS-IF97 and interpolated
 * (linear in log(P) for the saturation table, linear in T for the liquid table).
 * Subcooled liquid uses the "saturated liquid at the same temperature" approximation for
 * enthalpy plus an isothermal compressibility correction for volume.
 */
import {
  SAT_P, SAT_T, SAT_HF, SAT_HG, SAT_VF, SAT_VG,
  LIQ_T, LIQ_P, LIQ_H, LIQ_V, LIQ_VG,
} from './steamTables';

// ---------------------------------------------------------------- conversions
export const PSI_PER_MPA = 145.0377;
export const ATM_MPA = 0.101325;
export const psigToMPa = (psig: number) => (psig + 14.696) / PSI_PER_MPA;
export const mpaToPsig = (mpa: number) => mpa * PSI_PER_MPA - 14.696;
export const fToC = (f: number) => (f - 32) / 1.8;
export const cToF = (c: number) => c * 1.8 + 32;
/** US gallons per minute of ~cold water -> kg/s */
export const GPM_TO_KGS = 0.0625;
export const KGS_TO_GPM = 1 / GPM_TO_KGS;

// ---------------------------------------------------------------- interpolation helpers
const NP = SAT_P.length;
const LOGP = new Float64Array(NP);
for (let i = 0; i < NP; i++) LOGP[i] = Math.log(SAT_P[i]);
const NT = LIQ_T.length;

/** index i such that arr[i] <= x < arr[i+1] (clamped) for an increasing array */
function seg(arr: Float64Array, x: number): number {
  const n = arr.length;
  if (x <= arr[0]) return 0;
  if (x >= arr[n - 1]) return n - 2;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid; else hi = mid;
  }
  return lo;
}

// Saturation-by-pressure cache (most calls in a step reuse a handful of pressures).
let cP = -1, cI = 0, cF = 0;
function satIdx(P: number) {
  if (P === cP) return;
  cP = P;
  const lp = Math.log(Math.max(P, SAT_P[0]));
  const i = seg(LOGP, lp);
  cI = i;
  cF = Math.min(1.2, (lp - LOGP[i]) / (LOGP[i + 1] - LOGP[i]));
}
const lerpP = (arr: Float64Array) => arr[cI] + (arr[cI + 1] - arr[cI]) * cF;

export const PMIN = SAT_P[0];
export const PMAX = SAT_P[NP - 1];
export const PCRIT = 22.064;

export function tsat(P: number): number { satIdx(P); return lerpP(SAT_T); }
export function hf(P: number): number { satIdx(P); return lerpP(SAT_HF); }
export function hg(P: number): number { satIdx(P); return lerpP(SAT_HG); }
export function vf(P: number): number { satIdx(P); return lerpP(SAT_VF); }
export function vg(P: number): number {
  satIdx(P);
  // vg is very nonlinear: interpolate in log space
  const a = Math.log(SAT_VG[cI]), b = Math.log(SAT_VG[cI + 1]);
  return Math.exp(a + (b - a) * cF);
}

/** saturation pressure (MPa) at temperature T (°C) */
export function psat(T: number): number {
  const i = seg(LIQ_T, T);
  const f = (T - LIQ_T[i]) / (LIQ_T[i + 1] - LIQ_T[i]);
  const a = Math.log(LIQ_P[i]), b = Math.log(LIQ_P[i + 1]);
  return Math.exp(a + (b - a) * f);
}
/** saturated liquid enthalpy at temperature T (°C) */
export function hfT(T: number): number {
  const i = seg(LIQ_T, T);
  const f = (T - LIQ_T[i]) / (LIQ_T[i + 1] - LIQ_T[i]);
  return LIQ_H[i] + (LIQ_H[i + 1] - LIQ_H[i]) * f;
}
export function vfT(T: number): number {
  const i = seg(LIQ_T, T);
  const f = (T - LIQ_T[i]) / (LIQ_T[i + 1] - LIQ_T[i]);
  return LIQ_V[i] + (LIQ_V[i + 1] - LIQ_V[i]) * f;
}
/** saturated vapour density (kg/m³) at temperature T (°C) */
export function rhogT(T: number): number {
  const i = seg(LIQ_T, T);
  const f = (T - LIQ_T[i]) / (LIQ_T[i + 1] - LIQ_T[i]);
  const a = Math.log(LIQ_VG[i]), b = Math.log(LIQ_VG[i + 1]);
  return 1 / Math.exp(a + (b - a) * f);
}
/** temperature (°C) whose saturated vapour density equals rho (inverse of rhogT) */
export function tOfRhog(rho: number): number {
  // vg decreasing in T -> search on log vg
  const lv = Math.log(1 / Math.max(rho, 1e-6));
  let lo = 0, hi = NT - 1;
  if (lv >= Math.log(LIQ_VG[0])) return LIQ_T[0];
  if (lv <= Math.log(LIQ_VG[NT - 1])) return LIQ_T[NT - 1];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (Math.log(LIQ_VG[mid]) >= lv) lo = mid; else hi = mid;
  }
  const a = Math.log(LIQ_VG[lo]), b = Math.log(LIQ_VG[hi]);
  return LIQ_T[lo] + ((lv - a) / (b - a)) * (LIQ_T[hi] - LIQ_T[lo]);
}
/** liquid temperature (°C) from enthalpy (kJ/kg), saturated-liquid approximation */
export function tOfH(h: number): number {
  const i = seg(LIQ_H, h);
  const f = (h - LIQ_H[i]) / (LIQ_H[i + 1] - LIQ_H[i]);
  return LIQ_T[i] + (LIQ_T[i + 1] - LIQ_T[i]) * f;
}

/** isothermal compressibility of liquid water, 1/MPa (fit to IF97 data 100–340 °C) */
export function kappaLiquid(T: number): number {
  return (0.45e-9 + 2.0e-9 * Math.exp((T - 290) / 45)) * 1e6;
}

/** approximate superheated-steam cp, kJ/kg-K */
const CP_STEAM = 2.6;

export interface Props { T: number; x: number; v: number; }
const _p: Props = { T: 0, x: 0, v: 0 };
/**
 * State at enthalpy h and pressure P. Returns a SHARED object (copy fields you need).
 * x < 0 is reported as 0 for subcooled liquid; x > 1 as 1 for superheated steam.
 */
export function props(h: number, P: number): Props {
  const hl = hf(P);
  if (h < hl) {
    const T = tOfH(h);
    const ps = psat(T);
    const v0 = vfT(T);
    const k = kappaLiquid(T);
    _p.T = T; _p.x = 0; _p.v = v0 * Math.max(0.85, 1 - k * (P - ps));
    return _p;
  }
  const hv = hg(P);
  const ts = tsat(P);
  if (h <= hv) {
    const x = (h - hl) / (hv - hl);
    _p.T = ts; _p.x = x; _p.v = vf(P) + x * (vg(P) - vf(P));
    return _p;
  }
  const T = ts + (h - hv) / CP_STEAM;
  _p.T = T; _p.x = 1; _p.v = vg(P) * (T + 273.15) / (ts + 273.15);
  return _p;
}

/** saturated liquid / vapour internal energy (kJ/kg) */
export const uf = (P: number) => hf(P) - 1000 * P * vf(P);
export const ug = (P: number) => hg(P) - 1000 * P * vg(P);

/**
 * Equilibrium pressure of a closed rigid container holding M kg with internal energy U kJ
 * in volume V m³ (pressurizer, steam generator secondary).
 * Handles two-phase (normal), compressed-liquid ("solid") and superheated-vapour states.
 * Returns pressure in MPa abs; writes quality / liquid volume into `out`.
 */
export interface ContainerOut { P: number; x: number; liquidVolume: number; T: number; solid: boolean; }
export function containerPressure(M: number, U: number, V: number, Pguess: number, out: ContainerOut): number {
  const v = V / Math.max(M, 1e-6);
  const u = U / Math.max(M, 1e-6);
  // f(P) = u_mix(P; v) - u, increasing in P in the two-phase region
  const f = (P: number) => {
    const vl = vf(P), vv = vg(P);
    let x = (v - vl) / (vv - vl);
    if (x < 0) x = 0; // handled separately
    if (x > 1) x = 1;
    return uf(P) + x * (ug(P) - uf(P)) - u;
  };
  // Is the container liquid-solid? Check at the saturation pressure of the liquid temperature.
  // Liquid with internal energy u at volume v: if v < vf(T(u)), it's compressed liquid.
  const Tl = tOfH(u + 1000 * Math.max(Pguess, 0.1) * vfT(tOfH(u))); // h ≈ u + P v
  const vSatLiq = vfT(Tl);
  if (v < vSatLiq && Tl < 370) {
    const ps = psat(Tl);
    const k = kappaLiquid(Tl);
    const P = Math.min(60, ps + (1 - v / vSatLiq) / k);
    out.P = P; out.x = 0; out.liquidVolume = V; out.T = Tl; out.solid = true;
    return P;
  }
  // Pressure at which saturated vapour has exactly this specific volume: two-phase states
  // must lie below it. If u exceeds ug there, the container holds superheated steam.
  let Pv = PMAX;
  if (v > vg(PMAX)) {
    let l = Math.log(PMIN), h = Math.log(PMAX);
    if (v >= vg(PMIN)) Pv = PMIN;
    else {
      for (let it = 0; it < 30; it++) { const m = 0.5 * (l + h); if (vg(Math.exp(m)) > v) l = m; else h = m; }
      Pv = Math.exp(0.5 * (l + h));
    }
    if (u >= ug(Pv)) {
      const ts = tsat(Pv);
      const T = ts + (u - ug(Pv)) / (CP_STEAM - 0.46);
      const P = Math.min(PMAX, Pv * (T + 273.15) / (ts + 273.15));
      out.P = P; out.x = 1; out.liquidVolume = 0; out.T = T; out.solid = false;
      return P;
    }
  }
  const lo = PMIN, hi = Pv;
  let a = Math.max(lo, Math.min(hi, Pguess * 0.97));
  let b = Math.max(lo, Math.min(hi, Pguess * 1.03));
  if (b <= a) { a = lo; b = hi; }
  let fa = f(a), fb = f(b);
  let guard = 0;
  while (fa > 0 && a > lo && guard++ < 40) { b = a; fb = fa; a = Math.max(lo, a * 0.7); fa = f(a); }
  guard = 0;
  while (fb < 0 && b < hi && guard++ < 40) { a = b; fa = fb; b = Math.min(hi, b * 1.3); fb = f(b); }
  let P: number;
  if (fa > 0) P = a;
  else if (fb < 0) P = b;
  else {
    let side = 0;
    P = a;
    for (let it = 0; it < 50; it++) {
      P = (a * fb - b * fa) / (fb - fa);
      const fp = f(P);
      if (Math.abs(fp) < 2e-4 || Math.abs(b - a) < 1e-8) break;
      if (fp * fb > 0) { b = P; fb = fp; if (side === -1) fa *= 0.5; side = -1; }
      else { a = P; fa = fp; if (side === 1) fb *= 0.5; side = 1; }
    }
  }
  const vl = vf(P), vv = vg(P);
  let x = (v - vl) / (vv - vl);
  const T = tsat(P);
  if (x > 1) x = 1;
  if (x < 0) x = 0;
  out.P = P; out.x = x; out.liquidVolume = M * (1 - x) * vl; out.T = T; out.solid = false;
  return P;
}
