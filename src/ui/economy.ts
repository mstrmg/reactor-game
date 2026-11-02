/**
 * Grid & economics HUD: cash / price / grid clock / frequency strip, the active dispatch
 * card, +$/−$ toasts, the dispatcher's phone calls (non-blocking Animal Crossing box) and
 * the ledger HTML for the logbook. Reads state.grid (optional) and 'dispatch'/'money' events.
 */
import type { DispatchRequest, GridState, PlantState, ReactorSimApi, SimEvent } from '../sim/types';
import { bus } from '../core/bus';
import { voice, type Speaker } from '../audio/voice';
import { Typer } from './typer';

export interface EconomyApi {
  update(dt: number): void;
  reset(): void;
  /** Space/Enter advance the dispatcher call while it is on screen */
  handleKey(ev: KeyboardEvent): boolean;
  /** the dispatcher call box is on screen */
  talking(): boolean;
  ledgerHtml(s: PlantState): string;
  /** summary rows for reports */
  summary(s: PlantState | undefined): [string, string][];
}

export const money = (v: number, sign = false): string => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const str = a >= 1e9 ? `$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 2)}M` : a >= 1e4 ? `$${(a / 1e3).toFixed(1)}k` : `$${a.toFixed(0)}`;
  return (v < 0 ? '−' : sign ? '+' : '') + str;
};
const hhmm = (h: number) => {
  if (!Number.isFinite(h)) return '--:--';
  const x = ((h % 24) + 24) % 24;
  return `${String(Math.floor(x)).padStart(2, '0')}:${String(Math.floor((x % 1) * 60)).padStart(2, '0')}`;
};
const mmss = (s: number) => {
  const v = Math.max(0, Math.round(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

export function netMW(s: PlantState): number {
  return s.bop?.generator?.netMWe ?? s.grossMWe;
}

export function createEconomy(root: HTMLElement, hud: HTMLElement, sim: ReactorSimApi): EconomyApi {
  const st = (): PlantState | undefined => (sim as { state?: PlantState }).state;

  // ---------- strip ----------
  const strip = document.createElement('div');
  strip.className = 'econ';
  strip.innerHTML = `
    <div class="cell"><span class="k">Shift earnings</span><span class="v" data-r="cash">$0</span></div>
    <div class="cell"><span class="k">Price</span><span class="v" data-r="price">—</span></div>
    <div class="cell"><span class="k">Grid clock</span><span class="v" data-r="clock">--:--</span></div>
    <div class="cell"><span class="k">Frequency</span><span class="v" data-r="hz">—</span></div>`;
  hud.appendChild(strip);
  const r = (k: string) => strip.querySelector(`[data-r="${k}"]`) as HTMLElement;
  const eCash = r('cash'), ePrice = r('price'), eClock = r('clock'), eHz = r('hz');
  strip.hidden = true;

  // ---------- dispatch card ----------
  const card = document.createElement('div');
  card.className = 'dcard';
  card.hidden = true;
  card.innerHTML = `<div class="dcard__h"><span>Dispatch</span><span data-r="reason"></span></div>
    <div class="dcard__row"><div><span>Target net</span><b data-r="target"></b></div><div><span>Now</span><b data-r="now"></b></div><div><span data-r="dueK">Time left</span><b data-r="due"></b></div></div>
    <div class="dcard__st" data-r="st"></div>`;
  hud.appendChild(card);
  const c = (k: string) => card.querySelector(`[data-r="${k}"]`) as HTMLElement;

  // ---------- money toasts ----------
  const toasts = document.createElement('div');
  toasts.className = 'mtoasts';
  hud.appendChild(toasts);
  function moneyToast(label: string, amount: number) {
    const el = document.createElement('div');
    el.className = `mtoast ${amount >= 0 ? 'is-pos' : 'is-neg'}`;
    el.innerHTML = `<b>${esc(money(amount, true))}</b> ${esc(label)}`;
    toasts.prepend(el);
    while (toasts.children.length > 4) toasts.lastElementChild!.remove();
    setTimeout(() => el.classList.add('is-out'), 4200);
    setTimeout(() => el.remove(), 5200);
    voice.money(amount >= 0);
  }

  // ---------- dispatcher call box ----------
  const box = document.createElement('section');
  box.className = 'callbox';
  box.hidden = true;
  box.innerHTML = `<div class="talk__bubble"><div class="talk__name" data-r="name"></div><p class="talk__text" data-r="text"></p>
    <div class="talk__next" data-r="next">▼</div></div>`;
  root.appendChild(box);
  const bName = box.querySelector('[data-r="name"]') as HTMLElement;
  const bNext = box.querySelector('[data-r="next"]') as HTMLElement;
  const typer = new Typer(box.querySelector('[data-r="text"]') as HTMLElement);
  interface Line { who: Speaker; name: string; text: string }
  let lines: Line[] = [];
  let li = -1;
  let startAt = 0;
  let advanceAt = 0;

  function call(ls: Line[], ring: boolean) {
    // a new call replaces whatever is showing
    lines = ls;
    li = -1;
    box.hidden = false;
    bName.textContent = 'Grid Ops';
    box.dataset.who = 'lorraine';
    typer.start(ring ? 'Ring ring… it’s the grid dispatcher.' : '', 'sys');
    startAt = performance.now() + (ring ? voice.ring(1) * 0.55 : 0);
    if (!ring) startAt = performance.now();
    advanceAt = 0;
  }
  function next() {
    li++;
    advanceAt = 0;
    if (li >= lines.length) {
      box.hidden = true;
      voice.hangup();
      lines = [];
      return;
    }
    const l = lines[li];
    bName.textContent = l.name;
    box.dataset.who = l.who;
    typer.start(l.text, l.who);
  }
  const LOR = 'Lorraine · Grid Ops';

  const seen = new Map<number, DispatchRequest['status']>();
  function onDispatch(d: DispatchRequest) {
    const s = st();
    const prev = seen.get(d.id);
    if (prev === d.status) return;
    seen.set(d.id, d.status);
    const g = s?.grid;
    const due = g && s ? hhmm(g.hourOfDay + (d.deadline - s.t) / 3600) : '';
    const mins = s ? Math.max(1, Math.round((d.deadline - s.t) / 60)) : 0;
    if (d.status === 'pending') {
      call(
        [
          { who: 'lorraine', name: LOR, text: `${pick(['Hi hon, Lorraine at Grid Ops.', 'Grid Ops, Lorraine here.', 'Lorraine again, sugar.'])} ${d.reason}. I need you at ${Math.round(d.targetMW)} megawatts net by ${due} — that’s ${mins} minutes.` },
          { who: 'you', name: 'You', text: `${Math.round(d.targetMW)} megawatts net by ${due}. Copy.` },
          { who: 'lorraine', name: LOR, text: `There’s ${money(d.bonus)} in it if you make it, and a ${money(d.penalty)} penalty if you don’t. ${pick(['Bye now!', 'Don’t make me call twice.', 'Toodles.'])}` },
        ],
        true,
      );
    } else if (d.status === 'met') {
      call([{ who: 'lorraine', name: LOR, text: pick(['Right on the money. Bonus is on its way, hon.', 'That’s exactly where I need you. Thank you!']) }], false);
    } else if (d.status === 'missed') {
      call([{ who: 'lorraine', name: LOR, text: pick(['You missed the window. I have to write that up, sorry hon.', 'That’s a miss. The penalty’s going on your bill.']) }], false);
    } else if (d.status === 'cancelled') {
      call([{ who: 'lorraine', name: LOR, text: 'Never mind that last request, the wind picked back up. As you were!' }], false);
    }
  }

  bus.on('sim', (e: SimEvent) => {
    if (e.type === 'dispatch') onDispatch(e.request);
    else if (e.type === 'money') moneyToast(e.label, e.amount);
  });

  function refresh() {
    const s = st();
    const g: GridState | undefined = s?.grid;
    strip.hidden = !g;
    if (!s || !g) {
      card.hidden = true;
      return;
    }
    eCash.textContent = money(g.cash);
    eCash.parentElement!.classList.toggle('is-bad', g.cash < 0);
    ePrice.textContent = `$${g.pricePerMWh.toFixed(0)}/MWh`;
    eClock.textContent = hhmm(g.hourOfDay);
    eHz.textContent = `${g.frequencyHz.toFixed(2)} Hz`;
    eHz.parentElement!.classList.toggle('is-warn', Math.abs(g.frequencyHz - 60) > 0.05);
    const d = g.dispatch;
    if (d && d.status === 'pending') {
      // the sim may publish a request without an event: announce it once
      if (!seen.has(d.id)) onDispatch(d);
      card.hidden = false;
      const now = netMW(s);
      const left = d.deadline - s.t;
      c('reason').textContent = d.reason;
      c('target').textContent = `${Math.round(d.targetMW)} ±${Math.round(d.toleranceMW)} MW`;
      c('now').textContent = `${Math.round(now)} MW`;
      c('due').textContent = mmss(left);
      c('dueK').textContent = `Left · by ${hhmm(g.hourOfDay + left / 3600)}`;
      const err = now - d.targetMW;
      const ok = Math.abs(err) <= d.toleranceMW;
      const stEl = c('st');
      stEl.textContent = ok ? 'On target — hold it' : err < 0 ? `Raise ${Math.round(-err)} MW (TURBINE / GENERATOR, LOAD SETPOINT)` : `Lower ${Math.round(err)} MW (TURBINE / GENERATOR, LOAD SETPOINT)`;
      card.dataset.state = ok ? 'ok' : left < 120 ? 'late' : 'off';
    } else card.hidden = true;
  }

  let acc = 0;
  return {
    update(dt) {
      const now = performance.now();
      if (!box.hidden) {
        if (li < 0) {
          typer.update(dt);
          if (now >= startAt && lines.length) {
            voice.pickup();
            next();
          }
        } else {
          typer.update(dt);
          bNext.hidden = !typer.done;
          if (typer.done) {
            if (!advanceAt) advanceAt = now + 2600;
            else if (now >= advanceAt) next();
          }
        }
      }
      acc += dt;
      if (acc > 0.25) {
        acc = 0;
        refresh();
      }
    },
    reset() {
      seen.clear();
      box.hidden = true;
      lines = [];
      toasts.innerHTML = '';
      card.hidden = true;
    },
    handleKey(ev) {
      if (box.hidden || li < 0) return false;
      if (ev.code !== 'Space' && ev.code !== 'Enter') return false;
      ev.preventDefault();
      if (!typer.done) typer.finish();
      else next();
      return true;
    },
    talking: () => !box.hidden,
    ledgerHtml(s) {
      const g = s.grid;
      if (!g) return '<p class="ledger__none">The grid connection is not reporting yet.</p>';
      const rows = g.ledger
        .map((l) => `<tr><td>${esc(l.label)}</td><td class="${l.amount < 0 ? 'neg' : 'pos'}">${esc(money(l.amount, true))}</td></tr>`)
        .join('');
      const hist = g.dispatchHistory
        .slice(-6)
        .reverse()
        .map((d) => `<tr><td>${esc(d.reason)} · ${Math.round(d.targetMW)} MW</td><td class="${d.status === 'met' ? 'pos' : d.status === 'missed' ? 'neg' : ''}">${d.status}</td></tr>`)
        .join('');
      return `<table class="react"><caption>Shift ledger</caption>
        <tr><th>Revenue (MWh sold)</th><td class="pos">${money(g.revenue)}</td></tr>
        <tr><th>Costs and penalties</th><td class="neg">${money(-Math.abs(g.costs))}</td></tr>
        <tr class="sum"><th>Shift total</th><td>${money(g.cash)}</td></tr></table>
        <table class="react ledger"><caption>Recent transactions</caption>${rows || '<tr><td>None yet</td><td></td></tr>'}</table>
        ${hist ? `<table class="react ledger"><caption>Dispatch requests</caption>${hist}</table>` : ''}`;
    },
    summary(s) {
      const g = s?.grid;
      if (!g) return [];
      return [
        ['Shift earnings', money(g.cash)],
        ['Revenue', money(g.revenue)],
        ['Costs', money(-Math.abs(g.costs))],
      ];
    },
  };
}
