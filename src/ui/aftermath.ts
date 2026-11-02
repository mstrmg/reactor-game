/**
 * Aftermath: after a catastrophe the view cuts to an exterior camera ('view-mode' 'outside'),
 * with a radiation map (plume, rings, evacuation zone from state.release), a breaking-news
 * lower third and a scrolling ticker written from what actually happened on the shift.
 *
 * The 3D world renders the exterior itself; this overlay is transparent over it. If the world
 * fails to build its exterior view (the 'view-mode' handler throws), a 2D canvas scene is
 * drawn instead so the aftermath still reads.
 */
import type { PlantState, ReactorSimApi, ReleaseState } from '../sim/types';
import { bus } from '../core/bus';
import { voice } from '../audio/voice';
import { CATASTROPHE_TITLE } from './labels';
import { money } from './economy';

type Kind = NonNullable<PlantState['catastrophe']>['kind'];

export interface AftermathFacts {
  scenario: string;
  /** first malfunction of the shift, if any */
  initiating: string | null;
  trips: number;
}
export interface AftermathHooks {
  facts(): AftermathFacts;
  report(): void;
  restart(): void;
  clock(t: number): string;
}
export interface AftermathApi {
  start(): void;
  /** hide the overlay but stay in the exterior view (the report is on top) */
  hide(): void;
  show(): void;
  reset(): void;
  active(): boolean;
  update(dt: number): void;
}

export const EC_TITLE: Record<ReleaseState['emergencyClass'], string> = {
  none: 'No emergency',
  'unusual-event': 'Unusual Event',
  alert: 'Alert',
  'site-area-emergency': 'Site Area Emergency',
  'general-emergency': 'General Emergency',
};
export function fmtCi(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} billion`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)} million`;
  if (v >= 1e4) return `${Math.round(v / 1e3)} thousand`;
  return v >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v >= 1 ? 1 : 2);
}
export const totalCi = (r?: ReleaseState) => (r ? r.nobleGasCi + r.iodineCi + r.cesiumCi : 0);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const hhmm = (h: number) => {
  const x = ((h % 24) + 24) % 24;
  return `${String(Math.floor(x)).padStart(2, '0')}:${String(Math.floor((x % 1) * 60)).padStart(2, '0')}`;
};

const HEADLINE: Record<Kind, string> = {
  meltdown: 'Core melts at Unit 2',
  'steam-explosion': 'Steam explosion rocks Unit 2',
  'vessel-rupture': 'Reactor vessel fails at Unit 2',
  'containment-failure': 'Containment breached at Unit 2',
  'turbine-missile': 'Turbine throws a blade through Unit 2',
};
const TOWNS: { name: string; x: number; y: number }[] = [
  { name: 'Millbrook', x: 1.2, y: -3.6 },
  { name: 'Cedar Falls', x: -6.8, y: 4.1 },
  { name: 'Harlan', x: 7.9, y: 6.6 },
  { name: 'Port Ashby', x: -4.2, y: -8.3 },
  { name: 'Dunmore', x: 9.4, y: -7.1 },
];

export function createAftermath(root: HTMLElement, sim: ReactorSimApi, hooks: AftermathHooks): AftermathApi {
  const st = (): PlantState | undefined => (sim as { state?: PlantState }).state;
  let on = false;
  let fallback = false;
  let shownAt = 0;
  let newsAt = 0;
  let mapAcc = 0;
  let sceneAcc = 0;

  const el = document.createElement('section');
  el.className = 'aft';
  el.hidden = true;
  el.innerHTML = `
    <canvas class="aft__scene" data-r="scene" hidden></canvas>
    <div class="aft__cam">
      <i class="aft__corner aft__corner--tl"></i><i class="aft__corner aft__corner--tr"></i><i class="aft__corner aft__corner--bl"></i><i class="aft__corner aft__corner--br"></i>
      <div class="aft__camid"><span class="aft__rec">REC</span> Exterior cam — Unit 2 <small>CAM 04 · north perimeter fence</small></div>
      <div class="aft__time" data-r="time"></div>
    </div>
    <aside class="aft__map">
      <header><span>Dose projection</span><b data-r="ec"></b></header>
      <canvas data-r="map" width="360" height="360"></canvas>
      <dl class="aft__nums" data-r="nums"></dl>
    </aside>
    <div class="aft__btns">
      <button class="pushbtn pushbtn--sm" data-r="report"><span class="pushbtn__lens">Incident report</span></button>
      <button class="pushbtn pushbtn--sm pushbtn--alt" data-r="restart"><span class="pushbtn__lens">Try again</span></button>
    </div>
    <div class="aft__news" data-r="news" hidden>
      <div class="aft__lower">
        <div class="aft__tag"><span>Breaking news</span><i>Live</i></div>
        <div class="aft__head" data-r="head"></div>
        <div class="aft__sub" data-r="sub"></div>
      </div>
      <div class="aft__ticker"><b class="aft__bug">KNWS 7</b><div class="aft__tickwin"><div class="aft__tick" data-r="tick"></div></div></div>
    </div>`;
  root.appendChild(el);
  const R = (k: string) => el.querySelector(`[data-r="${k}"]`) as HTMLElement;
  const scene = R('scene') as HTMLCanvasElement;
  const map = R('map') as HTMLCanvasElement;
  R('report').addEventListener('click', () => hooks.report());
  R('restart').addEventListener('click', () => hooks.restart());
  // refresh the copy each time the ticker loops (the numbers keep moving)
  R('tick').addEventListener('animationiteration', () => buildTicker());

  // ---------------- news copy ----------------
  function news(s: PlantState) {
    const c = s.catastrophe;
    const kind: Kind = c?.kind ?? 'meltdown';
    const r = s.release;
    const g = s.grid;
    const f = hooks.facts();
    const ci = totalCi(r);
    const ec = r ? EC_TITLE[r.emergencyClass] : '';
    const evac = r?.evacuationRadiusMi ?? 0;
    const when = g ? hhmm(g.hourOfDay) : hooks.clock(c?.t ?? s.t);
    const down = r ? compass(r.windFromDeg + 180) : '';
    const head = HEADLINE[kind];
    const subBits = [
      r && r.emergencyClass !== 'none' ? `${ec} declared` : '',
      r ? (ci >= 1 ? `${fmtCi(ci)} curies released` : 'no significant release reported') : '',
      evac > 0 ? `evacuation out to ${Math.round(evac)} miles` : r ? 'no evacuation ordered' : '',
    ].filter(Boolean);
    const sub = subBits.length ? subBits.join(' · ') : `${CATASTROPHE_TITLE[kind] ?? kind} at ${when}`;

    const items: string[] = [];
    items.push(`${CATASTROPHE_TITLE[kind] ?? kind} at Critical Station Unit 2 at ${when}, ${hooks.clock(c?.t ?? s.t)} into the shift`);
    if (f.initiating) items.push(`Investigators say it started with ${/^[aeiou]/i.test(f.initiating) ? 'an' : 'a'} ${f.initiating.toLowerCase()}`);
    else items.push('Investigators find no equipment failure. “It was the operator,” says a spokesperson, “but in a supportive way.”');
    if (f.trips > 0) items.push(`The unit had already tripped ${f.trips} time${f.trips > 1 ? 's' : ''} this shift. Neighbors describe the plant as “moody”`);
    if (r && ci >= 1) {
      items.push(`Released: ${fmtCi(r.nobleGasCi)} Ci noble gas, ${fmtCi(r.iodineCi)} Ci iodine, ${fmtCi(r.cesiumCi)} Ci cesium`);
      items.push(`Projected dose at the site fence ${r.siteBoundaryDoseRem.toFixed(r.siteBoundaryDoseRem < 1 ? 2 : 1)} rem. For scale, the public’s annual limit is 0.1`);
      if (r.windSpeedMps > 0) items.push(`Wind from the ${compass(r.windFromDeg)} at ${Math.round(r.windSpeedMps * 2.237)} mph is carrying the plume ${down}. Residents ${down} of the plant told to stay indoors`);
      if (r.iodineCi > 1e3) items.push('Potassium iodide pills handed out at three county fire stations. The pharmacy has run out of “I survived” mugs');
    } else if (r) {
      items.push('Containment held. Off-site readings at background. Engineers describe themselves as “cautiously smug”');
    }
    if (evac > 0) items.push(`Schools closed within ${Math.round(evac)} miles. Traffic on Route 9 described as “biblical”`);
    if (g) {
      items.push(`Shift finances: ${money(g.cash)} after ${money(g.revenue)} in sales. Utility stock halted. Analysts call it “a rough day”`);
      if (g.dispatch?.status === 'pending' || g.dispatchHistory.length) items.push('Grid Ops dispatcher Lorraine: “I only asked for a few more megawatts, hon.”');
      if (g.frequencyHz < 59.97) items.push(`Regional grid frequency dipped to ${g.frequencyHz.toFixed(2)} Hz as Unit 2 went dark. Neighboring plants pick up the load`);
      else items.push('Neighboring plants pick up Unit 2’s load. “We had it covered,” says a smug rival utility');
    }
    items.push('NRC inspection team en route. Their first question is reportedly “who had the reactor?”');
    items.push('Local diner reports record coffee sales to reporters and men in hazmat suits');
    items.push(`Scenario: ${f.scenario}. Press “Try again” to take the shift back`);
    return { head, sub, items };
  }
  function buildTicker() {
    const s = st();
    if (!s) return;
    const n = news(s);
    R('head').textContent = n.head;
    R('sub').textContent = n.sub;
    const line = n.items.map((t) => `<span>${esc(t)}</span>`).join('<i>◆</i>');
    const tick = R('tick');
    tick.innerHTML = `${line}<i>◆</i>${line}<i>◆</i>`;
    // speed: ~90 px/s
    requestAnimationFrame(() => {
      const w = tick.scrollWidth / 2;
      tick.style.setProperty('--dur', `${Math.max(30, w / 90)}s`);
    });
  }

  // ---------------- numbers ----------------
  function refreshNums() {
    const s = st();
    const r = s?.release;
    const ecEl = R('ec');
    if (!r) {
      ecEl.textContent = 'No data';
      ecEl.dataset.ec = 'none';
      R('nums').innerHTML = `<div><dt>Release</dt><dd>—</dd></div><div><dt>Boundary dose</dt><dd>—</dd></div><div><dt>Wind</dt><dd>—</dd></div><div><dt>Evacuation</dt><dd>—</dd></div>`;
      return;
    }
    ecEl.textContent = EC_TITLE[r.emergencyClass];
    ecEl.dataset.ec = r.emergencyClass;
    const rows: [string, string][] = [
      ['Released', `${fmtCi(totalCi(r))} Ci`],
      ['Release rate', `${r.rateCiPerS >= 1 ? fmtCi(r.rateCiPerS) : r.rateCiPerS.toFixed(2)} Ci/s`],
      ['Site boundary', `${r.siteBoundaryDoseRem.toFixed(r.siteBoundaryDoseRem < 10 ? 2 : 0)} rem`],
      ['At 10 miles', `${r.tenMileDoseRem.toFixed(r.tenMileDoseRem < 10 ? 3 : 1)} rem`],
      ['Wind', `${Math.round(r.windFromDeg)}° · ${r.windSpeedMps.toFixed(1)} m/s · ${r.stabilityClass}`],
      ['Evacuation', r.evacuationRadiusMi > 0 ? `${Math.round(r.evacuationRadiusMi)} mi` : 'none'],
      ['Pathway', r.pathway.replace(/-/g, ' ')],
    ];
    R('nums').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  }

  // ---------------- radiation map ----------------
  function doseColor(rem: number): string {
    if (rem >= 5) return '#d63a2e';
    if (rem >= 1) return '#f07a2a';
    if (rem >= 0.1) return '#f0b23a';
    return '#c9d86a';
  }
  function drawMap(time: number) {
    const s = st();
    const r = s?.release;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 360;
    if (map.width !== W * dpr) {
      map.width = W * dpr;
      map.height = W * dpr;
    }
    const g = map.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = W / 2;
    const cy = W / 2;
    const px = (W / 2 - 14) / 12; // 12 miles to the edge
    g.fillStyle = '#0c1416';
    g.fillRect(0, 0, W, W);
    // grid
    g.strokeStyle = 'rgba(157,232,178,0.06)';
    g.lineWidth = 1;
    for (let i = -12; i <= 12; i += 2) {
      g.beginPath();
      g.moveTo(cx + i * px, 0);
      g.lineTo(cx + i * px, W);
      g.moveTo(0, cy + i * px);
      g.lineTo(W, cy + i * px);
      g.stroke();
    }
    // river and roads
    g.strokeStyle = 'rgba(80,140,170,0.55)';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(cx - 13 * px, cy + 3 * px);
    g.bezierCurveTo(cx - 6 * px, cy + 1 * px, cx - 3 * px, cy + 2.5 * px, cx + 0.6 * px, cy + 0.4 * px);
    g.bezierCurveTo(cx + 4 * px, cy - 1.6 * px, cx + 7 * px, cy + 3 * px, cx + 13 * px, cy + 1 * px);
    g.stroke();
    g.strokeStyle = 'rgba(216,223,201,0.14)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx - 13 * px, cy - 6 * px);
    g.lineTo(cx + 13 * px, cy + 9 * px);
    g.moveTo(cx + 2 * px, cy - 13 * px);
    g.lineTo(cx - 1 * px, cy + 13 * px);
    g.stroke();

    // evacuation zone
    const evac = r?.evacuationRadiusMi ?? 0;
    if (evac > 0) {
      g.save();
      g.beginPath();
      g.arc(cx, cy, evac * px, 0, Math.PI * 2);
      g.fillStyle = 'rgba(214,58,46,0.12)';
      g.fill();
      g.clip();
      g.strokeStyle = 'rgba(214,58,46,0.28)';
      g.lineWidth = 1;
      for (let i = -W; i < W; i += 9) {
        g.beginPath();
        g.moveTo(i, 0);
        g.lineTo(i + W, W);
        g.stroke();
      }
      g.restore();
      g.strokeStyle = 'rgba(214,58,46,0.9)';
      g.setLineDash([6, 4]);
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(cx, cy, evac * px, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }

    // plume
    const ci = totalCi(r);
    if (r && ci > 0.01) {
      const down = ((r.windFromDeg + 180) * Math.PI) / 180;
      const stab = { A: 0.5, B: 0.42, C: 0.34, D: 0.26, E: 0.19, F: 0.14 }[r.stabilityClass] ?? 0.26;
      const L = Math.max(0.6, Math.min(13, 1.6 * Math.log10(ci + 1) * (0.7 + Math.min(1.2, r.windSpeedMps / 6))));
      const bands: [number, number][] = [[1, 0.05]];
      if (r.siteBoundaryDoseRem >= 0.1) bands.push([0.7, 0.2]);
      if (r.siteBoundaryDoseRem >= 1) bands.push([0.45, 1.5]);
      if (r.siteBoundaryDoseRem >= 5) bands.push([0.25, 8]);
      g.save();
      g.translate(cx, cy);
      g.rotate(down);
      // screen: north is up; rotate so +y (down the screen) is... use -y as downwind after rotation
      for (const [f, rem] of bands) {
        const len = L * f * px;
        const wid = Math.max(4, len * stab);
        const pulse = 0.85 + 0.15 * Math.sin(time * 1.6 + f * 4);
        g.beginPath();
        g.ellipse(0, -len / 2, wid, len / 2, 0, 0, Math.PI * 2);
        g.fillStyle = doseColor(rem);
        g.globalAlpha = 0.28 * pulse + (f < 1 ? 0.1 : 0);
        g.fill();
      }
      // drifting puffs
      g.globalAlpha = 0.5;
      for (let i = 0; i < 6; i++) {
        const u = ((time * 0.08 + i / 6) % 1) * L * px;
        g.beginPath();
        g.arc(Math.sin(i * 2.3 + time) * u * stab * 0.4, -u, 2 + u * 0.04, 0, Math.PI * 2);
        g.fillStyle = '#fff3d0';
        g.fill();
      }
      g.restore();
      g.globalAlpha = 1;
    }

    // rings
    g.font = '600 11px "Barlow Condensed", sans-serif';
    g.textAlign = 'left';
    for (const mi of [2, 5, 10]) {
      g.strokeStyle = 'rgba(157,232,178,0.45)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx, cy, mi * px, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = 'rgba(157,232,178,0.8)';
      g.fillText(`${mi} mi`, cx + mi * px * 0.71 + 3, cy - mi * px * 0.71 - 2);
    }
    // towns
    g.font = '500 11px "Barlow Condensed", sans-serif';
    for (const t of TOWNS) {
      const x = cx + t.x * px;
      const y = cy + t.y * px;
      const inEvac = evac > 0 && Math.hypot(t.x, t.y) <= evac;
      g.fillStyle = inEvac ? '#ff8a72' : '#d8dfc9';
      g.fillRect(x - 2.5, y - 2.5, 5, 5);
      g.fillText(t.name.toUpperCase(), x + 5, y + 4);
    }
    // site
    g.fillStyle = '#f0b23a';
    g.beginPath();
    g.arc(cx, cy, 5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#0c1416';
    g.lineWidth = 2;
    g.stroke();
    g.font = '700 12px "Barlow Condensed", sans-serif';
    g.fillStyle = '#f0b23a';
    g.fillText('UNIT 2', cx + 8, cy - 6);

    // wind rose
    const wx = 34;
    const wy = 34;
    g.strokeStyle = 'rgba(216,223,201,0.5)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(wx, wy, 20, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(216,223,201,0.7)';
    g.textAlign = 'center';
    g.fillText('N', wx, wy - 24);
    if (r) {
      const a = ((r.windFromDeg + 180) * Math.PI) / 180;
      g.save();
      g.translate(wx, wy);
      g.rotate(a);
      g.strokeStyle = '#9de8b2';
      g.fillStyle = '#9de8b2';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, 16);
      g.lineTo(0, -12);
      g.stroke();
      g.beginPath();
      g.moveTo(0, -17);
      g.lineTo(-5, -9);
      g.lineTo(5, -9);
      g.closePath();
      g.fill();
      g.restore();
    }
    g.textAlign = 'left';
    // legend
    const lg: [string, string][] = [['> 5 rem', '#d63a2e'], ['1–5', '#f07a2a'], ['0.1–1', '#f0b23a'], ['< 0.1', '#c9d86a']];
    g.font = '500 11px "Barlow Condensed", sans-serif';
    lg.forEach(([t, col], i) => {
      const y = W - 14 - (lg.length - 1 - i) * 14;
      g.fillStyle = col;
      g.globalAlpha = 0.75;
      g.fillRect(W - 66, y - 8, 10, 10);
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(216,223,201,0.8)';
      g.fillText(t, W - 52, y + 1);
    });
    if (!r) {
      g.fillStyle = 'rgba(216,223,201,0.8)';
      g.font = '600 14px "Barlow Condensed", sans-serif';
      g.textAlign = 'center';
      g.fillText('RELEASE DATA UNAVAILABLE', cx, W - 20);
      g.textAlign = 'left';
    }
  }

  // ---------------- 2D exterior scene (fallback for the 3D outside view) ----------------
  interface Puff { x: number; y: number; r: number; vx: number; vy: number; a: number; c: string }
  const puffs: Puff[] = [];
  function drawScene(time: number, dt: number) {
    if (!fallback) return;
    const s = st();
    const kind: Kind = s?.catastrophe?.kind ?? 'meltdown';
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (scene.width !== Math.round(W * dpr) || scene.height !== Math.round(H * dpr)) {
      scene.width = Math.round(W * dpr);
      scene.height = Math.round(H * dpr);
    }
    const g = scene.getContext('2d')!;
    const since = (performance.now() - shownAt) / 1000;
    const shake = Math.max(0, 1 - since / 4) * 6;
    g.setTransform(dpr, 0, 0, dpr, (Math.random() - 0.5) * shake * dpr, (Math.random() - 0.5) * shake * dpr);
    // sky
    const sky = g.createLinearGradient(0, 0, 0, H * 0.7);
    sky.addColorStop(0, '#0d1420');
    sky.addColorStop(0.7, '#2a2f3a');
    sky.addColorStop(1, kind === 'turbine-missile' || kind === 'steam-explosion' ? '#5a3b2e' : '#4a3a36');
    g.fillStyle = sky;
    g.fillRect(-20, -20, W + 40, H + 40);
    const hy = H * 0.68; // horizon
    // far hills
    g.fillStyle = '#151b20';
    g.beginPath();
    g.moveTo(0, hy);
    for (let x = 0; x <= W; x += 40) g.lineTo(x, hy - 26 - 18 * Math.sin(x * 0.006) - 10 * Math.sin(x * 0.017 + 1));
    g.lineTo(W, hy);
    g.fill();
    // ground
    g.fillStyle = '#0e1214';
    g.fillRect(0, hy, W, H - hy);

    const u = Math.min(W, H * 1.6) / 1000; // scale unit
    const domeX = W * 0.42;
    const tgX = W * 0.62;
    const ctX = W * 0.16;
    // cooling tower
    g.fillStyle = '#2b3236';
    g.beginPath();
    const ctH = 280 * u;
    const ctW = 140 * u;
    g.moveTo(ctX - ctW / 2, hy);
    g.quadraticCurveTo(ctX - ctW * 0.22, hy - ctH * 0.6, ctX - ctW * 0.34, hy - ctH);
    g.lineTo(ctX + ctW * 0.34, hy - ctH);
    g.quadraticCurveTo(ctX + ctW * 0.22, hy - ctH * 0.6, ctX + ctW / 2, hy);
    g.fill();
    // turbine hall
    g.fillStyle = '#262c30';
    g.fillRect(tgX - 30 * u, hy - 120 * u, 300 * u, 120 * u);
    g.fillStyle = '#1d2226';
    g.fillRect(tgX - 30 * u, hy - 130 * u, 300 * u, 12 * u);
    if (kind === 'turbine-missile') {
      g.fillStyle = '#0a0c0d';
      g.beginPath();
      g.moveTo(tgX + 120 * u, hy - 128 * u);
      g.lineTo(tgX + 175 * u, hy - 118 * u);
      g.lineTo(tgX + 160 * u, hy - 70 * u);
      g.lineTo(tgX + 128 * u, hy - 84 * u);
      g.fill();
      // fire glow
      const fg = g.createRadialGradient(tgX + 148 * u, hy - 92 * u, 2, tgX + 148 * u, hy - 92 * u, 70 * u);
      fg.addColorStop(0, `rgba(255,170,60,${0.6 + 0.3 * Math.sin(time * 9)})`);
      fg.addColorStop(1, 'rgba(255,90,20,0)');
      g.fillStyle = fg;
      g.fillRect(tgX + 60 * u, hy - 170 * u, 180 * u, 160 * u);
    }
    // windows
    g.fillStyle = 'rgba(240,210,140,0.55)';
    for (let i = 0; i < 9; i++) if ((i * 7) % 3 !== 0 || kind !== 'turbine-missile') g.fillRect(tgX - 10 * u + i * 30 * u, hy - 60 * u, 12 * u, 6 * u);
    // containment
    const cw = 190 * u;
    const ch = 170 * u;
    g.fillStyle = '#3a4246';
    g.fillRect(domeX - cw / 2, hy - ch, cw, ch);
    g.beginPath();
    g.ellipse(domeX, hy - ch, cw / 2, cw * 0.36, 0, Math.PI, 0);
    g.fill();
    // shading
    const sh = g.createLinearGradient(domeX - cw / 2, 0, domeX + cw / 2, 0);
    sh.addColorStop(0, 'rgba(0,0,0,0.35)');
    sh.addColorStop(0.45, 'rgba(255,255,255,0.05)');
    sh.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = sh;
    g.fillRect(domeX - cw / 2, hy - ch - cw * 0.36, cw, ch + cw * 0.36);
    if (kind === 'containment-failure' || kind === 'vessel-rupture' || kind === 'steam-explosion') {
      g.strokeStyle = '#101416';
      g.lineWidth = 3 * u;
      g.beginPath();
      g.moveTo(domeX - 10 * u, hy - ch - cw * 0.34);
      g.lineTo(domeX + 6 * u, hy - ch - 30 * u);
      g.lineTo(domeX - 14 * u, hy - ch + 10 * u);
      g.lineTo(domeX + 10 * u, hy - ch + 60 * u);
      g.stroke();
    }
    // aircraft warning lights
    const blink = Math.sin(time * 3) > 0.2;
    g.fillStyle = blink ? '#ff3a2a' : '#4a1410';
    g.beginPath();
    g.arc(domeX, hy - ch - cw * 0.36 - 3 * u, 3 * u + 1, 0, Math.PI * 2);
    g.arc(ctX, hy - ctH - 3 * u, 3 * u + 1, 0, Math.PI * 2);
    g.fill();
    // fence posts in the foreground
    g.strokeStyle = 'rgba(120,130,130,0.35)';
    g.lineWidth = 1;
    for (let x = -20; x < W + 20; x += 46) {
      g.beginPath();
      g.moveTo(x, H * 0.9);
      g.lineTo(x + 6, H * 0.74);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(0, H * 0.78);
    g.lineTo(W, H * 0.76);
    g.moveTo(0, H * 0.84);
    g.lineTo(W, H * 0.82);
    g.stroke();

    // emit puffs: plume from the plant, colour by kind; cooling tower steam always
    const r = s?.release;
    const wind = r ? Math.sin(((r.windFromDeg + 180) * Math.PI) / 180) : 0.6;
    const smoky = kind === 'meltdown' || kind === 'containment-failure' || kind === 'turbine-missile';
    const srcX = kind === 'turbine-missile' ? tgX + 148 * u : domeX;
    const srcY = kind === 'turbine-missile' ? hy - 110 * u : hy - ch - cw * 0.2;
    const rate = kind === 'steam-explosion' ? 26 : 14;
    const n = Math.min(6, Math.floor(dt * rate + Math.random()));
    for (let i = 0; i < n; i++) {
      puffs.push({ x: srcX + (Math.random() - 0.5) * 30 * u, y: srcY, r: 10 * u + Math.random() * 14 * u, vx: (wind * 26 + (Math.random() - 0.5) * 12) * u, vy: -(30 + Math.random() * 30) * u, a: 0.55, c: smoky ? (Math.random() < 0.5 ? '#3b3632' : '#55504a') : '#cfd2d4' });
    }
    if (Math.random() < dt * 4) puffs.push({ x: ctX, y: hy - ctH, r: 18 * u, vx: wind * 14 * u, vy: -16 * u, a: 0.3, c: '#9aa0a4' });
    while (puffs.length > 220) puffs.shift();
    for (const p of puffs) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy *= 1 - 0.15 * dt;
      p.r += 9 * u * dt;
      p.a -= 0.035 * dt;
    }
    for (let i = puffs.length - 1; i >= 0; i--) if (puffs[i].a <= 0) puffs.splice(i, 1);
    for (const p of puffs) {
      g.globalAlpha = Math.max(0, p.a);
      g.fillStyle = p.c;
      g.beginPath();
      g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    if (smoky && kind !== 'turbine-missile') {
      const gl = g.createRadialGradient(srcX, srcY + 20 * u, 2, srcX, srcY + 20 * u, 120 * u);
      gl.addColorStop(0, `rgba(255,140,60,${0.22 + 0.08 * Math.sin(time * 5)})`);
      gl.addColorStop(1, 'rgba(255,100,40,0)');
      g.fillStyle = gl;
      g.fillRect(srcX - 130 * u, srcY - 110 * u, 260 * u, 260 * u);
    }
    // flash in the first moments
    if (since < 1.2) {
      g.fillStyle = `rgba(255,245,225,${(1 - since / 1.2) * 0.8})`;
      g.fillRect(-20, -20, W + 40, H + 40);
    }
  }

  function setActive(v: boolean) {
    on = v;
    root.classList.toggle('view-outside', v);
  }

  return {
    start() {
      if (on) return;
      setActive(true);
      el.hidden = false;
      el.classList.remove('is-hidden');
      R('news').hidden = true;
      shownAt = performance.now();
      newsAt = shownAt + 2600;
      puffs.length = 0;
      fallback = false;
      try {
        bus.emit('view-mode', 'outside');
      } catch (err) {
        // the world could not build its exterior: draw ours instead, keep the game loop alive
        console.error('exterior view failed, using the 2D fallback', err);
        fallback = true;
      }
      scene.hidden = !fallback;
      el.classList.toggle('is-fallback', fallback);
      refreshNums();
      drawMap(0);
    },
    hide() {
      el.classList.add('is-hidden');
    },
    show() {
      el.classList.remove('is-hidden');
    },
    reset() {
      if (on)
        try {
          bus.emit('view-mode', 'control-room');
        } catch (err) {
          console.error(err);
        }
      setActive(false);
      el.hidden = true;
      R('news').hidden = true;
      puffs.length = 0;
      newsAt = 0;
    },
    active: () => on,
    update(dt) {
      if (!on || el.classList.contains('is-hidden')) return;
      const now = performance.now();
      const time = now / 1000;
      if (newsAt && now >= newsAt) {
        newsAt = 0;
        buildTicker();
        R('news').hidden = false;
        voice.sting();
      }
      sceneAcc += dt;
      if (sceneAcc >= 1 / 30) {
        drawScene(time, sceneAcc);
        sceneAcc = 0;
      }
      mapAcc += dt;
      if (mapAcc >= 0.25) {
        mapAcc = 0;
        drawMap(time);
        refreshNums();
        const s = st();
        R('time').textContent = s ? `${s.grid ? hhmm(s.grid.hourOfDay) + ' · ' : ''}T+ ${hooks.clock(s.t)}${(sim.controls?.timeScale ?? 1) > 1 ? ` · ×${sim.controls.timeScale}` : ''}` : '';
      }
    },
  };
}
