/**
 * The crew: Marge (shift supervisor), Theo (reactor operator), Priya (balance of plant)
 * and Hank (field operator, on the radio). They call out what they see in three-way
 * communication style and carry out the player's orders, but they never act on their own.
 *
 * Speech: one speaker at a time through a small priority queue, shown as speech bubbles
 * (bottom left) with a typewriter and per-speaker voice blips. Emits 'crew-say' and
 * 'crew-activity' for the 3D NPCs. Orders: O, or click / F on an NPC ('crew-clicked').
 */
import type { ButtonId, FaultId, PlantControls, PlantState, ReactorSimApi, RodBankId, SimEvent, ActiveFault } from '../sim/types';
import { bus, type CrewId } from '../core/bus';
import { voice, type Speaker } from '../audio/voice';
import { Typer } from './typer';
import { TRIP_LABEL } from './labels';
import { money, netMW } from './economy';

export type Chatter = 'quiet' | 'normal' | 'full';
type Who = CrewId | 'YOU';

export interface CrewHooks {
  /** game is running (not title / game over) */
  playing(): boolean;
  /** hold speech (phone call, remote view, dispatcher call on screen) */
  hold(): boolean;
  /** the procedure's next open step, or null when the startup is complete */
  nextStep(): { n: number; title: string; where: string; control: string; action: string } | null;
  log(text: string): void;
}

export interface CrewApi {
  update(dt: number): void;
  reset(): void;
  handleKey(ev: KeyboardEvent): boolean;
  menuOpen(): boolean;
  openMenu(member?: CrewId): void;
  closeMenu(): void;
  chatter(): Chatter;
  cycleChatter(): Chatter;
  /** a crew member says something (priority 0..3) */
  say(who: CrewId, text: string, prio?: number): void;
}

const CREW: Record<CrewId, { name: string; role: string; voice: Speaker; home: string }> = {
  SRO: { name: 'Marge', role: 'Shift supervisor', voice: 'marge', home: 'PLANT COMPUTER' },
  RO: { name: 'Theo', role: 'Reactor operator', voice: 'theo', home: 'REACTOR CONTROL' },
  BOP: { name: 'Priya', role: 'Balance of plant', voice: 'priya', home: 'FEEDWATER & STEAM DUMP' },
  FIELD: { name: 'Hank', role: 'Field operator · radio', voice: 'hank', home: '' },
};
const ORDER: CrewId[] = ['SRO', 'RO', 'BOP', 'FIELD'];
const B = {
  SAFETY: 'SAFETY SYSTEMS & ELECTRICAL',
  CVCS: 'CVCS / BORON CONTROL',
  RX: 'REACTOR CONTROL',
  SG: 'STEAM GENERATORS',
  FW: 'FEEDWATER & STEAM DUMP',
  TG: 'TURBINE / GENERATOR',
};

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const r0 = (v: number) => Math.round(v).toLocaleString('en-US');
const AB = (i: number) => 'AB'[i] ?? String(i + 1);
const CHATTER_KEY = 'critical.chatter';

// ---------------------------------------------------------------- spoken alarm labels
const WORDS: Record<string, string> = {
  PZR: 'pressurizer', PRESS: 'pressure', LO: 'low', HI: 'high', LOLO: 'low-low', SG: 'steam generator',
  MFP: 'main feed pump', CNMT: 'containment', RAD: 'radiation', TEMP: 'temperature', CCW: 'component cooling water',
  CW: 'circ water', SW: 'service water', VAC: 'vacuum', COND: 'condenser', TURB: 'turbine', GEN: 'generator',
  RX: 'reactor', DEV: 'deviation', ISOL: 'isolation', INJ: 'injection', ACCUM: 'accumulator', HTR: 'heater', HTRS: 'heaters',
  OOS: 'out of service', DG: 'diesel generator', SI: 'safety injection', PR: 'power range', IR: 'intermediate range',
  SR: 'source range', SUR: 'startup rate', DNBR: 'D-N-B ratio', CET: 'core exit temperature', H2: 'hydrogen',
  PRT: 'relief tank', LD: 'letdown', HX: 'heat exchanger', CHG: 'charging', MS: 'main steam', AFW: 'aux feed',
  RIL: 'rod insertion limit', SDM: 'shutdown margin', OTDT: 'overtemp delta-T', VIB: 'vibration', EXP: 'expansion',
  DIFF: 'differential', CRIT: 'critical', INADEQ: 'inadequate', FW: 'feedwater', ACT: 'actuated', MVAR: 'megavars',
  OVERPRESS: 'overpressure', LOOP: 'loss of offsite power', PORV: 'PORV', MSIV: 'MSIV', RCS: 'RCS', RCP: 'RCP',
};
function spoken(label: string): string {
  const t = label
    .replace(/[^A-Z0-9 /-]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => WORDS[w.toUpperCase()] ?? w.toLowerCase())
    .join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function alarmOwner(id: string): CrewId {
  if (/^(PZR|RCS|SUR|PR_|IR_|SR_|ROD|RIL|DNBR|AXIAL|TAVG|OTDT|BORON|CHG|LETDOWN|LD_|SEAL|SDM|CET|SUBCOOL|VESSEL|INADEQ|FUEL|MAKEUP|PRT|P6|P10)/.test(id)) return 'RO';
  if (/^(SG|MFP|FW|COND|CW|HOTWELL|TURB|GEN|HOUSE|STEAM|MS|MSIV|AFW|DG|LOOP|CCW|SW|TURN)/.test(id)) return 'BOP';
  return 'SRO';
}

// ---------------------------------------------------------------- Hank's field observations
function fieldReport(f: ActiveFault): string {
  const n = typeof f.target === 'number' ? f.target : -1;
  const loop = n >= 0 ? ` ${n + 1}` : '';
  const T: Partial<Record<FaultId, string>> = {
    MFP_TRIP: `Main feed pump ${n >= 0 ? AB(n) : ''} just wound down out here. Breaker's flagged tripped and the motor smells cooked. That one's not coming back without maintenance.`,
    CCW_PUMP_TRIP: 'CCW pump motor tripped, I can hear the standby one sitting quiet. Somebody needs to start the standby pump from the board.',
    CIRC_WATER_PUMP_TRIP: `Circ water pump${loop} is coasting down at the intake. Motor breaker's tripped. Condenser's going to feel that.`,
    CONDENSATE_PUMP_TRIP: `Condensate pump${loop} tripped on overcurrent. Discharge pressure gauge is dropping. Your feed pump suction will follow.`,
    RCP_TRIP: `Can't get into containment, but the switchgear room says RCP${loop} breaker just opened on overcurrent.`,
    FEED_VALVE_FAIL: `Feed reg valve${loop} actuator is hunting, or stuck. Air line's hissing like a snake. Check it on the board.`,
    SG_TUBE_LEAK: `Steam jet air ejector rad monitor out here is climbing. Smells like a tube leak to me${loop ? `, maybe generator${loop}` : ''}.`,
    STEAM_LINE_BREAK: `Big steam leak in the main steam tunnel${loop ? ` on line${loop}` : ''}! I'm not going in there. It's a white-out.`,
    LOSS_OF_OFFSITE_POWER: 'Switchyard just went dark! Lights are out everywhere except emergency lighting. Diesels are cranking, I can hear them.',
    TURBINE_TRIP_SPURIOUS: 'Turbine just tripped on its own out here. Stop valves slammed shut. No fire, no smoke.',
    SMALL_LOCA: 'Auxiliary building sump pumps are cycling a lot more than usual. Something is leaking somewhere.',
    PZR_PORV_STUCK_OPEN: 'Relief tank discharge line is roaring. Sounds like something on the pressurizer is stuck open.',
    PZR_SPRAY_STUCK_OPEN: 'Can’t see the spray valve from here, but the air supply to it is wide open.',
    STUCK_ROD: 'Rod drive power cabinets are throwing an urgent failure light. One of the rods isn’t following.',
    DROPPED_ROD: 'Rod control cabinet just alarmed. Something dropped. Not literally, I hope.',
    INSTRUMENT_FAIL: 'Instrument rack in the cable spreading room has a channel throwing a failure flag.',
  };
  return T[f.id] ?? `Something just happened out here. ${f.description}`;
}

// ---------------------------------------------------------------- types
interface Line {
  who: Who;
  text: string | (() => string);
  prio: number;
  queued: number; // real ms
  key?: string;
  onDone?: () => void;
}
interface Job {
  member: CrewId;
  label: string;
  you: string;
  readback: string;
  board: string;
  walk: number; // real s before acting
  check?: () => string | null;
  exec: () => void;
  /** continuous jobs: return a done/fail text when finished */
  tick?: (s: PlantState) => string | null;
  verifyAfter?: number;
  verify?: () => boolean;
  done: () => string;
  fail?: (msg: string | null) => string;
  /** SRO-style: no walking, just talk */
  talk?: () => string[];
}
interface Running {
  job: Job;
  phase: 'readback' | 'walk' | 'tick' | 'verify' | 'report';
  t: number;
  msgs: string[];
}
interface MenuItem {
  label: string;
  note?: string;
  off?: boolean;
  sub?: () => MenuItem[];
  job?: () => Job;
}

export function createCrew(root: HTMLElement, sim: ReactorSimApi, hooks: CrewHooks): CrewApi {
  const st = (): PlantState | undefined => (sim as { state?: PlantState }).state;
  const ctl = (): PlantControls | undefined => sim.controls;

  let chatter: Chatter = 'normal';
  try {
    const v = localStorage.getItem(CHATTER_KEY);
    if (v === 'quiet' || v === 'normal' || v === 'full') chatter = v;
  } catch {
    /* storage blocked */
  }

  // ================= bubbles =================
  const stack = document.createElement('div');
  stack.className = 'crew';
  root.appendChild(stack);
  interface Bubble { el: HTMLElement; born: number }
  const bubbles: Bubble[] = [];
  let typer: Typer | null = null;
  let cur: Line | null = null;
  let curDoneAt = 0;
  const queue: Line[] = [];
  let gapUntil = 0;
  let squelchUntil = 0;

  function makeBubble(who: Who): HTMLElement {
    const el = document.createElement('div');
    const m = who === 'YOU' ? null : CREW[who];
    el.className = 'cb';
    el.dataset.who = who === 'YOU' ? 'you' : m!.voice;
    el.innerHTML = `<div class="cb__name">${who === 'YOU' ? 'You' : esc(m!.name)}<small>${who === 'YOU' ? 'Unit supervisor' : esc(who === 'FIELD' ? 'Field · radio' : m!.role)}</small></div><p class="cb__text"></p>`;
    stack.appendChild(el);
    bubbles.push({ el, born: performance.now() });
    while (bubbles.length > 3) bubbles.shift()!.el.remove();
    return el;
  }

  const cooldown = new Map<string, number>(); // key -> real ms when allowed again

  function allowed(prio: number): boolean {
    if (prio >= 3) return true;
    if (chatter === 'quiet') return false;
    if (chatter === 'normal') return prio >= 1;
    return true;
  }
  /** queue a line; key + throttle (s) suppress repeats */
  function enqueue(who: Who, text: Line['text'], prio: number, opt: { key?: string; throttle?: number; onDone?: () => void } = {}) {
    if (!allowed(prio)) {
      opt.onDone?.();
      return;
    }
    const now = performance.now();
    if (opt.key) {
      const until = cooldown.get(opt.key) ?? 0;
      if (now < until) return;
      const thr = (opt.throttle ?? 60) * (chatter === 'normal' && prio <= 1 ? 2 : 1);
      cooldown.set(opt.key, now + thr * 1000);
      if (queue.some((l) => l.key === opt.key)) return;
    }
    queue.push({ who, text, prio, queued: now, key: opt.key, onDone: opt.onDone });
    // keep the queue short: drop the lowest-priority, oldest chatter
    while (queue.length > 5) {
      let worst = -1;
      for (let i = 0; i < queue.length; i++) if (queue[i].prio < 3 && (worst < 0 || queue[i].prio < queue[worst].prio)) worst = i;
      if (worst < 0) break;
      const [x] = queue.splice(worst, 1);
      x.onDone?.();
    }
  }
  function nextLine(): Line | null {
    const now = performance.now();
    // drop stale chatter (it is no longer true)
    for (let i = queue.length - 1; i >= 0; i--) {
      const l = queue[i];
      if (l.prio < 3 && now - l.queued > (l.prio >= 2 ? 25000 : 14000)) {
        queue.splice(i, 1);
        l.onDone?.();
      }
    }
    if (!queue.length) return null;
    // highest priority first, FIFO within a priority
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].prio > queue[best].prio) best = i;
    return queue.splice(best, 1)[0];
  }
  const talking = new Set<CrewId>();
  function speak(l: Line) {
    cur = l;
    const text = typeof l.text === 'function' ? l.text() : l.text;
    const el = makeBubble(l.who);
    typer = new Typer(el.querySelector('.cb__text') as HTMLElement);
    const sp: Speaker = l.who === 'YOU' ? 'you' : CREW[l.who].voice;
    if (l.who === 'FIELD') {
      voice.radio();
      squelchUntil = performance.now() + 260;
      el.classList.add('is-radio');
    }
    typer.start(text, sp);
    curDoneAt = 0;
    if (l.who !== 'YOU') {
      bus.emit('crew-say', { member: l.who, text });
      if (l.who !== 'FIELD' && !running.has(l.who)) {
        talking.add(l.who);
        bus.emit('crew-activity', { member: l.who, board: null, state: 'talking' });
      }
    }
  }
  function endLine() {
    const l = cur;
    cur = null;
    typer = null;
    gapUntil = performance.now() + 450;
    if (l && l.who !== 'YOU' && talking.has(l.who as CrewId)) {
      talking.delete(l.who as CrewId);
      if (!running.has(l.who as CrewId)) bus.emit('crew-activity', { member: l.who as CrewId, board: null, state: 'idle' });
    }
    if (l?.who === 'FIELD') voice.radio();
    l?.onDone?.();
  }
  function speechUpdate(dt: number) {
    const now = performance.now();
    if (cur && typer) {
      if (now >= squelchUntil) typer.update(dt);
      if (typer.done) {
        if (!curDoneAt) curDoneAt = now;
        const hold = Math.min(1400, 500 + typer.text.length * 12);
        if (now - curDoneAt > hold) endLine();
      }
    } else if (now >= gapUntil && !hooks.hold()) {
      const l = nextLine();
      if (l) speak(l);
    }
    // fade old bubbles
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      const isCur = i === bubbles.length - 1 && cur;
      if (isCur) {
        b.born = now;
        continue;
      }
      const age = now - b.born;
      b.el.classList.toggle('is-old', true);
      if (age > 7000) {
        b.el.remove();
        bubbles.splice(i, 1);
      }
    }
  }

  // ================= jobs =================
  const running = new Map<CrewId, Running>();
  const lastMsgs: { t: number; text: string }[] = [];

  function issue(job: Job) {
    const m = job.member;
    const busy = running.get(m);
    hooks.log(`Order to ${CREW[m].name}: ${job.label}`);
    enqueue('YOU', `${CREW[m].name}, ${job.you}`, 3);
    if (busy) {
      enqueue(m, pick([`Give me a second, I’m still on “${busy.job.label}”.`, `Hang on, still working “${busy.job.label}”.`]), 3);
      return;
    }
    const r: Running = { job, phase: 'readback', t: 0, msgs: [] };
    running.set(m, r);
    enqueue(m, job.readback, 3, {
      onDone: () => {
        if (running.get(m) !== r) return;
        if (job.talk) {
          r.phase = 'report';
          const lines = job.talk();
          lines.forEach((tx, i) => enqueue(m, tx, 3, i === lines.length - 1 ? { onDone: () => finish(m, r) } : {}));
          if (!lines.length) finish(m, r);
          return;
        }
        r.phase = 'walk';
        r.t = 0;
        if (m !== 'FIELD') bus.emit('crew-activity', { member: m, board: job.board, state: 'walking' });
      },
    });
  }
  function finish(m: CrewId, r: Running) {
    if (running.get(m) === r) running.delete(m);
    if (m !== 'FIELD') bus.emit('crew-activity', { member: m, board: null, state: 'idle' });
  }
  function report(m: CrewId, r: Running, text: string) {
    r.phase = 'report';
    enqueue(m, text, 3, { onDone: () => finish(m, r) });
  }
  function blockedMsg(r: Running): string | null {
    const b = r.msgs.find((x) => /blocked|cannot|can't|not allowed/i.test(x));
    return b ?? null;
  }
  function jobsUpdate(dt: number) {
    const s = st();
    if (!s) return;
    for (const [m, r] of running) {
      const j = r.job;
      if (r.phase === 'walk') {
        r.t += dt;
        if (r.t < j.walk) continue;
        const why = j.check?.() ?? null;
        if (why) {
          report(m, r, why);
          continue;
        }
        r.msgs = [];
        try {
          j.exec();
        } catch {
          report(m, r, 'That didn’t take. Something’s off with the board.');
          continue;
        }
        if (m !== 'FIELD') bus.emit('crew-activity', { member: m, board: j.board, state: 'operating' });
        r.t = 0;
        r.phase = j.tick ? 'tick' : 'verify';
      } else if (r.phase === 'tick') {
        r.t += dt;
        const res = j.tick!(s);
        if (res) report(m, r, res);
      } else if (r.phase === 'verify') {
        r.t += dt;
        if (r.t < (j.verifyAfter ?? 1.6)) continue;
        const ok = j.verify ? j.verify() : true;
        if (ok) report(m, r, j.done());
        else report(m, r, j.fail ? j.fail(blockedMsg(r)) : `That didn’t work.${blockedMsg(r) ? ' ' + blockedMsg(r) : ''}`);
      }
    }
  }

  // ---------------- job builders ----------------
  const walkT = (m: CrewId) => (m === 'FIELD' ? 7 + Math.random() * 4 : 2 + Math.random() * 2);
  const blockedTail = (msg: string | null) => (msg ? msg.replace(/^.*blocked:\s*/i, '').replace(/\.$/, '') : '');

  function mfpJob(i: number, on: boolean): Job {
    const name = `MFP ${AB(i)}`;
    return {
      member: 'BOP',
      label: `${on ? 'start' : 'stop'} ${name}`,
      you: `${on ? 'start' : 'stop'} main feed pump ${AB(i)}.`,
      readback: `${on ? 'Start' : 'Stop'} main feed pump ${AB(i)}, aye.`,
      board: B.FW,
      walk: walkT('BOP'),
      check: () => {
        const s = st()!;
        if (s.mainFeedPumpsRunning[i] === on) return `${name} is already ${on ? 'running' : 'stopped'}.`;
        if (on && s.bop && s.bop.mfpSuctionPsig < 100 && !s.bop.condensateRunning.some(Boolean)) return `Can’t start ${name}: no suction pressure. No condensate pumps running.`;
        return null;
      },
      exec: () => {
        const c = ctl()!;
        c.mainFeedPumps[i] = on;
      },
      verify: () => st()!.mainFeedPumpsRunning[i] === on,
      done: () => `${name} ${on ? 'running' : 'stopped'}. ${on ? `Suction ${r0(st()!.bop?.mfpSuctionPsig ?? 0)} psig.` : ''}`.trim(),
      fail: (msg) => `Can’t ${on ? 'start' : 'stop'} ${name}${msg ? `: ${blockedTail(msg)}` : ''}.`,
    };
  }
  function pumpJob(kind: 'cw' | 'cond'): Job {
    const isCw = kind === 'cw';
    const nm = isCw ? 'circ water pump' : 'condensate pump';
    let idx = -1;
    return {
      member: 'BOP',
      label: `start a ${nm}`,
      you: `start another ${nm}.`,
      readback: `Start a ${nm}, aye.`,
      board: B.FW,
      walk: walkT('BOP'),
      check: () => {
        const c = ctl()!;
        const s = st()!;
        const arr = (isCw ? c.circWaterPumps : c.condensatePumps) ?? [];
        const run = (isCw ? s.bop?.circWaterRunning : s.bop?.condensateRunning) ?? arr;
        idx = run.findIndex((x) => !x);
        if (!arr.length) return `I don’t have ${nm} switches on this board.`;
        if (idx < 0) return `All three ${nm}s are already running.`;
        if (!s.offsitePower) return `Can’t start a ${nm}: no offsite power to the non-safety buses.`;
        return null;
      },
      exec: () => {
        const c = ctl()!;
        const arr = isCw ? c.circWaterPumps : c.condensatePumps;
        if (arr) arr[idx] = true;
      },
      verifyAfter: 2.2,
      verify: () => {
        const s = st()!;
        const run = isCw ? s.bop?.circWaterRunning : s.bop?.condensateRunning;
        return run ? !!run[idx] : true;
      },
      done: () => `${nm.charAt(0).toUpperCase() + nm.slice(1)} ${idx + 1} running.${isCw ? ` Vacuum ${(st()!.condenserVacuum).toFixed(1)} inches.` : ''}`,
      fail: (msg) => `${nm.charAt(0).toUpperCase() + nm.slice(1)} ${idx + 1} won’t start${msg ? `: ${blockedTail(msg)}` : ''}.`,
    };
  }
  function houseJob(): Job {
    const s = st();
    const toUat = (s?.bop?.electrical.houseLoadsOn ?? 'SAT') === 'SAT';
    const tgt = toUat ? 'unit auxiliary transformer' : 'startup transformer';
    return {
      member: 'BOP',
      label: `transfer house loads to the ${toUat ? 'UAT' : 'SAT'}`,
      you: `transfer house loads to the ${tgt}.`,
      readback: `Transfer house loads to the ${tgt}, aye.`,
      board: B.SAFETY,
      walk: walkT('BOP'),
      check: () => (toUat && !st()!.generatorBreakerClosed ? 'Can’t go to the UAT: the generator isn’t on line, there’s nothing to feed it.' : null),
      exec: () => sim.press(toUat ? 'HOUSE_XFER_UAT' : 'HOUSE_XFER_SAT'),
      verify: () => (st()!.bop?.electrical.houseLoadsOn ?? (toUat ? 'UAT' : 'SAT')) === (toUat ? 'UAT' : 'SAT'),
      done: () => `House loads on the ${tgt}.${toUat ? ` We’re carrying ${r0(st()!.bop?.electrical.houseLoadMW ?? 0)} megawatts of our own.` : ''}`,
      fail: (msg) => `Transfer didn’t go${msg ? `: ${blockedTail(msg)}` : ''}.`,
    };
  }
  function frvJob(): Job {
    return {
      member: 'BOP',
      label: 'feed reg valves to auto',
      you: 'put all four feed reg valves in automatic.',
      readback: 'All four feed reg valves to auto, aye.',
      board: B.FW,
      walk: walkT('BOP'),
      check: () => {
        const c = ctl()!;
        if (c.feedMode.every((x) => x === 'auto')) return 'They’re already all in auto.';
        if (st()!.ext?.fwIsolation) return 'I can put them in auto, but feedwater isolation is in. They’ll stay shut until it resets.';
        return null;
      },
      exec: () => {
        const c = ctl()!;
        for (let i = 0; i < c.feedMode.length; i++) c.feedMode[i] = 'auto';
      },
      verify: () => ctl()!.feedMode.every((x) => x === 'auto'),
      done: () => {
        const s = st()!;
        const lv = s.loops.map((l) => l.sgLevel);
        return `Feed regs in auto. Levels ${lv.map((v) => r0(v)).join(', ')} percent.`;
      },
    };
  }
  function loadJob(mw: number | null, delta: number): Job {
    const label = mw != null ? `turbine load ${mw} MW` : `turbine load ${delta > 0 ? '+' : '−'}${Math.abs(delta)} MW`;
    let target = 0;
    return {
      member: 'BOP',
      label,
      you: mw != null ? `set turbine load to ${mw} megawatts.` : `${delta > 0 ? 'raise' : 'lower'} turbine load ${Math.abs(delta)} megawatts.`,
      readback: mw != null ? `Turbine load setpoint ${mw} megawatts, aye.` : `${delta > 0 ? 'Raise' : 'Lower'} load ${Math.abs(delta)} megawatts, aye.`,
      board: B.TG,
      walk: walkT('BOP'),
      check: () => {
        const s = st()!;
        if (!s.generatorBreakerClosed) return 'Can’t load the turbine: the generator breaker is open.';
        const c = ctl()!;
        target = Math.max(0, Math.min(1200, mw ?? c.turbineLoadSetpointMW + delta));
        if (s.reactorTripped) return 'Reactor’s tripped. There’s no steam to load with.';
        return null;
      },
      exec: () => {
        ctl()!.turbineLoadSetpointMW = target;
      },
      verifyAfter: 1,
      done: () => {
        const c = ctl()!;
        const now = st()!.turbineLoadMW;
        const mins = Math.abs(target - now) / Math.max(1, c.turbineRampRateMWpm);
        return `Load setpoint ${r0(target)} megawatts, ramping at ${r0(c.turbineRampRateMWpm)} a minute. About ${Math.max(1, Math.round(mins))} minute${mins >= 1.5 ? 's' : ''}.${target > 900 ? ' Watch Tavg, Theo.' : ''}`;
      },
    };
  }
  function dumpJob(mode: PlantControls['steamDumpMode']): Job {
    const nm = mode === 'tavg' ? 'Tavg mode' : mode === 'pressure' ? 'steam pressure mode' : 'off';
    return {
      member: 'BOP',
      label: `steam dumps ${nm}`,
      you: `steam dumps to ${nm}.`,
      readback: `Steam dumps to ${nm}, aye.`,
      board: B.FW,
      walk: walkT('BOP'),
      check: () => (ctl()!.steamDumpMode === mode ? `Steam dumps are already in ${nm}.` : null),
      exec: () => {
        ctl()!.steamDumpMode = mode;
      },
      done: () => `Steam dumps in ${nm}.${mode !== 'off' && st()!.ext && !st()!.ext!.steamDumpsAvailable ? ' But C-9 isn’t made up, no condenser. They won’t open.' : ''}`,
    };
  }

  function makeupJob(kind: 'borate' | 'dilute', gal: number): Job {
    return {
      member: 'RO',
      label: `${kind} ${gal} gal`,
      you: `${kind} ${gal} gallons.`,
      readback: `${kind === 'borate' ? 'Borate' : 'Dilute'} ${gal} gallons, aye.`,
      board: B.CVCS,
      walk: walkT('RO'),
      check: () => {
        const s = st()!;
        if (s.bop?.makeupBatch.active) return `A batch is already running, ${r0(s.bop.makeupBatch.deliveredGal)} of ${r0(s.bop.makeupBatch.targetGal)} gallons. Want me to stop it first?`;
        if (kind === 'dilute' && s.reactorTripped) return 'Not diluting with the reactor tripped. That’s how you get a surprise criticality.';
        if (kind === 'dilute' && s.startupRateDpm > 0.5) return 'Startup rate’s already positive. I’m not adding reactivity on top of that.';
        return null;
      },
      exec: () => {
        const c = ctl()!;
        c.makeupMode = kind;
        if (!(c.makeupRateGpm > 0)) c.makeupRateGpm = 60;
        if (c.makeupBatchGallons !== undefined || st()!.bop) {
          c.makeupBatchGallons = gal;
          sim.press('MAKEUP_BATCH_START');
        }
      },
      verifyAfter: 1.2,
      verify: () => {
        const s = st()!;
        return s.bop ? s.bop.makeupBatch.active : true;
      },
      done: () => `${kind === 'borate' ? 'Boration' : 'Dilution'} of ${gal} gallons in progress at ${r0(ctl()!.makeupRateGpm)} gpm. I’ll call it when it’s in.`,
      fail: (msg) => `Batch didn’t start${msg ? `: ${blockedTail(msg)}` : ''}.`,
    };
  }

  function rodJob(dir: 1 | -1, steps: number): Job {
    let start: Record<RodBankId, number> | null = null;
    let t0 = 0;
    let lastMoveT = 0;
    let lastMax = 0;
    const word = dir > 0 ? 'withdraw' : 'insert';
    const moved = (s: PlantState) => {
      let m = 0;
      for (const b of Object.keys(s.rods) as RodBankId[]) m = Math.max(m, Math.abs(s.rods[b] - (start![b] ?? 0)));
      return m;
    };
    const leadBank = (s: PlantState) => {
      const order: RodBankId[] = ['CD', 'CC', 'CB', 'CA'];
      for (const b of order) if (s.rods[b] > 0.5 && s.rods[b] < 227.5) return `Bank ${b.slice(1)} at ${r0(s.rods[b])}`;
      return `Bank D at ${r0(s.rods.CD)}`;
    };
    const stop = () => {
      const c = ctl();
      if (c) c.rodMotion = 0;
    };
    return {
      member: 'RO',
      label: `${word} rods ${steps} steps`,
      you: `${word} control rods ${steps} steps.`,
      readback: `${dir > 0 ? 'Withdraw' : 'Insert'} control rods ${steps} steps, aye.`,
      board: B.RX,
      walk: 1.2 + Math.random(),
      check: () => {
        const s = st()!;
        const c = ctl()!;
        if (s.reactorTripped) return 'Can’t. The reactor is tripped, the rods are on the bottom. Reset the trip breakers first.';
        if (c.rodMode === 'auto') return 'Rods are in automatic. Tell me to take them to manual first.';
        if (dir > 0 && s.startupRateDpm > 1) return `Startup rate is ${s.startupRateDpm.toFixed(1)} decades a minute. I’m not pulling rods on that.`;
        if (dir > 0 && s.ext?.rodStops && (s.ext.rodStops.C1 || s.ext.rodStops.C2 || s.ext.rodStops.C3 || s.ext.rodStops.C4)) return 'There’s a rod stop in. Rods won’t withdraw until it clears.';
        return null;
      },
      exec: () => {
        const s = st()!;
        start = { ...s.rods };
        t0 = s.t;
        lastMoveT = s.t;
        lastMax = 0;
        ctl()!.rodMotion = dir;
      },
      tick: (s) => {
        const c = ctl()!;
        const m = moved(s);
        if (m > lastMax + 0.01) {
          lastMax = m;
          lastMoveT = s.t;
        }
        if (s.reactorTripped) {
          stop();
          return 'Reactor tripped! Rods are on the bottom.';
        }
        if (c.rodMode === 'auto') {
          stop();
          return 'Rods went to auto. I stopped.';
        }
        if (c.rodMotion !== dir) {
          // somebody else grabbed the lever
          return `Okay, you’ve got the rods. Moved ${r0(m)} steps.`;
        }
        if (dir > 0 && s.startupRateDpm > 1) {
          stop();
          return `Stopping at ${r0(m)} steps. Startup rate’s ${s.startupRateDpm.toFixed(1)} decades a minute.`;
        }
        if (m >= steps - 0.01) {
          stop();
          return `Rods ${dir > 0 ? 'out' : 'in'} ${steps} steps. ${leadBank(s)}.${dir > 0 && s.startupRateDpm > 0.05 ? ` Startup rate ${s.startupRateDpm.toFixed(2)}.` : ''}`;
        }
        if (s.t - lastMoveT > 15) {
          stop();
          return `Rods stopped moving at ${r0(m)} steps. ${dir > 0 ? 'Probably a rod stop or they’re all the way out.' : 'They’re on the bottom.'}`;
        }
        if (s.t - t0 > (steps / 48) * 60 * 2 + 20) {
          stop();
          return `Took too long, I stopped at ${r0(m)} steps.`;
        }
        return null;
      },
      done: () => '',
    };
  }
  function rodModeJob(): Job {
    const toAuto = ctl()?.rodMode !== 'auto';
    return {
      member: 'RO',
      label: `rods to ${toAuto ? 'auto' : 'manual'}`,
      you: `rod control to ${toAuto ? 'automatic' : 'manual'}.`,
      readback: `Rod control to ${toAuto ? 'automatic' : 'manual'}, aye.`,
      board: B.RX,
      walk: 1.2 + Math.random(),
      check: () => {
        const s = st()!;
        if (toAuto && s.turbineLoadMW < 0.15 * 1150 && s.powerRangePct < 15) return 'Auto rods aren’t allowed below fifteen percent turbine load. C-5 blocks it.';
        if (toAuto && Math.abs(s.tAvg - s.tRef) > 3) return `Tavg is ${Math.abs(s.tAvg - s.tRef).toFixed(1)} degrees off Tref. If I go to auto now they’ll jump. Match them first.`;
        return null;
      },
      exec: () => {
        const c = ctl()!;
        c.rodMotion = 0;
        c.rodMode = toAuto ? 'auto' : 'manual';
      },
      verifyAfter: 0.8,
      done: () => `Rods in ${toAuto ? 'automatic, following Tref' : 'manual'}.`,
    };
  }
  function tripJob(): Job {
    return {
      member: 'RO',
      label: 'trip the reactor',
      you: 'trip the reactor!',
      readback: 'Tripping the reactor!',
      board: B.RX,
      walk: 0.6,
      check: () => (st()!.reactorTripped ? 'Reactor’s already tripped.' : null),
      exec: () => sim.press('REACTOR_TRIP'),
      verifyAfter: 1.5,
      verify: () => st()!.reactorTripped,
      done: () => 'Reactor tripped. Rods on the bottom, flux dropping.',
    };
  }

  // ---------- SRO talk ----------
  function statusLines(): string[] {
    const s = st()!;
    const out: string[] = [];
    let mode: string;
    if (s.reactorTripped) mode = 'We’re tripped';
    else if (s.powerRangePct >= 2) mode = `We’re at ${s.powerRangePct.toFixed(0)} percent power`;
    else if (s.keff >= 0.9995 && s.neutronPower > 1e-8) mode = 'Reactor’s critical below the point of adding heat';
    else mode = 'Reactor is subcritical';
    const d = s.tAvg - s.tRef;
    out.push(`${mode}. Tavg ${s.tAvg.toFixed(0)}${Math.abs(d) > 1 && !s.reactorTripped && s.powerRangePct > 5 ? `, ${Math.abs(d).toFixed(1)} ${d > 0 ? 'above' : 'below'} Tref` : ''}. Pressurizer ${r0(s.rcsPressure)} psig, level ${r0(s.przLevel)} percent.`);
    const lv = s.loops.map((l) => l.sgLevel);
    const g = s.grid;
    out.push(
      `Steam generator levels ${r0(Math.min(...lv))} to ${r0(Math.max(...lv))}. ${s.generatorBreakerClosed ? `We’re on the grid at ${r0(netMW(s))} megawatts net` : 'Generator is off line'}${g ? `, shift earnings ${money(g.cash)}` : ''}.`,
    );
    const act = s.alarms.filter((a) => a.active && a.severity !== 'info');
    const faults = s.faults.length;
    out.push(act.length ? `${act.length} alarm${act.length > 1 ? 's' : ''} in${faults ? `, and ${faults} equipment problem${faults > 1 ? 's' : ''} I know of` : ''}. Press E if you want the details.` : faults ? `Boards are quiet, but we’ve got ${faults} equipment problem${faults > 1 ? 's' : ''}.` : 'Boards are quiet. Nice and boring, just how I like it.');
    return out;
  }
  function nextLines(): string[] {
    const s = st()!;
    if (s.reactorTripped) return ['First things first: we’re tripped. Stabilize, find the first out, then reset the trip breakers on REACTOR CONTROL when the signal clears.'];
    const n = hooks.nextStep();
    if (!n) return ['Startup’s complete. Keep the running checks green and keep Lorraine happy.'];
    return [`Step ${n.n}: ${n.title}.`, `That’s on ${n.where}, ${n.control}. ${n.action}`];
  }
  function briefLines(): string[] {
    const s = st()!;
    const rel = s.release;
    const out: string[] = [];
    if (rel && rel.emergencyClass !== 'none') {
      const total = rel.nobleGasCi + rel.iodineCi + rel.cesiumCi;
      out.push(`We’re in ${EC_SPOKEN[rel.emergencyClass]}. ${total > 1 ? `${fmtCi(total)} curies out so far,` : 'No significant release yet,'} site boundary dose ${rel.siteBoundaryDoseRem.toFixed(rel.siteBoundaryDoseRem < 1 ? 2 : 1)} rem.`);
      if (rel.evacuationRadiusMi > 0) out.push(`State is evacuating out to ${r0(rel.evacuationRadiusMi)} miles. Wind’s from ${r0(rel.windFromDeg)} degrees.`);
    }
    if (s.siActuated) out.push('Safety injection is in. Verify SI flow and containment isolation, and don’t reset SI until we have subcooling.');
    if (s.reactorTripped) out.push(`Reactor trip, first out ${s.firstOut ? TRIP_LABEL[s.firstOut] ?? s.firstOut : 'unknown'}. Immediate actions: rods on the bottom, turbine tripped, safety buses powered, check SI.`);
    if (s.fuelDamage > 0.001) out.push(`Core exit thermocouples say we have fuel damage, about ${(s.fuelDamage * 100).toFixed(0)} percent. Keep water on the core.`);
    if (!out.length) out.push('No emergency conditions. Plant’s stable. If that changes, I’ll be the loud one.');
    return out;
  }
  function sroJob(kind: 'status' | 'next' | 'brief'): Job {
    const map = {
      status: { label: 'status report', you: 'give me a status report.', rb: 'Status, okay.', fn: statusLines },
      next: { label: 'what’s next', you: 'what’s next on the procedure?', rb: 'Let me look.', fn: nextLines },
      brief: { label: 'emergency brief', you: 'emergency brief, please.', rb: 'Alright, listen up, everybody.', fn: briefLines },
    }[kind];
    return { member: 'SRO', label: map.label, you: map.you, readback: map.rb, board: '', walk: 0, exec: () => {}, done: () => '', talk: map.fn };
  }

  // ---------- FIELD ----------
  function fieldCheckJob(what: 'mfp' | 'walk'): Job {
    return {
      member: 'FIELD',
      label: what === 'mfp' ? 'check the feed pumps' : 'walk down the plant',
      you: what === 'mfp' ? 'go check the main feed pumps.' : 'do a walkdown of the turbine building.',
      readback: what === 'mfp' ? 'Heading to the feed pumps.' : 'Walking down the turbine building, copy.',
      board: '',
      walk: walkT('FIELD'),
      exec: () => {},
      verifyAfter: 0.1,
      done: () => {
        const s = st()!;
        if (what === 'mfp') {
          const f = s.faults.filter((x) => x.id === 'MFP_TRIP' || x.id === 'CONDENSATE_PUMP_TRIP');
          const run = s.mainFeedPumpsRunning.map((r, i) => `${AB(i)} ${r ? 'running' : 'idle'}`).join(', ');
          const suc = s.bop ? ` Suction ${r0(s.bop.mfpSuctionPsig)} psig.` : '';
          if (f.length) return `${run}.${suc} ${fieldReport(f[0])}`;
          return `Feed pumps: ${run}.${suc} ${s.mainFeedPumpsRunning.some(Boolean) ? 'Bearings sound fine, no leaks.' : 'Both cold. Lube oil’s up.'}`;
        }
        const f = s.faults;
        if (f.length) return `${f.length > 1 ? `I count ${f.length} problems. Worst one: ` : ''}${fieldReport(f[f.length - 1])}`;
        const vac = s.condenserVacuum;
        return pick([
          `All quiet out here. Vacuum reads ${vac.toFixed(1)} inches on the local gauge. Just me and the seagulls.`,
          'Walked the whole deck. No leaks, no smells, no surprises. Coffee machine’s broken again, though.',
          `Turbine building’s fine. Hotwell ${r0(s.bop?.hotwellLevelPct ?? 50)} percent. Nothing to report.`,
        ]);
      },
    };
  }
  function fieldRestartJob(): Job {
    let action: { text: string; run: () => void; check: () => boolean } | null = null;
    let refuse = '';
    return {
      member: 'FIELD',
      label: 'restart the tripped pump',
      you: 'see if you can get the tripped pump back.',
      readback: 'On my way. I’ll call you from the switchgear.',
      board: '',
      walk: walkT('FIELD'),
      check: () => {
        const s = st()!;
        const c = ctl()!;
        action = null;
        refuse = '';
        for (const f of s.faults) {
          if (f.id === 'CCW_PUMP_TRIP' && c.ccwPumps && s.bop) {
            const j = s.bop.ccw.pumpsRunning.findIndex((r) => !r);
            if (j >= 0) {
              action = { text: `Tripped CCW pump’s breaker won’t reset, so I started the standby. CCW pump ${AB(j)} is running.`, run: () => (c.ccwPumps![j] = true), check: () => !!st()!.bop?.ccw.pumpsRunning[j] };
              break;
            }
          }
          if ((f.id === 'CIRC_WATER_PUMP_TRIP' || f.id === 'CONDENSATE_PUMP_TRIP') && s.bop) {
            const cw = f.id === 'CIRC_WATER_PUMP_TRIP';
            const arr = cw ? c.circWaterPumps : c.condensatePumps;
            const run = cw ? s.bop.circWaterRunning : s.bop.condensateRunning;
            const j = run.findIndex((r, k) => !r && k !== f.target);
            if (arr && j >= 0) {
              action = { text: `The tripped one is done for, so I lined up and started the spare. ${cw ? 'Circ water' : 'Condensate'} pump ${j + 1} is running.`, run: () => (arr[j] = true), check: () => !!(cw ? st()!.bop?.circWaterRunning[j] : st()!.bop?.condensateRunning[j]) };
              break;
            }
            refuse = `No spare ${cw ? 'circ water' : 'condensate'} pump left to start. The tripped motor needs an electrician.`;
          }
          if (f.id === 'MFP_TRIP') refuse = refuse || `Feed pump ${typeof f.target === 'number' ? AB(f.target) : ''} breaker is locked out. That needs maintenance, not me with a wrench.`;
          if (f.id === 'RCP_TRIP') refuse = refuse || 'I can’t touch an RCP from out here, and you don’t want to restart one that tripped on overcurrent.';
        }
        if (action) return null;
        return refuse || 'Nothing’s tripped that I can find. Everything that should be running is running.';
      },
      exec: () => action?.run(),
      verifyAfter: 2.5,
      verify: () => action?.check() ?? false,
      done: () => action?.text ?? 'Done.',
      fail: (msg) => `It won’t start${msg ? `: ${blockedTail(msg)}` : ''}. Sorry, boss.`,
    };
  }
  function msivJob(i: number, open: boolean): Job {
    const b: ButtonId = open ? (`MSIV_OPEN_${i}` as ButtonId) : (`MSIV_CLOSE_${i}` as ButtonId);
    return {
      member: 'FIELD',
      label: `${open ? 'open' : 'close'} MSIV ${i + 1}`,
      you: `${open ? 'open' : 'close'} main steam isolation valve ${i + 1}.`,
      readback: `${open ? 'Open' : 'Close'} MSIV ${i + 1}, copy. Heading to the steam tunnel.`,
      board: B.SG,
      walk: walkT('FIELD'),
      check: () => {
        const o = st()!.ext?.msivOpen?.[i];
        if (o === open) return `MSIV ${i + 1} is already ${open ? 'open' : 'shut'}. I can see the position indicator.`;
        if (!open && st()!.faults.some((f) => f.id === 'STEAM_LINE_BREAK' && f.target === i)) return null;
        return null;
      },
      exec: () => sim.press(b),
      verifyAfter: 2,
      verify: () => {
        const o = st()!.ext?.msivOpen?.[i];
        return o === undefined ? true : o === open;
      },
      done: () => `MSIV ${i + 1} is ${open ? 'open' : 'shut'}. ${open ? 'Heard it thunk.' : 'She slammed like a bank vault.'}`,
      fail: (msg) => `MSIV ${i + 1} won’t ${open ? 'open' : 'close'}${msg ? `: ${blockedTail(msg)}` : ''}.`,
    };
  }

  // ================= order menu =================
  const menu = document.createElement('aside');
  menu.className = 'orders';
  menu.hidden = true;
  root.appendChild(menu);
  let mMember: CrewId | null = null;
  let mSub: { title: string; items: MenuItem[] } | null = null;

  function itemsFor(m: CrewId): MenuItem[] {
    const s = st();
    const c = ctl();
    if (!s || !c) return [];
    if (m === 'SRO')
      return [
        { label: 'Status report', job: () => sroJob('status') },
        { label: 'What’s next on the procedure?', job: () => sroJob('next') },
        { label: 'Emergency brief', job: () => sroJob('brief') },
      ];
    if (m === 'RO') {
      const gals = [25, 50, 100, 250, 500];
      const stepsL = [5, 10, 25, 50];
      return [
        { label: 'Borate…', note: `boron ${r0(s.boronPpm)} ppm`, sub: () => gals.map((g) => ({ label: `${g} gallons`, job: () => makeupJob('borate', g) })) },
        { label: 'Dilute…', sub: () => gals.map((g) => ({ label: `${g} gallons`, job: () => makeupJob('dilute', g) })) },
        { label: 'Withdraw rods…', sub: () => stepsL.map((n) => ({ label: `${n} steps`, job: () => rodJob(1, n) })) },
        { label: 'Insert rods…', sub: () => stepsL.map((n) => ({ label: `${n} steps`, job: () => rodJob(-1, n) })) },
        { label: c.rodMode === 'auto' ? 'Rods to manual' : 'Rods to automatic', job: rodModeJob },
        { label: 'Trip the reactor', note: s.reactorTripped ? 'already tripped' : 'manual trip', job: tripJob },
      ];
    }
    if (m === 'BOP') {
      const house = s.bop?.electrical.houseLoadsOn ?? 'SAT';
      return [
        {
          label: 'Main feed pumps…',
          note: s.mainFeedPumpsRunning.map((r, i) => `${AB(i)} ${r ? 'on' : 'off'}`).join(' · '),
          sub: () => [0, 1].map((i) => ({ label: `${st()!.mainFeedPumpsRunning[i] ? 'Stop' : 'Start'} MFP ${AB(i)}`, job: () => mfpJob(i, !st()!.mainFeedPumpsRunning[i]) })),
        },
        { label: 'Start a circ water pump', note: s.bop ? `${s.bop.circWaterRunning.filter(Boolean).length} of 3 running` : '', job: () => pumpJob('cw') },
        { label: 'Start a condensate pump', note: s.bop ? `${s.bop.condensateRunning.filter(Boolean).length} of 3 running` : '', job: () => pumpJob('cond') },
        { label: `House loads to ${house === 'SAT' ? 'UAT' : 'SAT'}`, note: `now on ${house}`, job: houseJob },
        { label: 'Feed reg valves to auto', note: c.feedMode.every((x) => x === 'auto') ? 'all auto' : `${c.feedMode.filter((x) => x === 'auto').length} of 4 auto`, job: frvJob },
        {
          label: 'Turbine load…',
          note: `setpoint ${r0(c.turbineLoadSetpointMW)} MW`,
          sub: () => [
            ...[300, 600, 900, 1150].map((mw) => ({ label: `${mw} MW`, job: () => loadJob(mw, 0) })),
            { label: '+50 MW', job: () => loadJob(null, 50) },
            { label: '−50 MW', job: () => loadJob(null, -50) },
          ],
        },
        {
          label: 'Steam dumps…',
          note: c.steamDumpMode,
          sub: () => [
            { label: 'Tavg mode (at power)', job: () => dumpJob('tavg') },
            { label: 'Steam pressure mode (startup)', job: () => dumpJob('pressure') },
            { label: 'Off', job: () => dumpJob('off') },
          ],
        },
      ];
    }
    return [
      { label: 'Check the main feed pumps', job: () => fieldCheckJob('mfp') },
      { label: 'Walk down the turbine building', job: () => fieldCheckJob('walk') },
      { label: 'Restart the tripped pump', note: s.faults.length ? `${s.faults.length} fault${s.faults.length > 1 ? 's' : ''} known` : '', job: fieldRestartJob },
      {
        label: 'Main steam isolation valves…',
        sub: () => {
          const o = st()!.ext?.msivOpen ?? [true, true, true, true];
          return [0, 1, 2, 3].map((i) => ({ label: `${o[i] ? 'Close' : 'Open'} MSIV ${i + 1}`, job: () => msivJob(i, !o[i]) }));
        },
      },
    ];
  }

  function renderMenu() {
    if (menu.hidden) return;
    let head = '';
    let rows = '';
    let items: MenuItem[] = [];
    if (!mMember) {
      head = `<div class="orders__h">Crew orders</div><div class="orders__sub">Who?</div>`;
      rows = ORDER.map((m, i) => {
        const r = running.get(m);
        return `<button class="orders__row" data-i="${i}"><kbd>${i + 1}</kbd><span class="orders__l"><b>${CREW[m].name}</b> · ${esc(CREW[m].role)}</span><span class="orders__n">${r ? `busy: ${esc(r.job.label)}` : ''}</span></button>`;
      }).join('');
    } else {
      items = mSub ? mSub.items : itemsFor(mMember);
      const r = running.get(mMember);
      head = `<div class="orders__h">${CREW[mMember].name} <small>${esc(CREW[mMember].role)}</small></div><div class="orders__sub">${mSub ? esc(mSub.title) : r ? `Busy: ${esc(r.job.label)}` : 'Order'}</div>`;
      rows = items
        .map((it, i) => `<button class="orders__row" data-i="${i}" ${it.off ? 'disabled' : ''}><kbd>${i + 1}</kbd><span class="orders__l">${esc(it.label)}</span><span class="orders__n">${esc(it.note ?? '')}</span></button>`)
        .join('');
    }
    menu.innerHTML = `${head}<div class="orders__list">${rows}</div><div class="orders__foot"><span><kbd>1</kbd>–<kbd>9</kbd> choose</span>${mMember ? '<span><kbd>⌫</kbd> back</span>' : ''}<span><kbd>O</kbd> close</span></div>`;
  }
  menu.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.orders__row');
    if (b) choose(Number(b.dataset.i));
  });
  function choose(i: number) {
    if (!mMember) {
      const m = ORDER[i];
      if (!m) return;
      mMember = m;
      mSub = null;
      renderMenu();
      return;
    }
    const items = mSub ? mSub.items : itemsFor(mMember);
    const it = items[i];
    if (!it || it.off) return;
    if (it.sub) {
      mSub = { title: it.label.replace(/…$/, ''), items: it.sub() };
      renderMenu();
      return;
    }
    if (it.job) {
      issue(it.job());
      closeMenu();
    }
  }
  function openMenu(member?: CrewId) {
    if (!hooks.playing()) return;
    menu.hidden = false;
    mMember = member ?? null;
    mSub = null;
    renderMenu();
  }
  function closeMenu() {
    menu.hidden = true;
    mMember = null;
    mSub = null;
  }
  bus.on('crew-clicked', ({ member }) => openMenu(member));

  // ================= callouts =================
  const EC_SPOKEN: Record<string, string> = {
    'unusual-event': 'a Notification of Unusual Event',
    alert: 'an Alert',
    'site-area-emergency': 'a Site Area Emergency',
    'general-emergency': 'a General Emergency',
  };
  function fmtCi(v: number): string {
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} million`;
    if (v >= 1e3) return `${r0(v / 1e3)} thousand`;
    return r0(v);
  }

  function onSim(e: SimEvent) {
    if (!hooks.playing()) return;
    const s = st();
    switch (e.type) {
      case 'message':
        lastMsgs.push({ t: performance.now(), text: e.text });
        if (lastMsgs.length > 12) lastMsgs.shift();
        for (const r of running.values()) if (r.phase === 'verify' || r.phase === 'tick') r.msgs.push(e.text);
        break;
      case 'alarm': {
        const a = e.alarm;
        if (a.severity === 'info') break;
        if (/^(RX_TRIP|TURB_TRIP|SI_ACT|MAKEUP_BATCH|AFW_RUNNING|DG_RUNNING|P6|P10)$/.test(a.id)) break;
        const who = alarmOwner(a.id);
        const prio = a.severity === 'warning' ? 1 : 2;
        const say = spoken(a.label);
        enqueue(who, pick([`${say}.`, `${say} alarm.`, `Got ${say.charAt(0).toLowerCase() + say.slice(1)}.`]), prio, { key: `al:${a.id}`, throttle: 60 });
        if (a.severity !== 'warning') enqueue('SRO', `Understand, ${say.charAt(0).toLowerCase() + say.slice(1)}.`, 0, { key: `alack:${a.id}`, throttle: 120 });
        break;
      }
      case 'trip': {
        const first = s?.firstOut ?? e.reason;
        enqueue('SRO', `Reactor trip! First out, ${TRIP_LABEL[first] ?? first}. Going to E-zero.`, 3, { key: 'trip', throttle: 20 });
        enqueue(
          'RO',
          () => {
            const x = st()!;
            const out = Object.values(x.rods).some((v) => v > 12) || x.faults.some((f) => f.id === 'STUCK_ROD');
            return out ? 'Reactor trip, but I’ve got a rod NOT on the bottom! Recommend emergency boration.' : `Reactor trip confirmed. All rods on the bottom, flux decreasing.`;
          },
          3,
          { key: 'trip-ro', throttle: 20 },
        );
        enqueue(
          'BOP',
          () => {
            const x = st()!;
            const afw = x.auxFeedPumpsRunning.filter(Boolean).length;
            return `${x.turbineTripped ? 'Turbine tripped' : 'Turbine is NOT tripped'}. ${afw ? `${afw} aux feed pump${afw > 1 ? 's' : ''} running` : 'No aux feed yet'}. ${x.offsitePower ? 'Offsite power’s good.' : 'We lost offsite power, diesels are carrying the safety buses.'}`;
          },
          3,
          { key: 'trip-bop', throttle: 20 },
        );
        break;
      }
      case 'si':
        enqueue('SRO', 'Safety injection! Verify SI flow and containment isolation.', 3, { key: 'si', throttle: 30 });
        enqueue('RO', () => `SI pumps running, ${r0(st()!.siFlowGpm)} gpm into the RCS.`, 2, { key: 'si-ro', throttle: 30 });
        break;
      case 'turbine-trip':
        if (s && !s.reactorTripped) enqueue('BOP', 'Turbine trip! Watch Tavg, steam dumps should be opening.', 2, { key: 'tt', throttle: 30 });
        break;
      case 'breaker':
        if (e.closed) {
          enqueue('BOP', 'Generator breaker closed. We’re on the grid.', 2, { key: 'brk', throttle: 30 });
          enqueue('SRO', pick(['Nice sync. Log it.', 'On the grid. Good job, everybody.']), 0, { key: 'brk2', throttle: 60 });
        } else enqueue('BOP', 'Generator breaker is open.', 2, { key: 'brk-open', throttle: 30 });
        break;
      case 'fault':
        enqueue('FIELD', fieldReport(e.fault), 2, { key: `f:${e.fault.id}:${e.fault.target ?? ''}`, throttle: 300 });
        enqueue('SRO', 'Copy, Hank. Stand by out there.', 0, { key: 'f-ack', throttle: 60 });
        break;
      case 'emergency-class': {
        const lv = e.level;
        if (lv === 'none') break;
        const R = st()?.release;
        const sro: Record<string, string> = {
          'unusual-event': 'I’m declaring a Notification of Unusual Event. Somebody get me the state notification form.',
          alert: 'I’m declaring an Alert. Notifying the state and the NRC. Get the technical support center staffed.',
          'site-area-emergency': 'Site Area Emergency. Evacuate non-essential people from the site. This one goes in the history books.',
          'general-emergency': `General Emergency. Recommending evacuation out to ${r0(R?.evacuationRadiusMi || 10)} miles downwind. God help us.`,
        };
        const hank: Record<string, string> = {
          'unusual-event': 'Heard the page out here. Want me to keep walking down or head in?',
          alert: 'Site sirens just went. I’m heading to the assembly point, unless you need me.',
          'site-area-emergency': 'Health physics is handing out dosimeters by the gate. Readings out here are climbing.',
          'general-emergency': 'Marge, the wind’s carrying it right over the parking lot. I’m leaving with the HP techs. Good luck in there.',
        };
        enqueue('SRO', sro[lv], 3, { key: `ec:${lv}`, throttle: 600 });
        enqueue('FIELD', hank[lv], 2, { key: `ech:${lv}`, throttle: 600 });
        break;
      }
      case 'dispatch':
        if (e.request.status === 'pending') {
          enqueue('SRO', `Grid wants ${r0(e.request.targetMW)} megawatts net. When you’re ready, give Priya a turbine load order.`, 1, { key: 'disp', throttle: 90 });
        } else if (e.request.status === 'missed') enqueue('SRO', 'We missed the dispatch window. That’s coming out of somebody’s bonus.', 1, { key: 'dispm', throttle: 90 });
        break;
      default:
        break;
    }
  }
  bus.on('sim', onSim);

  // ---- state milestones and trends ----
  const flags = new Set<string>();
  let prevBatch = false;
  let prevP = 0;
  let prevSg: number[] = [];
  let stuckSince = 0;
  let lastStep = -1;
  let acc = 0;
  function edge(key: string, cond: boolean, fn: () => void, resetCond?: boolean) {
    if (cond && !flags.has(key)) {
      flags.add(key);
      fn();
    } else if (resetCond) flags.delete(key);
  }
  function watch() {
    const s = st();
    if (!s || !hooks.playing()) return;
    const tripped = s.reactorTripped;
    const crit = !tripped && s.keff >= 0.9995 && s.startupRateDpm > -0.05 && s.neutronPower > 1e-8 && s.powerRangePct < 2;
    edge('crit', crit, () => {
      enqueue('RO', 'Reactor is critical.', 2, { key: 'crit', throttle: 120 });
      enqueue('SRO', 'Understand the reactor is critical. Log the rod heights and boron.', 1, { key: 'crit2', throttle: 120 });
    }, tripped || s.keff < 0.99);
    edge('sur05', !tripped && s.startupRateDpm > 0.5, () => enqueue('RO', `Startup rate ${s.startupRateDpm.toFixed(1)} decades per minute.`, 1, { key: 'sur05', throttle: 60 }), s.startupRateDpm < 0.3);
    edge('sur1', !tripped && s.startupRateDpm > 1, () => enqueue('RO', `Startup rate over one decade per minute! Recommend we hold rods.`, 2, { key: 'sur1', throttle: 45 }), s.startupRateDpm < 0.7);
    edge('p6', s.permissives.P6 && !tripped, () => enqueue('RO', 'P-6 is lit. Blocking source range high flux trip.', 1, { key: 'p6', throttle: 300 }), !s.permissives.P6);
    edge('p10', s.permissives.P10 && !tripped, () => enqueue('RO', 'P-10 is in. Blocking intermediate range and power range low trips.', 2, { key: 'p10', throttle: 300 }), !s.permissives.P10);
    edge('poah', !tripped && s.powerRangePct > 1 && s.powerRangePct < 5, () => enqueue('RO', 'Point of adding heat. Tavg starting to come up.', 1, { key: 'poah', throttle: 600 }), s.powerRangePct < 0.3);
    edge('p50', !tripped && s.powerRangePct >= 50, () => enqueue('RO', 'Fifty percent power.', 1, { key: 'p50', throttle: 600 }), s.powerRangePct < 45);
    edge('p100', !tripped && s.powerRangePct >= 99, () => enqueue('SRO', 'One hundred percent power. Nice work, everybody.', 2, { key: 'p100', throttle: 900 }), s.powerRangePct < 95);
    edge('rpm', s.turbineSpeedRpm >= 1795 && !s.generatorBreakerClosed, () => enqueue('BOP', 'Turbine at eighteen hundred rpm. Ready to sync.', 1, { key: 'rpm', throttle: 300 }), s.turbineSpeedRpm < 1700);
    edge('vac22', s.condenserVacuum >= 22, () => enqueue('BOP', 'Condenser vacuum twenty-two inches.', 1, { key: 'vac22', throttle: 600 }), s.condenserVacuum < 18);

    // batch complete
    const b = s.bop?.makeupBatch;
    if (b) {
      if (prevBatch && !b.active) enqueue('RO', `Batch complete, ${r0(b.deliveredGal)} gallons in. Boron ${r0(s.boronPpm)} ppm.`, 2, { key: 'batch', throttle: 10 });
      prevBatch = b.active;
    }

    // trends
    const atPower = !tripped && (s.generatorBreakerClosed || s.powerRangePct > 15);
    const d = s.tAvg - s.tRef;
    if (atPower && Math.abs(d) > 3) enqueue('RO', `Tavg ${Math.abs(d).toFixed(1)} degrees ${d > 0 ? 'above' : 'below'} Tref${ctl()?.rodMode === 'manual' ? ', rods in manual' : ''}.`, 1, { key: 'tavg', throttle: 90 });
    const p = s.rcsPressure;
    const dp = p - prevP;
    if (!tripped && prevP && (p < 2185 || p > 2285)) enqueue('RO', `Pressurizer pressure ${r0(p)} and ${Math.abs(dp) < 0.5 ? 'steady' : dp < 0 ? 'trending down' : 'trending up'}.`, p < 2000 || p > 2335 ? 2 : 1, { key: 'pzrp', throttle: 90 });
    prevP = p;
    if (!tripped || s.auxFeedPumpsRunning.some(Boolean)) {
      s.loops.forEach((l, i) => {
        const dl = l.sgLevel - (prevSg[i] ?? l.sgLevel);
        if (s.thermalPower > 0.02 && (l.sgLevel < 35 || l.sgLevel > 72)) enqueue('BOP', `Steam generator ${i + 1} level ${r0(l.sgLevel)} percent and ${Math.abs(dl) < 0.05 ? 'steady' : dl < 0 ? 'dropping' : 'rising'}.`, l.sgLevel < 25 || l.sgLevel > 80 ? 2 : 1, { key: `sg${i}`, throttle: 75 });
      });
    }
    prevSg = s.loops.map((l) => l.sgLevel);
    s.bop?.rcpAux.bearingTempF.forEach((tF, i) => {
      if (tF > 185 && s.loops[i]?.rcpRunning) enqueue('RO', `RCP ${i + 1} bearing temperature ${r0(tF)} and rising.`, tF > 195 ? 2 : 1, { key: `brg${i}`, throttle: 90 });
    });
    if (!tripped && s.powerRangePct > 50 && Math.abs(s.axialOffset) > 10) enqueue('RO', `Axial flux difference ${s.axialOffset.toFixed(0)} percent. Outside the band.`, 1, { key: 'afd', throttle: 180 });
    if (!tripped && s.powerRangePct > 10 && s.dnbr < 1.5) enqueue('RO', `DNB ratio down to ${s.dnbr.toFixed(2)}!`, 2, { key: 'dnbr', throttle: 60 });
    if (s.generatorBreakerClosed && s.condenserVacuum < 25) enqueue('BOP', `Condenser vacuum ${s.condenserVacuum.toFixed(1)} inches and ${s.condenserVacuum < 23 ? 'falling. We’ll trip the turbine at twenty' : 'low'}.`, 1, { key: 'vac', throttle: 90 });

    // supervisor reminder when the procedure has stalled
    const n = hooks.nextStep();
    const now = performance.now();
    const id = n ? n.n : 0;
    if (id !== lastStep) {
      lastStep = id;
      stuckSince = now;
    } else if (n && !tripped && !(s.generatorBreakerClosed && s.powerRangePct > 90) && now - stuckSince > 120000 && !running.size) {
      stuckSince = now;
      enqueue('SRO', `Per the procedure, next is step ${n.n}: ${n.title}. ${n.where}, ${n.control}.`, 1, { key: 'remind', throttle: 120 });
    }
  }

  // ================= API =================
  function reset() {
    queue.length = 0;
    cur = null;
    typer = null;
    for (const b of bubbles) b.el.remove();
    bubbles.length = 0;
    for (const m of running.keys()) if (m !== 'FIELD') bus.emit('crew-activity', { member: m, board: null, state: 'idle' });
    running.clear();
    cooldown.clear();
    flags.clear();
    prevBatch = false;
    prevP = 0;
    prevSg = [];
    lastStep = -1;
    stuckSince = performance.now();
    closeMenu();
  }

  return {
    update(dt) {
      if (!hooks.playing()) return;
      const paused = ctl()?.paused ?? true;
      if (!paused) {
        jobsUpdate(dt);
        acc += dt;
        if (acc > 0.5) {
          acc = 0;
          watch();
        }
      }
      speechUpdate(paused ? 0 : dt);
      root.classList.toggle('crew-talking', !!cur);
      if (!menu.hidden && Math.random() < dt * 2) renderMenu(); // keep notes live (~2 Hz)
    },
    reset,
    handleKey(ev) {
      if (ev.code === 'KeyO') {
        if (menu.hidden) openMenu();
        else closeMenu();
        return true;
      }
      if (menu.hidden) return false;
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(ev.code);
      if (m) {
        ev.preventDefault();
        choose(Number(m[1]) - 1);
        return true;
      }
      if (ev.code === 'Backspace') {
        ev.preventDefault();
        if (mSub) mSub = null;
        else if (mMember) mMember = null;
        else closeMenu();
        renderMenu();
        return true;
      }
      if (ev.code === 'Escape') {
        closeMenu();
        return false; // let Escape do its usual thing too
      }
      return false;
    },
    menuOpen: () => !menu.hidden,
    openMenu,
    closeMenu,
    chatter: () => chatter,
    cycleChatter() {
      chatter = chatter === 'normal' ? 'full' : chatter === 'full' ? 'quiet' : 'normal';
      try {
        localStorage.setItem(CHATTER_KEY, chatter);
      } catch {
        /* ignore */
      }
      if (chatter === 'quiet') for (let i = queue.length - 1; i >= 0; i--) if (queue[i].prio < 3) queue.splice(i, 1);
      return chatter;
    },
    say(who, text, prio = 2) {
      enqueue(who, text, prio);
    },
  };
}
