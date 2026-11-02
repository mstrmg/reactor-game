/**
 * Glue. Owns the frame loop and wires sim <-> world <-> ui <-> audio.
 * Module entry contracts:
 *   src/sim/ReactorSim.ts : export class ReactorSim implements ReactorSimApi { constructor(scenario: ScenarioId) }
 *   src/world/index.ts    : export function createWorld(container, sim): WorldApi
 *   src/ui/index.ts       : export function createUI(root, sim): UIApi
 *   src/audio/index.ts    : export function createAudio(sim): AudioApi
 */
import { ReactorSim } from './sim/ReactorSim';
import { createWorld } from './world';
import { createUI } from './ui';
import { createAudio } from './audio';
import { bus } from './core/bus';

const sim = new ReactorSim('hot-standby');
const world = createWorld(document.getElementById('app')!, sim);
const ui = createUI(document.getElementById('ui-root')!, sim);
const audio = createAudio(sim);

bus.on('press', (b) => sim.press(b));
bus.on('start-game', ({ scenario, randomFaults }) => {
  sim.reset(scenario);
  sim.randomFaults = randomFaults;
  sim.controls.paused = false;
  void audio.start();
  world.lockPointer();
});
bus.on('pause-changed', (p) => {
  sim.controls.paused = p;
  if (p) world.unlockPointer();
  else world.lockPointer();
});

// Debug handle for console / Playwright tests.
(window as any).__game = { sim, world, ui, audio, bus };

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!sim.controls.paused) sim.update(dt);
  for (const e of sim.drainEvents()) bus.emit('sim', e);
  world.update(dt);
  ui.update(dt);
  audio.update(dt);
  world.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
