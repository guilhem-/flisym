import * as THREE from 'three';
import { World } from './world/index.js';
import { Aircraft } from './aircraft/index.js';
import {
  advance,
  createInitialState,
  createNeutralControls,
  FLIGHT_MODEL,
} from './physics/index.js';
import { KeyboardInput } from './input/index.js';
import { HUD } from './hud/index.js';
import { CameraRig } from './camera/index.js';

const scene = new THREE.Scene();

const world = new World();
scene.add(world.mesh);
scene.fog = world.fog;

const aircraft = new Aircraft();
scene.add(aircraft.group);

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
  syncAircraftToState();
  aircraft.update(dt);
  world.update(dt);
  aircraftVelocity.copy(state.v_W);
  cameraRig.update(dt, aircraft.group, aircraftVelocity);
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
