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

const state = createInitialState();
state.x_W.set(-700, FLIGHT_MODEL.groundY, 0);

const controls = createNeutralControls();

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.5,
  60_000,
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
