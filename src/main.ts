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
import { NetClient } from './net/index.js';
import { checkWebGL, showWebGLUnavailableOverlay } from './webgl-check.js';
import {
  ModeSwitcher,
  getDefaultModeId,
  type ModeContext,
  type ModeId,
  type ModeTelemetryEvent,
} from './modes/index.js';
import { seedRNG } from './ai/index.js';

const FLISYM_GLOBALS = globalThis as typeof globalThis & {
  __FLISYM_READY__?: boolean;
  __FLISYM_WEBGL_OK__?: boolean;
  __FLISYM_FRAMES__?: number;
};
FLISYM_GLOBALS.__FLISYM_READY__ = false;
FLISYM_GLOBALS.__FLISYM_WEBGL_OK__ = false;
FLISYM_GLOBALS.__FLISYM_FRAMES__ = 0;

// Bail out with a friendly overlay before constructing anything heavy if the
// host can't give us a WebGL context.
const webglProbe = checkWebGL();
if (!webglProbe.ok) {
  showWebGLUnavailableOverlay(webglProbe.reason ?? 'unknown');
  throw new Error(`FLISYM: WebGL unavailable — ${webglProbe.reason ?? 'unknown'}`);
}
FLISYM_GLOBALS.__FLISYM_WEBGL_OK__ = true;

// --- ?seed= and ?mode= URL params ----------------------------------------
const urlParams = new URLSearchParams(window.location.search);
const seedParam = urlParams.get('seed');
const SESSION_SEED = (() => {
  if (seedParam != null) {
    const n = Number(seedParam);
    if (Number.isFinite(n)) return Math.floor(n) | 0;
  }
  return Date.now() & 0xffffffff;
})();
seedRNG(SESSION_SEED);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b6e8);

const world = new World();
scene.add(world.mesh);
scene.fog = world.fog;

const aircraft = new Aircraft();
scene.add(aircraft.group);

// Spawn 100 ft AGL above the runway threshold, heading east at cruise.
const SPAWN_ALT_FT = 100;
const SPAWN_ALT_M = SPAWN_ALT_FT * 0.3048;
const SPAWN_SPEED_MS = 50;
const SPAWN_THROTTLE = 0.7;

const state = createInitialState();
state.x_W.set(-700, FLIGHT_MODEL.groundY + SPAWN_ALT_M, 0);
state.v_W.set(SPAWN_SPEED_MS, 0, 0);
state.throttle = SPAWN_THROTTLE;
state.onGround = false;

const controls = createNeutralControls();
controls.throttleCmd = SPAWN_THROTTLE;

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  2,
  30_000,
);

// Detect software WebGL (SwiftShader, llvmpipe).
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

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: !isSoftwareRenderer,
    powerPreference: 'high-performance',
    logarithmicDepthBuffer: true,
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  showWebGLUnavailableOverlay(`WebGLRenderer threw: ${msg}`);
  throw e;
}
renderer.setPixelRatio(isSoftwareRenderer ? 1 : Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.setAttribute('data-testid', 'flisym-canvas');
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

setWindFn((altitude, time) => getWind(altitude, time));

const engineSound = new EngineSound();
window.addEventListener(
  'keydown',
  () => {
    engineSound.start();
  },
  { once: true },
);

let worldClock = 14.0;
const TIME_SPEED_HOURS_PER_SEC = 1.0 / 3600;
window.addEventListener('time:set', (e: Event) => {
  const detail = (e as CustomEvent<number>).detail;
  if (typeof detail === 'number' && Number.isFinite(detail)) {
    worldClock = detail;
  }
});

// --- Multiplayer presence (lazy connect; M key) --------------------------
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

// --- Mode lifecycle ------------------------------------------------------
function emitTelemetry(event: ModeTelemetryEvent): void {
  if (import.meta.env.DEV) {
    // Lightweight per-event log so debugging modes is observable.
    // eslint-disable-next-line no-console
    console.debug('[mode]', event);
  }
}

const modeCtx: ModeContext = {
  scene,
  world,
  hud,
  cameraRig,
  input,
  playerState: state,
  playerControls: controls,
  net,
  seed: SESSION_SEED,
  emit: emitTelemetry,
};

const switcher = new ModeSwitcher(modeCtx);
switcher.setMode(getDefaultModeId());
hud.setMode(switcher.status());

// Mode hotkeys 1..4 (only when not over a focused input). Reserved by
// docs/test-strategy.md §3.2 so Playwright can switch via keyboard.
const MODE_HOTKEYS: Record<string, ModeId> = {
  '1': 'free-flight',
  '2': 'time-trial',
  '3': 'dogfight',
  '4': 'strike-mission',
};
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const next = MODE_HOTKEYS[e.key];
  if (!next) return;
  if (switcher.getCurrent()?.meta.id === next) return;
  try {
    switcher.setMode(next);
    hud.setMode(switcher.status());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[mode] failed to switch to ${next}:`, err);
  }
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

function verifyRenderOnce(): void {
  if (renderVerified) return;
  renderVerifyAttempts += 1;
  if (renderVerifyAttempts < 3) return;
  try {
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const cx = Math.floor(renderer.domElement.width / 2);
    const cy = Math.floor(renderer.domElement.height / 2);
    gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const total = (px[0] ?? 0) + (px[1] ?? 0) + (px[2] ?? 0);
    if (total === 0) {
      showWebGLUnavailableOverlay(
        `Renderer produced black frame after ${renderVerifyAttempts} attempts (center pixel [0,0,0]). The WebGL context exists but isn't drawing — most likely Chromium's deprecated software-WebGL fallback. Try --use-angle=swiftshader --enable-unsafe-swiftshader.`,
      );
    }
    renderVerified = true;
  } catch {
    renderVerified = true;
  }
}

function animate(): void {
  const dt = Math.min(clock.getDelta(), 0.1);
  input.update(dt, controls);
  advance(state, dt, controls, getGroundHeight);

  // Mode tick happens after physics so modes (Time Trial, Dogfight, Strike)
  // see fresh state. Mode also drives its own HUD pushes.
  switcher.update(dt);
  hud.update(state);
  hud.setMode(switcher.status());

  syncAircraftToState();
  aircraft.update(dt);

  worldClock = (worldClock + dt * TIME_SPEED_HOURS_PER_SEC) % 24;
  world.setTimeOfDay(worldClock);
  world.update(dt);

  engineSound.update(
    state.throttle,
    RPM_IDLE + (RPM_FULL - RPM_IDLE) * state.throttle,
    state.stallFlag,
  );

  aircraftVelocity.copy(state.v_W);
  cameraRig.update(dt, aircraft.group, aircraftVelocity);

  net.update(state, dt);

  renderer.render(scene, camera);
  verifyRenderOnce();

  FLISYM_GLOBALS.__FLISYM_FRAMES__ = (FLISYM_GLOBALS.__FLISYM_FRAMES__ ?? 0) + 1;
  if (!FLISYM_GLOBALS.__FLISYM_READY__) FLISYM_GLOBALS.__FLISYM_READY__ = true;

  requestAnimationFrame(animate);
}

animate();

// --- Debug surface --------------------------------------------------------
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
    switcher: ModeSwitcher;
    seed: number;
    scenario?: {
      dogfightTrainer: () => void;
      timeTrialTrainer: () => void;
      reset: () => void;
    };
  };
}

const baseDebug = {
  state,
  controls,
  aircraft,
  world,
  camera,
  cameraRig,
  scene,
  switcher,
  seed: SESSION_SEED,
};

if (import.meta.env.DEV) {
  // Dev-only scenario trainers used by Playwright specs (docs/test-strategy.md §3.2).
  globalThis.FLISYM = {
    ...baseDebug,
    scenario: {
      dogfightTrainer(): void {
        switcher.setMode('dogfight');
        hud.setMode(switcher.status());
        // Bring the bot in close so a Playwright pulse-fire reliably scores.
        state.x_W.set(0, 600, 0);
        state.v_W.set(50, 0, 0);
        state.q.identity();
        state.throttle = 0.9;
      },
      timeTrialTrainer(): void {
        switcher.setMode('time-trial');
        hud.setMode(switcher.status());
        // Gate 0 is at world (1500, 250, 0) heading +X (src/challenge/gates.ts).
        // Spawn ~100 m short, on centerline, at gate altitude + cruise speed
        // so the player crosses gate 0 within ~2 s with no input required.
        state.x_W.set(1400, 250, 0);
        state.v_W.set(60, 0, 0);
        state.q.identity();
        state.throttle = 0.85;
      },
      reset(): void {
        switcher.setMode(getDefaultModeId());
        hud.setMode(switcher.status());
        state.x_W.set(-700, FLIGHT_MODEL.groundY + SPAWN_ALT_M, 0);
        state.v_W.set(SPAWN_SPEED_MS, 0, 0);
        state.q.identity();
        state.throttle = SPAWN_THROTTLE;
      },
    },
  };
} else {
  globalThis.FLISYM = baseDebug;
}
