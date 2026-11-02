/**
 * Rod cluster control assemblies: bank worths, overlap sequencing, drop dynamics.
 * Positions are in steps withdrawn (0 = fully inserted, 228 = fully withdrawn).
 */
import type { RodBankId } from './types';
import { ROD_BANKS, ROD_STEPS_MAX } from './types';

/** Total (fully inserted) bank worth, pcm. Total ≈ 7300 pcm. */
export const BANK_WORTH: Record<RodBankId, number> = {
  SA: 1800, SB: 1400, CA: 900, CB: 1100, CC: 1100, CD: 1000,
};
export const CONTROL_BANKS: RodBankId[] = ['CA', 'CB', 'CC', 'CD'];
/** overlap: next bank starts moving when previous reaches this many steps */
export const OVERLAP_START = 128;
export const SEQ_MAX = 3 * OVERLAP_START + ROD_STEPS_MAX; // 612

/**
 * Integral worth fraction withdrawn for a bank at position x (0..1 withdrawn).
 * Blend of the classic cosine-flux S-curve and a linear term (flux is not perfectly cosine).
 */
export function integralFraction(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  const s = c - Math.sin(2 * Math.PI * c) / (2 * Math.PI);
  return 0.72 * s + 0.28 * c;
}
/** differential worth, pcm/step, of a bank at a position */
export function differentialWorth(bank: RodBankId, steps: number): number {
  const c = Math.min(1, Math.max(0, steps / ROD_STEPS_MAX));
  const ds = 1 - Math.cos(2 * Math.PI * c);
  return (BANK_WORTH[bank] * (0.72 * ds + 0.28)) / ROD_STEPS_MAX;
}

/** reactivity (pcm, ≤ 0) inserted by a bank at a position */
export function bankRho(bank: RodBankId, steps: number): number {
  return -BANK_WORTH[bank] * (1 - integralFraction(steps / ROD_STEPS_MAX));
}

/** Sequence counter -> individual control bank positions (100-step overlap). */
export function seqToPositions(seq: number, out: Record<RodBankId, number>) {
  for (let k = 0; k < 4; k++) {
    out[CONTROL_BANKS[k]] = Math.min(ROD_STEPS_MAX, Math.max(0, seq - k * OVERLAP_START));
  }
}
/** Best-estimate sequence counter for current control bank positions. */
export function positionsToSeq(p: Record<RodBankId, number>): number {
  if (p.CD > 0) return p.CD + 3 * OVERLAP_START;
  if (p.CC > 0) return Math.max(p.CC + 2 * OVERLAP_START, Math.min(p.CB, ROD_STEPS_MAX) + OVERLAP_START);
  if (p.CB > 0) return Math.max(p.CB + OVERLAP_START, p.CA);
  return p.CA;
}

/** Find the control bank position that gives a target total control-bank reactivity. */
export function seqForControlRho(targetPcm: number): number {
  const pos = { SA: 228, SB: 228, CA: 0, CB: 0, CC: 0, CD: 0 } as Record<RodBankId, number>;
  let lo = 0, hi = SEQ_MAX;
  for (let it = 0; it < 50; it++) {
    const mid = 0.5 * (lo + hi);
    seqToPositions(mid, pos);
    let r = 0;
    for (const b of CONTROL_BANKS) r += bankRho(b, pos[b]);
    if (r < targetPcm) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export { ROD_BANKS, ROD_STEPS_MAX };
