/**
 * Neutronics: six-group point kinetics, decay heat, fission-product poisons.
 *
 * n is the fission rate normalised to rated (1.0 = 3411 MWt of fission power).
 * Precursor concentrations are stored as λ_i·C_i·Λ / β_i-normalised "equivalent power"
 * (so at steady state every c_i = n).
 */

// U-235 thermal fission delayed-neutron data (Keepin)
export const BETA_I = [0.000215, 0.001424, 0.001274, 0.002568, 0.000748, 0.000273];
export const LAMBDA_I = [0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01];
export const BETA = BETA_I.reduce((a, b) => a + b, 0); // 0.006502
/** prompt neutron generation time, s */
export const GEN_TIME = 2.0e-5;

export class PointKinetics {
  n = 1e-9;
  /** precursor "power-equivalent" concentrations; c_i = n at equilibrium */
  c = new Float64Array(6);
  /** extraneous neutron source (normalised so that n_eq = S·Λ/(-ρ)) */
  source = 9.4e-7;

  /** Set to equilibrium at power n (precursors in balance; valid for critical or source-driven). */
  setEquilibrium(n: number) {
    this.n = n;
    for (let i = 0; i < 6; i++) this.c[i] = n;
  }

  /**
   * Advance by dt with reactivity rho (Δk/k). Fully implicit (backward Euler) which is
   * unconditionally stable for subcritical / delayed-supercritical states and handles the
   * prompt jump/drop exactly in the limit. When prompt-critical-ish the caller must
   * substep (see maxStableDt). Returns the time-integrated n over the step (n·s).
   */
  step(rho: number, dt: number): number {
    const L = GEN_TIME;
    const n0 = this.n;
    let sumDelayed = 0; // Σ λ_i C_i^{k} / (1 + h λ_i)   in n-units * β_i / Λ
    let sumCoef = 0; // Σ β_i h λ_i / (Λ (1 + h λ_i))
    for (let i = 0; i < 6; i++) {
      const lh = LAMBDA_I[i] * dt;
      const d = 1 + lh;
      // precursor equation in normalised form: c_i' = λ_i (n - c_i)
      // backward Euler: c_i^{k+1} = (c_i + λ h n^{k+1}) / (1 + λ h)
      // neutron source term from group i: (β_i/Λ) c_i
      sumDelayed += (BETA_I[i] / L) * (this.c[i] / d);
      sumCoef += (BETA_I[i] / L) * (lh / d);
    }
    // n' = n + h[ (ρ-β)/Λ n' + Σ (β_i/Λ) c_i' + S ]
    const denom = 1 - dt * ((rho - BETA) / L) - dt * sumCoef;
    let n1 = (n0 + dt * (sumDelayed + this.source)) / denom;
    if (!(n1 > 0) || !isFinite(n1)) n1 = Math.max(1e-14, n0);
    for (let i = 0; i < 6; i++) {
      const lh = LAMBDA_I[i] * dt;
      this.c[i] = (this.c[i] + lh * n1) / (1 + lh);
    }
    this.n = n1;
    return 0.5 * (n0 + n1) * dt;
  }

  /** a step size small enough to stay accurate during prompt-supercritical excursions */
  static maxStableDt(rho: number): number {
    const excess = rho - 0.7 * BETA;
    if (excess <= 0) return Infinity;
    return Math.max(2e-5, (0.15 * GEN_TIME) / excess);
  }
}

// ------------------------------------------------------------------ decay heat
// Sum-of-exponentials fit to 0.066·(t+1.5)^-0.2 (Way–Wigner / ANS-5.1-like) for long irradiation.
export const DH_LAMBDA = [3.0, 0.3, 0.03, 3e-3, 3e-4, 3e-5, 3e-6, 3e-7];
export const DH_A = [0.001366, 0.015747, 0.015747, 0.010623, 0.005895, 0.00527, 0.000397, 0.005919];
export const DH_TOTAL = DH_A.reduce((a, b) => a + b, 0); // ≈ 0.061

export class DecayHeat {
  g = new Float64Array(8);
  /** equilibrium after long operation at power p */
  setEquilibrium(p: number) { for (let j = 0; j < 8; j++) this.g[j] = DH_A[j] * p; }
  /** long operation at power p followed by shutdown for tShut seconds */
  setAfterShutdown(p: number, tShut: number) {
    for (let j = 0; j < 8; j++) this.g[j] = DH_A[j] * p * Math.exp(-DH_LAMBDA[j] * tShut);
  }
  step(fissionPower: number, dt: number) {
    for (let j = 0; j < 8; j++) {
      const k = 1 - Math.exp(-DH_LAMBDA[j] * dt);
      this.g[j] += (DH_A[j] * fissionPower - this.g[j]) * k;
    }
  }
  get total() { let s = 0; for (let j = 0; j < 8; j++) s += this.g[j]; return s; }
}

// ------------------------------------------------------------------ poisons
// Normalised: iodine & xenon = 1.0 at equilibrium at 100 % power.
export const LAMBDA_I135 = Math.LN2 / (6.57 * 3600);
export const LAMBDA_XE = Math.LN2 / (9.14 * 3600);
/** xenon burnout rate σ_a·φ at 100 % power (1/s) */
export const XE_BURN = 9.0e-5;
const XE_PROD = LAMBDA_XE + XE_BURN; // total production at 100 % so that X_eq(1) = 1
const XE_DIRECT = 0.036; // fraction of Xe-135 produced directly from fission
/** xenon worth at 100 % equilibrium, pcm (negative) */
export const XE_WORTH_EQ = -2800;

export const LAMBDA_PM = Math.LN2 / (53.1 * 3600);
export const SM_BURN = 1.23e-6;
export const SM_WORTH_EQ = -700;

export class Poisons {
  iodine = 0;
  xenon = 0;
  pm = 0;
  sm = 1;
  setEquilibrium(p: number) {
    this.iodine = p;
    this.xenon = (XE_PROD * p) / (LAMBDA_XE + XE_BURN * p);
    this.pm = p;
    this.sm = 1;
  }
  /** equilibrium at p followed by shutdown for tShut seconds (analytic) */
  setAfterShutdown(p: number, tShut: number) {
    this.setEquilibrium(p);
    const I0 = this.iodine, X0 = this.xenon;
    const eI = Math.exp(-LAMBDA_I135 * tShut), eX = Math.exp(-LAMBDA_XE * tShut);
    const A = ((1 - XE_DIRECT) * XE_PROD * I0) / (LAMBDA_XE - LAMBDA_I135);
    this.iodine = I0 * eI;
    this.xenon = X0 * eX + A * (eI - eX);
    // samarium: all promethium decays into Sm
    const eP = Math.exp(-LAMBDA_PM * tShut);
    this.sm = 1 + (SM_BURN / LAMBDA_PM) * this.pm * (1 - eP);
    this.pm = this.pm * eP;
  }
  step(n: number, dt: number) {
    const p = Math.max(0, n);
    // iodine: exact exponential relaxation toward p
    this.iodine += (p - this.iodine) * (1 - Math.exp(-LAMBDA_I135 * dt));
    // xenon: semi-implicit
    const prod = XE_PROD * (XE_DIRECT * p + (1 - XE_DIRECT) * this.iodine);
    const loss = LAMBDA_XE + XE_BURN * p;
    this.xenon = (this.xenon + dt * prod) / (1 + dt * loss);
    this.pm += (p - this.pm) * (1 - Math.exp(-LAMBDA_PM * dt));
    this.sm = (this.sm + dt * SM_BURN * this.pm) / (1 + dt * SM_BURN * p);
  }
  get xenonPcm() { return XE_WORTH_EQ * this.xenon; }
  get samariumPcm() { return SM_WORTH_EQ * this.sm; }
}
