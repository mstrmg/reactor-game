/**
 * DOM overlay UI: title screen, HUD, pause menu, procedure binder, logbook,
 * controls sheet and the incident report (game over).
 * Text refreshes at ~7 Hz; nothing here runs per-frame work beyond a timer.
 */
import type { PlantState, ReactorSimApi, ScenarioId, SimEvent, AlarmSeverity } from '../sim/types';
import { bus } from '../core/bus';
import { audioPrefs } from '../audio/prefs';
import { CATASTROPHE_TITLE, SCENARIOS, TRIP_SHORT, faultLabel, tripLabel } from './labels';
import { KEYS_UI, KEYS_WORLD, PRIMER } from './content';
import { RUNNING_CHECKS, STARTUP } from './procedures';

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
    <div class="hint" data-ref="hint">Tab procedures · H controls · [ ] time</div>
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
    <header class="proc__head"><span class="proc__doc">OP-2.1 Plant startup, Mode 3 to Mode 1</span><span class="proc__key">Tab</span></header>
    <div class="proc__body" data-ref="procBody"></div>
    <h3 class="proc__sec">Running checks</h3>
    <ul class="checks" data-ref="checks"></ul>`;
  root.appendChild(proc);
  const pR = refs(proc);
  const stepEls = new Map<string, { li: HTMLElement; val: HTMLElement }>();
  {
    let n = 0;
    for (const sec of STARTUP) {
      pR.procBody.appendChild(h('h3', 'proc__sec', esc(sec.section)));
      const ol = h('ol', 'steps');
      for (const s of sec.steps) {
        n++;
        const li = h('li', 'step');
        li.innerHTML = `<span class="step__n">${n}</span><span class="step__box" aria-hidden="true"></span>
          <span class="step__t">${esc(s.text)}<small>${esc(s.hint)}</small></span><span class="step__v"></span>`;
        ol.appendChild(li);
        stepEls.set(s.id, { li, val: li.querySelector('.step__v') as HTMLElement });
      }
      pR.procBody.appendChild(ol);
    }
  }
  const checkEls = RUNNING_CHECKS.map((c) => {
    const li = h('li', 'check', `<span class="check__lamp"></span><span>${esc(c.text)}</span><span class="check__v"></span>`);
    pR.checks.appendChild(li);
    return { li, v: li.querySelector('.check__v') as HTMLElement };
  });

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
        <button class="link" data-ref="oTitle">Choose another scenario</button>
      </div>
    </div>`;
  root.appendChild(over);
  const oR = refs(over);
  oR.oRestart.addEventListener('click', () => startGame(scenario, randomFaults));
  oR.oTitle.addEventListener('click', () => showTitle());

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
    mode = 'playing';
    log.length = 0;
    latched.clear();
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
    mode = 'title';
    if (sim.controls) sim.controls.paused = true;
    title.hidden = false;
    hud.hidden = true;
    pause.hidden = true;
    over.hidden = true;
    proc.hidden = true;
    procOpen = false;
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
    if (procOpen) refreshProc();
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
        addLog(t, e.text, 'info');
        break;
      case 'alarm': {
        const sev: Sev = e.alarm.severity;
        addLog(t, `Alarm: ${e.alarm.label}`, sev);
        if (sev === 'alarm' || sev === 'trip') dropTime(e.alarm.label);
        break;
      }
      case 'trip': {
        const s = st();
        const first = s?.firstOut ?? e.reason;
        addLog(t, `REACTOR TRIP · first out: ${tripLabel(first)}`, 'trip');
        showBanner('Reactor trip', `First out: ${tripLabel(first)}`);
        dropTime('reactor trip');
        break;
      }
      case 'fault':
        addLog(t, e.fault.description || faultLabel(e.fault.id), 'fault');
        dropTime('malfunction');
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
      doPause();
    }
  }

  function beginGameOver() {
    if (overAt) return;
    overAt = performance.now();
    dropTime('plant lost');
    over.hidden = false;
    over.classList.add('is-flash');
    hR.banner.hidden = true;
  }

  function showReport() {
    overShown = true;
    mode = 'over';
    const s = st();
    const c = s?.catastrophe;
    if (sim.controls && !sim.controls.paused) bus.emit('pause-changed', true);
    if (sim.controls) sim.controls.paused = true;
    pause.hidden = true;
    proc.hidden = true;
    procOpen = false;
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
      case 'Escape':
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

    if (procOpen) refreshProc();
    if (sheet === 'log') refreshLogbookLive();
  }

  function refreshProc() {
    const s = st();
    const c = sim.controls;
    if (!s || !c) return;
    let nextMarked = false;
    for (const sec of STARTUP) {
      for (const step of sec.steps) {
        const el = stepEls.get(step.id)!;
        let ok = false;
        try {
          ok = step.done(s, c);
        } catch {
          ok = false;
        }
        if (ok) latched.add(step.id);
        const done = latched.has(step.id);
        el.li.classList.toggle('is-done', done);
        el.li.classList.toggle('is-live', ok);
        const isNext = !done && !nextMarked;
        if (isNext) nextMarked = true;
        el.li.classList.toggle('is-next', isNext);
        try {
          el.val.textContent = step.value ? step.value(s, c) : '';
        } catch {
          el.val.textContent = '';
        }
      }
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
  return {
    update(dt: number) {
      const now = performance.now();
      if (mode === 'title') return;

      // pointer lock watchdog (browsers refuse re-lock for ~1 s after Esc)
      if (mode === 'playing' && awaitLockSince && now - awaitLockSince > 1500) {
        if (!document.pointerLockElement && !locked) {
          doPause('Click Resume to take the controls.');
        }
        awaitLockSince = 0;
      }

      const s = st();
      if (s?.catastrophe && !overAt) beginGameOver();
      if (overAt && !overShown && now - overAt > 2600) showReport();

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
