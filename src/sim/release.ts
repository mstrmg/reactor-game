/**
 * Radioactive source term and off-site consequences, emergent from the plant state:
 *   fuel → RCS          gap release as cladding fails, in-vessel release as fuel melts
 *   RCS → containment   every mass flow the plant model sends to containment (break, PRT
 *                       rupture-disk discharge, failed RCP seals) carries its share of the inventory
 *   RCS → SG secondary  tube leak / rupture; then to atmosphere via ARVs / code safeties (bypass),
 *                       or to the condenser, where noble gases leave through the air-ejector vent
 *   containment → env.  design leakage (0.1 %/day at design pressure, scaled with pressure), plus
 *                       a large path once containment integrity is lost
 * Doses use a ground-level Gaussian plume (Briggs open-country σy/σz) with the current wind.
 */
import type { ReleaseState } from './types';
import type { ReactorSim } from './ReactorSim';
import { mpaToPsig } from './steam';
import * as K from './plant';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

type G = 'ng' | 'i' | 'cs';
const GROUPS: G[] = ['ng', 'i', 'cs'];
/** core inventory at ~3400 MWt, Ci */
const CORE: Record<G, number> = { ng: 3.0e8, i: 7.0e8, cs: 1.6e7 };
/** effective decay constants (1/s): Xe-133-dominated noble gases, I-131-dominated iodine, Cs stable */
const LAMBDA: Record<G, number> = { ng: 1 / (7.6 * 86400), i: 1 / (11.6 * 86400), cs: 0 };
/** fractions released from fuel: gap (per failed rod fraction) and in-vessel melt (per molten fraction) */
const GAP: Record<G, number> = { ng: 0.05, i: 0.05, cs: 0.05 };
const MELT: Record<G, number> = { ng: 0.95, i: 0.4, cs: 0.3 };
/** normal coolant activity as a fraction of core inventory (tramp uranium / pinhole leakers) */
const NORMAL: Record<G, number> = { ng: 2e-7, i: 1e-7, cs: 2e-8 };
/** TEDE dose conversion, rem per (Ci·s/m³) — submersion for noble gases, inhalation + 4-day groundshine for I/Cs */
const DCF: Record<G, number> = { ng: 0.03, i: 4.0, cs: 5.0 };
/** steam/water partition for the SG secondary (fraction carried with steam relative to liquid) */
const PARTITION: Record<G, number> = { ng: 1, i: 0.01, cs: 0.002 };

const SITE_BOUNDARY_M = 805; // 0.5 mi
const TEN_MILES_M = 16093;

type Stab = ReleaseState['stabilityClass'];
const STABS: Stab[] = ['A', 'B', 'C', 'D', 'E', 'F'];

export function chiOverQ(xm: number, u: number, st: Stab): number {
  const x = xm;
  let sy: number, sz: number;
  switch (st) {
    case 'A': sy = 0.22 * x / Math.sqrt(1 + 1e-4 * x); sz = 0.2 * x; break;
    case 'B': sy = 0.16 * x / Math.sqrt(1 + 1e-4 * x); sz = 0.12 * x; break;
    case 'C': sy = 0.11 * x / Math.sqrt(1 + 1e-4 * x); sz = 0.08 * x / Math.sqrt(1 + 2e-4 * x); break;
    case 'D': sy = 0.08 * x / Math.sqrt(1 + 1e-4 * x); sz = 0.06 * x / Math.sqrt(1 + 1.5e-3 * x); break;
    case 'E': sy = 0.06 * x / Math.sqrt(1 + 1e-4 * x); sz = 0.03 * x / (1 + 3e-4 * x); break;
    default: sy = 0.04 * x / Math.sqrt(1 + 1e-4 * x); sz = 0.016 * x / (1 + 3e-4 * x); break;
  }
  return 1 / (Math.PI * sy * Math.max(sz, 1) * Math.max(u, 0.5));
}

const CLASS_RANK: Record<ReleaseState['emergencyClass'], number> = {
  none: 0, 'unusual-event': 1, alert: 2, 'site-area-emergency': 3, 'general-emergency': 4,
};

export class Release {
  // inventories, Ci
  released: Record<G, number> = { ng: 0, i: 0, cs: 0 }; // cumulative fuel → RCS (fraction of core × core)
  rcs: Record<G, number> = { ng: 0, i: 0, cs: 0 };
  sec: Record<G, number> = { ng: 0, i: 0, cs: 0 };
  cont: Record<G, number> = { ng: 0, i: 0, cs: 0 };
  env: Record<G, number> = { ng: 0, i: 0, cs: 0 };
  rate = 0;
  rateBy: Record<G, number> = { ng: 0, i: 0, cs: 0 };
  pathway: ReleaseState['pathway'] = 'none';
  windFrom = 270;
  wind = 4;
  stab: Stab = 'D';
  doseBoundary = 0; // cumulative rem
  dose10 = 0;
  emergencyClass: ReleaseState['emergencyClass'] = 'none';
  private lastReleasedMass = 0;
  private stabTimer = 0;
  private cetHighTimer = 0;
  private lastDt = 0;

  constructor(private sim: ReactorSim) {}

  reset() {
    const sim = this.sim;
    const rng = sim.rng;
    for (const g of GROUPS) {
      this.released[g] = NORMAL[g] * CORE[g];
      this.rcs[g] = NORMAL[g] * CORE[g];
      this.sec[g] = 0; this.cont[g] = 0; this.env[g] = 0; this.rateBy[g] = 0;
    }
    this.rate = 0;
    this.pathway = 'none';
    this.windFrom = rng.range(0, 360);
    this.wind = rng.range(1.5, 7);
    this.stab = rng.pick(['B', 'C', 'D', 'D', 'D', 'E', 'F'] as Stab[]);
    this.stabTimer = rng.range(1800, 7200);
    this.doseBoundary = 0; this.dose10 = 0;
    this.emergencyClass = 'none';
    this.cetHighTimer = 0;
    this.lastReleasedMass = sim.rcsReleasedMass;
  }

  step(dt: number) {
    const sim = this.sim;
    const rng = sim.rng;

    // ---- meteorology (slow drift)
    this.windFrom = (this.windFrom + 0.6 * Math.sqrt(dt) * rng.gauss() + 360) % 360;
    this.wind = clamp(this.wind + 0.02 * Math.sqrt(dt) * rng.gauss() + (4 - this.wind) * dt / 20000, 0.7, 12);
    this.stabTimer -= dt;
    if (this.stabTimer <= 0) {
      this.stabTimer = rng.range(1800, 7200);
      const k = STABS.indexOf(this.stab) + (rng.next() < 0.5 ? -1 : 1);
      this.stab = STABS[clamp(k, 1, 5)];
    }

    // ---- fuel → RCS
    const fail = K.REGION_VFRAC[0] * sim.fail[0] + K.REGION_VFRAC[1] * sim.fail[1];
    const melt = K.REGION_VFRAC[0] * sim.melt[0] + K.REGION_VFRAC[1] * sim.melt[1];
    for (const g of GROUPS) {
      const target = CORE[g] * (NORMAL[g] + GAP[g] * fail + MELT[g] * melt);
      if (target > this.released[g]) {
        // gap release is quick, melt release over a few minutes
        const d = (target - this.released[g]) * Math.min(1, dt / 120);
        this.released[g] += d;
        this.rcs[g] += d;
      }
    }

    // ---- RCS → containment (every kg the plant model put into containment)
    const mRcs = Math.max(1000, sim.ML + sim.pzr.M);
    const dmCont = Math.max(0, sim.rcsReleasedMass - this.lastReleasedMass);
    this.lastReleasedMass = sim.rcsReleasedMass;
    const voided = sim.vaporVolume > 5;
    for (const g of GROUPS) {
      let f = dmCont / mRcs;
      if (g === 'ng' && voided) f *= 3; // noble gases collect in the steam spaces and leave first
      if (sim.vesselBreakArea > 0.3) f += dt / 300; // gross vessel failure: direct communication
      const x = this.rcs[g] * clamp(f, 0, 1);
      this.rcs[g] -= x;
      this.cont[g] += x;
    }

    // ---- RCS → SG secondary (tube leak) and secondary → environment / condenser vent
    let wTube = 0, mSec = 0, wAtm = 0, wCond = 0, wSecToCont = 0;
    for (const s of sim.sg) {
      wTube += s.wTubeLeak;
      mSec += s.M;
      wAtm += s.wArv + s.wSv;
      wSecToCont += s.wBreak;
      wCond += Math.max(0, s.wLine);
    }
    for (const g of GROUPS) {
      const x = this.rcs[g] * clamp((wTube * dt) / mRcs, 0, 1);
      this.rcs[g] -= x;
      this.sec[g] += x;
    }
    let directRate = 0, ventRate = 0;
    const ventFrac = 1; // SJAE exhaust is unfiltered to the plant vent
    const secRate: Record<G, number> = { ng: 0, i: 0, cs: 0 };
    if (mSec > 1) {
      for (const g of GROUPS) {
        const kSteam = g === 'ng' ? 1 / (0.08 * mSec) : PARTITION[g] / mSec;
        const outAtm = this.sec[g] * clamp(wAtm * kSteam * dt, 0, 1);
        const outCond = this.sec[g] * clamp(wCond * kSteam * dt, 0, 1 - wAtm * kSteam * dt);
        const outCont = this.sec[g] * clamp(wSecToCont * kSteam * dt, 0, 1);
        this.sec[g] -= outAtm + outCond + outCont;
        this.cont[g] += outCont;
        // condenser: noble gases go out the air ejector vent; iodine/Cs stay in the condensate
        const vent = g === 'ng' ? outCond * ventFrac : outCond * 0.001;
        this.env[g] += outAtm + vent;
        secRate[g] = (outAtm + vent) / dt;
        directRate += outAtm / dt;
        ventRate += vent / dt;
      }
    }

    // ---- containment → environment
    const Pc = Math.max(0, mpaToPsig(sim.cont.P));
    const integ = sim.integrity.containment;
    const lambdaLeak = (0.001 / 86400) * Math.sqrt(Pc / 45 + 0.01) + (1 - integ) ** 2 / 3600 + (integ <= 0 ? 1 / 1800 : 0);
    const sprays = sim.cont.sprays;
    let contRate = 0;
    for (const g of GROUPS) {
      const dep = g === 'ng' ? 0 : 1 / (3 * 3600) + (sprays ? (g === 'i' ? 1 / 600 : 1 / 1200) : 0);
      const out = this.cont[g] * clamp(lambdaLeak * dt, 0, 1);
      this.cont[g] -= out + this.cont[g] * clamp(dep * dt, 0, 1);
      this.env[g] += out;
      this.rateBy[g] = out / dt + secRate[g];
      contRate += out / dt;
    }

    // ---- radioactive decay of the inventories still on site
    for (const g of GROUPS) {
      const k = Math.exp(-LAMBDA[g] * dt);
      this.rcs[g] *= k; this.sec[g] *= k; this.cont[g] *= k;
    }

    this.rate = this.rateBy.ng + this.rateBy.i + this.rateBy.cs;
    const minRate = 1e-3; // Ci/s considered a release in progress
    if (this.rate < minRate) this.pathway = 'none';
    else if (integ <= 0.5 && contRate >= Math.max(directRate, ventRate)) this.pathway = 'containment-failure';
    else if (sim.vesselBreakArea > 0.3 && integ <= 0) this.pathway = 'direct';
    else if (directRate >= Math.max(contRate, ventRate)) this.pathway = 'sg-tube-steam';
    else if (ventRate >= contRate) this.pathway = 'vent';
    else this.pathway = 'containment-leak';

    // ---- dose accumulation (plume centreline)
    const cqB = chiOverQ(SITE_BOUNDARY_M, this.wind, this.stab);
    const cq10 = chiOverQ(TEN_MILES_M, this.wind, this.stab);
    let dB = 0, d10 = 0;
    for (const g of GROUPS) { dB += this.rateBy[g] * cqB * DCF[g]; d10 += this.rateBy[g] * cq10 * DCF[g]; }
    this.doseBoundary += dB * dt;
    this.dose10 += d10 * dt;
    this.doseRateB = dB;
    this.doseRate10 = d10;

    this.lastDt = dt;
    this.classify();
  }
  doseRateB = 0;
  doseRate10 = 0;

  /** projected TEDE: received so far + 4 h at the current rate */
  projected(atBoundary: boolean) {
    return atBoundary ? this.doseBoundary + this.doseRateB * 4 * 3600 : this.dose10 + this.doseRate10 * 4 * 3600;
  }

  private classify() {
    const sim = this.sim;
    const fd = sim.fuelDamage();
    const melt = K.REGION_VFRAC[0] * sim.melt[0] + K.REGION_VFRAC[1] * sim.melt[1];
    const leakGpm = (sim.breakKgs + sim.tubeLeakKgs + (sim.prtRuptured ? sim.reliefKgs : 0)) / 0.0631;
    const Pc = mpaToPsig(sim.cont.P);
    const rcsBreached = leakGpm > 50 || sim.vesselBreakArea > 0 || (sim.prtRuptured && sim.reliefKgs > 1);
    const contChallenged = sim.integrity.containment < 1 || Pc > 45 || (sim.tubeLeakKgs > 1 && fd > 0.01);
    const pB = this.projected(true);
    let c: ReleaseState['emergencyClass'] = 'none';
    if (sim.siActuated || !sim.offsite || leakGpm > 10 || sim.catastrophe?.kind === 'turbine-missile') c = 'unusual-event';
    const cetF = (Math.max(sim.T[K.UP], sim.T[K.CORE]) * 9) / 5 + 32;
    if (fd > 0.001 || leakGpm > 50 || cetF > 700 || pB > 0.01) c = 'alert';
    if (fd > 0.05 || (fd > 0.01 && rcsBreached) || pB > 0.1) c = 'site-area-emergency';
    // NEI 99-01 style barrier logic: fuel clad lost + RCS lost + potential loss of containment
    // (containment radiation equivalent to gross core damage, or CET > 1200 F for 15 minutes)
    this.cetHighTimer = cetF > 1200 ? this.cetHighTimer + this.lastDt : 0;
    const contPotentialLoss = contChallenged || fd > 0.2 || this.cetHighTimer > 900;
    const twoBarriersPlusOne = fd > 0.05 && rcsBreached && contPotentialLoss;
    if (twoBarriersPlusOne || (melt > 0.02 && contChallenged) || pB > 1 || (sim.catastrophe && sim.catastrophe.kind !== 'turbine-missile') || (fd > 0.05 && sim.integrity.containment <= 0)) c = 'general-emergency';
    // classifications only escalate during an event (terminated by the utility afterwards)
    if (CLASS_RANK[c] > CLASS_RANK[this.emergencyClass]) {
      this.emergencyClass = c;
      sim.emit({ type: 'emergency-class', level: c });
      const names: Record<string, string> = {
        'unusual-event': 'NOTIFICATION OF UNUSUAL EVENT declared — state and local authorities notified.',
        alert: 'ALERT declared — Technical Support Center activated; potential degradation of plant safety.',
        'site-area-emergency': 'SITE AREA EMERGENCY declared — actual or likely major failures of plant functions. Emergency Operations Facility activated; public warned near the site.',
        'general-emergency': 'GENERAL EMERGENCY declared — substantial core damage with potential loss of containment. Protective actions for the public are being ordered.',
      };
      sim.msg(names[c] ?? c);
    }
  }

  evacuationRadius(): number {
    switch (this.emergencyClass) {
      case 'site-area-emergency': return 2;
      case 'general-emergency':
        return this.projected(false) > 0.1 || this.sim.integrity.containment <= 0 || this.projected(true) > 5 ? 10 : 5;
      default: return 0;
    }
  }

  publish(): ReleaseState {
    return {
      nobleGasCi: this.env.ng,
      iodineCi: this.env.i,
      cesiumCi: this.env.cs,
      rateCiPerS: this.rate,
      containmentCi: this.cont.ng + this.cont.i + this.cont.cs,
      pathway: this.pathway,
      windFromDeg: this.windFrom,
      windSpeedMps: this.wind,
      stabilityClass: this.stab,
      siteBoundaryDoseRem: this.projected(true),
      tenMileDoseRem: this.projected(false),
      emergencyClass: this.emergencyClass,
      evacuationRadiusMi: this.evacuationRadius(),
    };
  }
}
