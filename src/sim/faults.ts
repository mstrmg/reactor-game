/**
 * Equipment faults. Every fault acts on the physics (a break area, a failed valve, a lost pump,
 * a biased controller input) — the consequences then follow from the plant model.
 */
import type { ActiveFault, FaultId, RodBankId } from './types';
import type { ReactorSim } from './ReactorSim';
import { CL, HL } from './plant';
import { describeFault } from './describe';

const ALL: FaultId[] = [
  'STUCK_ROD', 'DROPPED_ROD', 'RCP_TRIP', 'MFP_TRIP', 'FEED_VALVE_FAIL', 'PZR_PORV_STUCK_OPEN',
  'PZR_SPRAY_STUCK_OPEN', 'SG_TUBE_LEAK', 'SMALL_LOCA', 'LOSS_OF_OFFSITE_POWER', 'TURBINE_TRIP_SPURIOUS',
  'STEAM_LINE_BREAK', 'INSTRUMENT_FAIL', 'CCW_PUMP_TRIP', 'CIRC_WATER_PUMP_TRIP', 'CONDENSATE_PUMP_TRIP',
];
/** relative likelihood for the random-fault generator */
const WEIGHT: Record<FaultId, number> = {
  STUCK_ROD: 0.7, DROPPED_ROD: 0.8, RCP_TRIP: 1, MFP_TRIP: 1.3, FEED_VALVE_FAIL: 1.3, PZR_PORV_STUCK_OPEN: 0.8,
  PZR_SPRAY_STUCK_OPEN: 0.9, SG_TUBE_LEAK: 0.9, SMALL_LOCA: 0.6, LOSS_OF_OFFSITE_POWER: 0.5,
  TURBINE_TRIP_SPURIOUS: 0.9, STEAM_LINE_BREAK: 0.35, INSTRUMENT_FAIL: 1.4,
  CCW_PUMP_TRIP: 0.9, CIRC_WATER_PUMP_TRIP: 1.0, CONDENSATE_PUMP_TRIP: 1.0,
};

type InstrTarget = 'PR' | 'TAVG' | 'PZR_PRESS' | `SG_LEVEL_${number}`;

export class FaultManager {
  active: ActiveFault[] = [];
  nextRandomAt = -1;
  locaArea = 0;
  locaNode = CL(0);
  tubeLeakArea = 0;
  steamBreak: number[] = [0, 0, 0, 0];
  feedFail: (null | 'open' | 'closed')[] = [null, null, null, null];
  instr: { target: InstrTarget; bias: number; until: number } | null = null;
  turbineSpuriousUntil = -1;

  constructor(private sim: ReactorSim) {}

  has(id: FaultId, target?: number | string): boolean {
    return this.active.some((f) => f.id === id && (target === undefined || f.target === target));
  }
  clear(id: FaultId) {
    this.active = this.active.filter((f) => f.id !== id);
  }

  inject(id: FaultId, target?: number | string): void {
    const sim = this.sim;
    const rng = sim.rng;
    const loopT = () => (typeof target === 'number' ? target % 4 : rng.int(0, 3));
    let tgt: number | string | undefined = target;
    let detail = '';
    switch (id) {
      case 'STUCK_ROD': {
        let bank = (typeof target === 'string' ? target : null) as RodBankId | null;
        if (!bank) {
          const cands: RodBankId[] = (['CD', 'CC', 'CB', 'CA', 'SB', 'SA'] as RodBankId[]).filter((b) => sim.rodPos[b] > 20);
          bank = cands.length ? cands[0] : 'CD';
        }
        sim.stuckRod = { bank, pos: sim.rodPos[bank] };
        tgt = bank;
        detail = `one RCCA in bank ${bank} is mechanically stuck at ${Math.round(sim.rodPos[bank])} steps`;
        break;
      }
      case 'DROPPED_ROD': {
        const cands: RodBankId[] = (['CD', 'CC', 'SB', 'SA'] as RodBankId[]).filter((b) => sim.rodPos[b] > 60);
        const bank = (typeof target === 'string' ? target : cands[0] ?? 'SA') as RodBankId;
        sim.droppedRod = { bank };
        tgt = bank;
        detail = `one RCCA in bank ${bank} dropped to the bottom of the core (stationary gripper failure)`;
        break;
      }
      case 'RCP_TRIP': {
        const i = typeof target === 'number' ? target : this.pick(sim.rcpOn.map((r, k) => (r ? k : -1)).filter((k) => k >= 0)) ?? 0;
        sim.rcpOn[i] = false;
        tgt = i;
        detail = `RCP ${i + 1} tripped on motor overcurrent`;
        break;
      }
      case 'MFP_TRIP': {
        const i = typeof target === 'number' ? target : this.pick(sim.mfpRunning.map((r, k) => (r ? k : -1)).filter((k) => k >= 0)) ?? 0;
        sim.mfpRunning[i] = false;
        sim.controls.mainFeedPumps[i] = false;
        tgt = i;
        detail = `main feed pump ${'AB'[i]} tripped on low suction pressure`;
        break;
      }
      case 'FEED_VALVE_FAIL': {
        const i = loopT();
        const mode = rng.next() < 0.5 ? 'open' : 'closed';
        this.feedFail[i] = mode;
        tgt = i;
        detail = `SG ${i + 1} feedwater regulating valve failed ${mode} (positioner failure)`;
        break;
      }
      case 'PZR_PORV_STUCK_OPEN':
        sim.porvValveOpen = true;
        detail = 'a pressurizer PORV has failed open (pilot solenoid failure); its block valve can still be closed';
        break;
      case 'PZR_SPRAY_STUCK_OPEN':
        detail = 'a pressurizer spray valve has failed partially open; stopping the loop 1 & 2 RCPs stops spray flow';
        break;
      case 'SG_TUBE_LEAK': {
        const i = loopT();
        const rupture = rng.next() < 0.45;
        this.tubeLeakArea = rupture ? rng.range(2.5e-4, 3.8e-4) : rng.range(3e-6, 2.5e-5);
        tgt = i;
        detail = rupture ? `SG ${i + 1} tube rupture (double-ended tube break)` : `SG ${i + 1} tube leak`;
        break;
      }
      case 'SMALL_LOCA': {
        const i = loopT();
        this.locaArea = rng.range(1.2e-4, 1.0e-3);
        this.locaNode = rng.next() < 0.7 ? CL(i) : HL(i);
        tgt = i;
        const dIn = Math.sqrt((4 * this.locaArea) / Math.PI) / 0.0254;
        detail = `${dIn.toFixed(1)}-inch equivalent break in the loop ${i + 1} ${this.locaNode === CL(i) ? 'cold' : 'hot'} leg`;
        break;
      }
      case 'LOSS_OF_OFFSITE_POWER':
        sim.offsite = false;
        sim.offsiteRestoreAt = sim.t + rng.range(20, 40) * 60;
        detail = 'grid disturbance: switchyard breakers opened, all offsite power lost';
        break;
      case 'TURBINE_TRIP_SPURIOUS':
        this.turbineSpuriousUntil = sim.t + 240;
        detail = 'spurious turbine trip (EHC fluid pressure transmitter failure)';
        break;
      case 'STEAM_LINE_BREAK': {
        const i = loopT();
        this.steamBreak[i] = rng.range(0.02, 0.09);
        tgt = i;
        detail = `main steam line break inside containment on SG ${i + 1} (${(this.steamBreak[i] * 10.76).toFixed(2)} ft²)`;
        break;
      }
      case 'CCW_PUMP_TRIP': {
        const c = sim.controls.ccwPumps ?? [];
        for (let k = 0; k < c.length; k++) c[k] = false;
        tgt = undefined;
        detail = 'CCW pump motor tripped on overcurrent; the standby CCW pump did not auto-start';
        break;
      }
      case 'CIRC_WATER_PUMP_TRIP': {
        const c = sim.controls.circWaterPumps ?? [];
        const i = typeof target === 'number' ? target : this.pick(c.map((r, k) => (r ? k : -1)).filter((k) => k >= 0)) ?? 0;
        c[i] = false;
        tgt = i;
        detail = `circulating water pump ${i + 1} tripped (motor ground fault)`;
        break;
      }
      case 'CONDENSATE_PUMP_TRIP': {
        const c = sim.controls.condensatePumps ?? [];
        const i = typeof target === 'number' ? target : this.pick(c.map((r, k) => (r ? k : -1)).filter((k) => k >= 0)) ?? 0;
        c[i] = false;
        tgt = i;
        detail = `condensate pump ${i + 1} tripped on motor overload`;
        break;
      }
      case 'INSTRUMENT_FAIL': {
        const opts: InstrTarget[] = ['PR', 'TAVG', 'PZR_PRESS', `SG_LEVEL_${rng.int(0, 3)}`];
        const t = (typeof target === 'string' ? target : rng.pick(opts)) as InstrTarget;
        const high = rng.next() < 0.7;
        let bias = 0;
        if (t === 'PR') bias = high ? rng.range(10, 18) : -rng.range(15, 30);
        else if (t === 'TAVG') bias = high ? rng.range(6, 12) : -rng.range(6, 12);
        else if (t === 'PZR_PRESS') bias = high ? rng.range(80, 150) : -rng.range(80, 150);
        else bias = high ? rng.range(20, 35) : -rng.range(20, 35);
        this.instr = { target: t, bias, until: sim.t + 20 * 60 };
        tgt = t;
        const name = t === 'PR' ? 'power range NI channel N-41' : t === 'TAVG' ? 'loop Tavg (auctioneered high) RTD' :
          t === 'PZR_PRESS' ? 'controlling pressurizer pressure channel' : `controlling SG ${+t.slice(-1) + 1} level channel`;
        detail = `${name} failed ${bias > 0 ? 'high' : 'low'}`;
        break;
      }
    }
    if (!this.has(id, tgt)) {
      const f: ActiveFault = { id, target: tgt, startedAt: sim.t, description: `${describeFault(id)} — ${detail}.` };
      this.active.push(f);
      sim.emit({ type: 'fault', fault: { ...f } });
      sim.msg(`FAULT: ${detail}.`);
    }
  }

  private pick(arr: number[]): number | undefined {
    return arr.length ? arr[Math.floor(this.sim.rng.next() * arr.length)] : undefined;
  }

  step(_dt: number) {
    const sim = this.sim;
    if (this.instr && sim.t > this.instr.until) {
      this.instr = null;
      this.clear('INSTRUMENT_FAIL');
      sim.msg('I&C technicians have bypassed the failed instrument channel.');
    }
    if (this.turbineSpuriousUntil > 0 && sim.t > this.turbineSpuriousUntil) {
      this.turbineSpuriousUntil = -1;
      this.clear('TURBINE_TRIP_SPURIOUS');
      sim.msg('EHC pressure transmitter replaced — turbine may be relatched.');
    }
    if (!sim.randomFaults || sim.catastrophe) { this.nextRandomAt = -1; return; }
    if (this.nextRandomAt < 0) this.nextRandomAt = sim.t + sim.rng.range(300, 600);
    if (sim.t >= this.nextRandomAt) {
      this.nextRandomAt = sim.t + sim.rng.range(600, 1500);
      const cands = ALL.filter((id) => this.applicable(id));
      if (!cands.length) return;
      let tot = 0;
      for (const c of cands) tot += WEIGHT[c];
      let r = sim.rng.next() * tot;
      for (const c of cands) { r -= WEIGHT[c]; if (r <= 0) { this.inject(c); break; } }
    }
  }

  private applicable(id: FaultId): boolean {
    const sim = this.sim;
    if (this.has(id)) return false;
    switch (id) {
      case 'STUCK_ROD': return !sim.stuckRod && (sim.rodPos.CD > 20 || sim.rodPos.CC > 20);
      case 'DROPPED_ROD': return !sim.droppedRod && !sim.reactorTripped && sim.rodPos.CD > 60;
      case 'RCP_TRIP': return sim.rcpOn.filter((r) => r).length >= 3;
      case 'MFP_TRIP': return sim.mfpRunning.some((r) => r);
      case 'TURBINE_TRIP_SPURIOUS': return sim.turb.latched && !sim.turb.tripped;
      case 'LOSS_OF_OFFSITE_POWER': return sim.offsite;
      case 'INSTRUMENT_FAIL': return !this.instr;
      case 'CCW_PUMP_TRIP': return (sim.controls.ccwPumps ?? []).some(Boolean);
      case 'CIRC_WATER_PUMP_TRIP': return (sim.controls.circWaterPumps ?? []).filter(Boolean).length >= 2;
      case 'CONDENSATE_PUMP_TRIP': return (sim.controls.condensatePumps ?? []).filter(Boolean).length >= 2;
      default: return true;
    }
  }

  // ---------------------------------------------------------- physics hooks
  breakArea(): number { return this.has('SMALL_LOCA') ? this.locaArea : 0; }
  breakNode(): number { return this.locaArea > 0 ? this.locaNode : 0; }
  steamBreakArea(i: number): number { return this.has('STEAM_LINE_BREAK', i) ? this.steamBreak[i] : 0; }
  feedValveFailure(i: number) { return this.has('FEED_VALVE_FAIL', i) ? this.feedFail[i] : null; }
  prBias(): number { return this.instr?.target === 'PR' ? this.instr.bias : 0; }
  tavgBias(): number { return this.instr?.target === 'TAVG' ? this.instr.bias : 0; }
  pzrPressureBias(): number { return this.instr?.target === 'PZR_PRESS' ? this.instr.bias : 0; }
  sgLevelBias(i: number): number { return this.instr?.target === `SG_LEVEL_${i}` ? this.instr.bias : 0; }
}
