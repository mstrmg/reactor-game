// Art style definitions. Each style supplies materials, palette, lighting and post-processing.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { canvasTex, noiseTex, rng } from './textures.js';

const EMISSIVE = new Set(['lampRedOn', 'lampGreenOn', 'troffer']);
const LAMP_COL = { lampRedOn: '#ff3020', lampGreenOn: '#30ff60' };

// ---------- shared shaders ----------
const COMMON = /* glsl */`
  varying vec2 vUv;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float bayer2(vec2 a){ a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  #define bayer4(a) (bayer2(0.5*(a))*0.25 + bayer2(a))
  #define bayer8(a) (bayer4(0.5*(a))*0.25 + bayer2(a))
`;
const VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export const GradeShader = (o = {}) => ({
  uniforms: {
    tDiffuse: { value: null }, res: { value: new THREE.Vector2(1600, 900) },
    vig: { value: o.vig ?? 0.35 }, grain: { value: o.grain ?? 0.03 }, sat: { value: o.sat ?? 1 },
    contrast: { value: o.contrast ?? 1 }, ab: { value: o.ab ?? 0 },
    tint: { value: new THREE.Color(o.tint ?? '#ffffff') }, lift: { value: new THREE.Color(o.lift ?? '#000000') },
  },
  vertexShader: VERT,
  fragmentShader: COMMON + /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 res; uniform float vig, grain, sat, contrast, ab; uniform vec3 tint, lift;
    void main(){
      vec2 uv = vUv; vec2 d = uv - 0.5; vec3 c;
      if (ab > 0.0) { c.r = texture2D(tDiffuse, uv + d * ab).r; c.g = texture2D(tDiffuse, uv).g; c.b = texture2D(tDiffuse, uv - d * ab).b; }
      else c = texture2D(tDiffuse, uv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114)); c = mix(vec3(l), c, sat);
      c = (c - 0.5) * contrast + 0.5; c = c * tint + lift;
      c *= 1.0 - vig * dot(d, d) * 2.5;
      c += (hash(uv * res) - 0.5) * grain;
      gl_FragColor = vec4(c, 1.0);
    }`,
});

export const GlowShader = {
  uniforms: { tDiffuse: { value: null }, res: { value: new THREE.Vector2(1600, 900) }, strength: { value: 0.5 }, radius: { value: 20 }, threshold: { value: 1 } },
  vertexShader: VERT,
  fragmentShader: COMMON + /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 res; uniform float strength, radius, threshold;
    void main(){
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      vec3 acc = vec3(0.0); float ws = 0.0;
      for (int i = 0; i < 64; i++) {
        float a = float(i) * 2.39996; float r = sqrt((float(i) + 0.5) / 64.0) * radius;
        vec3 s = texture2D(tDiffuse, vUv + vec2(cos(a), sin(a)) * r / res).rgb;
        float w = exp(-r * r / (0.5 * radius * radius));
        acc += max(s - threshold, 0.0) * w; ws += w;
      }
      gl_FragColor = vec4(base + acc / ws * strength * 4.0, 1.0);
    }`,
};

const CRTShader = {
  uniforms: { tDiffuse: { value: null }, res: { value: new THREE.Vector2(1600, 900) } },
  vertexShader: VERT,
  fragmentShader: COMMON + /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 res;
    vec2 curve(vec2 uv){ uv = uv * 2.0 - 1.0; vec2 o = abs(uv.yx) / vec2(5.0, 4.0); uv = uv + uv * o * o; return uv * 0.5 + 0.5; }
    void main(){
      vec2 uv = curve(vUv);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      vec3 c = texture2D(tDiffuse, uv).rgb;
      c += texture2D(tDiffuse, uv + vec2(0.0015, 0.0)).rgb * 0.25;
      float s = sin(uv.y * res.y * 1.0472) * 0.5 + 0.5;
      c *= mix(1.0, s, 0.45);
      float m = mod(gl_FragCoord.x, 3.0);
      c *= m < 1.0 ? vec3(1.0, 0.85, 0.85) : m < 2.0 ? vec3(0.85, 1.0, 0.85) : vec3(0.85, 0.85, 1.0);
      vec2 d = uv - 0.5; c *= 1.0 - dot(d, d) * 1.6;
      c += (hash(uv * res) - 0.5) * 0.04;
      gl_FragColor = vec4(c * 1.15, 1.0);
    }`,
};

const PS1Shader = {
  uniforms: { tDiffuse: { value: null }, levels: { value: 24 } },
  vertexShader: VERT,
  fragmentShader: COMMON + /* glsl */`
    uniform sampler2D tDiffuse; uniform float levels;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float t = bayer4(gl_FragCoord.xy) - 0.5;
      c = floor(c * levels + t + 0.5) / levels;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

const DitherShader = (dark, light) => ({
  uniforms: { tDiffuse: { value: null }, dark: { value: new THREE.Color(dark) }, light: { value: new THREE.Color(light) } },
  vertexShader: VERT,
  fragmentShader: COMMON + /* glsl */`
    uniform sampler2D tDiffuse; uniform vec3 dark, light;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      l = clamp((l - 0.06) * 1.25, 0.0, 1.0);
      float t = bayer8(gl_FragCoord.xy);
      gl_FragColor = vec4(l > t ? light : dark, 1.0);
    }`,
});

const TiltShiftShader = {
  uniforms: { tDiffuse: { value: null }, res: { value: new THREE.Vector2(1600, 900) }, focus: { value: 0.52 } },
  vertexShader: VERT,
  fragmentShader: COMMON + /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 res; uniform float focus;
    void main(){
      float f = smoothstep(0.1, 0.5, abs(vUv.y - focus)) * 7.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 32; i++) {
        float a = float(i) * 2.39996; float r = sqrt(float(i) / 32.0) * f;
        acc += texture2D(tDiffuse, vUv + vec2(cos(a), sin(a)) * r / res).rgb;
      }
      acc /= 32.0;
      float l = dot(acc, vec3(0.299, 0.587, 0.114));
      acc = mix(vec3(l), acc, 1.18);
      gl_FragColor = vec4(acc, 1.0);
    }`,
};

// ---------- helpers ----------
function concreteTex(seed) {
  return canvasTex(512, 512, (g) => {
    g.fillStyle = '#9d9b96'; g.fillRect(0, 0, 512, 512);
    const r = rng(seed);
    for (let i = 0; i < 300; i++) { g.fillStyle = r() < 0.5 ? '#7d7b76' : '#b2b0aa'; g.globalAlpha = 0.07; g.beginPath(); g.arc(r() * 512, r() * 512, 8 + r() * 50, 0, Math.PI * 2); g.fill(); }
    g.globalAlpha = 1;
    // board marks
    for (let y = 0; y < 512; y += 48) {
      g.fillStyle = 'rgba(40,40,40,0.35)'; g.fillRect(0, y, 512, 2);
      for (let k = 0; k < 30; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '60,60,60' : '200,200,200'},0.12)`; g.fillRect(r() * 512, y + r() * 48, 30 + r() * 150, 1); }
    }
    for (let i = 0; i < 8000; i++) { g.fillStyle = r() < 0.5 ? 'rgba(50,50,50,0.4)' : 'rgba(220,220,220,0.3)'; g.fillRect(r() * 512, r() * 512, 1 + r() * 2, 1 + r() * 2); }
  });
}
function tileTex(c1, c2, n = 4, speck = null, size = 512, grout = null) {
  const t = canvasTex(size, size, (g) => {
    const s = size / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? c1 : c2; g.fillRect(x * s, y * s, s, s);
    }
    if (speck) {
      const r = rng(5);
      for (let i = 0; i < 6000; i++) { g.fillStyle = speck[Math.floor(r() * speck.length)]; g.globalAlpha = 0.35; g.fillRect(r() * size, r() * size, 2, 2); }
      g.globalAlpha = 1;
    }
    if (grout) { g.strokeStyle = grout; g.lineWidth = 2; for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, size); g.stroke(); g.beginPath(); g.moveTo(0, i * s); g.lineTo(size, i * s); g.stroke(); } }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(9, 9);
  return t;
}
function rep(t, x, y) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(x, y); return t; }

function stdMat(role, c, o = {}) {
  if (EMISSIVE.has(role)) {
    const col = o.lampColors?.[role] ?? LAMP_COL[role] ?? c;
    return new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: role === 'troffer' ? (o.trofferGlow ?? 1.0) : (o.glow ?? 3) });
  }
  if (role === 'glass') return new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0.1, depthWrite: false });
  const metal = role === 'metal' || (o.metalRoles || []).includes(role);
  return new THREE.MeshStandardMaterial({ color: c, roughness: o.rough?.[role] ?? (metal ? 0.35 : 0.68), metalness: metal ? 0.85 : 0.0, ...(o.extra?.[role] || {}) });
}
function stdFace(map, emissive, kind, o = {}) {
  const screen = kind === 'screen';
  return new THREE.MeshStandardMaterial({
    map, roughness: screen ? 0.25 : 0.55, metalness: 0,
    emissive: (emissive || screen) ? new THREE.Color('#ffffff') : new THREE.Color('#000000'),
    emissiveMap: emissive || (screen ? map : null),
    emissiveIntensity: screen ? (o.screenGlow ?? 1.1) : (o.annGlow ?? 1.6),
  });
}
function basicFace(map, emissive, kind) { return new THREE.MeshBasicMaterial({ map }); }

function addEdges(scene, color, threshold = 25, opacity = 1, skip = () => false) {
  const lm = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh && !skip(o)) meshes.push(o); });
  meshes.forEach((m) => {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, threshold), lm);
    e.raycast = () => {};
    m.add(e);
  });
}
function envMap(renderer, scene, intensity = 0.5) {
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = intensity;
}
function keyLight(scene, { color = '#ffffff', intensity = 2, pos = [1.5, 3.1, 2.2], target = [0, 1.0, -1.6], shadow = true, mapSize = 2048, radius = 2, bias = -0.0004 } = {}) {
  const d = new THREE.DirectionalLight(color, intensity);
  d.position.set(...pos); d.target.position.set(...target);
  scene.add(d, d.target);
  if (shadow) {
    d.castShadow = true;
    d.shadow.mapSize.set(mapSize, mapSize);
    const c = d.shadow.camera; c.left = -5; c.right = 5; c.top = 4; c.bottom = -4; c.near = 0.1; c.far = 12;
    d.shadow.bias = bias; d.shadow.normalBias = 0.02; d.shadow.radius = radius;
  }
  return d;
}
function ceilingPoints(scene, color, intensity, distance = 0, decay = 2, positions = [[-2.5, 3.0, -0.4], [0, 3.0, -0.6], [2.5, 3.0, -0.4], [0, 3.0, 1.6]]) {
  positions.forEach((p) => { const l = new THREE.PointLight(color, intensity, distance, decay); l.position.set(...p); scene.add(l); });
}

// ---------- base palette ----------
const P70 = {
  font: '"Liberation Sans", sans-serif', monoFont: '"Liberation Mono", monospace',
  annBg: '#e9e3cf', annFrame: '#26292a', annBevel: '#c9c2aa', annLit: ['#fff4c8', '#ffd27a', '#ff7a55'], annText: '#4a4a44', annLitText: '#1a1000',
  dialFace: '#f4f1e6', dialInk: '#1b1b1b', dialNeedle: '#c0151b', dialBezel: '#2b2f2c', dialBand: '#d6402f', labelText: '#efe9d6',
  paper: '#f3efe0', paperGrid: '#b9d3b5', paperInk: ['#c0151b', '#1a3fa0'],
  mimicBg: '#2c3a33', mimicLine: '#e8e4d4', mimicHot: '#e2402c', mimicCold: '#3fd07a', mimicSteam: '#e8e4d4', mimicDim: '#55665c',
  screenBg: '#04130a', screenFg: '#62ff8a', screenAccent: '#ffcc33',
  plateBg: '#1f2421', plateText: '#efe9d6',
};
const C70 = {
  panel: '#94b39f', panelTop: '#a6c2ae', hood: '#7d9a87', kick: '#2f3632', trim: '#55615a', bezel: '#2b2f2c', handle: '#141414', tag: '#ece6d2',
  knob: '#1c1c1c', lampOff: '#4a4a40', red: '#c41f1f', green: '#2e8b3e', amber: '#e39a1c', white: '#eeeeee', yellow: '#f0c419', glass: '#ffffff',
  troffer: '#fff8e6', floor: '#c9bea4', wall: '#d6ceb8', ceiling: '#e6e2d6', cabinet: '#8aa595', desk: '#6e7a72', deskTop: '#5c4a38',
  crt: '#cfc6b0', keyboard: '#bdb39a', binder: '#2a4d8f', phone: '#d6cdb3', mug: '#f0f0f0', chair: '#8a4b2a', metal: '#9a9a9a',
};

function make(def) {
  return {
    palette: P70, colors: C70, bg: '#000000', seg: 24, toneMapping: THREE.ACESFilmicToneMapping, exposure: 1, shadows: true,
    mat(role, c) { return stdMat(role, c, def.matOpts); },
    face(map, e, kind) { return stdFace(map, e, kind, def.matOpts); },
    ...def,
    palette: { ...P70, ...(def.palette || {}) },
    colors: { ...C70, ...(def.colors || {}) },
  };
}

// =====================================================================
export const STYLES = {

  analog70s: make({
    title: '1970s Analog Realism',
    note: 'Seafoam-green benchboards, backlit annunciator windows, edgewise meters and strip-chart recorders. Closest to a real Western PWR control room circa 1975.',
    lights(scene, { renderer }) {
      envMap(renderer, scene, 0.25);
      scene.add(new THREE.HemisphereLight('#fff6e8', '#5a5040', 0.45));
      keyLight(scene, { color: '#fff1d8', intensity: 1.5, radius: 4 });
      ceilingPoints(scene, '#fff2dc', 2.8);
    },
    afterBuild(scene) {
      const floor = scene.getObjectByName('floor');
      floor.material = new THREE.MeshStandardMaterial({ map: tileTex('#cdbf9f', '#bfb293', 4, ['#8d826a', '#e8dfc9', '#6d6452'], 512, '#a89c80'), roughness: 0.45 });
    },
    post(c, { bloom }) { c.addPass(bloom(0.5, 0.35, 2.0)); },
    final(c, { pass }) { c.addPass(pass(GradeShader({ vig: 0.45, grain: 0.035, sat: 0.92, tint: '#fff6ea' }))); },
  }),

  lowpoly: make({
    title: 'Low-Poly Pastel',
    note: 'Flat-shaded facets, six-sided cylinders and a soft pastel palette. Cheap to render and very readable; feels like a cozy management sim.',
    seg: 6, toneMapping: THREE.NoToneMapping, bg: '#f6d6ad',
    colors: {
      panel: '#7fb7be', panelTop: '#a8dadc', hood: '#457b9d', kick: '#1d3557', trim: '#1d3557', bezel: '#3d5a80', handle: '#293241', tag: '#f1faee',
      knob: '#293241', lampOff: '#98c1d9', red: '#e63946', green: '#52b788', amber: '#f4a261', white: '#f1faee', yellow: '#f6bd60',
      troffer: '#fffbe6', floor: '#f2e3c6', wall: '#f6d6ad', ceiling: '#fff4e0', cabinet: '#a8dadc', desk: '#c9ada7', deskTop: '#f2cc8f',
      crt: '#e0e1dd', keyboard: '#9a8c98', binder: '#e07a5f', phone: '#f1faee', mug: '#e63946', chair: '#e07a5f', metal: '#4a4e69',
    },
    palette: {
      font: '"Inter", sans-serif', annBg: '#d8eef0', annFrame: '#3d5a80', annBevel: null, annLit: ['#f6bd60', '#e63946'], annText: '#3d5a80', annLitText: '#1d3557',
      dialFace: '#f1faee', dialInk: '#1d3557', dialNeedle: '#e63946', dialBezel: '#3d5a80', dialBand: '#f4a261', labelText: '#f1faee',
      paper: '#f1faee', paperGrid: '#a8dadc', paperInk: ['#e63946', '#457b9d'],
      mimicBg: '#1d3557', mimicLine: '#f1faee', mimicHot: '#e63946', mimicCold: '#52b788', mimicDim: '#3d5a80',
      screenBg: '#1d3557', screenFg: '#a8dadc', screenAccent: '#f6bd60', plateBg: '#1d3557', plateText: '#f1faee',
    },
    mat(role, c) {
      if (role === 'glass') return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
      if (EMISSIVE.has(role)) return new THREE.MeshBasicMaterial({ color: LAMP_COL[role] ? (role === 'lampRedOn' ? '#ff6b6b' : '#7dff9e') : c });
      return new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    },
    face(map, e) { return new THREE.MeshLambertMaterial({ map, emissive: e ? '#ffffff' : '#000000', emissiveMap: e, emissiveIntensity: 0.6 }); },
    lights(scene) {
      scene.add(new THREE.HemisphereLight('#fff4e0', '#ead8cc', 1.6));
      keyLight(scene, { color: '#fff1d0', intensity: 1.8, pos: [2.5, 4, 3], radius: 1 });
    },
  }),

  atompunk: make({
    title: 'Atompunk Retro-Futurism',
    note: 'The 1950s idea of the atomic future: teal enamel, cream bakelite, chrome trim, brass-bezelled dials, glowing vacuum tubes and a porthole onto the Cherenkov-blue core.',
    colors: {
      panel: '#2f6f6a', panelTop: '#e8dcc0', hood: '#e2d6b8', kick: '#1a2a28', trim: '#d0d4d8', bezel: '#b8862b', handle: '#e0e4e8', tag: '#efe3c2',
      knob: '#7a2a14', lampOff: '#3a2a1a', red: '#d9381e', green: '#2e8b6e', amber: '#ff8a1f', white: '#efe3c2', yellow: '#f2b134',
      troffer: '#ffe8c0', floor: '#222', wall: '#18403d', ceiling: '#d8ccb0', cabinet: '#2f6f6a', desk: '#2f6f6a', deskTop: '#e8dcc0',
      crt: '#e8dcc0', keyboard: '#c8b48a', binder: '#7a2a14', phone: '#e8dcc0', mug: '#d0d4d8', chair: '#d9381e', metal: '#d0d4d8',
    },
    palette: {
      font: '"DejaVu Sans", sans-serif', annBg: '#3b2a18', annFrame: '#b8862b', annBevel: '#6a4a24', annLit: ['#ff8a1f', '#ffb347', '#7fffd4'], annText: '#a07a50', annLitText: '#2a1000',
      dialFace: '#efe3c2', dialInk: '#3b2b1b', dialNeedle: '#d9480f', dialBezel: '#b8862b', dialRim: '#7a5a20', dialBand: '#2f6f6a', labelText: '#2a1a0a',
      paper: '#efe3c2', paperGrid: '#d9c9a0', paperInk: ['#d9480f', '#2f6f6a'],
      mimicBg: '#0f2b2a', mimicLine: '#7fffd4', mimicHot: '#ff8a1f', mimicCold: '#7fffd4', mimicDim: '#1f4b4a', mimicSteam: '#d0d4d8',
      screenBg: '#0a1a14', screenFg: '#7fffd4', screenAccent: '#ff8a1f', plateBg: '#b8862b', plateText: '#2a1a0a', scramPlateBg: '#d9381e',
      annLitChance: 0.18,
    },
    matOpts: {
      metalRoles: ['trim', 'bezel', 'handle', 'metal'], glow: 4,
      rough: { trim: 0.12, handle: 0.12, metal: 0.15, bezel: 0.3, panel: 0.35, panelTop: 0.4, hood: 0.35, knob: 0.3, cabinet: 0.35 },
      extra: { bezel: { color: '#c99a3a' } },
      lampColors: { lampRedOn: '#ff6a1a', lampGreenOn: '#7fffd4', troffer: '#ffe8c0' },
    },
    lights(scene, { renderer }) {
      envMap(renderer, scene, 0.45);
      scene.add(new THREE.HemisphereLight('#ffe9c8', '#0f2b2a', 0.6));
      keyLight(scene, { color: '#ffe2b8', intensity: 1.6, radius: 3 });
      ceilingPoints(scene, '#ffb870', 5);
      const cyan = new THREE.PointLight('#40d0ff', 6, 0, 2); cyan.position.set(0, 2.9, -2.6); scene.add(cyan);
    },
    afterBuild(scene) {
      const floor = scene.getObjectByName('floor');
      floor.material = new THREE.MeshStandardMaterial({ map: tileTex('#efe3c2', '#1a1a1a', 8, null), roughness: 0.25, metalness: 0.0 });
      // porthole onto the core
      const port = new THREE.Group(); port.position.set(-2.0, 2.92, -3.15); scene.add(port);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.05, 16, 48), new THREE.MeshStandardMaterial({ color: '#c99a3a', metalness: 1, roughness: 0.25 }));
      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.3, 48), new THREE.MeshBasicMaterial({ map: canvasTex(256, 256, (g) => {
        const gr = g.createRadialGradient(128, 128, 10, 128, 128, 128); gr.addColorStop(0, '#d8f8ff'); gr.addColorStop(0.4, '#3cb8ff'); gr.addColorStop(1, '#06204a');
        g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
        g.strokeStyle = 'rgba(10,30,60,0.8)'; g.lineWidth = 6;
        for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) if (Math.hypot(i - 3, j - 3) < 3.2) g.strokeRect(40 + i * 25, 40 + j * 25, 20, 20);
      }) }));
      glow.material.color.setScalar(2.2);
      port.add(ring, glow);
      // glowing vacuum tubes on top of the hoods
      const tubeMat = new THREE.MeshStandardMaterial({ color: '#ff8a1f', emissive: '#ff6a00', emissiveIntensity: 6, transparent: true, opacity: 0.95 });
      const baseMat = new THREE.MeshStandardMaterial({ color: '#c99a3a', metalness: 1, roughness: 0.3 });
      for (let i = 0; i < 9; i++) {
        const t = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.12, 6, 16), tubeMat); t.position.set(-1.6 + i * 0.4, 2.8, -1.85);
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 16), baseMat); b.position.set(-1.6 + i * 0.4, 2.71, -1.85);
        scene.add(t, b);
      }
    },
    post(c, { bloom }) { c.addPass(bloom(0.8, 0.4, 1.8)); },
    final(c, { pass }) { c.addPass(pass(GradeShader({ vig: 0.5, grain: 0.02, sat: 1.1, contrast: 1.05, tint: '#fff2e0' }))); },
  }),

  toon: make({
    title: 'Cel-Shaded Comic',
    note: 'Three-band toon lighting with black ink outlines on every edge. Bold, clean and stylised; reads well at any resolution and ages gracefully.',
    toneMapping: THREE.NoToneMapping, bg: '#fdf6e3',
    colors: {
      panel: '#5fa8d3', panelTop: '#cae9ff', hood: '#1b4965', kick: '#1b263b', trim: '#1b4965', bezel: '#2b2d42', handle: '#2b2d42', tag: '#ffffff',
      knob: '#2b2d42', lampOff: '#8d99ae', red: '#ef233c', green: '#06d6a0', amber: '#ffd166', white: '#ffffff', yellow: '#ffd166',
      troffer: '#ffffff', floor: '#ffd166', wall: '#fdf6e3', ceiling: '#ffffff', cabinet: '#62b6cb', desk: '#bee9e8', deskTop: '#ef476f',
      crt: '#edf2f4', keyboard: '#8d99ae', binder: '#7209b7', phone: '#ffffff', mug: '#ef476f', chair: '#ef476f', metal: '#2b2d42',
    },
    palette: {
      font: '"Inter", sans-serif', annBg: '#edf2f4', annFrame: '#2b2d42', annBevel: null, annLit: ['#ffd166', '#ef233c'], annText: '#2b2d42', annLitText: '#2b2d42',
      dialFace: '#ffffff', dialInk: '#2b2d42', dialNeedle: '#ef233c', dialBezel: '#2b2d42', dialBand: '#ffd166',
      paper: '#ffffff', paperGrid: '#cae9ff', paperInk: ['#ef233c', '#1b4965'],
      mimicBg: '#1b263b', mimicLine: '#ffffff', mimicHot: '#ef233c', mimicCold: '#06d6a0', mimicDim: '#415a77',
      screenBg: '#1b263b', screenFg: '#cae9ff', screenAccent: '#ffd166', plateBg: '#2b2d42', plateText: '#ffffff',
    },
    mat(role, c) {
      if (role === 'glass') return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
      if (EMISSIVE.has(role)) return new THREE.MeshBasicMaterial({ color: role === 'troffer' ? '#ffffff' : LAMP_COL[role] });
      if (role === 'ceiling') return new THREE.MeshBasicMaterial({ color: '#e9eef2' });
      return new THREE.MeshToonMaterial({ color: c, gradientMap: this._grad || (this._grad = canvasTex(3, 1, (g) => { ['#555', '#aaa', '#fff'].forEach((s, i) => { g.fillStyle = s; g.fillRect(i, 0, 1, 1); }); }, { nearest: true })) });
    },
    face(map, e) { return new THREE.MeshBasicMaterial({ map }); },
    lights(scene) {
      scene.add(new THREE.AmbientLight('#ffffff', 0.9));
      keyLight(scene, { intensity: 2.2, pos: [2.5, 4, 3], shadow: true, radius: 0 });
    },
    afterBuild(scene) {
      addEdges(scene, '#111111', 30, 1, (o) => o.material?.transparent && o.material.opacity === 0);
    },
  }),

  brutalist: make({
    title: 'Brutalist Concrete',
    note: 'Board-marked concrete everywhere, deep coffered ceiling, one hard light and almost no colour except safety red. Heavy, cold and monumental.',
    exposure: 0.95,
    colors: {
      panel: '#8b8a86', panelTop: '#77766f', hood: '#6d6c68', kick: '#3a3a38', trim: '#4a4a48', bezel: '#1d1d1d', handle: '#0d0d0d', tag: '#d8d6d0',
      knob: '#0d0d0d', lampOff: '#3a3a38', red: '#e01e12', green: '#bfbfbf', amber: '#bfbfbf', white: '#d8d6d0', yellow: '#e01e12',
      troffer: '#f4f4f4', floor: '#6e6d69', wall: '#8b8a86', ceiling: '#7d7c78', cabinet: '#7d7c78', desk: '#5a5955', deskTop: '#2a2a2a',
      crt: '#2a2a2a', keyboard: '#1d1d1d', binder: '#e01e12', phone: '#1d1d1d', mug: '#d8d6d0', chair: '#1d1d1d', metal: '#3a3a3a',
    },
    palette: {
      font: '"Inter Display", "Inter", sans-serif', annBg: '#3c3c3a', annFrame: '#141414', annBevel: null, annLit: ['#ff2a1a', '#f4f4f4'], annText: '#8b8a86', annLitText: '#140000',
      dialFace: '#d8d6d0', dialInk: '#111', dialNeedle: '#e01e12', dialBezel: '#1d1d1d', dialBand: '#e01e12',
      paper: '#e4e2dc', paperGrid: '#c4c2bc', paperInk: ['#e01e12', '#111'],
      mimicBg: '#1d1d1d', mimicLine: '#d8d6d0', mimicHot: '#e01e12', mimicCold: '#f4f4f4', mimicDim: '#3a3a38', mimicSteam: '#8b8a86',
      screenBg: '#0d0d0d', screenFg: '#d8d6d0', screenAccent: '#ff2a1a', plateBg: '#141414', plateText: '#d8d6d0', annLitChance: 0.08,
    },
    mat(role, c) {
      const concrete = ['panel', 'panelTop', 'hood', 'wall', 'ceiling', 'floor', 'cabinet', 'desk'].includes(role);
      if (concrete) {
        this._conc ||= concreteTex(3);
        const m = stdMat(role, c, { rough: { [role]: 0.95 } });
        m.map = rep(this._conc.clone(), role === 'floor' ? 6 : 2, role === 'floor' ? 6 : 2); m.map.needsUpdate = true;
        m.color.set('#ffffff');
        return m;
      }
      return stdMat(role, c, { glow: 3 });
    },
    lights(scene, { renderer }) {
      envMap(renderer, scene, 0.12);
      scene.add(new THREE.HemisphereLight('#dfe6ee', '#3a3a3a', 1.3));
      const s = new THREE.SpotLight('#f4f6ff', 700, 0, 0.5, 0.35, 2);
      s.position.set(-2.4, 6.5, 2.8); s.target.position.set(0, 1.1, -1.6);
      s.castShadow = true; s.shadow.mapSize.set(2048, 2048); s.shadow.bias = -0.0003; s.shadow.normalBias = 0.02;
      scene.add(s, s.target);
      ceilingPoints(scene, '#ffffff', 1.0);
    },
    afterBuild(scene) {
      const conc = concreteTex(4);
      const m = new THREE.MeshStandardMaterial({ map: rep(conc, 1, 2), roughness: 0.95, color: '#ffffff' });
      // coffered ceiling beams + wall fins
      for (let x = -6; x <= 6; x += 1.6) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.55, 12), m); b.position.set(x, 3.03, 0); b.castShadow = b.receiveShadow = true; scene.add(b); }
      for (let z = -3; z <= 6; z += 1.6) { const b = new THREE.Mesh(new THREE.BoxGeometry(13, 0.55, 0.35), m); b.position.set(0, 3.03, z); b.castShadow = b.receiveShadow = true; scene.add(b); }
      for (let x = -5.6; x <= 5.6; x += 1.4) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.3, 0.5), m); f.position.set(x, 1.65, -2.95); f.castShadow = f.receiveShadow = true; scene.add(f); }
      scene.traverse((o) => { if (o.isMesh && o.material?.emissive && o.material.color?.getHexString() === 'f4f4f4') o.visible = false; });
    },
    post(c, { bloom }) { c.addPass(bloom(0.6, 0.35, 2.0)); },
    final(c, { pass }) { c.addPass(pass(GradeShader({ vig: 0.6, grain: 0.04, sat: 0.55, contrast: 1.18, tint: '#f2f5ff' }))); },
  }),

  eastern: make({
    title: 'Cold War Eastern Bloc',
    note: 'Grey-green mosaic panel boards, black round dials with white numerals, wood-panelled walls and warm incandescent light. Utilitarian 1980s industrial.',
    colors: {
      panel: '#8fa39a', panelTop: '#9db0a6', hood: '#77887f', kick: '#33302a', trim: '#4a4a42', bezel: '#1e1e1c', handle: '#111', tag: '#f2efe2',
      knob: '#111', lampOff: '#5a5a50', red: '#c0281e', green: '#3c8a3c', amber: '#e3a81c', white: '#f2efe2', yellow: '#e3c31c',
      troffer: '#ffe6b8', floor: '#7a5636', wall: '#6b4a2f', ceiling: '#d8d2c0', cabinet: '#8fa39a', desk: '#5d4632', deskTop: '#7a5b3d',
      crt: '#b9b39f', keyboard: '#8a8472', binder: '#5a2a1e', phone: '#c0281e', mug: '#f2efe2', chair: '#3a2a1c', metal: '#888',
    },
    palette: {
      font: '"DejaVu Sans", sans-serif', monoFont: '"DejaVu Sans Mono", monospace',
      annBg: '#dfe6cf', annFrame: '#1e1e1c', annBevel: '#b8bfa8', annLit: ['#fff08a', '#a8ff7a', '#ff7a5a'], annText: '#4a4a40', annLitText: '#1a1a00',
      dialFace: '#141414', dialInk: '#f2efe2', dialNeedle: '#ffdd44', dialBezel: '#1e1e1c', dialRim: '#5a5a50', dialBand: '#c0281e', labelText: '#f2efe2',
      paper: '#f0ecd8', paperGrid: '#e0b4a8', paperInk: ['#7a1a8a', '#1a3a9a'],
      mimicBg: '#8fa39a', mimicLine: '#1e1e1c', mimicHot: '#d03020', mimicCold: '#2a7a2a', mimicDim: '#6f8379', mimicText: '#1e1e1c', mimicColdGlow: '#5aff5a',
      screenBg: '#101a10', screenFg: '#d8ffb8', screenAccent: '#ffdd44', plateBg: '#f2efe2', plateText: '#1e1e1c',
      annLitChance: 0.16,
    },
    mat(role, c) {
      const m = stdMat(role, c, { glow: 4, lampColors: { troffer: '#ffe0a8' } });
      if (['panel', 'panelTop', 'cabinet'].includes(role)) {
        this._mosaic ||= canvasTex(256, 256, (g) => {
          g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
          g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 2;
          for (let i = 0; i <= 256; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
        });
        m.map = rep(this._mosaic.clone(), 10, 6); m.map.needsUpdate = true;
      }
      if (role === 'wall') {
        m.map = rep(canvasTex(512, 512, (g) => {
          const r = rng(2);
          for (let x = 0; x < 512; x += 64) { g.fillStyle = `hsl(28, 40%, ${26 + r() * 8}%)`; g.fillRect(x, 0, 64, 512); g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(x, 0, 3, 512);
            for (let k = 0; k < 40; k++) { g.strokeStyle = `rgba(0,0,0,${0.05 + r() * 0.1})`; g.beginPath(); const xx = x + r() * 64; g.moveTo(xx, 0); g.bezierCurveTo(xx + 8, 170, xx - 8, 340, xx + 4, 512); g.stroke(); } }
        }), 6, 1); m.color.set('#ffffff');
      }
      if (role === 'floor') { m.map = tileTex('#8a6240', '#6e4b2e', 8, ['#4a3020', '#a07850']); m.color.set('#ffffff'); m.roughness = 0.4; }
      return m;
    },
    lights(scene, { renderer }) {
      envMap(renderer, scene, 0.25);
      scene.add(new THREE.HemisphereLight('#ffe6c0', '#3a2a1c', 0.8));
      keyLight(scene, { color: '#ffd9a0', intensity: 1.8, radius: 4 });
      ceilingPoints(scene, '#ffcc88', 6);
    },
    post(c, { bloom }) { c.addPass(bloom(0.5, 0.35, 2.0)); },
    final(c, { pass }) { c.addPass(pass(GradeShader({ vig: 0.55, grain: 0.05, sat: 0.8, contrast: 1.05, tint: '#fff0d8', lift: '#060402' }))); },
  }),

  crt: make({
    title: 'Vector CRT Terminal',
    note: 'The whole room drawn as glowing green phosphor wireframe on a curved, scanlined monitor, like a 1980s training simulator. Hugely atmospheric and very cheap to render.',
    toneMapping: THREE.NoToneMapping, shadows: false, bg: '#000000',
    palette: {
      font: '"DejaVu Sans Mono", monospace', monoFont: '"DejaVu Sans Mono", monospace',
      annBg: '#000', annFrame: '#0a3a12', annBevel: '#1a7a2a', annLit: ['#3aff6a'], annText: '#1f8a3a', annLitText: '#001a05',
      dialFace: '#000', dialInk: '#3aff6a', dialNeedle: '#c8ffd0', dialBezel: '#000', dialRim: '#3aff6a', dialBand: null, labelText: '#3aff6a', edgeBezel: '#000',
      paper: '#000', paperGrid: '#0a3a12', paperInk: ['#3aff6a', '#c8ffd0'],
      mimicBg: '#000', mimicLine: '#3aff6a', mimicHot: '#c8ffd0', mimicCold: '#3aff6a', mimicDim: '#0a3a12',
      screenBg: '#000', screenFg: '#3aff6a', screenAccent: '#c8ffd0', screenGrid: '#1f8a3a', plateBg: '#000', plateText: '#3aff6a', scramPlateBg: '#000',
      annLitChance: 0.1,
    },
    mat(role, c) {
      if (role === 'glass') return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
      if (role === 'lampRedOn' || role === 'lampGreenOn' || role === 'red') return new THREE.MeshBasicMaterial({ color: '#3aff6a' });
      return new THREE.MeshBasicMaterial({ color: '#000000', polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    },
    face(map) { return new THREE.MeshBasicMaterial({ map, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }); },
    lights() {},
    afterBuild(scene) {
      addEdges(scene, '#3aff6a', 20, 0.9, (o) => o.material?.transparent || o.material?.map);
      const grid = new THREE.GridHelper(18, 36, '#1f8a3a', '#0d4a1a'); grid.position.y = 0.002; scene.add(grid);
    },
    post(c, { bloom }) { c.addPass(bloom(0.45, 0.0, 0.2)); },
    final(c, { pass }) { c.addPass(pass(CRTShader)); },
    overlay: `<div style="position:absolute;left:90px;top:70px;font:22px 'DejaVu Sans Mono';color:#4aff7a;text-shadow:0 0 8px #3aff6a;opacity:.9">RX-SIM 4.1  ·  UNIT 1 MCR<br><span style="opacity:.7">RCS 2235 PSIG  TAVG 584.2  PWR 98.7%</span></div><div style="position:absolute;right:90px;bottom:70px;font:22px 'DejaVu Sans Mono';color:#4aff7a;text-shadow:0 0 8px #3aff6a;opacity:.9">&gt; READY_</div>`,
  }),

  ps1: make({
    title: 'PS1-Era Low-Fi',
    note: 'Rendered at 400×225, wobbly vertex snapping, crunchy unfiltered textures, dithered colour and thick fog. Instantly evokes late-90s horror games and makes a meltdown feel uneasy.',
    seg: 8, lowRes: [400, 225], noAA: true, exposure: 1.1, shadows: false, bg: '#0a0d10',
    fog: { color: '#0a0d10', near: 2.5, far: 8.5 },
    palette: { nearest: true, font: '"DejaVu Sans", sans-serif' },
    mat(role, c) {
      let m;
      if (EMISSIVE.has(role)) m = new THREE.MeshBasicMaterial({ color: role === 'troffer' ? '#e8e0c8' : LAMP_COL[role] });
      else if (role === 'glass') m = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
      else {
        m = new THREE.MeshLambertMaterial({ color: c });
        if (['panel', 'panelTop', 'hood', 'wall', 'floor', 'cabinet', 'ceiling', 'deskTop'].includes(role)) {
          const t = noiseTex('#ffffff', ['#9a9a9a', '#cfcfcf', '#7a7a7a'], 64, role.length, false);
          t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
          m.map = rep(t, role === 'floor' ? 24 : 4, role === 'floor' ? 24 : 4);
        }
      }
      return snap(m);
    },
    face(map, e) { return snap(new THREE.MeshLambertMaterial({ map, emissive: e ? '#ffffff' : '#000000', emissiveMap: e, emissiveIntensity: 0.8 })); },
    lights(scene) {
      scene.add(new THREE.HemisphereLight('#c8d0d8', '#2a2018', 1.2));
      const d = new THREE.DirectionalLight('#fff0d0', 1.6); d.position.set(2, 4, 3); scene.add(d);
      const r = new THREE.PointLight('#ff3020', 3, 6, 1.5); r.position.set(1.2, 2.6, -1.2); scene.add(r);
    },
    final(c, { pass }) { c.addPass(pass(PS1Shader)); },
  }),

  blueprint: make({
    title: 'Technical Blueprint',
    note: 'Hidden-line white strokes on cyanotype blue with a title block and callouts. Would suit a menu, tutorial or a "plant schematic" map view more than the main game.',
    toneMapping: THREE.NoToneMapping, shadows: false, bg: '#123d6b',
    palette: {
      font: '"Liberation Mono", monospace', monoFont: '"Liberation Mono", monospace',
      annBg: '#123d6b', annFrame: '#123d6b', annBevel: '#cfe3ff', annLit: ['#cfe3ff'], annText: '#cfe3ff', annLitText: '#123d6b',
      dialFace: '#123d6b', dialInk: '#e8f2ff', dialNeedle: '#ffffff', dialBezel: '#123d6b', dialRim: '#e8f2ff', dialBand: null, labelText: '#e8f2ff', edgeBezel: '#123d6b',
      paper: '#123d6b', paperGrid: '#2a5a8a', paperInk: ['#e8f2ff', '#9cc4ff'],
      mimicBg: '#123d6b', mimicLine: '#e8f2ff', mimicHot: '#ffffff', mimicCold: '#9cc4ff', mimicDim: '#4a7aaa',
      screenBg: '#123d6b', screenFg: '#e8f2ff', screenAccent: '#9cc4ff', screenGrid: '#4a7aaa', plateBg: '#123d6b', plateText: '#e8f2ff', scramPlateBg: '#123d6b',
      annLitChance: 0.0,
    },
    mat(role) {
      if (role === 'glass') return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
      return new THREE.MeshBasicMaterial({ color: '#123d6b', polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    },
    face(map) { return new THREE.MeshBasicMaterial({ map, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }); },
    lights() {},
    afterBuild(scene) {
      addEdges(scene, '#e8f2ff', 20, 0.95, (o) => o.material?.transparent || o.material?.map);
      const grid = new THREE.GridHelper(18, 72, '#4a7aaa', '#24527f'); grid.position.y = 0.002; scene.add(grid);
    },
    final(c, { pass }) { c.addPass(pass(GradeShader({ vig: 0.2, grain: 0.05 }))); },
    overlay: `
      <div style="position:absolute;right:28px;bottom:28px;border:2px solid #e8f2ff;color:#e8f2ff;font:15px 'Liberation Mono';width:430px">
        <div style="padding:8px 12px;border-bottom:2px solid #e8f2ff;font-size:20px;letter-spacing:2px">MAIN CONTROL ROOM · UNIT 1</div>
        <div style="display:flex"><div style="padding:6px 12px;border-right:2px solid #e8f2ff;flex:1">DWG RX-MCR-001</div><div style="padding:6px 12px;border-right:2px solid #e8f2ff">REV C</div><div style="padding:6px 12px">1:25</div></div>
        <div style="padding:6px 12px;border-top:2px solid #e8f2ff">PWR · 4-LOOP · 3411 MWt · OPERATOR POV</div></div>
      <div style="position:absolute;left:620px;top:150px;color:#e8f2ff;font:14px 'Liberation Mono'">(A) ANNUNCIATOR WINDOWS ─────╮</div>
      <div style="position:absolute;left:1000px;top:640px;color:#e8f2ff;font:14px 'Liberation Mono'">╰── (B) REACTOR TRIP PB</div>
      <div style="position:absolute;left:40px;top:300px;color:#e8f2ff;font:14px 'Liberation Mono'">(C) RCS BOARD<br>EDGEWISE METERS<br>STRIP RECORDERS</div>`,
  }),

  emergency: make({
    title: 'Emergency Lighting Thriller',
    note: 'Normal lights failed: deep shadow, red emergency beacons, a wall of flashing annunciators and haze. The same room as the realism style, graded for tension during a transient or scram.',
    exposure: 1.0, bg: '#050203', fog: { color: '#1a0506', density: 0.09 },
    palette: { annLit: ['#ff3b2f', '#ffb02e', '#ff3b2f'], annLitChance: 0.55, screenFg: '#ff5a4a', screenAccent: '#ffcc33', screenBg: '#120303' },
    colors: { troffer: '#0a0a0a' },
    matOpts: { glow: 6, annGlow: 2.2, lampColors: { troffer: '#060606', lampGreenOn: '#30ff60' }, rough: { floor: 0.3 } },
    lights(scene) {
      scene.add(new THREE.HemisphereLight('#401010', '#050505', 0.35));
      const beacons = [[-2.6, 2.95, -2.9], [2.6, 2.95, -2.9], [0, 3.1, 1.5]];
      beacons.forEach((p, i) => {
        const l = new THREE.PointLight('#ff1a10', 5, 0, 2); l.position.set(...p); scene.add(l);
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3020').multiplyScalar(3) }));
        b.position.set(...p); scene.add(b);
      });
      const s = new THREE.SpotLight('#ff2a14', 50, 0, 0.6, 0.6, 2);
      s.position.set(-2.6, 3.0, -2.6); s.target.position.set(0.6, 1.0, -1.2);
      s.castShadow = true; s.shadow.mapSize.set(1024, 1024); s.shadow.bias = -0.0005;
      scene.add(s, s.target);
      // a single flashlight beam from the operator
      const f = new THREE.SpotLight('#fff1d8', 40, 0, 0.22, 0.55, 2);
      f.position.set(0.5, 1.45, 1.6); f.target.position.set(-0.2, 1.75, -1.6); f.castShadow = true; f.shadow.mapSize.set(1024, 1024);
      scene.add(f, f.target);
    },
    afterBuild(scene) { scene.fog = new THREE.FogExp2('#120304', 0.05); },
    post(c, { bloom }) { c.addPass(bloom(0.9, 0.4, 1.4)); },
    final(c, { pass }) { c.addPass(pass(GradeShader({ vig: 0.9, grain: 0.07, sat: 0.95, contrast: 1.12, ab: 0.006 }))); },
  }),

  dither: make({
    title: '1-Bit Ordered Dither',
    note: 'Two inks only (warm paper and deep ink), Bayer-dithered at 640×360 with crisp outlines. Striking, unusual and timeless; text stays legible thanks to the outline pass.',
    lowRes: [640, 360], noAA: true, toneMapping: THREE.NoToneMapping, bg: '#000',
    palette: { nearest: true },
    mat(role, c) {
      if (role === 'glass') return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
      if (EMISSIVE.has(role)) return new THREE.MeshBasicMaterial({ color: '#ffffff' });
      return new THREE.MeshLambertMaterial({ color: c });
    },
    face(map, e) { return new THREE.MeshBasicMaterial({ map }); },
    lights(scene) {
      scene.add(new THREE.HemisphereLight('#ffffff', '#202020', 0.9));
      keyLight(scene, { intensity: 2.6, pos: [3, 4.5, 3], radius: 0, mapSize: 1024 });
    },
    afterBuild(scene) { addEdges(scene, '#000000', 30, 1, (o) => o.material?.transparent); },
    final(c, { pass }) { c.addPass(pass(DitherShader('#1c1a2e', '#efe6cc'))); },
  }),

  modern: make({
    title: 'Modern Digital Glass',
    variant: 'modern',
    note: 'A 2020s digital control room: graphite consoles, large flat displays, aluminium trim and cool LED light. Clean UI-forward look where most interaction is on screens.',
    exposure: 1.0,
    colors: {
      panel: '#2b3038', panelTop: '#22262d', hood: '#1a1d22', kick: '#121418', trim: '#9aa3ad', bezel: '#0e1014', handle: '#111', tag: '#ddd',
      knob: '#111', lampOff: '#333', red: '#e5322d', green: '#22c55e', amber: '#f59e0b', white: '#eee', yellow: '#f5c518',
      troffer: '#eaf4ff', floor: '#4a5058', wall: '#dfe3e8', ceiling: '#f1f3f5', cabinet: '#c9ced4', desk: '#2b3038', deskTop: '#e9ecef',
      crt: '#111', keyboard: '#1a1d22', binder: '#2ec4ff', phone: '#1a1d22', mug: '#ffffff', chair: '#1a1d22', metal: '#9aa3ad',
    },
    palette: {
      font: '"Inter", sans-serif', monoFont: '"JetBrains Mono", monospace',
      screenBg: '#0b1622', screenFg: '#d8e6f3', screenAccent: '#2ec4ff', screenGrid: '#2a4a6a', screenTile: 'rgba(46,196,255,0.08)',
      plateBg: '#0e1014', plateText: '#9aa3ad', scramPlateBg: '#e5322d',
    },
    matOpts: {
      metalRoles: ['trim', 'metal'], glow: 3, screenGlow: 0.9,
      rough: { panel: 0.35, panelTop: 0.25, hood: 0.3, deskTop: 0.3, bezel: 0.2, floor: 0.5, trim: 0.25 },
      lampColors: { troffer: '#eaf4ff' },
    },
    lights(scene, { renderer }) {
      envMap(renderer, scene, 0.6);
      scene.add(new THREE.HemisphereLight('#eef6ff', '#30343a', 0.7));
      keyLight(scene, { color: '#f2f8ff', intensity: 1.5, radius: 6 });
      ceilingPoints(scene, '#eaf4ff', 3);
    },
    afterBuild(scene) {
      const floor = scene.getObjectByName('floor');
      floor.material = new THREE.MeshStandardMaterial({ map: tileTex('#50565e', '#4a5058', 6, null, 512, '#3a3f45'), roughness: 0.5 });
      // LED accent strip along the slope lips
      scene.traverse((o) => { if (o.isMesh && o.material?.color?.getHexString?.() === '9aa3ad' && o.geometry.parameters?.height === 0.035) { o.material = new THREE.MeshBasicMaterial({ color: new THREE.Color('#2ec4ff').multiplyScalar(2) }); } });
    },
    post(c, { bloom }) { c.addPass(bloom(0.5, 0.35, 2.4)); },
    final(c, { pass }) { c.addPass(pass(GradeShader({ vig: 0.3, grain: 0.015, sat: 1.0, contrast: 1.04, tint: '#f6fbff' }))); },
  }),

  clay: make({
    title: 'Clay Diorama',
    note: 'Everything rounded and matte like a stop-motion set, in a warm toy palette with soft shadows and a tilt-shift blur. Friendly and charming; would make the danger feel ironic.',
    exposure: 1.05, fov: 58,
    colors: {
      panel: '#f4a261', panelTop: '#f6c28b', hood: '#2a9d8f', kick: '#264653', trim: '#264653', bezel: '#264653', handle: '#264653', tag: '#fff',
      knob: '#e76f51', lampOff: '#8ab17d', red: '#e63946', green: '#2a9d8f', amber: '#e9c46a', white: '#fff', yellow: '#e9c46a',
      troffer: '#fffaf0', floor: '#e9d8c4', wall: '#a8dadc', ceiling: '#f1faee', cabinet: '#2a9d8f', desk: '#e9c46a', deskTop: '#e76f51',
      crt: '#f1faee', keyboard: '#264653', binder: '#457b9d', phone: '#e63946', mug: '#fff', chair: '#457b9d', metal: '#264653',
    },
    palette: {
      font: '"Inter", sans-serif', annBg: '#fdf0d5', annFrame: '#264653', annBevel: null, annLit: ['#e9c46a', '#e76f51'], annText: '#264653', annLitText: '#264653',
      dialFace: '#fdf0d5', dialInk: '#264653', dialNeedle: '#e63946', dialBezel: '#264653', dialBand: '#e9c46a',
      paper: '#fdf0d5', paperGrid: '#f4c69a', paperInk: ['#e63946', '#2a9d8f'],
      mimicBg: '#264653', mimicLine: '#fdf0d5', mimicHot: '#e76f51', mimicCold: '#8ab17d', mimicDim: '#3a6a7a',
      screenBg: '#264653', screenFg: '#fdf0d5', screenAccent: '#e9c46a', plateBg: '#264653', plateText: '#fdf0d5',
    },
    matOpts: { glow: 1.6, rough: {} },
    mat(role, c) {
      const m = stdMat(role, c, { glow: 1.6 });
      if (!EMISSIVE.has(role) && role !== 'glass') { m.roughness = 0.92; m.metalness = 0; }
      return m;
    },
    shadowType: THREE.VSMShadowMap,
    lights(scene, { renderer }) {
      envMap(renderer, scene, 0.5);
      scene.add(new THREE.HemisphereLight('#fff4e6', '#c9a27e', 1.2));
      const k = keyLight(scene, { color: '#fff1dc', intensity: 2.4, pos: [-2.5, 4.5, 3.0], radius: 12, mapSize: 2048, bias: -0.0002 });
      k.shadow.blurSamples = 16;
    },
    cameraTweak(cam) { cam.position.set(0.1, 1.85, 2.0); cam.lookAt(0, 1.2, -1.3); },
    afterBuild(scene) {
      scene.traverse((o) => {
        if (o.isMesh && o.geometry.type === 'BoxGeometry') {
          const { width: w, height: h, depth: d } = o.geometry.parameters;
          const r = Math.min(w, h, d) * 0.3;
          if (Math.max(w, h, d) < 10) o.geometry = new RoundedBoxGeometry(w, h, d, 3, r);
        }
      });
    },
    final(c, { pass }) { c.addPass(pass(TiltShiftShader)); c.addPass(pass(GradeShader({ vig: 0.3, grain: 0.02, sat: 1.05 }))); },
  }),
};

// PS1 vertex snapping
function snap(m) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      vec4 sp = gl_Position; sp.xyz /= sp.w; sp.xy = floor(sp.xy * vec2(120.0, 68.0) + 0.5) / vec2(120.0, 68.0); sp.xyz *= sp.w; gl_Position = sp;`);
  };
  return m;
}
