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

  // ---- Phone call / remote reactor view / tour ----
  /** world -> ui: player activated the desk telephone (ui starts the call dialogue) */
  'phone-pickup': void;
  /** ui -> world (and anyone): which camera/scene is shown.
   *  'control-room' = normal FPS; 'reactor-cam' = colleague's view on the reactor bridge;
   *  'tour' = guided tour inside the reactor. In non-control-room modes the pointer is
   *  unlocked (so buttons are clickable) and losing pointer lock must NOT pause the game. */
  'view-mode': 'control-room' | 'reactor-cam' | 'tour' | 'outside';
  /** ui -> world: next / previous tour stop */
  'tour-nav': 1 | -1;
  /** world -> ui: tour arrived at a stop (ui shows the caption with typewriter + babble) */
  'tour-stop': { index: number; count: number; title: string; text: string };

  // ---- Crew ----
  /** ui -> world: animate a crew NPC. board = section placard name the member should go to/operate
   *  (e.g. 'FEEDWATER & STEAM DUMP'), or null to return to their home position. */
  'crew-activity': { member: CrewId; board: string | null; state: 'idle' | 'walking' | 'operating' | 'talking' };
  /** ui -> world: crew member speaks (world can turn their head / bob; ui shows the bubble) */
  'crew-say': { member: CrewId; text: string };
  /** world -> ui: player clicked / pressed F on a crew NPC (ui opens the order menu for that member) */
  'crew-clicked': { member: CrewId };
}

/** SRO = shift supervisor, RO = reactor operator, BOP = balance-of-plant operator, FIELD = field operator (off-screen, phone) */
export type CrewId = 'SRO' | 'RO' | 'BOP' | 'FIELD';

type Handler<T> = (payload: T) => void;

class Bus {
  private map = new Map<keyof BusEvents, Set<Handler<any>>>();
  on<K extends keyof BusEvents>(k: K, h: Handler<BusEvents[K]>): () => void {
    let s = this.map.get(k);
    if (!s) this.map.set(k, (s = new Set()));
    s.add(h);
    return () => s!.delete(h);
  }
  emit<K extends keyof BusEvents>(k: K, ...args: BusEvents[K] extends void ? [] : [BusEvents[K]]): void {
    const payload = args[0];
    this.map.get(k)?.forEach((h) => h(payload));
  }
}

export const bus = new Bus();
