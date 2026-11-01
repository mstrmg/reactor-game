// Builds the mock PWR control room. Geometry is identical across styles;
// the style supplies materials (style.mat / style.face) and palette colours.
import * as THREE from 'three';
import * as TX from './textures.js';

const D2R = Math.PI / 180;

export function buildRoom(style) {
  const scene = new THREE.Scene();
  const p = style.palette;
  const seg = style.seg ?? 24;
  const matCache = new Map();
  const M = (role) => {
    if (!matCache.has(role)) matCache.set(role, style.mat(role, style.colors[role] ?? style.colors.panel));
    return matCache.get(role);
  };
  const F = (map, emissive, kind) => style.face(map, emissive, kind);

  const add = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const box = (parent, w, h, d, role, x, y, z, rx, ry, rz) =>
    add(parent, new THREE.BoxGeometry(w, h, d), typeof role === 'string' ? M(role) : role, x, y, z, rx, ry, rz);
  const plane = (parent, w, h, mat, x, y, z, rx, ry, rz) => {
    const m = add(parent, new THREE.PlaneGeometry(w, h), mat, x, y, z, rx, ry, rz);
    m.castShadow = false;
    return m;
  };
  const cyl = (parent, rt, rb, h, role, x, y, z, rx = 0, ry = 0, rz = 0, s = seg) =>
    add(parent, new THREE.CylinderGeometry(rt, rb, h, s), typeof role === 'string' ? M(role) : role, x, y, z, rx, ry, rz);

  // ---------- room shell ----------
  const room = new THREE.Group(); scene.add(room);
  const floor = plane(room, 18, 18, M('floor'), 0, 0, 0, -Math.PI / 2); floor.name = 'floor';
  plane(room, 18, 18, M('ceiling'), 0, 3.3, 0, Math.PI / 2);
  plane(room, 18, 3.3, M('wall'), 0, 1.65, -3.2);
  plane(room, 18, 3.3, M('wall'), -6.5, 1.65, 0, 0, Math.PI / 2);
  plane(room, 18, 3.3, M('wall'), 6.5, 1.65, 0, 0, -Math.PI / 2);
  plane(room, 18, 3.3, M('wall'), 0, 1.65, 6, 0, Math.PI);
  // skirting
  box(room, 18, 0.12, 0.03, 'trim', 0, 0.06, -3.185);
  // ceiling troffers
  for (let x = -4.8; x <= 4.8; x += 1.6) for (let z = -2.4; z <= 4; z += 1.6) {
    box(room, 1.2, 0.03, 0.6, 'troffer', x, 3.285, z);
  }
  // wall sign + clock above the board
  plane(room, 1.8, 0.24, F(TX.labelPlate(p, style.signText || 'UNIT 1 · MAIN CONTROL ROOM'), null, 'plate'), 0, 2.95, -3.18);
  box(room, 0.34, 0.34, 0.05, 'bezel', 2.0, 2.95, -3.17);
  plane(room, 0.3, 0.3, F(TX.dial(p, 'TIME', 'UTC', 0, 12, 4.2), null, 'dial'), 2.0, 2.95, -3.14);

  // back wall cabinets (relay racks) visible above/behind the board
  for (let i = 0; i < 7; i++) {
    const x = -4.2 + i * 1.4;
    box(room, 1.2, 2.2, 0.6, 'cabinet', x, 1.1, -2.88);
    box(room, 1.1, 0.04, 0.02, 'trim', x, 2.0, -2.575);
    for (let k = 0; k < 3; k++) cyl(room, 0.012, 0.012, 0.01, k === 0 ? 'lampGreenOn' : 'lampOff', x - 0.45 + k * 0.05, 2.12, -2.575, Math.PI / 2, 0, 0, 8);
  }

  // ---------- the control board ----------
  const SLOPE_DEPTH = 0.75, SLOPE_RISE = 0.25, BASE_H = 0.8, VP_H = 1.5;
  const alpha = Math.atan2(SLOPE_DEPTH, SLOPE_RISE);
  const L = Math.hypot(SLOPE_DEPTH, SLOPE_RISE);

  function switchJ(parent, x, v, litGreen) {
    const y = v * L;
    cyl(parent, 0.028, 0.032, 0.02, 'bezel', x, y, 0.01, Math.PI / 2, 0, 0, Math.min(seg, 16));
    box(parent, 0.016, 0.075, 0.022, 'handle', x, y + 0.012, 0.032, 0, 0, litGreen ? 0.5 : -0.5);
    // indicating lamps above the switch
    cyl(parent, 0.011, 0.011, 0.015, litGreen ? 'lampOff' : 'lampRedOn', x - 0.022, y + 0.07, 0.008, Math.PI / 2, 0, 0, 10);
    cyl(parent, 0.011, 0.011, 0.015, litGreen ? 'lampGreenOn' : 'lampOff', x + 0.022, y + 0.07, 0.008, Math.PI / 2, 0, 0, 10);
    // tag
    box(parent, 0.07, 0.022, 0.004, 'tag', x, y - 0.05, 0.002);
  }
  function pushbutton(parent, x, v, role) {
    const y = v * L;
    box(parent, 0.05, 0.05, 0.012, 'bezel', x, y, 0.006);
    box(parent, 0.036, 0.036, 0.02, role, x, y, 0.014);
  }
  function knob(parent, x, v) {
    const y = v * L;
    cyl(parent, 0.022, 0.026, 0.03, 'knob', x, y, 0.015, Math.PI / 2, 0, 0, Math.min(seg, 16));
    box(parent, 0.004, 0.02, 0.004, 'tag', x, y + 0.012, 0.031);
  }

  function section(x0, w, kind, seed) {
    const g = new THREE.Group();
    const cx = x0 + w / 2;
    // base cabinet and toe kick
    box(g, w, BASE_H - 0.08, 0.82, 'panel', cx, 0.08 + (BASE_H - 0.08) / 2, -0.43);
    box(g, w, 0.08, 0.76, 'kick', cx, 0.04, -0.46);
    // wedge under the slope
    const sh = new THREE.Shape();
    sh.moveTo(0, 0); sh.lineTo(SLOPE_DEPTH + 0.02, 0); sh.lineTo(SLOPE_DEPTH + 0.02, SLOPE_RISE); sh.closePath();
    const wedge = new THREE.ExtrudeGeometry(sh, { depth: w, bevelEnabled: false });
    wedge.rotateY(Math.PI / 2); wedge.translate(x0, BASE_H, 0);
    add(g, wedge, M('panel'), 0, 0, 0);
    // front lip
    box(g, w, 0.035, 0.07, 'trim', cx, BASE_H, -0.01);

    // sloped benchboard
    const slope = new THREE.Group();
    slope.position.set(0, BASE_H + 0.005, 0);
    slope.rotation.x = -alpha;
    g.add(slope);
    box(slope, w, L, 0.03, 'panelTop', cx, L / 2, -0.015);

    // vertical board
    const vp = new THREE.Group();
    vp.position.set(0, BASE_H + SLOPE_RISE, -SLOPE_DEPTH);
    g.add(vp);
    box(vp, w, VP_H, 0.4, 'panel', cx, VP_H / 2, -0.2);
    // hood
    box(g, w, 0.14, 0.75, 'hood', cx, BASE_H + SLOPE_RISE + VP_H + 0.07, -SLOPE_DEPTH - 0.1);
    box(g, w - 0.02, 0.01, 0.5, 'troffer', cx, BASE_H + SLOPE_RISE + VP_H - 0.005, -SLOPE_DEPTH + 0.05);

    // section dividers
    box(g, 0.03, VP_H + 0.14, 0.42, 'trim', x0 + 0.015, BASE_H + SLOPE_RISE + (VP_H + 0.14) / 2, -SLOPE_DEPTH - 0.19);

    const modern = style.variant === 'modern';

    // annunciators
    const cols = Math.round((w - 0.1) / 0.16);
    const annW = cols * 0.16, annH = 4 * 0.085;
    if (!modern) {
      const ann = TX.annunciator(p, cols, 4, seed);
      box(vp, annW + 0.04, annH + 0.04, 0.05, 'bezel', cx, VP_H - 0.06 - annH / 2, 0.02);
      const a = plane(vp, annW, annH, F(ann.map, ann.emissive, 'ann'), cx, VP_H - 0.06 - annH / 2, 0.047);
      a.name = 'annunciator';
    } else {
      const sw = w - 0.12;
      box(vp, sw + 0.03, 0.36, 0.04, 'bezel', cx, VP_H - 0.25, 0.02);
      plane(vp, sw, 0.33, F(TX.screen(p, 'overview', seed), null, 'screen'), cx, VP_H - 0.25, 0.041);
    }
    const plateTxt = { center: 'REACTOR CONTROL', left: 'REACTOR COOLANT SYSTEM', right: 'FEEDWATER · STEAM · TURBINE' }[kind];
    plane(vp, Math.min(1.6, w - 0.2), 0.065, F(TX.labelPlate(p, plateTxt), null, 'plate'), cx, VP_H - 0.47, 0.003);

    if (modern) {
      // big flat displays instead of discrete instruments
      const n = kind === 'center' ? 2 : 2;
      const sw = (w - 0.16) / n - 0.04;
      for (let i = 0; i < n; i++) {
        const x = x0 + 0.1 + sw / 2 + i * (sw + 0.04);
        box(vp, sw + 0.03, 0.6, 0.04, 'bezel', x, 0.62, 0.02);
        const kinds = ['trend', 'table', 'overview'];
        plane(vp, sw, 0.57, F(TX.screen(p, kinds[(i + seed) % 3], seed + i), null, 'screen'), x, 0.62, 0.041);
      }
      // slim touch strip on the slope
      for (let i = 0; i < 3; i++) {
        const sw2 = (w - 0.3) / 3;
        const x = x0 + 0.15 + sw2 / 2 + i * sw2;
        box(slope, sw2 - 0.06, 0.36, 0.015, 'bezel', x, L * 0.55, 0.008);
        plane(slope, sw2 - 0.08, 0.33, F(TX.screen(p, ['table', 'trend', 'overview'][(i + seed + 1) % 3], seed * 3 + i), null, 'screen'), x, L * 0.55, 0.0165);
      }
      if (kind === 'center') {
        cyl(slope, 0.05, 0.05, 0.03, 'yellow', cx, L * 0.15, 0.015, Math.PI / 2, 0, 0);
        const b = add(slope, new THREE.SphereGeometry(0.04, seg, Math.max(6, seg / 2), 0, Math.PI * 2, 0, Math.PI / 2), M('red'), cx, L * 0.15, 0.03, Math.PI / 2, 0, 0);
        b.name = 'scram';
      }
      return g;
    }

    if (kind === 'center') {
      // rod position map in the middle
      box(vp, 0.62, 0.62, 0.05, 'bezel', cx, 0.6, 0.02);
      plane(vp, 0.58, 0.58, F(TX.rodMap(p), TX.rodMap({ ...p, mimicBg: '#000', mimicLine: '#000', mimicCold: p.mimicColdGlow || p.mimicCold, mimicHot: p.mimicHot, mimicDim: '#000', mimicText: '#000' }), 'mimic'), cx, 0.6, 0.047);
      // dials either side
      const labels = [['NEUTRON FLUX', '% PWR', 0, 120, 98], ['STARTUP RATE', 'DPM', -1, 5, 0.1], ['TAVG', '°F', 500, 620, 584], ['ROD BANK D', 'STEPS', 0, 230, 218]];
      labels.forEach((l, i) => {
        const side = i < 2 ? -1 : 1;
        const x = cx + side * (0.52 + (i % 2) * 0.25);
        box(vp, 0.22, 0.22, 0.06, 'bezel', x, 0.75, 0.03);
        plane(vp, 0.2, 0.2, F(TX.dial(p, ...l), null, 'dial'), x, 0.75, 0.061);
      });
      for (let i = 0; i < 8; i++) {
        const side = i < 4 ? -1 : 1;
        const x = cx + side * (0.42 + (i % 4) * 0.095);
        box(vp, 0.07, 0.26, 0.06, 'bezel', x, 0.36, 0.03);
        plane(vp, 0.06, 0.24, F(TX.edgewise(p, ['PR N41', 'PR N42', 'PR N43', 'PR N44', 'IR N35', 'IR N36', 'SR N31', 'SR N32'][i], 0.75 + 0.05 * Math.sin(i * 3)), null, 'dial'), x, 0.36, 0.061);
      }
      // outboard recorders + meter clusters
      for (const side of [-1, 1]) {
        const xr = cx + side * 1.38;
        box(vp, 0.3, 0.26, 0.12, 'bezel', xr, 0.74, 0.06);
        plane(vp, 0.25, 0.19, F(TX.stripChart(p, 30 + side), null, 'chart'), xr, 0.75, 0.122);
        plane(vp, 0.26, 0.2, M('glass'), xr, 0.75, 0.126);
        for (let i = 0; i < 4; i++) {
          const x = xr - 0.13 + i * 0.085;
          box(vp, 0.075, 0.27, 0.06, 'bezel', x, 0.32, 0.03);
          plane(vp, 0.065, 0.25, F(TX.edgewise(p, ['BORON', 'RCS F', 'ΔT', 'ΔI', 'SG A L', 'SG B L', 'FW A', 'FW B'][(side + 1) * 2 + i], 0.3 + 0.5 * Math.abs(Math.cos(i * 2 + side))), null, 'dial'), x, 0.32, 0.061);
        }
      }
      // slope: rod control + scram
      for (let i = 0; i < 6; i++) switchJ(slope, x0 + 0.35 + i * 0.16, 0.62, i % 3 !== 1);
      for (let i = 0; i < 4; i++) switchJ(slope, x0 + w - 0.85 + i * 0.16, 0.62, i % 2 === 0);
      for (let i = 0; i < 5; i++) pushbutton(slope, x0 + 0.4 + i * 0.09, 0.3, ['white', 'amber', 'white', 'green', 'white'][i]);
      for (let i = 0; i < 4; i++) knob(slope, x0 + w - 0.75 + i * 0.12, 0.3);
      // the big red one
      box(slope, 0.2, 0.2, 0.012, 'yellow', cx, L * 0.32, 0.006);
      cyl(slope, 0.055, 0.055, 0.04, 'bezel', cx, L * 0.32, 0.02, Math.PI / 2, 0, 0);
      const scram = add(slope, new THREE.SphereGeometry(0.048, seg, Math.max(6, seg / 2), 0, Math.PI * 2, 0, Math.PI / 2), M('red'), cx, L * 0.32, 0.04, Math.PI / 2, 0, 0);
      scram.name = 'scram';
      plane(slope, 0.24, 0.04, F(TX.labelPlate({ ...p, plateBg: p.scramPlateBg || '#c01818', plateText: '#fff' }, 'REACTOR TRIP'), null, 'plate'), cx, L * 0.32 - 0.14, 0.004);
    } else if (kind === 'left') {
      // edgewise meter clusters
      for (let gi = 0; gi < 3; gi++) for (let i = 0; i < 4; i++) {
        const x = x0 + 0.3 + gi * 0.45 + i * 0.085;
        box(vp, 0.075, 0.27, 0.06, 'bezel', x, 0.72, 0.03);
        plane(vp, 0.065, 0.25, F(TX.edgewise(p, ['PZR P', 'PZR L', 'TH A', 'TC A', 'TH B', 'TC B', 'FLOW A', 'FLOW B', 'VCT L', 'CHG F', 'LTDN F', 'SEAL F'][gi * 4 + i], 0.4 + 0.4 * Math.abs(Math.sin(gi * 4 + i))), null, 'dial'), x, 0.72, 0.061);
      }
      // strip chart recorders
      for (let i = 0; i < 3; i++) {
        const x = x0 + 0.42 + i * 0.45;
        box(vp, 0.3, 0.26, 0.12, 'bezel', x, 0.3, 0.06);
        plane(vp, 0.25, 0.19, F(TX.stripChart(p, 10 + i), null, 'chart'), x, 0.31, 0.122);
        plane(vp, 0.26, 0.2, M('glass'), x, 0.31, 0.126);
      }
      // pressurizer heater / spray switches
      for (let i = 0; i < 7; i++) switchJ(slope, x0 + 0.3 + i * 0.17, 0.6, i % 4 !== 2);
      for (let i = 0; i < 6; i++) switchJ(slope, x0 + 0.38 + i * 0.17, 0.25, i % 3 === 0);
    } else if (kind === 'right') {
      // mimic + dials
      box(vp, 0.95, 0.5, 0.04, 'bezel', x0 + 0.85, 0.7, 0.02);
      plane(vp, 0.9, 0.45, F(TX.mimic(p), null, 'mimic'), x0 + 0.85, 0.7, 0.041);
      const dl = [['SG A PRESS', 'PSIG', 0, 1200, 1005], ['SG B PRESS', 'PSIG', 0, 1200, 998], ['MAIN GEN', 'MWe', 0, 1300, 1121], ['COND VAC', 'IN HG', 0, 30, 27.5]];
      dl.forEach((l, i) => {
        const x = x0 + 1.55 + (i % 2) * 0.25, y = 0.84 - Math.floor(i / 2) * 0.26;
        box(vp, 0.22, 0.22, 0.06, 'bezel', x, y, 0.03);
        plane(vp, 0.2, 0.2, F(TX.dial(p, ...l), null, 'dial'), x, y, 0.061);
      });
      for (let i = 0; i < 2; i++) {
        const x = x0 + 0.55 + i * 0.6;
        box(vp, 0.3, 0.26, 0.12, 'bezel', x, 0.25, 0.06);
        plane(vp, 0.25, 0.19, F(TX.stripChart(p, 20 + i), null, 'chart'), x, 0.26, 0.122);
        plane(vp, 0.26, 0.2, M('glass'), x, 0.26, 0.126);
      }
      for (let i = 0; i < 7; i++) switchJ(slope, x0 + 0.3 + i * 0.17, 0.6, i % 2 === 0);
      for (let i = 0; i < 6; i++) pushbutton(slope, x0 + 0.35 + i * 0.1, 0.25, i % 2 ? 'green' : 'red');
      for (let i = 0; i < 4; i++) knob(slope, x0 + 1.1 + i * 0.12, 0.25);
    }
    return g;
  }

  const CW = 3.6, SW = 3.0, ANG = 35 * D2R, BZ = -1.6;
  const center = section(-CW / 2, CW, 'center', 1); center.position.z = BZ; scene.add(center);
  const right = section(0, SW, 'right', 2); right.position.set(CW / 2, 0, BZ); right.rotation.y = -ANG; scene.add(right);
  const left = section(-SW, SW, 'left', 3); left.position.set(-CW / 2, 0, BZ); left.rotation.y = ANG; scene.add(left);

  // ---------- operator desk (foreground) ----------
  const desk = new THREE.Group(); desk.position.set(-1.05, 0, -0.25); desk.rotation.y = 12 * D2R; scene.add(desk);
  box(desk, 1.3, 0.04, 0.7, 'deskTop', 0, 0.74, 0);
  box(desk, 0.4, 0.72, 0.62, 'desk', -0.42, 0.36, 0);
  box(desk, 0.04, 0.72, 0.6, 'desk', 0.6, 0.36, 0);
  box(desk, 1.2, 0.3, 0.02, 'desk', 0.1, 0.55, -0.3);
  if (style.variant === 'modern') {
    box(desk, 0.62, 0.36, 0.025, 'bezel', 0.05, 1.0, -0.15, -0.08);
    plane(desk, 0.59, 0.33, F(TX.screen(p, 'table', 7), null, 'screen'), 0.05, 1.0, -0.136, -0.08);
    cyl(desk, 0.02, 0.03, 0.2, 'bezel', 0.05, 0.84, -0.18, 0, 0, 0, 10);
  } else {
    box(desk, 0.46, 0.4, 0.42, 'crt', 0.05, 0.96, -0.12);
    box(desk, 0.5, 0.03, 0.44, 'crt', 0.05, 0.775, -0.12);
    plane(desk, 0.38, 0.29, F(TX.screen(p, 'trend', 7), null, 'screen'), 0.05, 0.97, 0.092);
  }
  box(desk, 0.45, 0.025, 0.15, 'keyboard', 0.05, 0.765, 0.2, 0.08);
  box(desk, 0.24, 0.03, 0.3, 'binder', -0.42, 0.775, 0.1, 0, 0.3);
  box(desk, 0.18, 0.06, 0.2, 'phone', 0.48, 0.79, 0.08);
  cyl(desk, 0.04, 0.035, 0.1, 'mug', 0.42, 0.81, 0.24);

  // ---------- chair ----------
  const chair = new THREE.Group(); chair.position.set(1.45, 0, -0.35); chair.rotation.y = -40 * D2R; scene.add(chair);
  box(chair, 0.5, 0.08, 0.5, 'chair', 0, 0.5, 0);
  box(chair, 0.48, 0.55, 0.07, 'chair', 0, 0.85, 0.24, 0.12);
  cyl(chair, 0.03, 0.03, 0.42, 'metal', 0, 0.26, 0);
  for (let i = 0; i < 5; i++) box(chair, 0.04, 0.04, 0.32, 'metal', Math.sin(i * 1.256) * 0.14, 0.06, Math.cos(i * 1.256) * 0.14, 0, i * 1.256);

  const camera = new THREE.PerspectiveCamera(style.fov || 62, 16 / 9, 0.05, 50);
  camera.position.set(0.15, 1.62, 1.75);
  camera.lookAt(0, 1.33, -1.2);
  if (style.cameraTweak) style.cameraTweak(camera);

  return { scene, camera };
}
