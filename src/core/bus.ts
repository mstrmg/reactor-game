/** Tiny typed event bus shared by world / ui / audio. The sim does NOT use it;
 *  main.ts drains sim events each frame and re-emits them here as 'sim'. */
import type { SimEvent, ButtonId } from '../sim/types';

export interface BusEvents {
  sim: SimEvent;
  /** world -> ui: what the crosshair is over (null = nothing) */
  hover: { id: string; label: string; detail?: string } | null;
  /** world -> audio: a physical control was used */
  'control-used': { id: string; kind: 'button' | 'switch' | 'knob' | 'lever' | 'key' };
  /** ui/world -> main: an operator pressed a momentary button */
  press: ButtonId;
  /** ui -> main */
  'start-game': { scenario: import('../sim/types').ScenarioId; randomFaults: boolean };
  'pause-changed': boolean;
  /** world: pointer lock state */
  'pointer-lock': boolean;
}

type Handler<T> = (payload: T) => void;

class Bus {
  private map = new Map<keyof BusEvents, Set<Handler<any>>>();
  on<K extends keyof BusEvents>(k: K, h: Handler<BusEvents[K]>): () => void {
    let s = this.map.get(k);
    if (!s) this.map.set(k, (s = new Set()));
    s.add(h);
    return () => s!.delete(h);
  }
  emit<K extends keyof BusEvents>(k: K, payload: BusEvents[K]): void {
    this.map.get(k)?.forEach((h) => h(payload));
  }
}

export const bus = new Bus();
