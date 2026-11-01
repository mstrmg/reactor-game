/**
 * 3D control room. createWorld(container, sim) builds the renderer, room,
 * boards and first-person controller.
 *
 * Draw-call budget (approx): shell 1, labels 1, readouts 1, annunciators 1,
 * floor 1, ceiling 1, troffers 1, instanced needles/lamps/handles/knobs/buttons 5,
 * CRTs 2 + supervisor 1, chart 1, exit 1, beacon 2  → ~20.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { PlantState, ReactorSimApi } from '../sim/types';
import { bus } from '../core/bus';
import { PanelKit } from './panel';
import { buildLayout } from './layout';
import { Annunciators } from './annunciator';
import { buildRoom } from './room';
import { Player } from './player';

export interface WorldApi {
  update(dt: number): void;
  render(): void;
  lockPointer(): void;
  unlockPointer(): void;
  /** toggle the bloom post-process (default on) */
  setBloom(on: boolean): void;
  /** quality: 'low' = pixel ratio 1 & no bloom, 'high' = pixel ratio ≤1.5 & bloom */
  setQuality(q: 'low' | 'high'): void;
  /** renderer stats */
  getInfo(): { calls: number; triangles: number; textures: number; geometries: number; fps: number };
  /** debug/testing: place the camera */
  setView(x: number, z: number, yaw: number, pitch: number, focus?: boolean): void;
  /** debug/testing: accept keyboard/mouse without pointer lock */
  setFreeInput(on: boolean): void;
  /** current crosshair target id (or null) */
  getTarget(): string | null;
  /** debug: stand in front of an interactable and aim the crosshair at it */
  debugLookAt(id: string, dist?: number): boolean;
  /** debug: invoke an interactable as if clicked (button 0 primary / 2 secondary) */
  debugActivate(id: string, button?: 0 | 2): boolean;
}

export function createWorld(container: HTMLElement, sim: ReactorSimApi): WorldApi {
  /* ---------------- renderer ---------------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
  let maxPR = 1.5;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPR));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = false;
  renderer.info.autoReset = false;
  renderer.setClearColor(0x0a0a0a, 1);
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.tabIndex = 0;
  if (!container.style.position) {
    container.style.position = 'fixed';
    container.style.inset = '0';
  }
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = true;
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 60);
  camera.rotation.order = 'YXZ';

  /* ---------------- lights ---------------- */
  const hemi = new THREE.HemisphereLight(0xfff4e2, 0x4a4640, 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2dc, 0.9);
  sun.position.set(1.5, 8, 3);
  sun.target.position.set(0, 0, -5);
  scene.add(sun, sun.target);
  const fill = new THREE.PointLight(0xfff0dc, 1.0, 0, 0);
  fill.position.set(0, 3.0, -1.0);
  scene.add(fill);
  const baseLights = { hemi: hemi.intensity, sun: sun.intensity, fill: fill.intensity };

  /* ---------------- content ---------------- */
  const kit = new PanelKit(sim);
  const layout = buildLayout(kit, sim);
  const ann = new Annunciators(kit, layout.sections, layout.firstOutAt);
  const room = buildRoom(kit, scene, layout.sections, layout.crtB.tex);
  const shellMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  kit.finalize(scene, shellMat);
  scene.add(ann.mesh);
  for (const m of layout.displayMeshes) scene.add(m);
  if (kit.staticAtlas.overflow) console.warn('[world] static atlas overflowed — enlarge it');
  // everything static: freeze matrices
  scene.traverse((o) => {
    if (o !== room.beacon && o.parent !== room.beacon) {
      o.matrixAutoUpdate = false;
    }
  });
  scene.updateMatrixWorld(true);

  /* ---------------- player ---------------- */
  const player = new Player(camera, canvas, sim, kit.interactables, room.colliders);

  /* ---------------- post ---------------- */
  let bloomOn = true;
  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;
  function buildComposer() {
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    // high-DPI screens are already supersampled; skip MSAA there to keep fill-rate sane
    const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: pr >= 1.4 ? 0 : 4 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.45, 0.92);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  function resize() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPR));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
      bloom?.resolution.set(w / 2, h / 2);
    }
  }
  window.addEventListener('resize', resize);
  resize();
  buildComposer();
  resize();

  /* ---------------- atmosphere ---------------- */
  let time = 0;
  let shake = 0;
  let rumble = 0;
  let flicker = 1;
  let flickerT = 0;
  let fps = 60;
  let fpsAcc = 0;
  let fpsN = 0;
  const trofferBase = room.trofferMat.color.clone();
  const red = new THREE.Color(1, 0.12, 0.08);
  const amber = new THREE.Color(1, 0.55, 0.08);
  const warm = new THREE.Color(0xfff0dc);
  const hemiSky = new THREE.Color(0xfff4e2);
  const tmpC = new THREE.Color();

  bus.on('sim', (e) => {
    if (e.type === 'trip') shake = Math.max(shake, 0.25);
    else if (e.type === 'turbine-trip') shake = Math.max(shake, 0.35);
    else if (e.type === 'si') shake = Math.max(shake, 0.2);
    else if (e.type === 'catastrophe') {
      shake = Math.max(shake, e.kind === 'steam-explosion' || e.kind === 'vessel-rupture' || e.kind === 'turbine-missile' ? 2.2 : 1.2);
      rumble = 0.18;
    } else if (e.type === 'meltdown') rumble = Math.max(rumble, 0.12);
  });

  function atmosphere(s: PlantState, dt: number) {
    const cat = !!s.catastrophe;
    const damaged = s.coreStatus && s.coreStatus !== 'ok';
    const blackout = s.offsitePower === false && !(s.dieselGeneratorsRunning ?? []).some(Boolean);
    const alarmState = s.reactorTripped || ann.activeTrips > 0 || s.siActuated || cat || damaged;
    // room light level
    let level = 1;
    let emergency = 0;
    if (blackout) {
      level = 0.18;
      emergency = 0.5;
    }
    if (cat) {
      level = 0.12;
      emergency = 1;
    }
    if (cat || damaged || blackout) {
      flickerT -= dt;
      if (flickerT <= 0) {
        flickerT = 0.04 + Math.random() * (cat ? 0.25 : 0.9);
        flicker = Math.random() < (cat ? 0.45 : 0.15) ? 0.15 + Math.random() * 0.5 : 1;
      }
    } else flicker = 1;
    const L = level * flicker;
    room.trofferMat.color.copy(trofferBase).multiplyScalar(Math.max(0.04, L));
    hemi.intensity = baseLights.hemi * (0.25 + 0.75 * L);
    sun.intensity = baseLights.sun * L;
    hemi.color.copy(hemiSky).lerp(red, emergency * 0.7);
    // beacon
    room.beaconBeams.visible = !!alarmState;
    const bc = cat || damaged || s.siActuated ? red : amber;
    if (alarmState) {
      room.beacon.rotation.y += dt * 5.5;
      room.beacon.updateMatrixWorld(true);
      (room.beaconBeams.material as THREE.MeshBasicMaterial).color.copy(bc);
      room.beaconLamp.color.copy(bc).multiplyScalar(3);
      const pulse = 0.5 + 0.5 * Math.cos(room.beacon.rotation.y * 2);
      tmpC.copy(warm).lerp(bc, 0.35 + 0.4 * pulse);
      fill.color.copy(tmpC);
      fill.intensity = baseLights.fill * (0.6 + 0.6 * pulse) * Math.max(0.35, L);
    } else {
      room.beaconLamp.color.setRGB(0.16, 0.03, 0.02);
      fill.color.copy(warm).lerp(red, emergency);
      fill.intensity = baseLights.fill * Math.max(0.3, L);
    }
    if (emergency > 0) {
      fill.color.copy(red);
      fill.intensity = 0.7 + 0.25 * Math.sin(time * 2.0);
    }
    // camera shake
    if (cat) rumble = Math.max(rumble, 0.08);
    shake = Math.max(rumble, shake * Math.exp(-2.2 * dt));
  }

  function applyShake() {
    if (shake < 0.002) return;
    const a = shake * 0.025;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
    camera.position.z += (Math.random() - 0.5) * a;
    camera.rotation.x += (Math.random() - 0.5) * a * 0.6;
    camera.rotation.z += (Math.random() - 0.5) * a * 0.4;
    camera.updateMatrixWorld();
  }

  /* ---------------- API ---------------- */
  let lastInfo = { calls: 0, triangles: 0, textures: 0, geometries: 0, fps: 60 };

  const api: WorldApi = {
    update(dt: number) {
      time += dt;
      fpsAcc += dt;
      fpsN++;
      if (fpsAcc > 0.5) {
        fps = fpsN / fpsAcc;
        fpsAcc = 0;
        fpsN = 0;
      }
      player.update(dt);
      const s = sim.state;
      if (!s) return;
      kit.update(s, dt, time, true);
      ann.update(s, time, true);
      layout.hist.sample(s);
      layout.crtA.update(dt, s, false);
      layout.crtB.update(dt, s, false);
      layout.chart.update(dt, s);
      atmosphere(s, dt);
      applyShake();
    },
    render() {
      renderer.info.reset();
      if (bloomOn && composer) composer.render();
      else renderer.render(scene, camera);
      const i = renderer.info.render;
      lastInfo = { calls: i.calls, triangles: i.triangles, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries, fps };
    },
    lockPointer() {
      player.lock();
    },
    unlockPointer() {
      player.unlock();
    },
    setBloom(on: boolean) {
      bloomOn = on;
    },
    setQuality(q) {
      maxPR = q === 'low' ? 1 : 1.5;
      bloomOn = q !== 'low';
      resize();
    },
    getInfo() {
      return lastInfo;
    },
    setView(x, z, yaw, pitch, focus) {
      player.pos.set(x, 0, z);
      player.yaw = yaw;
      player.pitch = pitch;
      if (focus !== undefined) player.focus = focus;
      player.update(1);
    },
    setFreeInput(on) {
      player.freeInput = on;
    },
    getTarget() {
      return player.target?.id ?? null;
    },
    debugLookAt(id, dist = 1.0) {
      const it = kit.interactables.find((x) => x.id === id);
      if (!it) return false;
      const m = it.inv.clone().invert();
      const n = new THREE.Vector3().setFromMatrixColumn(m, 2);
      n.y = 0;
      n.normalize();
      const px = it.center.x + n.x * dist;
      const pz = it.center.z + n.z * dist;
      const dx = it.center.x - px;
      const dz = it.center.z - pz;
      const dy = it.center.y - 1.65;
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.atan2(dy, Math.hypot(dx, dz));
      player.pos.set(px, 0, pz);
      player.yaw = yaw;
      player.pitch = pitch;
      player.update(0.016);
      return true;
    },
    debugActivate(id, button = 0) {
      const it = kit.interactables.find((x) => x.id === id);
      if (!it) return false;
      if (button === 0) (it.primary ?? (() => it.holdStart?.(1)))();
      else (it.secondary ?? (() => it.holdStart?.(-1)))();
      return true;
    },
  };
  (api as any)._debug = { renderer, scene, camera, kit, player, ann, layout, room };
  return api;
}
