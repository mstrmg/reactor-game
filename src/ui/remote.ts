/**
 * Phone call to the reactor bridge, the colleague's helmet-cam overlay and the reactor tour
 * captions. Owns view-mode: emits 'view-mode' and 'tour-nav', listens to 'phone-pickup' and
 * 'tour-stop'. Text is typed out per character with voice blips (src/audio/voice.ts).
 */
import type { PlantState, ReactorSimApi, SimEvent } from '../sim/types';
import { bus } from '../core/bus';
import { voice, type Speaker } from '../audio/voice';
import { Typer } from './typer';

export type ViewMode = 'control-room' | 'reactor-cam' | 'tour';

export interface RemoteHooks {
  /** true when a call may start (playing, not paused, no game over) */
  canCall(): boolean;
  /** true while the E alarm-help panel is open (it owns the arrow keys then) */
  helpOpen(): boolean;
  /** the UI asked main.ts to re-lock the pointer; start the lock watchdog */
  expectLock(): void;
  /** call ended without a user gesture we can lock from (Esc): show the pause menu */
  pauseWithNote(note: string): void;
  clock(t: number): string;
}

export interface RemoteApi {
  update(dt: number): void;
  /** call in progress or not in the control-room view */
  active(): boolean;
  viewMode(): ViewMode;
  handleKey(ev: KeyboardEvent): boolean;
  reset(): void;
}

const COLLEAGUE = 'Dale';
const COLLEAGUE_TAG = 'Dale · reactor bridge';

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ---------------- what Dale sees ----------------
type PlantMood = 'lost' | 'damage' | 'loca' | 'si' | 'tripped' | 'high' | 'low' | 'critical' | 'shutdown';

export function classify(s: PlantState): PlantMood {
  if (s.catastrophe) return 'lost';
  if (s.coreStatus !== 'ok' || s.fuelDamage > 0.001 || s.coreUncovered) return 'damage';
  if (s.containmentPressure > 1.5 || s.rcsLeakGpm > 20 || s.subcoolingMargin < 10) return 'loca';
  if (s.siActuated) return 'si';
  if (s.reactorTripped) return 'tripped';
  if (s.powerRangePct >= 30) return 'high';
  if (s.powerRangePct >= 2) return 'low';
  if (s.permissives.P6 || (s.keff >= 0.9995 && s.startupRateDpm > -0.05 && s.neutronPower > 1e-8)) return 'critical';
  return 'shutdown';
}

const MOOD_LABEL: Record<PlantMood, string> = {
  lost: 'PLANT LOST',
  damage: 'FUEL DAMAGE · HIGH RADIATION',
  loca: 'STEAM IN CONTAINMENT',
  si: 'SAFETY INJECTION RUNNING',
  tripped: 'REACTOR TRIPPED · DECAY HEAT',
  high: 'AT POWER',
  low: 'LOW POWER',
  critical: 'CRITICAL · LOW POWER',
  shutdown: 'SHUTDOWN · SUBCRITICAL',
};

function report(s: PlantState): string[] {
  const p = s.powerRangePct.toFixed(0);
  const t = s.tAvg.toFixed(0);
  switch (classify(s)) {
    case 'lost':
      return [pick(['There’s nothing left to look at. Get out of there!', 'The whole building is shaking. I’m leaving. Now.'])];
    case 'damage':
      return [
        pick([
          'My dosimeter is screaming and I’m nowhere near the head. Something in that core has cracked open.',
          'The area monitors just went off the scale. That’s fuel, not crud. I’m backing off to the stairwell.',
          'It smells like hot metal up here and the rad alarm won’t stop. That core is in trouble.',
        ]),
        'Look for yourself, but I’m not staying long.',
      ];
    case 'loca':
      return [
        pick([
          'There’s steam everywhere! I can barely see the vessel head. Something is leaking, and it’s big.',
          'It’s like a sauna up here. Hissing from under the missile shield. You’ve got a leak, friend.',
          'Containment’s fogged up. I can hear water roaring somewhere below the deck.',
        ]),
      ];
    case 'si':
      return [
        pick([
          'Safety injection is running. You can hear the water pouring in through the cold legs. Loud stuff.',
          'SI pumps are going full blast. The whole deck is vibrating. What did you do?',
        ]),
      ];
    case 'tripped':
      return [
        pick([
          'All rods are on the bottom. The blue glow is fading out. Just decay heat now, nice and boring.',
          'She’s tripped. Rod drive mechanisms went quiet, glow is gone. Did you mean to do that?',
          'Trip breakers are open, I heard the rods clunk home from up here. Core looks dark.',
        ]),
        `Coolant is still about ${t} degrees, so the pumps are doing their job.`,
      ];
    case 'high':
      return [
        pick([
          `She’s humming along at about ${p} percent. Bright blue glow, strong and steady. Beautiful.`,
          `About ${p} percent and you can feel the heat through the shielding. Glow is so bright it hurts.`,
          `Loud up here! Main steam lines are roaring. Core glow is a deep, solid blue at ${p} percent.`,
        ]),
      ];
    case 'low':
      return [
        pick([
          `Around ${p} percent. There’s a nice blue glow in the core and the steam lines are starting to tick.`,
          `Low power, about ${p} percent. Glow’s there but it’s gentle, like a night light.`,
        ]),
      ];
    case 'critical':
      return [
        pick([
          'She’s critical! There’s a faint blue shimmer down in the water. Go easy on those rods.',
          'I can see a soft Cherenkov glow starting. You’re on the edge, keep that startup rate low.',
        ]),
      ];
    default:
      return [
        pick([
          'Pretty quiet. The water’s clear, no glow, and I can count the fuel assemblies from here.',
          'All dark down there. Just the pumps humming and me with cold coffee.',
          'Nothing happening. Core’s subcritical, water’s calm. Wake me up when you pull some rods.',
        ]),
      ];
  }
}

export function createRemote(root: HTMLElement, sim: ReactorSimApi, hooks: RemoteHooks): RemoteApi {
  const st = (): PlantState | undefined => (sim as { state?: PlantState }).state;
  let view: ViewMode = 'control-room';

  // ---------------- dialogue (phone) ----------------
  const talk = document.createElement('section');
  talk.className = 'talk';
  talk.hidden = true;
  talk.innerHTML = `
    <div class="talk__bubble" data-ref="bubble">
      <div class="talk__name" data-ref="name"></div>
      <p class="talk__text" data-ref="text"></p>
      <div class="talk__next" data-ref="next" aria-hidden="true">▼</div>
    </div>
    <div class="talk__hint" data-ref="hint">Click, Space or Enter to continue · Esc to hang up</div>`;
  root.appendChild(talk);
  const tk = refs(talk);
  const talkTyper = new Typer(tk.text);

  interface Line {
    who: Speaker;
    text: string;
    auto?: number; // ms after typed to auto-advance
  }
  let call: { lines: Line[]; i: number; ringingUntil: number; autoAt: number } | null = null;

  function showLine(l: Line) {
    tk.name.textContent = l.who === 'you' ? 'You' : l.who === 'dale' ? COLLEAGUE_TAG : 'Phone';
    talk.dataset.who = l.who;
    tk.next.hidden = true;
    talkTyper.start(l.text, l.who);
    if (call) call.autoAt = 0;
  }

  function startCall() {
    if (call || view !== 'control-room' || !hooks.canCall()) return;
    const s = st();
    const greeting = pick([
      `Bridge, ${COLLEAGUE} speaking. Make it quick, my coffee’s getting cold.`,
      `Yeah, ${COLLEAGUE} here on the operating deck. What’s up?`,
      `Reactor bridge. ${COLLEAGUE}. You again?`,
    ]);
    const ask = pick([
      `Hey ${COLLEAGUE}, it’s the control room. Can you take a look at the reactor for me?`,
      `${COLLEAGUE}, control room here. Mind looking down into the core and telling me what you see?`,
    ]);
    const lines: Line[] = [
      { who: 'dale', text: greeting },
      { who: 'you', text: ask },
      ...(s ? report(s) : ['Hang on, my flashlight died.']).map((t) => ({ who: 'dale' as Speaker, text: t })),
      { who: 'you', text: pick(['Thanks. Turn on your helmet cam, I want to see for myself.', 'Can you switch on your helmet cam? I want eyes on it.']) },
      { who: 'dale', text: pick(['Helmet cam’s on. Ignore the smudge on the lens.', 'Okay, camera on. Wave hello to the control room.']) },
      { who: 'sys', text: `Switching to ${COLLEAGUE}’s helmet cam…`, auto: 700 },
    ];
    const ringMs = voice.ring(2);
    call = { lines, i: -1, ringingUntil: performance.now() + ringMs, autoAt: 0 };
    root.classList.add('in-call');
    talk.hidden = false;
    tk.hint.hidden = true;
    tk.next.hidden = true;
    tk.name.textContent = 'Phone';
    talk.dataset.who = 'sys';
    talkTyper.start('Calling the reactor bridge…  ring…  ring…', 'sys');
    // release the mouse without pausing (pause menu is suppressed while active())
    if (document.pointerLockElement) document.exitPointerLock();
  }

  function advance() {
    if (!call) return;
    if (performance.now() < call.ringingUntil) return;
    if (!talkTyper.done) {
      talkTyper.finish();
      return;
    }
    voice.tick();
    nextLine();
  }

  function nextLine() {
    if (!call) return;
    call.i++;
    if (call.i >= call.lines.length) {
      endCall(true);
      return;
    }
    showLine(call.lines[call.i]);
  }

  function endCall(toCam: boolean) {
    call = null;
    talk.hidden = true;
    root.classList.remove('in-call');
    voice.hangup();
    if (toCam) setView('reactor-cam');
  }

  talk.addEventListener('click', (e) => {
    e.stopPropagation();
    advance();
  });

  // ---------------- camera feed overlay ----------------
  const feed = document.createElement('section');
  feed.className = 'feed';
  feed.hidden = true;
  feed.innerHTML = `
    <div class="feed__frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="feed__scan" aria-hidden="true"></div>
    <header class="feed__top">
      <span class="feed__rec"><b></b>REC</span>
      <span class="feed__cam" data-ref="cam">RX BLDG — OPERATING DECK — CAM 2</span>
      <span class="feed__time" data-ref="time"></span>
    </header>
    <div class="feed__status" data-ref="status"></div>
    <dl class="feed__vals" data-ref="vals"></dl>
    <div class="feed__say" data-ref="say" hidden><div class="talk__name">${COLLEAGUE_TAG}</div><p data-ref="sayText"></p></div>
    <nav class="feed__btns" data-ref="camBtns">
      <button class="fbtn fbtn--go" data-act="tour">Tour the reactor <kbd>T</kbd></button>
      <button class="fbtn" data-act="back">Back to control room <kbd>B</kbd></button>
    </nav>
    <section class="tourcap" data-ref="tour" hidden>
      <div class="tourcap__idx" data-ref="tIdx"></div>
      <h3 class="tourcap__title" data-ref="tTitle"></h3>
      <p class="tourcap__text" data-ref="tText"></p>
      <div class="tourcap__btns">
        <button class="fbtn" data-act="prev">◀ Prev</button>
        <button class="fbtn fbtn--go" data-act="next">Next ▶</button>
        <span class="tourcap__sp"></span>
        <button class="fbtn fbtn--q" data-act="cam">Back to camera <kbd>C</kbd></button>
        <button class="fbtn fbtn--q" data-act="back">Control room <kbd>B</kbd></button>
      </div>
    </section>`;
  root.appendChild(feed);
  const fd = refs(feed);
  const sayTyper = new Typer(fd.sayText);
  const tourTyper = new Typer(fd.tText);
  let sayHideAt = 0;
  let lastSay = 0;
  let tourSeen = false;

  feed.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) {
      // clicking the feed itself finishes the typing (never re-locks the pointer)
      if (view === 'tour' && !tourTyper.done) tourTyper.finish();
      return;
    }
    voice.tick();
    const a = b.dataset.act;
    if (a === 'tour') setView('tour');
    else if (a === 'back') backToRoom();
    else if (a === 'cam') setView('reactor-cam');
    else if (a === 'next') bus.emit('tour-nav', 1);
    else if (a === 'prev') bus.emit('tour-nav', -1);
  });

  function setView(m: ViewMode) {
    if (m === view) return;
    view = m;
    const remote = m !== 'control-room';
    root.classList.toggle('view-remote', remote);
    feed.hidden = !remote;
    feed.dataset.mode = m;
    fd.camBtns.hidden = m !== 'reactor-cam';
    fd.tour.hidden = m !== 'tour';
    fd.cam.textContent = m === 'tour' ? 'REACTOR VESSEL — GUIDED TOUR — DALE' : 'RX BLDG — OPERATING DECK — CAM 2';
    if (m === 'tour') {
      tourSeen = false;
      fd.tIdx.textContent = '';
      fd.tTitle.textContent = 'Heading in…';
      tourTyper.start('Follow me. Mind the railing, it’s a long way down.', 'dale');
      hideSay();
    }
    if (m === 'reactor-cam') {
      lastSay = performance.now() - 4000;
      prevMood = null;
    }
    bus.emit('view-mode', m);
    if (remote) refreshVals();
  }

  function backToRoom() {
    setView('control-room');
    hideSay();
    // inside a click/key gesture: main.ts re-locks the pointer on pause-changed(false)
    hooks.expectLock();
    bus.emit('pause-changed', false);
  }

  bus.on('phone-pickup', () => startCall());
  bus.on('tour-stop', (t) => {
    if (view !== 'tour') return;
    tourSeen = true;
    fd.tIdx.textContent = `${t.index + 1} / ${t.count}`;
    fd.tTitle.textContent = t.title;
    tourTyper.start(t.text, 'dale');
    (feed.querySelector('[data-act="prev"]') as HTMLButtonElement).disabled = t.index <= 0;
    (feed.querySelector('[data-act="next"]') as HTMLButtonElement).disabled = t.index >= t.count - 1;
  });

  // The world pauses the game when the pointer lock is lost; during a call or remote
  // view the game must keep running, so undo that pause right after main.ts applies it.
  bus.on('pause-changed', (p) => {
    if (p && (call || view !== 'control-room')) {
      queueMicrotask(() => {
        if (sim.controls && (call || view !== 'control-room')) sim.controls.paused = false;
      });
    }
  });

  // ---------------- Dale's running commentary ----------------
  let prevMood: PlantMood | null = null;
  let prevP10 = false;
  let prevP50 = false;
  let idleAt = 0;

  function say(text: string, force = false) {
    if (view !== 'reactor-cam') return;
    const now = performance.now();
    if (!force && now - lastSay < 7000) return;
    lastSay = now;
    fd.say.hidden = false;
    sayTyper.start(text, 'dale');
    sayHideAt = 0;
    idleAt = now + 45000 + Math.random() * 30000;
  }
  function hideSay() {
    fd.say.hidden = true;
    sayTyper.finish();
    sayHideAt = 0;
  }

  bus.on('sim', (e: SimEvent) => {
    if (view !== 'reactor-cam') return;
    switch (e.type) {
      case 'trip':
        say(pick(['Whoa! Rods just slammed in. That’s a trip!', 'Bang! Every rod just dropped. You’re tripped.']), true);
        break;
      case 'si':
        say('Safety injection just kicked on. You hear that water rushing?', true);
        break;
      case 'turbine-trip':
        say('Turbine stop valves slammed shut. I felt that one through the floor.');
        break;
      case 'fault':
        say(pick(['Something just changed down there. Sounded wrong.', 'Did you hear that? Something let go somewhere.']));
        break;
      case 'rod-step':
        if (Math.random() < 0.02) say('I can hear the rod drives clicking up here. Clack, clack, clack.');
        break;
      default:
        break;
    }
  });

  function watchState(s: PlantState) {
    const mood = classify(s);
    if (prevMood === null) {
      prevMood = mood;
      prevP10 = s.permissives.P10;
      prevP50 = s.powerRangePct >= 50;
      idleAt = performance.now() + 30000;
      return;
    }
    if (prevMood && mood !== prevMood) {
      const lines: Partial<Record<PlantMood, string>> = {
        critical: 'There it is! A faint blue shimmer in the water. She’s critical.',
        low: 'Glow’s getting brighter. You’re making real heat now.',
        high: 'Now that’s a glow. She’s really cooking.',
        loca: 'Steam! There’s steam coming from somewhere under the deck!',
        damage: 'Radiation alarm up here just went off. That’s bad. Really bad.',
        si: 'Safety injection is running. Water’s pouring in.',
        shutdown: 'Glow’s gone. Quiet again.',
      };
      const l = lines[mood];
      if (l) say(l, mood === 'damage' || mood === 'loca');
    }
    prevMood = mood;
    if (s.permissives.P10 && !prevP10) say('Ten percent and climbing. Steam lines are getting loud.');
    prevP10 = s.permissives.P10;
    const p50 = s.powerRangePct >= 50;
    if (p50 && !prevP50) say('Half power! The whole deck is humming.');
    prevP50 = p50;
    if (idleAt && performance.now() > idleAt) {
      say(
        pick(
          mood === 'shutdown'
            ? ['Still dark down there. I’m going to count fuel assemblies again.', 'You know you’re allowed to pull rods, right?']
            : mood === 'high' || mood === 'low'
              ? ['Glow looks nice and even. No hot spots I can see.', 'Coolant’s crystal clear. You run a tidy plant.', 'Pumps sound happy. That’s a good sign.']
              : ['I’m keeping my distance, just in case.', 'Let me know when you want me to look somewhere else.'],
        ),
      );
    }
  }

  // ---------------- live values ----------------
  function refreshVals() {
    const s = st();
    if (!s) return;
    fd.time.textContent = `T+ ${hooks.clock(s.t)}`;
    const mood = classify(s);
    fd.status.textContent = MOOD_LABEL[mood];
    fd.status.dataset.mood = mood;
    const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
    const rows: [string, string][] = [
      ['Power', `${fmt(s.powerRangePct, 1)} %`],
      ['Tavg', `${fmt(s.tAvg, 1)} °F`],
      ['PZR press', `${fmt(s.rcsPressure)} psig`],
      ['Core exit', `${fmt(s.coreExitTemp)} °F`],
      ['Subcooling', `${fmt(s.subcoolingMargin)} °F`],
      ['Rods CD', `${fmt(s.rods.CD)} steps`],
    ];
    fd.vals.innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  }

  // ---------------- keys ----------------
  function handleKey(ev: KeyboardEvent): boolean {
    if (call) {
      if (ev.code === 'Space' || ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.code === 'KeyF') {
        ev.preventDefault();
        advance();
        return true;
      }
      if (ev.code === 'Escape') {
        endCall(false);
        hooks.pauseWithNote('Call ended. Click Resume to take the controls.');
        return true;
      }
      // let M, [ ] and alarm keys through
      return !['KeyM', 'BracketLeft', 'BracketRight', 'Minus', 'Equal', 'KeyE', 'KeyX', 'KeyQ'].includes(ev.code);
    }
    if (view === 'control-room') return false;
    const help = hooks.helpOpen();
    switch (ev.code) {
      case 'KeyB':
      case 'Backspace':
        if (help && ev.code === 'Backspace') return false;
        backToRoom();
        return true;
      case 'KeyT':
        if (view === 'reactor-cam') setView('tour');
        return true;
      case 'KeyC':
        if (view === 'tour') setView('reactor-cam');
        return true;
      case 'Escape':
        if (help) return false;
        if (view === 'tour') setView('reactor-cam');
        return true;
      case 'ArrowRight':
      case 'ArrowLeft':
        if (help || view !== 'tour') return help ? false : true;
        ev.preventDefault();
        bus.emit('tour-nav', ev.code === 'ArrowRight' ? 1 : -1);
        voice.tick();
        return true;
      case 'Space':
      case 'Enter':
        ev.preventDefault();
        if (view === 'tour' && !tourTyper.done) tourTyper.finish();
        else if (view === 'tour') bus.emit('tour-nav', 1);
        return true;
      case 'Tab':
      case 'KeyP':
        ev.preventDefault();
        return true; // no procedure binder or pause menu in remote views
      default:
        return false;
    }
  }

  let valAcc = 0;
  return {
    update(dt: number) {
      if (call) {
        const now = performance.now();
        talkTyper.update(dt);
        if (call.i < 0 && now >= call.ringingUntil) {
          voice.pickup();
          tk.hint.hidden = false;
          nextLine();
        } else if (call.i >= 0) {
          tk.next.hidden = !talkTyper.done;
          const l = call.lines[call.i];
          if (talkTyper.done && l.auto) {
            if (!call.autoAt) call.autoAt = now + l.auto;
            else if (now >= call.autoAt) nextLine();
          }
        }
      }
      if (view === 'control-room') return;
      sayTyper.update(dt);
      tourTyper.update(dt);
      const now = performance.now();
      if (!fd.say.hidden && sayTyper.done) {
        if (!sayHideAt) sayHideAt = now + 5500;
        else if (now > sayHideAt) hideSay();
      }
      if (view === 'tour' && !tourSeen) {
        /* waiting for the world's first tour-stop */
      }
      valAcc += dt;
      if (valAcc > 0.25) {
        valAcc = 0;
        refreshVals();
        const s = st();
        if (s && view === 'reactor-cam') watchState(s);
      }
    },
    active: () => !!call || view !== 'control-room',
    viewMode: () => view,
    handleKey,
    reset() {
      if (call) {
        call = null;
        talk.hidden = true;
        root.classList.remove('in-call');
      }
      if (view !== 'control-room') {
        view = 'control-room';
        root.classList.remove('view-remote');
        feed.hidden = true;
        bus.emit('view-mode', 'control-room');
      }
      hideSay();
      prevMood = null;
    },
  };
}

function refs(el: HTMLElement): Record<string, HTMLElement> {
  const out: Record<string, HTMLElement> = {};
  el.querySelectorAll<HTMLElement>('[data-ref]').forEach((n) => (out[n.dataset.ref!] = n));
  return out;
}
