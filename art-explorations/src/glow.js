// Separable gaussian glow (threshold -> H blur -> V blur -> add), two scales.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export class GlowPass extends Pass {
  constructor(w, h, strength, radius, threshold) {
    super();
    const mk = (d) => new THREE.WebGLRenderTarget(Math.ceil(w / d), Math.ceil(h / d), { type: THREE.HalfFloatType });
    this.levels = [2, 6].map((d) => ({ a: mk(d), b: mk(d), d }));
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() }, threshold: { value: threshold }, useThr: { value: 1 }, sigma: { value: 4 } },
      vertexShader: VERT,
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform vec2 dir; uniform float threshold, useThr, sigma; varying vec2 vUv;
        vec3 smp(vec2 uv){ vec3 c = texture2D(tDiffuse, uv).rgb; return useThr > 0.5 ? max(c - threshold, 0.0) : c; }
        void main(){
          vec3 acc = vec3(0.0); float ws = 0.0;
          for (int i = -12; i <= 12; i++) {
            float x = float(i); float w = exp(-x * x / (2.0 * sigma * sigma));
            acc += smp(vUv + dir * x) * w; ws += w;
          }
          gl_FragColor = vec4(acc / ws, 1.0);
        }`,
    });
    this.comp = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, g1: { value: null }, g2: { value: null }, strength: { value: strength } },
      vertexShader: VERT,
      fragmentShader: `uniform sampler2D tDiffuse, g1, g2; uniform float strength; varying vec2 vUv;
        void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; gl_FragColor = vec4(c + (texture2D(g1, vUv).rgb * 0.6 + texture2D(g2, vUv).rgb * 1.0) * strength * 2.0, 1.0); }`,
    });
    this.radius = radius;
    this.quad = new FullScreenQuad();
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.blur.uniforms;
    this.quad.material = this.blur;
    for (const L of this.levels) {
      const w = L.a.width, h = L.a.height;
      u.sigma.value = Math.min(6, 2 + this.radius * 6);
      u.tDiffuse.value = readBuffer.texture; u.useThr.value = 1; u.dir.value.set(1 / w, 0);
      renderer.setRenderTarget(L.a); this.quad.render(renderer);
      u.tDiffuse.value = L.a.texture; u.useThr.value = 0; u.dir.value.set(0, 1 / h);
      renderer.setRenderTarget(L.b); this.quad.render(renderer);
    }
    this.quad.material = this.comp;
    this.comp.uniforms.tDiffuse.value = readBuffer.texture;
    this.comp.uniforms.g1.value = this.levels[0].b.texture;
    this.comp.uniforms.g2.value = this.levels[1].b.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}
