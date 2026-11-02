/** DEV ONLY harness: /src/world/dev.html[?real=1&scenario=hot-standby] — world + (mock|real) sim, no UI/audio. */
import { MockSim } from './devMock';
import { createWorld } from './index';
import { bus } from '../core/bus';
import type { ReactorSimApi, ScenarioId } from '../sim/types';

async function main() {
  const q = new URLSearchParams(location.search);
  const scenario = (q.get('scenario') ?? 'full-power') as ScenarioId;
  let sim: ReactorSimApi;
  if (q.get('real')) {
    const mod = await import('../sim/ReactorSim');
    sim = new (mod as any).ReactorSim(scenario);
  } else sim = new MockSim(scenario);
  const world = createWorld(document.getElementById('app')!, sim);
  const hud = document.getElementById('hud')!;
  let hover = '';
  bus.on('hover', (h) => (hover = h ? `${h.label} — ${h.detail ?? ''}` : ''));
  bus.on('press', (b) => sim.press(b));
  (window as any).__dev = { sim, world, bus };
  let last = performance.now();
  let t = 0;
  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!sim.controls.paused) sim.update(dt);
    for (const e of sim.drainEvents()) bus.emit('sim', e);
    world.update(dt);
    world.render();
    t += dt;
    if (t > 0.25) {
      t = 0;
      const i = world.getInfo();
      hud.textContent = `fps ${i.fps.toFixed(0)} calls ${i.calls} tris ${i.triangles}\n${hover}`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
void main();
