/**
 * Telephone + "animalese" voice blips. A module-level singleton so the UI can call it
 * directly; createAudio() attaches it to the live AudioContext once audio has started.
 * Every call is a no-op until then.
 */
import { audioPrefs } from './prefs';

export type Speaker = 'you' | 'dale' | 'sys';

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let lastBlip = 0;

export function attachVoice(c: AudioContext, dest: AudioNode) {
  ctx = c;
  out = c.createGain();
  out.gain.value = audioPrefs.muted ? 0 : audioPrefs.volume;
  out.connect(dest);
  audioPrefs.onChange(() => {
    if (out && ctx) out.gain.setTargetAtTime(audioPrefs.muted ? 0 : audioPrefs.volume, ctx.currentTime, 0.03);
  });
}

// vowel formant centres (single band-pass "mouth")
const FORMANT: Record<string, number> = { a: 1000, e: 1900, i: 2400, o: 650, u: 450, y: 2100 };
const VOICE: Record<Speaker, { base: number; type: OscillatorType; q: number; gain: number; spread: number }> = {
  you: { base: 330, type: 'triangle', q: 4, gain: 0.22, spread: 5 },
  dale: { base: 175, type: 'square', q: 6, gain: 0.13, spread: 4 },
  sys: { base: 520, type: 'sine', q: 2, gain: 0.08, spread: 2 },
};

function osc(type: OscillatorType, f: number, t: number, dur: number, dest: AudioNode) {
  const o = ctx!.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}
function env(t: number, a: number, peak: number, hold: number, rel: number): GainNode {
  const g = ctx!.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setValueAtTime(peak, t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
  return g;
}

export const voice = {
  get ready() {
    return !!ctx && !!out;
  },
  /** One syllable for a typed character. Throttled; spaces and punctuation are silent. */
  babble(ch: string, who: Speaker, question = false) {
    if (!ctx || !out) return;
    const c = ch.toLowerCase();
    if (!/[a-z0-9]/.test(c)) return;
    const now = ctx.currentTime;
    if (now - lastBlip < 0.055) return;
    lastBlip = now;
    const v = VOICE[who];
    const code = c.charCodeAt(0);
    // letter -> semitone offset in a pentatonic-ish set, so it sounds sung, not random
    const steps = [0, 2, 4, 7, 9, 12, 14];
    const semi = steps[code % steps.length] - v.spread + (question ? 4 : 0) + (Math.random() - 0.5) * 1.2;
    const f = v.base * Math.pow(2, semi / 12);
    const isVowel = c in FORMANT;
    const t = now + 0.005;
    const dur = isVowel ? 0.075 : 0.05;
    const g = env(t, 0.006, v.gain, dur * 0.4, dur * 0.6);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = isVowel ? FORMANT[c] : 1300 + (code % 5) * 220;
    bp.Q.value = v.q;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    g.connect(lp).connect(out);
    bp.connect(g);
    const o = osc(v.type, f, t, dur, bp);
    // a little pitch "bend" makes it chirpy
    o.frequency.setValueAtTime(f * 1.06, t);
    o.frequency.exponentialRampToValueAtTime(f, t + dur * 0.6);
    // dry body so low voices are audible through the formant
    const body = ctx.createGain();
    body.gain.value = 0.35;
    body.connect(g);
    osc(v.type === 'square' ? 'triangle' : 'sine', f, t, dur, body);
  },
  /** Outgoing call ringback (US 440+480 Hz), `rings` cycles. Returns duration in ms. */
  ring(rings = 2): number {
    if (!ctx || !out) return rings * 2000;
    const t0 = ctx.currentTime + 0.35;
    for (let r = 0; r < rings; r++) {
      const t = t0 + r * 2.0;
      const g = env(t, 0.02, 0.07, 1.15, 0.05);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2800;
      g.connect(lp).connect(out);
      osc('sine', 440, t, 1.25, g);
      osc('sine', 480, t, 1.25, g);
    }
    // dial pulses before the ring
    this.click(0.4, 2400, 0.0);
    this.click(0.3, 2000, 0.08);
    return 350 + rings * 2000;
  },
  pickup() {
    this.click(0.8, 900, 0);
    this.click(0.5, 1600, 0.05);
  },
  hangup() {
    this.click(0.9, 700, 0);
    this.click(0.6, 500, 0.07);
  },
  /** soft UI tick for buttons / advancing text */
  tick() {
    this.click(0.25, 3000, 0);
  },
  click(gain: number, f: number, delay: number) {
    if (!ctx || !out) return;
    const t = ctx.currentTime + 0.005 + delay;
    const n = Math.floor(ctx.sampleRate * 0.03);
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const tt = i / ctx.sampleRate;
      d[i] = (Math.random() * 2 - 1) * Math.exp(-tt / 0.002) * 0.6 + Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt / 0.008);
    }
    const s = ctx.createBufferSource();
    s.buffer = b;
    const g = ctx.createGain();
    g.gain.value = gain * 0.5;
    s.connect(g).connect(out);
    s.start(t);
  },
};
