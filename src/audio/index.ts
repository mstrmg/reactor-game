/**
 * Control room audio. Tone.js unlocks/owns the AudioContext; the graph itself
 * is a handful of raw Web Audio nodes driven from plant state at ~10 Hz, and
 * every one-shot is a procedurally generated buffer (no assets, few voices).
 *
 *   sources ─┬─ ambience ─┐
 *            ├─ machines ─┤
 *            ├─ sfx ──────┼─ master ─ muffle(LPF) ─ compressor ─ out
 *            └─ alarms ───┘   (alarms duck while paused)
 */
import * as Tone from 'tone';
import type { PlantState, ReactorSimApi, SimEvent } from '../sim/types';
import { bus } from '../core/bus';
import { audioPrefs } from './prefs';
import { attachVoice } from './voice';

export interface AudioApi {
  start(): Promise<void>;
  update(dt: number): void;
  mute(m?: boolean): void;
  debug?(): { ctx: AudioContext | null; master: GainNode; state?: string };
}

type Kind = 'button' | 'switch' | 'knob' | 'lever' | 'key';
type BufName = Kind | 'rod' | 'sr' | 'boom' | 'breaker' | 'valve' | 'noise' | 'brown';

export function createAudio(sim: ReactorSimApi): AudioApi {
  let ctx: AudioContext | null = null;
  let ready = false;
  const bufs = {} as Record<BufName, AudioBuffer>;

  // nodes (assigned in build)
  let master!: GainNode, muffle!: BiquadFilterNode, ambience!: GainNode, machines!: GainNode, sfx!: GainNode, alarms!: GainNode;
  let humGain!: GainNode, turbGain!: GainNode, turbA!: OscillatorNode, turbB!: OscillatorNode;
  let steamGain!: GainNode, steamFilt!: BiquadFilterNode, rumbleGain!: GainNode, srHiss!: GainNode;
  let hornOscA!: OscillatorNode, hornOscB!: OscillatorNode, hornGain!: GainNode;
  let klaxOsc!: OscillatorNode, klaxGain!: GainNode;

  // scheduling state
  let paramAcc = 0;
  let nextSrClick = 0;
  let hornNext = 0;
  let hornPhase = 0;
  let klaxNext = 0;
  let lastRod = 0;
  let catastropheAt = -1;

  const st = (): PlantState | undefined => (sim as { state?: PlantState }).state;

  // ---------------- buffer synthesis ----------------
  function makeBuffers(c: AudioContext) {
    const sr = c.sampleRate;
    const mk = (secs: number, fn: (t: number, i: number) => number): AudioBuffer => {
      const n = Math.max(1, Math.floor(secs * sr));
      const b = c.createBuffer(1, n, sr);
      const d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = fn(i / sr, i);
      return b;
    };
    const rnd = () => Math.random() * 2 - 1;
    const ring = (t: number, f: number, decay: number) => Math.sin(2 * Math.PI * f * t) * Math.exp(-t / decay);

    bufs.noise = mk(2, () => rnd());
    let last = 0;
    bufs.brown = mk(3, () => {
      last = (last + 0.02 * rnd()) / 1.02;
      return last * 3.5;
    });
    // momentary pushbutton: soft plastic thunk
    bufs.button = mk(0.08, (t) => 0.7 * ring(t, 190, 0.012) + 0.35 * rnd() * Math.exp(-t / 0.0025) + 0.25 * ring(t, 1250, 0.006));
    // rotary switch detent: two sharp clacks
    bufs.switch = mk(0.12, (t) => {
      const a = rnd() * Math.exp(-t / 0.002) + ring(t, 2300, 0.01);
      const t2 = t - 0.028;
      const b = t2 > 0 ? 0.7 * (rnd() * Math.exp(-t2 / 0.002) + ring(t2, 1700, 0.012)) : 0;
      return 0.5 * (a + b) + 0.4 * ring(t, 140, 0.02);
    });
    bufs.knob = mk(0.03, (t) => 0.5 * ring(t, 3400, 0.003) + 0.3 * rnd() * Math.exp(-t / 0.001));
    bufs.lever = mk(0.16, (t) => {
      let v = 0;
      for (let k = 0; k < 3; k++) {
        const tk = t - k * 0.035;
        if (tk > 0) v += (rnd() * Math.exp(-tk / 0.0015) + ring(tk, 1900 - k * 200, 0.008)) * (1 - k * 0.2);
      }
      return 0.45 * v + 0.3 * ring(t, 110, 0.03);
    });
    bufs.key = mk(0.14, (t) => {
      const t2 = t - 0.05;
      return 0.4 * (rnd() * Math.exp(-t / 0.002) + ring(t, 2900, 0.015)) + (t2 > 0 ? 0.5 * (ring(t2, 1450, 0.02) + rnd() * Math.exp(-t2 / 0.002)) : 0);
    });
    // CRDM step: lift coil / gripper latch double clack with steel ring
    bufs.rod = mk(0.22, (t) => {
      const hit = (tt: number, a: number) =>
        tt > 0 ? a * (0.6 * rnd() * Math.exp(-tt / 0.003) + ring(tt, 820, 0.03) + 0.6 * ring(tt, 1530, 0.02) + 0.5 * ring(tt, 95, 0.04)) : 0;
      return 0.35 * (hit(t, 1) + hit(t - 0.07, 0.7));
    });
    // source range count-rate speaker click
    bufs.sr = mk(0.012, (t) => (t < 0.0004 ? 1 : 0) * 0.9 + 0.5 * ring(t, 3900, 0.0015) - 0.3 * ring(t, 900, 0.002));
    // heavy breaker / stop valve clunk
    bufs.breaker = mk(0.5, (t) => 0.8 * ring(t, 75, 0.08) + 0.5 * rnd() * Math.exp(-t / 0.012) + 0.3 * ring(t, 420, 0.05));
    // steam valve whoosh
    let lp = 0;
    bufs.valve = mk(1.6, (t) => {
      lp += 0.08 * (rnd() - lp);
      const env = Math.min(1, t / 0.05) * Math.exp(-t / 0.6);
      return 1.6 * lp * env;
    });
    // catastrophe: distant blast through a concrete building
    let lb = 0;
    bufs.boom = mk(6, (t) => {
      const cut = 0.02 + 0.25 * Math.exp(-t / 0.15);
      lb += cut * (rnd() - lb);
      const env = Math.min(1, t / 0.008) * Math.exp(-t / 1.4);
      const thump = Math.sin(2 * Math.PI * (40 * t - 6 * t * t)) * Math.exp(-t / 0.9);
      return 2.2 * lb * env + 0.9 * thump;
    });
  }

  // ---------------- graph ----------------
  function loop(buf: AudioBuffer, dest: AudioNode, gain = 1): GainNode {
    const c = ctx!;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buf.duration;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    src.start(c.currentTime + Math.random() * 0.01, Math.random() * buf.duration);
    return g;
  }

  function osc(type: OscillatorType, f: number, dest: AudioNode): OscillatorNode {
    const o = ctx!.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(dest);
    o.start();
    return o;
  }

  function build() {
    const c = ctx!;
    makeBuffers(c);
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(c.destination);
    attachVoice(c, comp);
    muffle = c.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 18000;
    muffle.connect(comp);
    master = c.createGain();
    master.gain.value = 0;
    master.connect(muffle);
    const bus_ = (v: number) => {
      const g = c.createGain();
      g.gain.value = v;
      g.connect(master);
      return g;
    };
    ambience = bus_(1);
    machines = bus_(1);
    sfx = bus_(0.9);
    alarms = bus_(0.55);

    // Room tone: HVAC rumble + air hiss + fluorescent ballast hum
    const roomLp = c.createBiquadFilter();
    roomLp.type = 'lowpass';
    roomLp.frequency.value = 220;
    roomLp.connect(ambience);
    loop(bufs.brown, roomLp, 0.07);
    const hiss = c.createBiquadFilter();
    hiss.type = 'bandpass';
    hiss.frequency.value = 2600;
    hiss.Q.value = 0.4;
    hiss.connect(ambience);
    loop(bufs.noise, hiss, 0.006);
    humGain = c.createGain();
    humGain.gain.value = 0.006;
    humGain.connect(ambience);
    osc('sine', 120, humGain);
    const h2 = c.createGain();
    h2.gain.value = 0.35;
    h2.connect(humGain);
    osc('triangle', 240, h2);

    // Turbine whine (far away through the wall)
    const turbF = c.createBiquadFilter();
    turbF.type = 'lowpass';
    turbF.frequency.value = 1400;
    turbF.connect(machines);
    turbGain = c.createGain();
    turbGain.gain.value = 0;
    turbGain.connect(turbF);
    turbA = osc('triangle', 40, turbGain);
    const tb = c.createGain();
    tb.gain.value = 0.4;
    tb.connect(turbGain);
    turbB = osc('sine', 80, tb);

    // Steam: dumps / relief valves (hiss band) + deep rumble
    steamFilt = c.createBiquadFilter();
    steamFilt.type = 'bandpass';
    steamFilt.frequency.value = 500;
    steamFilt.Q.value = 0.6;
    steamFilt.connect(machines);
    steamGain = loop(bufs.noise, steamFilt, 0);
    const rumbleLp = c.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 120;
    rumbleLp.connect(machines);
    rumbleGain = loop(bufs.brown, rumbleLp, 0);

    // Source range hiss when count rate is too high to resolve clicks
    const srF = c.createBiquadFilter();
    srF.type = 'highpass';
    srF.frequency.value = 1800;
    srF.connect(sfx);
    srHiss = loop(bufs.noise, srF, 0);

    // Annunciator horn: two-tone, pulsed
    const hornF = c.createBiquadFilter();
    hornF.type = 'lowpass';
    hornF.frequency.value = 2200;
    hornF.connect(alarms);
    hornGain = c.createGain();
    hornGain.gain.value = 0;
    hornGain.connect(hornF);
    hornOscA = osc('square', 680, hornGain);
    const hb = c.createGain();
    hb.gain.value = 0.5;
    hb.connect(hornGain);
    hornOscB = osc('sawtooth', 1360, hb);

    // Trip / evacuation klaxon: rising whoop
    const klF = c.createBiquadFilter();
    klF.type = 'lowpass';
    klF.frequency.value = 2600;
    klF.connect(alarms);
    klaxGain = c.createGain();
    klaxGain.gain.value = 0;
    klaxGain.connect(klF);
    klaxOsc = osc('sawtooth', 420, klaxGain);

    applyMaster();
  }

  function applyMaster() {
    if (!ready) return;
    const v = audioPrefs.muted ? 0 : audioPrefs.volume;
    master.gain.setTargetAtTime(v, ctx!.currentTime, 0.05);
  }
  audioPrefs.onChange(applyMaster);

  function play(name: BufName, dest: AudioNode, gain = 1, rate = 1, when = 0) {
    if (!ready) return;
    const c = ctx!;
    const src = c.createBufferSource();
    src.buffer = bufs[name];
    src.playbackRate.value = rate;
    if (gain !== 1) {
      const g = c.createGain();
      g.gain.value = gain;
      src.connect(g).connect(dest);
    } else src.connect(dest);
    src.start(when || c.currentTime);
  }

  // ---------------- events ----------------
  bus.on('control-used', ({ kind }) => {
    play(kind as Kind, sfx, kind === 'knob' ? 0.6 : 0.9, 0.92 + Math.random() * 0.16);
  });

  let remote = false;
  bus.on('view-mode', (m) => {
    remote = m !== 'control-room';
    if (!ready || catastropheAt >= 0) return;
    const now = ctx!.currentTime;
    muffle.frequency.cancelScheduledValues(now);
    muffle.frequency.setTargetAtTime(remote ? 1800 : 18000, now, 0.15);
  });

  bus.on('start-game', () => {
    remote = false;
    catastropheAt = -1;
    if (ready) {
      muffle.frequency.cancelScheduledValues(ctx!.currentTime);
      muffle.frequency.setTargetAtTime(18000, ctx!.currentTime, 0.1);
    }
  });

  bus.on('sim', (e: SimEvent) => {
    if (!ready) return;
    const c = ctx!;
    const now = c.currentTime;
    switch (e.type) {
      case 'rod-step':
        if (now - lastRod > 0.11) {
          lastRod = now;
          play('rod', sfx, 0.55, 0.95 + Math.random() * 0.1);
        }
        break;
      case 'trip':
        play('breaker', sfx, 1, 1);
        // all rods falling: a rattle of gripper releases over ~1.5 s
        for (let i = 0; i < 10; i++) play('rod', sfx, 0.35, 0.8 + Math.random() * 0.3, now + 0.15 + i * 0.12 + Math.random() * 0.06);
        break;
      case 'breaker':
        play('breaker', sfx, 0.8, e.closed ? 1.1 : 0.9);
        break;
      case 'turbine-trip':
        play('breaker', sfx, 0.9, 0.7);
        play('valve', machines, 0.7, 1);
        break;
      case 'si':
        play('breaker', sfx, 0.7, 0.8);
        break;
      case 'catastrophe':
        catastropheAt = now;
        play('boom', sfx, 1.4, 1);
        muffle.frequency.cancelScheduledValues(now);
        muffle.frequency.setValueAtTime(muffle.frequency.value, now);
        muffle.frequency.linearRampToValueAtTime(320, now + 0.25);
        muffle.frequency.setTargetAtTime(2500, now + 1.5, 4);
        break;
      default:
        break;
    }
  });

  // ---------------- per-frame ----------------
  function scheduleAlarms(s: PlantState, paused: boolean) {
    const c = ctx!;
    const now = c.currentTime;
    const ahead = now + 0.25;
    let hornOn = false;
    let klaxOn = !!s.catastrophe;
    for (const a of s.alarms) {
      if (a.acknowledged) continue;
      if (a.severity === 'trip') klaxOn = true;
      else if (a.active && (a.severity === 'alarm' || a.severity === 'warning')) hornOn = true;
    }
    if (paused) {
      hornOn = false;
      klaxOn = false;
    }
    alarms.gain.setTargetAtTime(paused ? 0 : 0.55, now, 0.08);

    // Horn: 0.35 s on / 0.15 s off, alternating pitch
    if (hornOn && !klaxOn) {
      if (hornNext < now) hornNext = now + 0.02;
      while (hornNext < ahead) {
        hornPhase ^= 1;
        const f = hornPhase ? 680 : 540;
        hornOscA.frequency.setValueAtTime(f, hornNext);
        hornOscB.frequency.setValueAtTime(f * 2.01, hornNext);
        hornGain.gain.setTargetAtTime(0.09, hornNext, 0.006);
        hornGain.gain.setTargetAtTime(0, hornNext + 0.33, 0.01);
        hornNext += 0.5;
      }
    } else if (hornNext > 0) {
      hornGain.gain.cancelScheduledValues(now);
      hornGain.gain.setTargetAtTime(0, now, 0.02);
      hornNext = 0;
    }

    // Klaxon: 0.8 s rising whoop, every 1.1 s
    if (klaxOn) {
      if (klaxNext < now) klaxNext = now + 0.02;
      while (klaxNext < ahead) {
        klaxOsc.frequency.setValueAtTime(380, klaxNext);
        klaxOsc.frequency.exponentialRampToValueAtTime(980, klaxNext + 0.8);
        klaxGain.gain.setTargetAtTime(0.085, klaxNext, 0.02);
        klaxGain.gain.setTargetAtTime(0, klaxNext + 0.8, 0.03);
        klaxNext += 1.1;
      }
    } else if (klaxNext > 0) {
      klaxGain.gain.cancelScheduledValues(now);
      klaxGain.gain.setTargetAtTime(0, now, 0.03);
      klaxNext = 0;
    }
  }

  /** Poisson clicks proportional to source range count rate. */
  function scheduleSourceRange(s: PlantState, paused: boolean) {
    const c = ctx!;
    const now = c.currentTime;
    // the SR detectors are de-energised above P-6; the speaker goes quiet
    const live = !paused && !s.permissives.P6 && Number.isFinite(s.sourceRangeCps) && s.sourceRangeCps > 0;
    const CAP = 90;
    const rate = live ? s.sourceRangeCps * 0.1 : 0; // audio scaler: 1 click per 10 counts
    const clickRate = Math.min(CAP, rate);
    const over = rate > CAP ? Math.min(1, Math.log10(rate / CAP) / 2) : 0;
    srHiss.gain.setTargetAtTime(0.05 * over, now, 0.2);
    if (clickRate < 0.02) {
      nextSrClick = 0;
      return;
    }
    if (nextSrClick < now) nextSrClick = now + 0.03;
    const ahead = now + 0.15;
    let guard = 0;
    while (nextSrClick < ahead && guard++ < 40) {
      play('sr', sfx, 0.32 * (1 - 0.6 * over), 0.9 + Math.random() * 0.2, nextSrClick);
      nextSrClick += -Math.log(1 - Math.random()) / clickRate;
    }
  }

  function updateParams(s: PlantState, paused: boolean) {
    const c = ctx!;
    const now = c.currentTime;
    const rpm = Math.max(0, s.turbineSpeedRpm || 0);
    const x = Math.min(1.1, rpm / 1800);
    const f = 30 + 330 * x;
    turbA.frequency.setTargetAtTime(f, now, 0.3);
    turbB.frequency.setTargetAtTime(f * 2.02, now, 0.3);
    const load = Math.min(1, Math.max(0, (s.grossMWe || 0) / 1150));
    turbGain.gain.setTargetAtTime(x > 0.01 ? 0.03 * Math.pow(x, 1.5) * (0.6 + 0.4 * load) : 0, now, 0.4);

    const dump = Math.max(0, Math.min(1, s.steamDumpDemand || 0));
    const sv = s.safetyValvesOpen ? 1 : 0;
    const porv = s.porvOpen ? 1 : 0;
    steamGain.gain.setTargetAtTime(0.05 * dump + 0.18 * sv + 0.05 * porv, now, 0.25);
    steamFilt.frequency.setTargetAtTime(sv ? 900 : porv ? 1500 : 450, now, 0.3);
    let rumble = 0.18 * dump + 0.45 * sv;
    if (catastropheAt >= 0) rumble += 0.6 * Math.exp(-(now - catastropheAt) / 20);
    rumbleGain.gain.setTargetAtTime(rumble, now, 0.3);

    machines.gain.setTargetAtTime(paused ? 0.35 : 1, now, 0.2);
  }

  return {
    async start() {
      try {
        await Tone.start();
        if (!ctx) {
          ctx = Tone.getContext().rawContext as unknown as AudioContext;
          build();
          ready = true;
          applyMaster();
        } else if (ctx.state !== 'running') {
          await ctx.resume();
        }
      } catch (err) {
        console.warn('[audio] failed to start', err);
      }
    },
    /** debug/test hook: the live context and the post-master node */
    debug() {
      return { ctx, master, state: ctx?.state };
    },
    mute(m?: boolean) {
      audioPrefs.setMuted(m ?? !audioPrefs.muted);
    },
    update(dt: number) {
      if (!ready) return;
      const s = st();
      if (!s) return;
      const paused = !!sim.controls?.paused;
      scheduleSourceRange(s, paused);
      paramAcc += dt;
      if (paramAcc >= 0.1) {
        paramAcc = 0;
        scheduleAlarms(s, paused);
        updateParams(s, paused);
      }
    },
  };
}
