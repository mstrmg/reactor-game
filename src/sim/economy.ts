/**
 * Grid dispatch and plant economics.
 *  - grid clock (shift starts 07:00), electricity price with a daily curve + noise
 *  - revenue from net MWe sold, fuel + fixed O&M, station-service power bought while off line
 *  - one-off costs for trips, SI, damage, failed equipment (emergent: they are charged when the
 *    physics produces them)
 *  - grid frequency with small noise and a sag when the unit trips at load
 *  - a dispatcher that asks for load changes while the unit is on line
 */
import type { DispatchRequest, GridState } from './types';
import type { ReactorSim } from './ReactorSim';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const SHIFT_START_H = 7;
const FUEL_PER_MWH_TH = 2.0; // $/MWh thermal (≈ $6/MWh electric)
const OM_PER_HOUR = 15000; // $ fixed O&M per hour
const NET_MAX = 1075; // MWe net at 100 %
const NET_MIN = 330;
const RAMP_MW_PER_MIN = 0.05 * 1150; // 5 %/min

const FAULT_REPAIR: Record<string, [string, number]> = {
  STUCK_ROD: ['Rod control repair', 400e3],
  DROPPED_ROD: ['CRDM gripper repair', 350e3],
  RCP_TRIP: ['RCP motor repair', 600e3],
  MFP_TRIP: ['Main feed pump repair', 250e3],
  FEED_VALVE_FAIL: ['Feed regulating valve repair', 120e3],
  PZR_PORV_STUCK_OPEN: ['PORV repair', 300e3],
  PZR_SPRAY_STUCK_OPEN: ['Spray valve repair', 150e3],
  SG_TUBE_LEAK: ['SG tube plugging', 3.5e6],
  SMALL_LOCA: ['RCS pipe repair', 12e6],
  LOSS_OF_OFFSITE_POWER: ['Diesel run & switchyard checks', 80e3],
  TURBINE_TRIP_SPURIOUS: ['EHC transmitter replacement', 40e3],
  STEAM_LINE_BREAK: ['Main steam line repair', 9e6],
  INSTRUMENT_FAIL: ['Instrument channel repair', 25e3],
  CCW_PUMP_TRIP: ['CCW pump motor repair', 90e3],
  CIRC_WATER_PUMP_TRIP: ['Circ water pump repair', 150e3],
  CONDENSATE_PUMP_TRIP: ['Condensate pump repair', 70e3],
};

const CATASTROPHE_COST: Record<string, number> = {
  meltdown: 4e9,
  'steam-explosion': 15e9,
  'vessel-rupture': 3e9,
  'containment-failure': 12e9,
  'turbine-missile': 600e6,
};

/** typical wholesale price curve, $/MWh, for hour of day h (0..24) */
export function basePrice(h: number): number {
  const knots: [number, number][] = [
    [0, 26], [3, 22], [5, 24], [7, 38], [9, 46], [12, 44], [15, 47], [17, 70], [18.5, 115], [19.5, 125],
    [21, 75], [22.5, 40], [24, 26],
  ];
  const x = ((h % 24) + 24) % 24;
  for (let i = 1; i < knots.length; i++) {
    if (x <= knots[i][0]) {
      const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
      const u = (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos(Math.PI * u));
    }
  }
  return 26;
}

export function fmtHour(h: number) {
  const x = ((h % 24) + 24) % 24;
  const hh = Math.floor(x), mm = Math.floor((x - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export class Economy {
  grid: GridState = Economy.blank();
  private priceNoise = 0;
  private spike = 0;
  private fNoise = 0;
  private fSag = 0;
  private hourBucket = { energy: 0, fuel: 0, om: 0, station: 0, hour: SHIFT_START_H };
  private lastGenBook = -1e9;
  private lastFuelBook = -1e9;
  private prev = { tripped: false, turbOnline: false, si: false, genDamage: 0, fuelDamage: 0, prtRuptured: false, seized: 0, catastrophe: false };
  private chargedFaults = new Set<string>();
  private nextId = 1;
  private onlineSince = -1;
  private nextRequestAt = -1;
  private inBandSince = -1;
  private comeOnlineIssued = false;

  constructor(private sim: ReactorSim) {}

  static blank(): GridState {
    return {
      frequencyHz: 60, pricePerMWh: basePrice(SHIFT_START_H), cash: 0, revenue: 0, costs: 0, ledger: [],
      dispatch: null, dispatchHistory: [], hourOfDay: SHIFT_START_H,
    };
  }

  reset() {
    const sim = this.sim;
    this.grid = Economy.blank();
    this.priceNoise = 0; this.spike = 0; this.fNoise = 0; this.fSag = 0;
    this.lastGenBook = -1e9; this.lastFuelBook = -1e9;
    this.hourBucket = { energy: 0, fuel: 0, om: 0, station: 0, hour: SHIFT_START_H };
    this.prev = {
      tripped: sim.reactorTripped, turbOnline: sim.turb.breaker, si: sim.siActuated, genDamage: 0, fuelDamage: 0,
      prtRuptured: false, seized: 0, catastrophe: false,
    };
    this.chargedFaults = new Set();
    this.nextId = 1;
    this.onlineSince = sim.turb.breaker ? 0 : -1;
    this.nextRequestAt = -1;
    this.inBandSince = -1;
    this.comeOnlineIssued = false;
  }

  private book(label: string, amount: number, notable = true) {
    const g = this.grid;
    if (amount >= 0) g.revenue += amount; else g.costs += -amount;
    g.cash = g.revenue - g.costs;
    g.ledger.unshift({ t: this.sim.t, label, amount });
    if (g.ledger.length > 20) g.ledger.length = 20;
    if (notable) this.sim.emit({ type: 'money', label, amount });
  }

  netMW(): number {
    const sim = this.sim;
    const house = sim.bop.houseMW;
    return sim.turb.breaker ? sim.turb.mwe - house : -house;
  }

  step(dt: number) {
    const sim = this.sim;
    const g = this.grid;
    const rng = sim.rng;
    g.hourOfDay = (SHIFT_START_H + sim.t / 3600) % 24;

    // ---- price
    this.priceNoise += (-this.priceNoise / 1800) * dt + 0.06 * Math.sqrt(dt / 1800) * rng.gauss();
    this.spike *= Math.exp(-dt / 900);
    g.pricePerMWh = Math.max(5, basePrice(g.hourOfDay) * (1 + this.priceNoise) + this.spike);

    // ---- frequency
    this.fNoise += (-this.fNoise / 20) * dt + 0.004 * Math.sqrt(dt) * rng.gauss();
    this.fSag *= Math.exp(-dt / 45);
    g.frequencyHz = 60 + clamp(this.fNoise, -0.03, 0.03) - this.fSag;

    // ---- continuous money
    const net = this.netMW();
    const hrs = dt / 3600;
    const energy = net > 0 && sim.turb.breaker ? net * g.pricePerMWh * hrs : 0;
    const station = net < 0 ? -net * g.pricePerMWh * hrs : 0; // house loads bought from the grid
    const thermalMW = Math.max(0, sim.qCoolKW) / 1000;
    const fuel = thermalMW * FUEL_PER_MWH_TH * hrs;
    const om = OM_PER_HOUR * hrs;
    g.revenue += energy;
    g.costs += fuel + om + station;
    g.cash = g.revenue - g.costs;
    const b = this.hourBucket;
    b.energy += energy; b.fuel += fuel; b.om += om; b.station += station;
    const hourNow = Math.floor(SHIFT_START_H + sim.t / 3600);
    if (hourNow > b.hour) {
      const span = `${fmtHour(b.hour)}–${fmtHour(b.hour + 1)}`;
      const push = (label: string, amt: number) => {
        if (Math.abs(amt) < 1) return;
        g.ledger.unshift({ t: sim.t, label: `${label} ${span}`, amount: amt });
      };
      push('Energy sales', b.energy);
      push('Fuel burn', -b.fuel);
      push('Fixed O&M', -b.om);
      push('Station power bought', -b.station);
      if (g.ledger.length > 20) g.ledger.length = 20;
      this.hourBucket = { energy: 0, fuel: 0, om: 0, station: 0, hour: hourNow };
    }

    // ---- one-off costs, emergent from the plant
    const p = this.prev;
    if (sim.reactorTripped && !p.tripped) this.book(`Reactor trip (${sim.firstOut ?? 'unknown'}) — restart & investigation`, -500e3);
    p.tripped = sim.reactorTripped;
    const online = sim.turb.breaker;
    if (!online && p.turbOnline) {
      const lostMW = Math.max(0, this.lastOnlineMW);
      if (lostMW > 100) {
        this.fSag += 0.22 * (lostMW / 1150);
        this.spike += 25 * (lostMW / 1150);
        if (sim.turb.tripped) this.book('Turbine-generator trip at load — inspection', -100e3);
        this.lastOnlineMW = 0;
        sim.msg(`DISPATCHER: We lost ${lostMW.toFixed(0)} MW from your unit — grid frequency dipped to ${(60 - this.fSag).toFixed(2)} Hz. Reserves are picking it up.`);
      }
    }
    if (online && !sim.turb.tripped && sim.turb.mwe > 0) this.lastOnlineMW = Math.max(0, net);
    p.turbOnline = online;
    if (sim.siActuated && !p.si) this.book('Safety injection — borated water cleanup & ECCS inspection', -2e6);
    p.si = sim.siActuated;
    const gd = sim.bop.genDamage;
    // progressive damage is booked in lumps (at most every 30 s) so the ledger is not flooded
    if (gd > p.genDamage + 1e-6 && (sim.t - this.lastGenBook > 30 || gd - p.genDamage > 0.1)) {
      this.book('Generator stator/rotor repair', -60e6 * (gd - p.genDamage));
      p.genDamage = gd; this.lastGenBook = sim.t;
    }
    const fd = sim.fuelDamage();
    if (fd > p.fuelDamage + 0.002 && (sim.t - this.lastFuelBook > 30 || fd - p.fuelDamage > 0.1)) {
      this.book('Fuel damage — core recovery & cleanup', -2e9 * (fd - p.fuelDamage));
      p.fuelDamage = fd; this.lastFuelBook = sim.t;
    }
    if (sim.prtRuptured && !p.prtRuptured) this.book('PRT rupture disk replacement & decon', -250e3);
    p.prtRuptured = sim.prtRuptured;
    const nSeized = sim.bop.seized.filter(Boolean).length;
    if (nSeized > p.seized) this.book('RCP bearing/shaft replacement', -15e6 * (nSeized - p.seized));
    p.seized = nSeized;
    if (sim.catastrophe && !p.catastrophe) this.book(`Plant loss — ${sim.catastrophe.kind}`, -(CATASTROPHE_COST[sim.catastrophe.kind] ?? 5e9));
    p.catastrophe = !!sim.catastrophe;
    for (const f of sim.faults.active) {
      const key = `${f.id}:${f.target ?? ''}:${f.startedAt}`;
      if (this.chargedFaults.has(key)) continue;
      this.chargedFaults.add(key);
      const r = FAULT_REPAIR[f.id];
      if (r) this.book(r[0], -r[1]);
    }

    this.dispatcher(dt, net);
  }
  private lastOnlineMW = 0;

  // ---------------------------------------------------------------- dispatcher
  private issue(req: Omit<DispatchRequest, 'id' | 'issuedAt' | 'status'>) {
    const sim = this.sim;
    const r: DispatchRequest = { ...req, id: this.nextId++, issuedAt: sim.t, status: 'pending' };
    this.grid.dispatch = r;
    this.inBandSince = -1;
    sim.emit({ type: 'dispatch', request: { ...r } });
    sim.msg(`DISPATCHER: ${r.reason} — please be at ${r.targetMW.toFixed(0)} MW net (±${r.toleranceMW.toFixed(0)}) by ${fmtHour(SHIFT_START_H + r.deadline / 3600)}.`);
  }

  private close(status: 'met' | 'missed' | 'cancelled', why: string) {
    const sim = this.sim;
    const g = this.grid;
    const r = g.dispatch;
    if (!r) return;
    r.status = status;
    g.dispatchHistory.unshift({ ...r });
    if (g.dispatchHistory.length > 20) g.dispatchHistory.length = 20;
    g.dispatch = null;
    sim.emit({ type: 'dispatch', request: { ...r } });
    if (status === 'met') this.book(`Dispatch #${r.id} met — ${r.reason}`, r.bonus);
    else if (status === 'missed') this.book(`Dispatch #${r.id} missed — ${r.reason}`, -r.penalty);
    sim.msg(`DISPATCHER: ${why}`);
    this.nextRequestAt = sim.t + sim.rng.range(900, 2400);
  }

  private dispatcher(_dt: number, net: number) {
    const sim = this.sim;
    const g = this.grid;
    const rng = sim.rng;
    const online = sim.turb.breaker && !sim.catastrophe;
    if (online && this.onlineSince < 0) this.onlineSince = sim.t;
    if (!online) this.onlineSince = -1;

    // hot standby: one "come on line" request
    if (!this.comeOnlineIssued && sim.spec.id === 'hot-standby' && sim.t > 30) {
      this.comeOnlineIssued = true;
      this.issue({
        targetMW: 150, toleranceMW: 150, deadline: sim.t + 3.5 * 3600,
        reason: 'Morning load pickup: grid needs your unit synchronised and on line', bonus: 150e3, penalty: 100e3,
      });
    }

    const r = g.dispatch;
    if (r) {
      const inBand = online && Math.abs(net - r.targetMW) <= r.toleranceMW;
      if (inBand) { if (this.inBandSince < 0) this.inBandSince = sim.t; } else this.inBandSince = -1;
      if (this.inBandSince >= 0 && sim.t - this.inBandSince >= 120) {
        this.close('met', `Thanks, holding ${net.toFixed(0)} MW is what we needed (request #${r.id}).`);
      } else if (sim.t > r.deadline) {
        this.close('missed', `Request #${r.id} not met by the deadline — the grid had to buy replacement power. Penalty applied.`);
      } else if (!online && r.reason.indexOf('synchronised') < 0) {
        this.close('cancelled', `Your unit is off line — request #${r.id} cancelled.`);
      }
      return;
    }
    if (!online || sim.t - this.onlineSince < 300) return;
    if (this.nextRequestAt < 0) this.nextRequestAt = sim.t + rng.range(900, 2400);
    if (sim.t < this.nextRequestAt) return;

    // ---- choose a request that the plant can physically meet
    const h = g.hourOfDay;
    const cur = clamp(net, 0, NET_MAX);
    const deadlineMin = rng.range(10, 30);
    const maxMove = RAMP_MW_PER_MIN * 0.6 * deadlineMin;
    type Opt = { reason: string; target: number; weight: number };
    const opts: Opt[] = [];
    if (h >= 15 && h < 20) opts.push({ reason: 'Evening peak building — we need everything you can give', target: NET_MAX, weight: 3 });
    if (h >= 21 || h < 5) opts.push({ reason: 'Night valley: demand falling, please reduce', target: cur - rng.range(150, 300), weight: 3 });
    opts.push({ reason: 'Wind farm output dropped off — please pick up load', target: cur + rng.range(80, 220), weight: 2 });
    opts.push({ reason: 'Transmission line outage on your corridor — please back down', target: cur - rng.range(100, 250), weight: 1.5 });
    opts.push({ reason: 'Frequency event on the interconnection — raise output', target: cur + rng.range(40, 100), weight: 1 });
    opts.push({ reason: 'Economic redispatch — cheaper imports available', target: cur - rng.range(60, 150), weight: h >= 9 && h < 16 ? 1.5 : 0.5 });
    let tot = 0;
    for (const o of opts) tot += o.weight;
    let x = rng.next() * tot;
    let pick = opts[0];
    for (const o of opts) { x -= o.weight; if (x <= 0) { pick = o; break; } }
    let target = clamp(pick.target, Math.max(NET_MIN, cur - maxMove), Math.min(NET_MAX, cur + maxMove));
    // xenon: avoid asking for big increases soon after a large power reduction is impossible to know
    // exactly here; keep increases modest when rods are deep
    if (target > cur && sim.rodSeq < sim.insertionLimit(sim.kin.n * 100) + 40) target = Math.min(target, cur + 60);
    target = Math.round(target / 5) * 5;
    if (Math.abs(target - cur) < 25) {
      // nothing meaningful to ask for — try again later
      this.nextRequestAt = sim.t + rng.range(600, 1200);
      return;
    }
    const dMW = Math.abs(target - cur);
    const bonus = Math.round(5000 + 120 * dMW);
    this.issue({
      targetMW: target, toleranceMW: 20, deadline: sim.t + deadlineMin * 60,
      reason: pick.reason, bonus, penalty: Math.round(bonus * 1.5),
    });
  }
}
