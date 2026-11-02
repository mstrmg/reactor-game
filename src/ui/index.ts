/**
 * DOM overlay UI: title screen, HUD, pause menu, procedure binder, logbook,
 * controls sheet and the incident report (game over).
 * Text refreshes at ~7 Hz; nothing here runs per-frame work beyond a timer.
 */
import type { PlantState, ReactorSimApi, ScenarioId, SimEvent, AlarmSeverity, ActiveFault, FaultId } from '../sim/types';
import { bus } from '../core/bus';
import { audioPrefs } from '../audio/prefs';
import { CATASTROPHE_TITLE, SCENARIOS, TRIP_SHORT, faultLabel, tripLabel } from './labels';
import { KEYS_UI, KEYS_WORLD, PRIMER } from './content';
import { RUNNING_CHECKS, STARTUP, type ProcStep } from './procedures';
import { createRemote } from './remote';
import { createEconomy, money } from './economy';
import { createCrew } from './crew';
import { createAftermath, EC_TITLE, fmtCi, totalCi } from './aftermath';
import { alarmHelp, faultHelp, relatedValues, tripAdvice } from './alarmHelp';

export interface UIApi {
  update(dt: number): void;
}

type Sev = 'info' | 'warning' | 'alarm' | 'trip' | 'fault';
interface LogEntry {
  t: number;
  text: string;
  sev: Sev;
  real: number;
}

const TIME_STEPS = [1, 2, 5, 10, 30];
const MAX_LOG = 400;

// ---------- formatting helpers ----------
const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
export function fmtClock(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  return `${pad(t / 3600)}:${pad((t % 3600) / 60)}:${pad(t % 60)}`;
}
function fmtExp(v: number, digits = 1): string {
  if (!Number.isFinite(v) || v <= 0) return '0';
  const e = Math.floor(Math.log10(v));
  const m = v / Math.pow(10, e);
  return `${m.toFixed(digits)}e${e}`;
}
function fmtCps(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v < 1000) return v.toFixed(0);
  return fmtExp(v, 1);
}
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
}
function refs(el: HTMLElement): Record<string, HTMLElement> {
  const out: Record<string, HTMLElement> = {};
  el.querySelectorAll<HTMLElement>('[data-ref]').forEach((n) => (out[n.dataset.ref!] = n));
  return out;
}

export function createUI(root: HTMLElement, sim: ReactorSimApi): UIApi {
  root.classList.add('ui');
  const st = (): PlantState | undefined => (sim as { state?: PlantState }).state;

  // ---------------- state ----------------
  let mode: 'title' | 'playing' | 'over' = 'title';
  let scenario: ScenarioId = 'hot-standby';
  let randomFaults = true;
  let locked = false;
  let awaitLockSince = 0; // performance.now() when we asked for lock, 0 = not waiting
  let sheet: 'none' | 'help' | 'log' | 'primer' = 'none';
  let procOpen = false;
  let refreshAcc = 0;
  let overAt = 0; // real ms when catastrophe seen
  let overShown = false;
  const log: LogEntry[] = [];
  const latched = new Set<string>();
  let lastHover: { label: string; detail?: string } | null = null;
  let bannerUntil = 0;
  let toastUntil = 0;

  // keep the sim still behind the title screen
  if (sim.controls) sim.controls.paused = true;

  // ================= TITLE =================
  const title = h('section', 'title');
  title.innerHTML = `
    <div class="title__glass"></div>
    <div class="title__cover">
      <div class="cover__plate">
        <div class="cover__unit">Unit 2 · Main control room</div>
        <h1 class="cover__name" aria-label="Critical">CRITICAL</h1>
        <p class="cover__pitch">A four-loop pressurized water reactor, 3411 megawatts thermal. You have the reactor.
        Bring it up from hot standby, put it on the grid and keep it there. Nothing is scripted: the plant only does what its physics allow, and that includes failing.</p>
      </div>
      <div class="cover__meta">
        <span>Keyboard and mouse</span>
        <span>Best with sound on</span>
      </div>
    </div>
    <div class="binder" data-ref="binder">
      <nav class="binder__tabs" role="tablist">
        <button class="tab is-on" data-tab="shift" role="tab">Shift turnover</button>
        <button class="tab" data-tab="primer" role="tab">Reactor primer</button>
        <button class="tab" data-tab="keys" role="tab">Controls</button>
      </nav>
      <div class="binder__page" data-page="shift">
        <h2 class="page__h">Choose your shift</h2>
        <ol class="scen" data-ref="scen"></ol>
        <label class="toggle">
          <input type="checkbox" data-ref="faults" checked />
          <span class="toggle__box" aria-hidden="true"></span>
          <span class="toggle__text"><b>Random equipment faults</b><br/>Pumps trip, valves stick, rods drop. Diagnose it from the boards.</span>
        </label>
        <div class="startrow">
          <button class="pushbtn" data-ref="start"><span class="pushbtn__lens">Take the shift</span></button>
          <p class="startrow__note">Click to lock the mouse. Esc releases it and pauses.</p>
        </div>
      </div>
      <div class="binder__page" data-page="primer" hidden>
        <h2 class="page__h">How to run a reactor</h2>
        <div class="primer">${PRIMER.map((p) => `<section><h3>${p.h}</h3><p>${p.body}</p></section>`).join('')}</div>
      </div>
      <div class="binder__page" data-page="keys" hidden>
        <h2 class="page__h">Controls</h2>
        ${keysTable()}
      </div>
    </div>`;
  root.appendChild(title);
  const tR = refs(title);

  for (const sc of SCENARIOS) {
    const li = h('li', 'scen__row');
    li.innerHTML = `<label><input type="radio" name="scen" value="${sc.id}" ${sc.id === scenario ? 'checked' : ''}/>
      <span class="scen__mark" aria-hidden="true"></span>
      <span class="scen__name">${sc.name}${sc.id === 'hot-standby' ? ' <i>recommended</i>' : ''}</span>
      <span class="scen__len">${sc.length}</span>
      <span class="scen__blurb">${sc.blurb}</span></label>`;
    tR.scen.appendChild(li);
  }
  tR.scen.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.name === 'scen') scenario = t.value as ScenarioId;
  });
  (tR.faults as HTMLInputElement).addEventListener('change', (e) => {
    randomFaults = (e.target as HTMLInputElement).checked;
  });
  title.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      title.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-on', x === b));
      title.querySelectorAll<HTMLElement>('.binder__page').forEach((p) => (p.hidden = p.dataset.page !== b.dataset.tab));
    }),
  );
  // MUST stay a direct click handler: main.ts requests pointer lock inside it.
  tR.start.addEventListener('click', () => startGame(scenario, randomFaults));

  // ================= HUD =================
  const hud = h('section', 'hud');
  hud.hidden = true;
  hud.innerHTML = `
    <div class="cross" aria-hidden="true"></div>
    <div class="tip" data-ref="tip" hidden><div class="tip__l" data-ref="tipL"></div><div class="tip__d" data-ref="tipD"></div></div>
    <div class="strip" data-ref="strip">
      <div class="cell cell--clock"><span class="k">Elapsed</span><span class="v" data-ref="clock">00:00:00</span></div>
      <div class="cell cell--rate" data-ref="rateCell"><span class="k">Rate</span><span class="v" data-ref="rate">1×</span></div>
      <div class="cell"><span class="k" data-ref="niK">Power</span><span class="v" data-ref="ni">—</span></div>
      <div class="cell"><span class="k">SUR</span><span class="v" data-ref="sur">—</span></div>
      <div class="cell"><span class="k">Tavg</span><span class="v" data-ref="tavg">—</span></div>
      <div class="cell"><span class="k">PZR</span><span class="v" data-ref="pzr">—</span></div>
      <div class="cell"><span class="k">Output</span><span class="v" data-ref="mwe">—</span></div>
      <div class="cell cell--status" data-ref="statusCell"><span class="k">Reactor</span><span class="v" data-ref="status">—</span></div>
      <div class="cell cell--alm" data-ref="almCell"><span class="k">Alarms</span><span class="v" data-ref="alm">0</span></div>
    </div>
    <div class="hint" data-ref="hint">E alarm help · O crew orders · Tab procedure · Z zoom · H controls · [ ] time</div>
    <div class="mute" data-ref="mute" hidden>Sound off (M)</div>
    <div class="toast" data-ref="toast" hidden></div>
    <ol class="oplog" data-ref="oplog" aria-live="polite"></ol>
    <div class="banner" data-ref="banner" hidden>
      <div class="banner__h" data-ref="bannerH">Reactor trip</div>
      <div class="banner__d" data-ref="bannerD"></div>
    </div>`;
  root.appendChild(hud);
  const hR = refs(hud);

  // ================= PROCEDURE BINDER (side sheet) =================
  const proc = h('aside', 'proc');
  proc.hidden = true;
  proc.innerHTML = `
    <header class="proc__head"><span class="proc__doc">OP-2.1 Plant startup</span><span class="proc__prog" data-ref="procProg"></span></header>
    <section class="now" data-ref="now">
      <div class="now__tag">Do this now <span data-ref="nowPhase"></span></div>
      <h3 class="now__title" data-ref="nowTitle"></h3>
      <dl class="now__where">
        <div><dt>Board</dt><dd data-ref="nowWhere"></dd></div>
        <div><dt>Control</dt><dd data-ref="nowCtl"></dd></div>
      </dl>
      <p class="now__act" data-ref="nowAct"></p>
      <div class="now__meter">
        <div><span>Target</span><b data-ref="nowTarget"></b></div>
        <div><span>Now</span><b data-ref="nowVal"></b></div>
        <em class="now__state" data-ref="nowState">Not yet</em>
      </div>
      <p class="now__gotcha" data-ref="nowGotcha"></p>
    </section>
    <div class="proc__body" data-ref="procBody"></div>
    <h3 class="proc__sec">Running checks <small>keep these green once at power</small></h3>
    <ul class="checks" data-ref="checks"></ul>`;
  root.appendChild(proc);
  const pR = refs(proc);
  const stepEls = new Map<string, { li: HTMLElement; val: HTMLElement }>();
  const allSteps: { step: ProcStep; phase: string; n: number }[] = [];
  {
    let n = 0;
    for (const ph of STARTUP) {
      pR.procBody.appendChild(h('h3', 'proc__sec', esc(ph.name)));
      const ol = h('ol', 'steps');
      for (const st_ of ph.steps) {
        n++;
        allSteps.push({ step: st_, phase: ph.name, n });
        const li = h('li', 'step');
        li.innerHTML = `<span class="step__n">${n}</span><span class="step__box" aria-hidden="true"></span>
          <span class="step__t">${esc(st_.title)}</span><span class="step__v"></span>`;
        ol.appendChild(li);
        stepEls.set(st_.id, { li, val: li.querySelector('.step__v') as HTMLElement });
      }
      pR.procBody.appendChild(ol);
    }
  }
  const checkEls = RUNNING_CHECKS.map((c) => {
    const li = h('li', 'check', `<span class="check__lamp"></span><span>${esc(c.text)}</span><span class="check__v"></span>`);
    pR.checks.appendChild(li);
    return { li, v: li.querySelector('.check__v') as HTMLElement };
  });
  let currentStepId: string | null | undefined = undefined; // undefined = not evaluated since start

  // ================= ALARM CARD + ALARM HELP (E) =================
  interface HelpItem { key: string; kind: 'alarm' | 'fault'; id: string; label: string; severity: Sev; t: number; fault?: ActiveFault }
  const acard = h('div', 'acard');
  acard.hidden = true;
  acard.innerHTML = `<div class="acard__tile" data-ref="acTile"></div>
    <div class="acard__body"><div class="acard__m" data-ref="acMean"></div>
    <div class="acard__k"><kbd>E</kbd> How to fix <span data-ref="acMore"></span></div></div>`;
  hud.appendChild(acard);
  const acR = refs(acard);
  const ahelp = h('aside', 'ahelp');
  ahelp.hidden = true;
  ahelp.innerHTML = `<header class="ahelp__head"><div class="ahelp__tile" data-ref="ahTile"></div><span class="ahelp__pos" data-ref="ahPos"></span></header>
    <div class="ahelp__body" data-ref="ahBody">
      <p class="ahelp__mean" data-ref="ahMean"></p>
      <p class="ahelp__first" data-ref="ahFirst"></p>
      <h4>What to do</h4><ol class="ahelp__acts" data-ref="ahActs"></ol>
      <h4>Right now</h4><dl class="ahelp__live" data-ref="ahLive"></dl>
      <h4 data-ref="ahCausesH">Likely causes</h4><ul class="ahelp__causes" data-ref="ahCauses"></ul>
    </div>
    <footer class="ahelp__foot"><span><kbd>E</kbd> next</span><span><kbd>Q</kbd> previous</span><span><kbd>X</kbd> close</span><span><kbd>↑</kbd><kbd>↓</kbd> scroll</span></footer>`;
  root.appendChild(ahelp);
  const ahR = refs(ahelp);
  let lastPopup: HelpItem | null = null;
  let acardUntil = 0;
  let lastPopAt = 0;
  let helpList: HelpItem[] = [];
  let helpIdx = -1;
  const knownFaults: HelpItem[] = [];
  const SEV_RANK: Record<Sev, number> = { trip: 4, fault: 3, alarm: 2, warning: 1, info: 0 };

  function popAlarm(item: HelpItem) {
    const nowMs = performance.now();
    if (lastPopup && lastPopup.key === item.key && nowMs - lastPopAt < 2000) return;
    if (lastPopup && nowMs < acardUntil && nowMs - lastPopAt < 5000 && SEV_RANK[lastPopup.severity] > SEV_RANK[item.severity]) {
      const others = activeAlarmItems().filter((x) => x.key !== lastPopup!.key).length;
      acR.acMore.textContent = others ? `· ${others} other active` : '';
      return;
    }
    lastPopAt = nowMs;
    lastPopup = item;
    const help = item.kind === 'fault' ? faultHelp(item.fault!.id, item.fault!.description) : alarmHelp(item.id, item.severity);
    acR.acTile.textContent = item.label;
    acard.dataset.sev = item.severity;
    acR.acMean.textContent = firstSentence(help.meaning);
    const others = activeAlarmItems().filter((x) => x.key !== item.key).length;
    acR.acMore.textContent = others ? `· ${others} other active` : '';
    acard.hidden = helpIdx >= 0;
    acard.classList.remove('is-in');
    void acard.offsetWidth;
    acard.classList.add('is-in');
    acardUntil = performance.now() + 12000;
  }
  function firstSentence(t: string): string {
    const m = t.match(/^.*?[.!?;](\s|$)/);
    let out = (m ? m[0] : t).split(' — ')[0].trim().replace(/[;,]$/, '.');
    if (out.length > 150) out = out.slice(0, 147).replace(/\s+\S*$/, '') + '…';
    return out;
  }
  function activeAlarmItems(): HelpItem[] {
    const s = st();
    if (!s) return [];
    return s.alarms
      .filter((a) => a.active && a.severity !== 'info')
      .map((a) => ({ key: `a:${a.id}`, kind: 'alarm' as const, id: a.id, label: a.label, severity: a.severity as Sev, t: a.time }))
      .sort((x, y) => SEV_RANK[y.severity] - SEV_RANK[x.severity] || y.t - x.t);
  }
  function openHelp(dir: 1 | -1 = 1) {
    if (helpIdx < 0) {
      const act = activeAlarmItems();
      const list: HelpItem[] = [];
      if (lastPopup && (lastPopup.kind === 'fault' || act.some((a) => a.key === lastPopup!.key) || performance.now() < acardUntil)) list.push(lastPopup);
      for (const a of act) if (!list.some((x) => x.key === a.key)) list.push(a);
      for (const f of knownFaults.slice().reverse()) if (!list.some((x) => x.key === f.key)) list.push(f);
      if (!list.length) {
        toast('No active alarms · Tab shows the procedure');
        return;
      }
      helpList = list;
      helpIdx = 0;
    } else {
      helpIdx += dir;
      if (helpIdx >= helpList.length || helpIdx < 0) {
        closeHelp();
        return;
      }
    }
    acard.hidden = true;
    ahelp.hidden = false;
    renderHelp();
    ahR.ahBody.scrollTop = 0;
  }
  function closeHelp() {
    helpIdx = -1;
    ahelp.hidden = true;
  }
  function renderHelp() {
    const item = helpList[helpIdx];
    if (!item) return;
    const help = item.kind === 'fault' ? faultHelp(item.fault!.id, item.fault!.description) : alarmHelp(item.id, item.severity);
    ahR.ahTile.textContent = item.label;
    ahelp.dataset.sev = item.severity;
    ahR.ahPos.textContent = helpList.length > 1 ? `${helpIdx + 1} of ${helpList.length}` : '';
    ahR.ahMean.textContent = help.meaning;
    const s = st();
    const first = item.id === 'RX_TRIP' && s?.firstOut ? `First out: ${tripLabel(s.firstOut)}. ${tripAdvice(s.firstOut)}` : '';
    ahR.ahFirst.textContent = first;
    ahR.ahFirst.hidden = !first;
    ahR.ahCauses.innerHTML = help.causes.map((c) => `<li>${esc(c)}</li>`).join('');
    ahR.ahCauses.hidden = ahR.ahCausesH.hidden = !help.causes.length;
    ahR.ahActs.innerHTML = help.actions.map((c) => `<li>${esc(c)}</li>`).join('');
    renderHelpLive();
  }
  function renderHelpLive() {
    const item = helpList[helpIdx];
    const s = st();
    if (!item || !s || !sim.controls) return;
    const id = item.kind === 'fault' ? faultAlarmProxy(item.fault!.id) : item.id;
    const rows = relatedValues(id, s, sim.controls);
    const a = s.alarms.find((x) => x.id === item.id);
    const status = item.kind === 'fault' ? 'Malfunction reported' : a ? (a.active ? (a.acknowledged ? 'Active, acknowledged' : 'Active, not acknowledged (ACK on REACTOR CONTROL)') : 'Cleared (RESET on REACTOR CONTROL to clear the window)') : '';
    ahR.ahLive.innerHTML = [['Alarm', status] as [string, string], ...rows].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  }
  function faultAlarmProxy(id: FaultId): string {
    const m: Partial<Record<FaultId, string>> = {
      STUCK_ROD: 'ROD_DEV', DROPPED_ROD: 'ROD_BOTTOM', RCP_TRIP: 'RCP1_TRIP', MFP_TRIP: 'MFP_TRIP', FEED_VALVE_FAIL: 'SG1_LEVEL_LO',
      PZR_PORV_STUCK_OPEN: 'PZR_PORV_OPEN', PZR_SPRAY_STUCK_OPEN: 'PZR_PRESS_LO', SG_TUBE_LEAK: 'MS_RAD_HI', SMALL_LOCA: 'RCS_LEAK',
      LOSS_OF_OFFSITE_POWER: 'LOOP', TURBINE_TRIP_SPURIOUS: 'TURB_TRIP', STEAM_LINE_BREAK: 'STEAMLINE_P_LO', INSTRUMENT_FAIL: 'PR_CHANNEL_DEV',
    };
    return m[id] ?? 'RX_TRIP';
  }

  // ================= SHEETS (help / logbook / primer) =================
  const sheetEl = h('section', 'sheet');
  sheetEl.hidden = true;
  sheetEl.innerHTML = `<div class="sheet__paper" role="dialog">
      <header class="sheet__head"><h2 data-ref="sheetH"></h2><button class="link" data-ref="sheetX">Close</button></header>
      <div class="sheet__body" data-ref="sheetBody"></div></div>`;
  root.appendChild(sheetEl);
  const sR = refs(sheetEl);
  sR.sheetX.addEventListener('click', () => setSheet('none'));

  // ================= PAUSE =================
  const pause = h('section', 'pause');
  pause.hidden = true;
  pause.innerHTML = `<div class="pause__card">
      <div class="pause__state" data-ref="pState">Paused</div>
      <p class="pause__sub" data-ref="pSub"></p>
      <button class="pushbtn pushbtn--sm" data-ref="resume"><span class="pushbtn__lens">Resume</span></button>
      <p class="pause__note" data-ref="pNote"></p>
      <div class="pause__list">
        <button class="row" data-act="proc">Procedure binder <kbd>Tab</kbd></button>
        <button class="row" data-act="log">Plant logbook <kbd>L</kbd></button>
        <button class="row" data-act="help">Controls <kbd>H</kbd></button>
        <button class="row" data-act="primer">Reactor primer</button>
        <button class="row" data-act="chatter">Crew chatter: <b data-ref="chat"></b></button>
        <button class="row" data-act="restart">Restart this scenario</button>
        <button class="row" data-act="title">Change scenario</button>
      </div>
      <div class="pause__audio">
        <label>Volume <input type="range" min="0" max="1" step="0.05" data-ref="vol"/></label>
        <button class="link" data-ref="muteBtn"></button>
      </div>
    </div>`;
  root.appendChild(pause);
  const paR = refs(pause);
  paR.resume.addEventListener('click', () => resume());
  pause.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      const a = b.dataset.act!;
      if (a === 'proc') toggleProc();
      else if (a === 'log') setSheet(sheet === 'log' ? 'none' : 'log');
      else if (a === 'help') setSheet(sheet === 'help' ? 'none' : 'help');
      else if (a === 'primer') setSheet(sheet === 'primer' ? 'none' : 'primer');
      else if (a === 'chatter') {
        crew.cycleChatter();
        syncChatter();
      }
      else if (a === 'restart') startGame(scenario, randomFaults);
      else if (a === 'title') showTitle();
    }),
  );
  const vol = paR.vol as HTMLInputElement;
  vol.value = String(audioPrefs.volume);
  vol.addEventListener('input', () => audioPrefs.setVolume(parseFloat(vol.value)));
  paR.muteBtn.addEventListener('click', () => audioPrefs.toggleMute());
  const syncMute = () => {
    paR.muteBtn.textContent = audioPrefs.muted ? 'Unmute (M)' : 'Mute (M)';
    hR.mute.hidden = !audioPrefs.muted;
  };
  audioPrefs.onChange(syncMute);
  syncMute();

  // ================= GAME OVER =================
  const over = h('section', 'over');
  over.hidden = true;
  over.innerHTML = `<div class="over__flash" data-ref="flash"></div>
    <div class="report" data-ref="report">
      <header class="report__head">
        <span>Incident report</span><span data-ref="oTime"></span>
      </header>
      <div class="report__stamp" aria-hidden="true">Plant lost</div>
      <h2 class="report__kind" data-ref="oKind"></h2>
      <p class="report__desc" data-ref="oDesc"></p>
      <dl class="report__stats" data-ref="oStats"></dl>
      <h3 class="report__h">Sequence of events</h3>
      <ol class="report__seq" data-ref="oSeq"></ol>
      <div class="report__btns">
        <button class="pushbtn pushbtn--sm" data-ref="oRestart"><span class="pushbtn__lens">Try again</span></button>
        <button class="link" data-ref="oCam" hidden>Back to the exterior cam</button>
        <button class="link" data-ref="oTitle">Choose another scenario</button>
      </div>
    </div>`;
  root.appendChild(over);
  const oR = refs(over);
  oR.oRestart.addEventListener('click', () => startGame(scenario, randomFaults));
  oR.oTitle.addEventListener('click', () => showTitle());
  oR.oCam.addEventListener('click', () => {
    over.hidden = true;
    over.classList.remove('is-report');
    aftermath.show();
    if (sim.controls) sim.controls.paused = false;
  });

  // ================= PHONE / REMOTE VIEW =================
  const remote = createRemote(root, sim, {
    canCall: () => mode === 'playing' && !overAt && !(sim.controls?.paused ?? true),
    helpOpen: () => helpIdx >= 0,
    expectLock: () => {
      awaitLockSince = performance.now();
    },
    pauseWithNote: (n) => {
      if (!locked) doPause(n);
    },
    clock: (t) => fmtClock(t),
  });

  // ================= GRID / ECONOMY, CREW, AFTERMATH =================
  const econ = createEconomy(root, hud, sim);
  const crew = createCrew(root, sim, {
    playing: () => mode === 'playing' && !overAt,
    hold: () => remote.active() || econ.talking(),
    nextStep: () => {
      const it = allSteps.find((x) => x.step.id === currentStepId);
      return it ? { n: it.n, title: it.step.title, where: it.step.where, control: it.step.control, action: it.step.action } : null;
    },
    log: (text) => addLog(st()?.t ?? 0, text, 'info'),
  });
  const syncChatter = () => {
    paR.chat.textContent = { quiet: 'Quiet (emergencies only)', normal: 'Normal', full: 'Full (everything)' }[crew.chatter()];
  };
  syncChatter();
  const aftermath = createAftermath(root, sim, {
    facts: () => {
      const s = st();
      const f = knownFaults[0] ?? null;
      return {
        scenario: SCENARIOS.find((x) => x.id === scenario)?.name ?? scenario,
        initiating: f ? faultLabel(f.id as FaultId) || f.label : null,
        trips: s?.score.trips ?? 0,
      };
    },
    report: () => showReport(),
    restart: () => startGame(scenario, randomFaults),
    clock: (t) => fmtClock(t),
  });
  // keep the sim running behind the exterior cam (losing pointer lock pauses it)
  bus.on('pause-changed', (p) => {
    if (p && aftermath.active() && !overShown)
      queueMicrotask(() => {
        if (sim.controls && aftermath.active() && !overShown) sim.controls.paused = false;
      });
  });
  bus.on('crew-clicked', () => {
    if (helpIdx >= 0) closeHelp();
  });

  // ================= behaviour =================
  function keysTable(): string {
    const rows = (k: [string, string][]) =>
      k.map(([a, b]) => `<tr><th><kbd>${esc(a)}</kbd></th><td>${esc(b)}</td></tr>`).join('');
    return `<div class="keys"><table><caption>In the room</caption>${rows(KEYS_WORLD)}</table>
      <table><caption>Shift tools</caption>${rows(KEYS_UI)}</table></div>`;
  }

  function startGame(sc: ScenarioId, rf: boolean) {
    scenario = sc;
    randomFaults = rf;
    remote.reset();
    aftermath.reset();
    econ.reset();
    crew.reset();
    mode = 'playing';
    log.length = 0;
    latched.clear();
    currentStepId = undefined;
    knownFaults.length = 0;
    lastPopup = null;
    acard.hidden = true;
    closeHelp();
    overShown = false;
    overAt = 0;
    bannerUntil = 0;
    hR.oplog.innerHTML = '';
    title.hidden = true;
    over.hidden = true;
    over.classList.remove('is-report');
    pause.hidden = true;
    hud.hidden = false;
    setSheet('none');
    if (sim.controls) sim.controls.timeScale = 1;
    awaitLockSince = performance.now();
    addLog(0, `Shift turnover: ${SCENARIOS.find((s) => s.id === sc)?.name ?? sc}. Random faults ${rf ? 'on' : 'off'}.`, 'info');
    bus.emit('start-game', { scenario: sc, randomFaults: rf });
    refresh();
  }

  function showTitle() {
    remote.reset();
    aftermath.reset();
    econ.reset();
    crew.reset();
    mode = 'title';
    if (sim.controls) sim.controls.paused = true;
    title.hidden = false;
    hud.hidden = true;
    pause.hidden = true;
    over.hidden = true;
    proc.hidden = true;
    procOpen = false;
    root.classList.remove('proc-open');
    setSheet('none');
  }

  function resume() {
    if (mode !== 'playing') return;
    pause.hidden = true;
    setSheet('none');
    awaitLockSince = performance.now();
    bus.emit('pause-changed', false); // main requests pointer lock (this runs inside the click/key gesture)
  }

  function doPause(note = '') {
    if (mode !== 'playing') return;
    awaitLockSince = 0;
    closeHelp();
    crew.closeMenu();
    if (sim.controls && !sim.controls.paused) bus.emit('pause-changed', true);
    if (sim.controls) sim.controls.paused = true;
    paR.pNote.textContent = note;
    const s = st();
    paR.pSub.textContent = `${SCENARIOS.find((x) => x.id === scenario)?.name ?? scenario} · elapsed ${fmtClock(s?.t ?? 0)}`;
    pause.hidden = false;
  }

  function toggleProc() {
    procOpen = !procOpen;
    proc.hidden = !procOpen;
    if (procOpen) {
      refreshProc();
      const id = currentStepId;
      if (id) requestAnimationFrame(() => scrollToStep(id));
    }
    root.classList.toggle('proc-open', procOpen);
  }
  function scrollToStep(id: string) {
    const li = stepEls.get(id)?.li;
    if (!li) return;
    proc.scrollTop = Math.max(0, li.offsetTop - pR.now.offsetHeight - 90);
  }

  function setSheet(k: typeof sheet) {
    sheet = k;
    sheetEl.hidden = k === 'none';
    sheetEl.classList.toggle('is-live', locked);
    if (k === 'help') {
      sR.sheetH.textContent = 'Controls';
      sR.sheetBody.innerHTML = keysTable();
    } else if (k === 'primer') {
      sR.sheetH.textContent = 'How to run a reactor';
      sR.sheetBody.innerHTML = `<div class="primer">${PRIMER.map((p) => `<section><h3>${p.h}</h3><p>${p.body}</p></section>`).join('')}</div>`;
    } else if (k === 'log') {
      sR.sheetH.textContent = 'Plant logbook';
      refreshLogbook();
    }
  }

  function setTimeScale(dir: 1 | -1) {
    if (!sim.controls || mode !== 'playing') return;
    const cur = sim.controls.timeScale ?? 1;
    let i = TIME_STEPS.findIndex((v) => v >= cur);
    if (i < 0) i = TIME_STEPS.length - 1;
    if (TIME_STEPS[i] !== cur && dir < 0) i = Math.max(0, i - 1);
    else i = Math.max(0, Math.min(TIME_STEPS.length - 1, i + dir));
    sim.controls.timeScale = TIME_STEPS[i];
    toast(`Time ×${TIME_STEPS[i]}`);
    refresh();
  }

  function dropTime(reason: string) {
    if (sim.controls && sim.controls.timeScale > 1) {
      sim.controls.timeScale = 1;
      toast(`Back to 1× · ${reason}`);
    }
  }

  function toast(text: string) {
    hR.toast.textContent = text;
    hR.toast.hidden = false;
    toastUntil = performance.now() + 1800;
  }

  function addLog(t: number, text: string, sev: Sev) {
    const e: LogEntry = { t, text, sev, real: performance.now() };
    log.push(e);
    if (log.length > MAX_LOG) log.shift();
    const li = h('li', `ln ln--${sev}`);
    li.innerHTML = `<span class="ln__t">${fmtClock(t)}</span><span class="ln__x">${esc(text)}</span>`;
    hR.oplog.appendChild(li);
    while (hR.oplog.children.length > 7) hR.oplog.firstElementChild!.remove();
    if (sheet === 'log') refreshLogbook();
  }

  function showBanner(head: string, detail: string, ms = 6000) {
    delete hR.banner.dataset.kind;
    hR.bannerH.textContent = head;
    hR.bannerD.textContent = detail;
    hR.banner.hidden = false;
    hR.banner.classList.remove('is-in');
    void hR.banner.offsetWidth;
    hR.banner.classList.add('is-in');
    bannerUntil = performance.now() + ms;
  }

  function onSim(e: SimEvent) {
    if (mode === 'title') return;
    const t = st()?.t ?? 0;
    switch (e.type) {
      case 'message':
        if (e.text.startsWith('FAULT:')) break; // the 'fault' event already logs it
        addLog(t, e.text, 'info');
        break;
      case 'alarm': {
        const sev: Sev = e.alarm.severity;
        addLog(t, `Alarm: ${e.alarm.label}`, sev);
        if (sev === 'alarm' || sev === 'trip') dropTime(e.alarm.label);
        if (sev !== 'info') popAlarm({ key: `a:${e.alarm.id}`, kind: 'alarm', id: e.alarm.id, label: e.alarm.label, severity: sev, t });
        break;
      }
      case 'trip': {
        const s = st();
        const first = s?.firstOut ?? e.reason;
        addLog(t, `REACTOR TRIP · first out: ${tripLabel(first)}`, 'trip');
        showBanner('Reactor trip', `First out: ${tripLabel(first)}`);
        dropTime('reactor trip');
        popAlarm({ key: 'a:RX_TRIP', kind: 'alarm', id: 'RX_TRIP', label: 'REACTOR TRIP', severity: 'trip', t });
        break;
      }
      case 'fault':
        addLog(t, e.fault.description || faultLabel(e.fault.id), 'fault');
        dropTime('malfunction');
        {
          const fi: HelpItem = { key: `f:${e.fault.id}:${e.fault.target ?? ''}`, kind: 'fault', id: e.fault.id, label: (faultLabel(e.fault.id) || e.fault.id).toUpperCase(), severity: 'fault', t, fault: e.fault };
          knownFaults.push(fi);
          popAlarm(fi);
        }
        break;
      case 'si':
        addLog(t, 'SAFETY INJECTION actuated', 'trip');
        showBanner('Safety injection', 'ECCS pumps injecting borated water into the RCS', 5000);
        dropTime('safety injection');
        break;
      case 'breaker':
        addLog(t, e.closed ? 'Generator breaker closed: on the grid' : 'Generator breaker open', e.closed ? 'info' : 'warning');
        break;
      case 'turbine-trip':
        addLog(t, 'Turbine tripped', 'alarm');
        dropTime('turbine trip');
        break;
      case 'meltdown':
        addLog(t, 'Core damage in progress', 'trip');
        break;
      case 'emergency-class': {
        if (e.level === 'none') break;
        const big = e.level === 'site-area-emergency' || e.level === 'general-emergency';
        addLog(t, `EMERGENCY CLASSIFICATION: ${EC_TITLE[e.level]}`, big ? 'trip' : 'alarm');
        if (!overAt) {
          const r = st()?.release;
          const detail =
            e.level === 'general-emergency'
              ? `Release in progress · evacuation out to ${Math.round(r?.evacuationRadiusMi || 10)} miles`
              : e.level === 'site-area-emergency'
                ? 'Major failure of plant functions · non-essential staff leave the site'
                : e.level === 'alert'
                  ? 'Potential substantial degradation of plant safety · state and NRC notified'
                  : 'Potential degradation of plant safety · notifications in progress';
          showBanner(EC_TITLE[e.level], detail, 9000);
          hR.banner.dataset.kind = big ? 'ec-red' : 'ec-amber';
          dropTime('emergency declared');
        }
        break;
      }
      case 'money':
        if (Math.abs(e.amount) >= 1000) addLog(t, `${e.label}: ${money(e.amount, true)}`, e.amount < 0 ? 'warning' : 'info');
        break;
      case 'dispatch':
        if (e.request.status === 'pending') addLog(t, `Dispatch: ${Math.round(e.request.targetMW)} MW net · ${e.request.reason}`, 'info');
        else if (e.request.status !== 'cancelled') addLog(t, `Dispatch ${e.request.status}: ${Math.round(e.request.targetMW)} MW`, e.request.status === 'met' ? 'info' : 'warning');
        break;
      case 'catastrophe':
        addLog(t, `${CATASTROPHE_TITLE[e.kind] ?? e.kind}`, 'trip');
        beginGameOver();
        break;
      default:
        break;
    }
  }
  bus.on('sim', onSim);

  bus.on('hover', (hv) => {
    lastHover = hv;
    if (!hv) {
      hR.tip.hidden = true;
      return;
    }
    hR.tipL.textContent = hv.label;
    hR.tipD.textContent = hv.detail ?? '';
    hR.tipD.hidden = !hv.detail;
    hR.tip.hidden = !locked && mode === 'playing' ? true : false;
  });

  bus.on('pointer-lock', (on) => onLock(on));
  document.addEventListener('pointerlockchange', () => onLock(!!document.pointerLockElement));
  function onLock(on: boolean) {
    if (on === locked) return;
    locked = on;
    root.classList.toggle('is-locked', on);
    if (on) {
      awaitLockSince = 0;
      if (mode === 'playing') {
        pause.hidden = true;
        if (sheet !== 'none') setSheet('none');
      }
    } else if (mode === 'playing' && !overShown) {
      hR.tip.hidden = true;
      if (!remote.active()) doPause();
    }
  }

  function beginGameOver() {
    if (overAt) return;
    overAt = performance.now();
    dropTime('plant lost');
    crew.closeMenu();
    closeHelp();
    over.hidden = false;
    over.classList.add('is-flash');
    hR.banner.hidden = true;
  }

  /** flash -> exterior cam with radiation map and the news */
  function startAftermath() {
    remote.reset();
    mode = 'over';
    over.hidden = true;
    over.classList.remove('is-flash');
    hud.hidden = true;
    proc.hidden = true;
    procOpen = false;
    root.classList.remove('proc-open');
    pause.hidden = true;
    setSheet('none');
    if (sim.controls) {
      sim.controls.paused = false;
      sim.controls.timeScale = 10; // let the release develop while the news rolls
    }
    aftermath.start();
    if (document.pointerLockElement) document.exitPointerLock();
  }

  function showReport() {
    remote.reset();
    crew.closeMenu();
    aftermath.hide();
    over.hidden = false;
    oR.oCam.hidden = !aftermath.active();
    overShown = true;
    mode = 'over';
    const s = st();
    const c = s?.catastrophe;
    if (sim.controls && !sim.controls.paused) bus.emit('pause-changed', true);
    if (sim.controls) sim.controls.paused = true;
    pause.hidden = true;
    proc.hidden = true;
    procOpen = false;
    root.classList.remove('proc-open');
    setSheet('none');
    over.classList.remove('is-flash');
    over.classList.add('is-report');
    oR.oKind.textContent = c ? CATASTROPHE_TITLE[c.kind] ?? c.kind : 'Plant lost';
    oR.oDesc.textContent = c?.description ?? '';
    oR.oTime.textContent = `T+ ${fmtClock(c?.t ?? s?.t ?? 0)}`;
    const sc = s?.score;
    const stats: [string, string][] = [
      ['Time on shift', fmtClock(s?.t ?? 0)],
      ['Electricity generated', `${(sc?.mwhGenerated ?? 0).toFixed(0)} MWh`],
      ['Reactor trips', String(sc?.trips ?? 0)],
      ['Fuel damaged', `${((s?.fuelDamage ?? 0) * 100).toFixed(0)} %`],
      ...econ.summary(s),
      ...(s?.release
        ? ([
            ['Radioactivity released', `${fmtCi(totalCi(s.release))} Ci`],
            ['Site boundary dose', `${s.release.siteBoundaryDoseRem.toFixed(2)} rem`],
            ['Emergency class', EC_TITLE[s.release.emergencyClass]],
            ['Evacuation', s.release.evacuationRadiusMi > 0 ? `${Math.round(s.release.evacuationRadiusMi)} miles` : 'None'],
          ] as [string, string][])
        : []),
      ['Scenario', SCENARIOS.find((x) => x.id === scenario)?.name ?? scenario],
    ];
    oR.oStats.innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    const tail = log.slice(-12);
    oR.oSeq.innerHTML = tail
      .map((e) => `<li class="ln--${e.sev}"><span>${fmtClock(e.t)}</span>${esc(e.text)}</li>`)
      .join('');
  }

  // ---------------- keyboard ----------------
  window.addEventListener('keydown', (ev) => {
    if (ev.repeat && !['BracketLeft', 'BracketRight', 'Minus', 'Equal'].includes(ev.code)) return;
    const tgt = ev.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' && (tgt as HTMLInputElement).type === 'text')) return;
    if (mode === 'title') {
      if (ev.code === 'Enter' && !title.hidden) {
        ev.preventDefault();
        startGame(scenario, randomFaults);
      }
      return;
    }
    if (mode === 'playing' && remote.handleKey(ev)) return;
    if (mode === 'playing' && !overAt && !remote.active()) {
      if (crew.handleKey(ev)) return;
      if (econ.handleKey(ev)) return;
    }
    switch (ev.code) {
      case 'Tab':
        ev.preventDefault();
        if (mode === 'playing') toggleProc();
        break;
      case 'BracketLeft':
      case 'Minus':
      case 'NumpadSubtract':
        setTimeScale(-1);
        break;
      case 'BracketRight':
      case 'Equal':
      case 'NumpadAdd':
        setTimeScale(1);
        break;
      case 'KeyP':
        if (mode !== 'playing') break;
        if (sim.controls?.paused) resume();
        else doPause();
        break;
      case 'KeyH':
      case 'F1':
        ev.preventDefault();
        setSheet(sheet === 'help' ? 'none' : 'help');
        break;
      case 'KeyL':
        setSheet(sheet === 'log' ? 'none' : 'log');
        break;
      case 'KeyM':
        audioPrefs.toggleMute();
        toast(audioPrefs.muted ? 'Sound off' : 'Sound on');
        break;
      case 'KeyE':
        if (mode === 'playing') openHelp(1);
        break;
      case 'KeyQ':
      case 'ArrowLeft':
        if (helpIdx >= 0) openHelp(-1);
        break;
      case 'ArrowRight':
        if (helpIdx >= 0) openHelp(1);
        break;
      case 'ArrowDown':
      case 'ArrowUp':
        if (helpIdx >= 0) {
          ev.preventDefault();
          ahR.ahBody.scrollBy({ top: ev.code === 'ArrowDown' ? 120 : -120 });
        } else if (procOpen) {
          ev.preventDefault();
          proc.scrollBy({ top: ev.code === 'ArrowDown' ? 120 : -120 });
        }
        break;
      case 'KeyX':
      case 'Backspace':
        if (helpIdx >= 0) closeHelp();
        break;
      case 'Escape':
        if (helpIdx >= 0) closeHelp();
        if (!locked && sheet !== 'none') setSheet('none');
        break;
    }
  });

  // ---------------- refresh ----------------
  function refresh() {
    const s = st();
    const c = sim.controls;
    if (!s || !c) return;
    hR.clock.textContent = fmtClock(s.t);
    const ts = c.timeScale ?? 1;
    hR.rate.textContent = c.paused ? 'Paused' : `${ts}×`;
    hR.rateCell.classList.toggle('is-fast', ts > 1);

    // Nuclear instrument shown depends on which range is on scale.
    if (s.powerRangePct >= 0.5 || s.permissives.P10) {
      hR.niK.textContent = 'Power';
      hR.ni.textContent = `${s.powerRangePct.toFixed(1)} %`;
    } else if (!s.permissives.P6) {
      hR.niK.textContent = 'Source rng';
      hR.ni.textContent = `${fmtCps(s.sourceRangeCps)} cps`;
    } else {
      hR.niK.textContent = 'Inter rng';
      hR.ni.textContent = `${fmtExp(s.intermediateRangeAmps)} A`;
    }
    const sur = s.startupRateDpm;
    hR.sur.textContent = `${Number.isFinite(sur) ? (sur >= 0 ? '+' : '') + sur.toFixed(2) : '—'} dpm`;
    hR.sur.parentElement!.classList.toggle('is-warn', sur > 1);
    hR.sur.parentElement!.classList.toggle('is-bad', sur > 3);
    hR.tavg.textContent = `${s.tAvg.toFixed(1)} °F`;
    hR.pzr.textContent = `${s.rcsPressure.toFixed(0)} psig`;
    const pzrBad = s.rcsPressure < 1950 || s.rcsPressure > 2350;
    hR.pzr.parentElement!.classList.toggle('is-bad', pzrBad);
    hR.mwe.textContent = `${s.grossMWe.toFixed(0)} MWe`;

    let status = '';
    let cls = '';
    if (s.catastrophe) {
      status = 'PLANT LOST';
      cls = 'is-bad';
    } else if (s.reactorTripped) {
      status = s.firstOut ? `TRIPPED · ${TRIP_SHORT[s.firstOut] ?? s.firstOut}` : 'TRIPPED';
      cls = 'is-bad';
    } else if (s.powerRangePct >= 2) {
      status = 'AT POWER';
      cls = 'is-ok';
    } else if (s.keff >= 0.9995 && s.startupRateDpm > -0.05 && s.neutronPower > 1e-8) {
      status = 'CRITICAL';
      cls = 'is-ok';
    } else {
      status = 'SUBCRITICAL';
    }
    if (s.coreStatus === 'damaged' && !s.catastrophe) {
      status += ' · FUEL DMG';
      cls = 'is-bad';
    }
    hR.status.textContent = status;
    hR.statusCell.className = `cell cell--status ${cls}`;
    const unack = s.alarms.filter((a) => a.active && !a.acknowledged).length;
    const active = s.alarms.filter((a) => a.active).length;
    hR.alm.textContent = unack ? `${unack} new / ${active}` : String(active);
    hR.almCell.classList.toggle('is-flash', unack > 0);

    refreshProc();
    if (helpIdx >= 0) renderHelpLive();
    if (sheet === 'log') refreshLogbookLive();
  }

  function refreshProc() {
    const s = st();
    const c = sim.controls;
    if (!s || !c || mode === 'title') return;
    const firstEval = currentStepId === undefined;
    let cur: (typeof allSteps)[number] | null = null;
    let doneCount = 0;
    for (const it of allSteps) {
      let ok = false;
      try {
        ok = it.step.done(s, c);
      } catch {
        ok = false;
      }
      if (ok) latched.add(it.step.id);
      const done = latched.has(it.step.id);
      if (done) doneCount++;
      else if (!cur) cur = it;
      if (procOpen) {
        const el = stepEls.get(it.step.id)!;
        el.li.classList.toggle('is-done', done);
        el.li.classList.toggle('is-live', ok);
        el.li.classList.toggle('is-next', cur === it);
        try {
          el.val.textContent = it.step.value(s, c);
        } catch {
          el.val.textContent = '';
        }
      }
    }
    const newId = cur ? cur.step.id : null;
    if (!firstEval && newId !== currentStepId && mode === 'playing') {
      const prev = allSteps.find((x) => x.step.id === currentStepId);
      if (prev && latched.has(prev.step.id)) {
        toast(cur ? `Step ${prev.n} done · next: ${cur.step.title} (Tab)` : 'Startup complete · keep the running checks green');
        pR.now.classList.remove('is-adv');
        void pR.now.offsetWidth;
        pR.now.classList.add('is-adv');
      }
    }
    const changed = newId !== currentStepId;
    currentStepId = newId;
    if (!procOpen) return;
    if (changed && cur) requestAnimationFrame(() => scrollToStep(cur!.step.id));
    pR.procProg.textContent = `${doneCount} of ${allSteps.length} done`;
    if (cur) {
      const st_ = cur.step;
      pR.nowPhase.textContent = `· step ${cur.n} · ${cur.phase.replace(/^[A-Z]\. /, '')}`;
      pR.nowTitle.textContent = st_.title;
      pR.nowWhere.textContent = st_.where;
      pR.nowCtl.textContent = st_.control;
      pR.nowAct.textContent = st_.action;
      pR.nowTarget.textContent = st_.target;
      let v = '';
      try {
        v = st_.value(s, c);
      } catch {
        /* ignore */
      }
      pR.nowVal.textContent = v;
      pR.nowState.textContent = 'Not yet';
      pR.nowGotcha.textContent = st_.gotcha ? `Watch out: ${st_.gotcha}` : '';
      pR.nowGotcha.hidden = !st_.gotcha;
      pR.now.classList.remove('is-complete');
      pR.now.querySelectorAll<HTMLElement>('.now__where, .now__meter, .now__act').forEach((e) => (e.hidden = false));
    } else {
      pR.nowPhase.textContent = '';
      pR.nowTitle.textContent = 'Startup complete';
      pR.nowAct.textContent = 'The unit is at full power. Keep every running check below green: watch Tavg, pressure, SG levels and xenon.';
      pR.nowGotcha.hidden = true;
      pR.now.classList.add('is-complete');
      pR.now.querySelectorAll<HTMLElement>('.now__where, .now__meter').forEach((e) => (e.hidden = true));
    }
    RUNNING_CHECKS.forEach((chk, i) => {
      let ok = false;
      let v = '';
      try {
        ok = chk.ok(s);
        v = chk.value(s);
      } catch {
        /* sim field missing */
      }
      checkEls[i].li.classList.toggle('is-ok', ok);
      checkEls[i].v.textContent = v;
    });
  }

  function refreshLogbook() {
    const s = st();
    const rows = log
      .slice()
      .reverse()
      .map((e) => `<tr class="ln--${e.sev}"><td>${fmtClock(e.t)}</td><td>${sevName(e.sev)}</td><td>${esc(e.text)}</td></tr>`)
      .join('');
    sR.sheetBody.innerHTML = `<div class="logbook">
      <div class="logbook__react" data-ref="react">${s ? reactTable(s) : ''}</div>
      <div class="logbook__ledger">${s ? econ.ledgerHtml(s) : ''}</div>
      <div class="logbook__events"><table class="evt"><thead><tr><th>Time</th><th>Type</th><th>Entry</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No entries yet. Events, alarms and trips are logged here as they happen.</td></tr>'}</tbody></table></div></div>`;
  }
  function refreshLogbookLive() {
    const s = st();
    const r = sR.sheetBody.querySelector('.logbook__react');
    if (r && s) r.innerHTML = reactTable(s);
  }
  function sevName(s: Sev | AlarmSeverity) {
    return { info: 'Note', warning: 'Warning', alarm: 'Alarm', trip: 'Trip', fault: 'Malfunction' }[s];
  }
  function reactTable(s: PlantState): string {
    const r = s.reactivity;
    const row = (k: string, v: number) =>
      `<tr><th>${k}</th><td class="${v < 0 ? 'neg' : 'pos'}">${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)}</td></tr>`;
    return `<table class="react"><caption>Reactivity balance, pcm</caption>
      ${row('Control rods', r.rods)}${row('Boron', r.boron)}${row('Doppler (fuel)', r.doppler)}${row('Moderator', r.moderator)}
      ${row('Xenon', r.xenon)}${row('Samarium', r.samarium)}
      <tr class="sum"><th>Total</th><td>${r.total >= 0 ? '+' : '−'}${Math.abs(r.total).toFixed(0)}</td></tr></table>
      <dl class="kv">
        <div><dt>k-effective</dt><dd>${s.keff.toFixed(5)}</dd></div>
        <div><dt>Boron</dt><dd>${s.boronPpm.toFixed(0)} ppm</dd></div>
        <div><dt>Xenon (rel. eq.)</dt><dd>${s.xenon.toFixed(2)}</dd></div>
        <div><dt>Period</dt><dd>${Number.isFinite(s.periodSeconds) ? s.periodSeconds.toFixed(0) + ' s' : '∞'}</dd></div>
        <div><dt>Rods SA SB CA CB CC CD</dt><dd>${(['SA', 'SB', 'CA', 'CB', 'CC', 'CD'] as const).map((b) => s.rods[b].toFixed(0)).join(' ')}</dd></div>
        <div><dt>Neutron flux</dt><dd>${fmtExp(s.neutronFlux)} n/cm²s</dd></div>
      </dl>`;
  }

  // ---------------- frame ----------------
  let lastUpd = 0;
  return {
    update(dt: number) {
      const now = performance.now();
      // UI timers run on wall-clock time: main.ts caps dt at 0.1 s, which slows typing and
      // crew timers to a crawl when the frame rate drops
      const udt = lastUpd ? Math.min(1, (now - lastUpd) / 1000) : dt;
      lastUpd = now;
      if (mode === 'title') return;
      remote.update(dt);
      econ.update(udt);
      crew.update(udt);
      aftermath.update(udt);

      // pointer lock watchdog (browsers refuse re-lock for ~1 s after Esc)
      if (mode === 'playing' && awaitLockSince && now - awaitLockSince > 1500) {
        if (!document.pointerLockElement && !locked && !remote.active()) {
          doPause('Click Resume to take the controls.');
        }
        awaitLockSince = 0;
      }

      const s = st();
      if (s?.catastrophe && !overAt) beginGameOver();
      if (overAt && !overShown && !aftermath.active() && now - overAt > 3000) startAftermath();

      // fade log lines
      const lines = hR.oplog.children;
      for (let i = 0; i < lines.length; i++) {
        const el = lines[i] as HTMLElement;
        const born = Number(el.dataset.born || (el.dataset.born = String(now)));
        const age = (now - born) / 1000;
        el.style.opacity = age < 18 ? '1' : String(Math.max(0, 1 - (age - 18) / 6));
      }
      if (bannerUntil && now > bannerUntil) {
        hR.banner.hidden = true;
        bannerUntil = 0;
      }
      if (acardUntil && now > acardUntil) {
        acard.hidden = true;
        acardUntil = 0;
      }
      if (toastUntil && now > toastUntil) {
        hR.toast.hidden = true;
        toastUntil = 0;
      }
      if (lastHover && locked) hR.tip.hidden = false;

      refreshAcc += dt;
      if (refreshAcc >= 0.15) {
        refreshAcc = 0;
        refresh();
      }
    },
  };
}
