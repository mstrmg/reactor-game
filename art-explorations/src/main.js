import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { STYLES } from './styles.js';
import { GlowPass } from './glow.js';
import { buildRoom } from './scene.js';

window.onerror = (m) => { window.__err = String(m); };
const name = new URLSearchParams(location.search).get('style') || 'analog70s';
const style = STYLES[name];
const W = 1600, H = 900;
const [rw, rh] = style.lowRes || [W, H];
const renderer = new THREE.WebGLRenderer({ antialias: !style.noAA, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(rw, rh, false);
if (style.lowRes) renderer.domElement.style.imageRendering = 'pixelated';
renderer.toneMapping = style.toneMapping;
renderer.toneMappingExposure = style.exposure;
renderer.shadowMap.enabled = style.shadows;
renderer.shadowMap.type = style.shadowType || THREE.PCFShadowMap;
document.getElementById('wrap').appendChild(renderer.domElement);

const { scene, camera } = buildRoom(style);
scene.background = new THREE.Color(style.bg);
if (style.fog?.near) scene.fog = new THREE.Fog(style.fog.color, style.fog.near, style.fog.far);
const ctx = { renderer, scene, camera };
style.lights(scene, ctx);
style.afterBuild?.(scene, ctx);
if (!style.shadows) scene.traverse((o) => { o.castShadow = false; });

const composer = new EffectComposer(renderer);
composer.setPixelRatio(1);
composer.setSize(rw, rh);
composer.addPass(new RenderPass(scene, camera));
const helpers = {
  bloom: (s, r, t) => {
    const p = new GlowPass(rw, rh, s, r, t);
    if (location.search.includes('nobloom')) p.enabled = false;
    return p;
  },
  pass: (sh) => { const p = new ShaderPass(typeof sh === 'function' ? sh() : sh); if (p.uniforms.res) p.uniforms.res.value.set(rw, rh); return p; },
};
style.post?.(composer, helpers);
composer.addPass(new OutputPass());
style.final?.(composer, helpers);

if (style.overlay) {
  const o = document.createElement('div');
  o.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  o.innerHTML = style.overlay;
  document.getElementById('wrap').appendChild(o);
}
let n = 0;
function frame() { composer.render(); if (++n < 3) requestAnimationFrame(frame); else window.__ready = true; }
document.fonts.ready.then(() => requestAnimationFrame(frame));
window.__style = style;
