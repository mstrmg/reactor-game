/** Tiny shared audio preference store (ui writes, audio reads). */
type Listener = () => void;
const KEY = 'critical.audio';

function load(): { muted: boolean; volume: number } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { muted: !!p.muted, volume: typeof p.volume === 'number' ? p.volume : 0.8 };
    }
  } catch {
    /* ignore */
  }
  return { muted: false, volume: 0.8 };
}

const init = load();
const listeners = new Set<Listener>();

export const audioPrefs = {
  muted: init.muted,
  volume: init.volume,
  setMuted(m: boolean) {
    this.muted = m;
    this.save();
  },
  toggleMute() {
    this.setMuted(!this.muted);
  },
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.save();
  },
  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ muted: this.muted, volume: this.volume }));
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l());
  },
  onChange(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
