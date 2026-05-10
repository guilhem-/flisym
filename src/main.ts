import * as THREE from 'three';
import { World } from './world/index.js';
import { getWind } from './world/wind.js';
import { Aircraft } from './aircraft/index.js';
import {
  advance,
  createInitialState,
  createNeutralControls,
  setWindFn,
  FLIGHT_MODEL,
} from './physics/index.js';
import { KeyboardInput } from './input/index.js';
import { HUD } from './hud/index.js';
import { CameraRig } from './camera/index.js';
import { EngineSound } from './audio/engine.js';
import { GateCourse } from './challenge/index.js';
import { NetClient } from './net/index.js';
import { checkWebGL, showWebGLUnavailableOverlay } from './webgl-check.js';

// Bail out with a friendly overlay before constructing anything heavy if the
// host can't give us a WebGL context (e.g. headless Chrome without
// --use-angle=swiftshader, GPU blocklisted, no Mesa drivers).
const webglProbe = checkWebGL();
if (!webglProbe.ok) {
  showWebGLUnavailableOverlay(webglProbe.reason ?? 'unknown');
  throw new Error(`FLISYM: WebGL unavailable — ${webglProbe.reason ?? 'unknown'}`);
}

const scene = new THREE.Scene();
// Fallback sky color so the canvas never reads pure black if the Sky shader
// fails to draw on a given frame (e.g. before the first sun position is set).
scene.background = new THREE.Color(0x87b6e8);

const world = new World();
scene.add(world.mesh);
scene.fog = world.fog;

const aircraft = new Aircraft();
scene.add(aircraft.group);

const course = new GateCourse();
scene.add(course.mesh);

// Spawn in flight at ~100 ft AGL above the runway threshold, on a +X heading
// (runway alignment), trimmed for cruise speed. Cessna-172N cruise ≈ 110 kt
// (≈ 56.6 m/s); pick 50 m/s as a comfortable hands-off speed slightly below
// cruise so the user has margin both ways.
const SPAWN_ALT_FT = 100;
const SPAWN_ALT_M = SPAWN_ALT_FT * 0.3048; // 30.48 m
const SPAWN_SPEED_MS = 50;                 // ≈ 97 kt — well above stall
const SPAWN_THROTTLE = 0.7;                // cruise-ish throttle

const state = createInitialState();
state.x_W.set(-700, FLIGHT_MODEL.groundY + SPAWN_ALT_M, 0);
state.v_W.set(SPAWN_SPEED_MS, 0, 0);       // body +X is forward → world +X here
state.throttle = SPAWN_THROTTLE;
state.onGround = false;

const controls = createNeutralControls();
controls.throttleCmd = SPAWN_THROTTLE;

// Camera near/far chosen to keep the 24-bit depth buffer usable.
//   near=2 / far=30_000 → 15,000:1 ratio. Was 0.5/60_000 = 120,000:1 which
//   caused obvious z-fighting on distant terrain. With FogExp2 density
//   0.00012 and a fade to ~99% by 30 km, the old 60 km far plane was
//   wasted depth precision the user couldn't see anyway.
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  2,
  30_000,
);

// Detect software WebGL (SwiftShader, llvmpipe). On software rasterizers
// MSAA + 2× pixel ratio is the difference between 60 fps and 6 fps, so we
// skip both. Hardware GPUs get the full quality path.
let isSoftwareRenderer = false;
const probeCanvas = document.createElement('canvas');
const probeGL =
  (probeCanvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
  (probeCanvas.getContext('webgl') as WebGLRenderingContext | null);
if (probeGL !== null) {
  const dbg = probeGL.getExtension('WEBGL_debug_renderer_info');
  const rendererStr = dbg
    ? String(probeGL.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    : '';
  isSoftwareRenderer = /SwiftShader|llvmpipe|Software|Microsoft Basic|swrast/i.test(
    rendererStr,
  );
}

// Even though checkWebGL() succeeded above, the WebGLRenderer constructor can
// still throw on edge cases (e.g. context lost mid-init). Catch and surface.
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({
    // antialias and pixelRatio>1 are fine on real GPUs but cripple software
    // rasterizers — skip both when we know we're on one.
    antialias: !isSoftwareRenderer,
    powerPreference: 'high-performance',
    // logarithmicDepthBuffer trades a small per-fragment cost for vastly
    // better depth precision over 30 km of terrain. Eliminates the residual
    // z-fighting on the runway-vs-terrain seam at long distances.
    logarithmicDepthBuffer: true,
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  showWebGLUnavailableOverlay(`WebGLRenderer threw: ${msg}`);
  throw e;
}
// Cap pixel ratio at 1 on software WebGL (saves 4× fragment work on retina).
// On hardware GPUs allow up to 2× for crispness without going further.
renderer.setPixelRatio(isSoftwareRenderer ? 1 : Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const getGroundHeight = (x: number, z: number): number =>
  world.getGroundHeight(x, z);

const input = new KeyboardInput();
const hud = new HUD();
document.body.appendChild(hud.root);

const cameraRig = new CameraRig(camera);
cameraRig.attachInput();
cameraRig.setMode('chase', true);

const aircraftVelocity = new THREE.Vector3();

const RPM_IDLE = 700;
const RPM_FULL = 2400;

// --- Wind layer ----------------------------------------------------------
// Hand the physics step a sampler so it can compute air-relative velocity.
setWindFn((altitude, time) => getWind(altitude, time));

// --- Engine sound (lazy-start on first user gesture) ---------------------
const engineSound = new EngineSound();
window.addEventListener(
  'keydown',
  () => {
    engineSound.start();
  },
  { once: true },
);

// --- Time-of-day clock ---------------------------------------------------
// `worldClock` in hours (0..24). Per the brief: speed = 1.0 → 1 in-game
// second per real second. One in-game second = 1/3600 hour, so we advance
// `worldClock` by `dt * TIME_SPEED_HOURS_PER_SEC`.
let worldClock = 14.0;
const TIME_SPEED_HOURS_PER_SEC = 1.0 / 3600;
window.addEventListener('time:set', (e: Event) => {
  const detail = (e as CustomEvent<number>).detail;
  if (typeof detail === 'number' && Number.isFinite(detail)) {
    worldClock = detail;
  }
});

// --- Multiplayer presence (lazy connect) ---------------------------------
// Press M once to connect to the presence server. URL can be overridden via
// `VITE_FLISYM_WS_URL` at build time; defaults to localhost:3030.
const net = new NetClient();
scene.add(net.getRoot());
const wsUrl =
  (import.meta.env as { VITE_FLISYM_WS_URL?: string } | undefined)
    ?.VITE_FLISYM_WS_URL ?? 'ws://localhost:3030';
let netConnected = false;
const onMKey = (e: KeyboardEvent): void => {
  if (netConnected) return;
  if (e.key === 'm' || e.key === 'M') {
    netConnected = true;
    net.connect(wsUrl);
    window.removeEventListener('keydown', onMKey);
  }
};
window.addEventListener('keydown', onMKey);

// Challenge: track whether the finish overlay has been shown for this run.
let finishShown = false;
window.addEventListener('challenge:reset', () => {
  course.reset();
  hud.hideFinishOverlay();
  finishShown = false;
});

function syncAircraftToState(): void {
  aircraft.group.position.copy(state.x_W);
  aircraft.group.quaternion.copy(state.q);
  aircraft.setControls({
    aileron: state.delta_a * 0.35,
    elevator: state.delta_e * 0.35,
    rudder: state.delta_r * 0.4,
    flaps: state.delta_f * 0.5,
  });
  aircraft.setPropellerRPM(RPM_IDLE + (RPM_FULL - RPM_IDLE) * state.throttle);
}

const clock = new THREE.Clock();
let renderVerified = false;
let renderVerifyAttempts = 0;

/**
 * Post-render sanity check: after the first few frames, sample the framebuffer
 * center pixel. If it's all-black despite `scene.background` being a non-black
 * color, the renderer constructed a context but isn't actually drawing —
 * Chromium's deprecated software-WebGL fallback, headless GPU process failure,
 * or similar. Show the overlay so the user sees a real signal.
 */
function verifyRenderOnce(): void {
  if (renderVerified) return;
  renderVerifyAttempts += 1;
  // Wait a couple of frames for the camera snap and clear buffers to settle.
  if (renderVerifyAttempts < 3) return;
  try {
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const cx = Math.floor(renderer.domElement.width / 2);
    const cy = Math.floor(renderer.domElement.height / 2);
    gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const total = (px[0] ?? 0) + (px[1] ?? 0) + (px[2] ?? 0);
    if (total === 0) {
      // Pure black despite scene.background = horizon blue → renderer can't
      // actually paint. Surface to user.
      showWebGLUnavailableOverlay(
        `Renderer produced black frame after ${renderVerifyAttempts} attempts (center pixel [0,0,0]). The WebGL context exists but isn't drawing — most likely Chromium's deprecated software-WebGL fallback. Try --use-angle=swiftshader --enable-unsafe-swiftshader.`,
      );
    }
    renderVerified = true;
  } catch {
    // readPixels on the default framebuffer can fail silently in some hosts.
    // If we can't probe, give up gracefully — the overlay won't fire.
    renderVerified = true;
  }
}

function animate(): void {
  const dt = Math.min(clock.getDelta(), 0.1);
  input.update(dt, controls);
  advance(state, dt, controls, getGroundHeight);
  hud.update(state);

  // Challenge gate course: tick logic and surface state to HUD.
  const gs = course.update(state.x_W, state.v_W, dt);
  hud.setChallenge(gs);
  if (gs.finished && !finishShown) {
    hud.showFinishOverlay(gs.courseTime, gs.missed);
    finishShown = true;
  }

  syncAircraftToState();
  aircraft.update(dt);

  // Advance world clock and drive the sun/sky/fog tint each frame.
  worldClock = (worldClock + dt * TIME_SPEED_HOURS_PER_SEC) % 24;
  world.setTimeOfDay(worldClock);
  world.update(dt);

  // Engine audio follows propeller RPM and stall flag.
  engineSound.update(
    state.throttle,
    RPM_IDLE + (RPM_FULL - RPM_IDLE) * state.throttle,
    state.stallFlag,
  );

  aircraftVelocity.copy(state.v_W);
  cameraRig.update(dt, aircraft.group, aircraftVelocity);

  // Multiplayer: send our state at 30 Hz and lerp peer aircraft each frame.
  net.update(state, dt);

  renderer.render(scene, camera);
  verifyRenderOnce();
  requestAnimationFrame(animate);
}

animate();

// Expose for debugging/HUD/Camera modules to wire into.
declare global {
  // eslint-disable-next-line no-var
  var FLISYM: {
    state: typeof state;
    controls: typeof controls;
    aircraft: Aircraft;
    world: World;
    camera: THREE.PerspectiveCamera;
    cameraRig: CameraRig;
    scene: THREE.Scene;
  };
}
globalThis.FLISYM = { state, controls, aircraft, world, camera, cameraRig, scene };
