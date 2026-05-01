import * as THREE from 'three';
import { World, WORLD_CONFIG } from './world/index.js';
import { Aircraft } from './aircraft/index.js';
import {
  advance,
  createInitialState,
  createNeutralControls,
  FLIGHT_MODEL,
} from './physics/index.js';

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

// Chase-camera scratch state.
const chaseOffset = new THREE.Vector3(-18, 4.5, 0);
const chaseTargetLookAt = new THREE.Vector3();
const chaseDesiredPos = new THREE.Vector3();

function updateChaseCamera(dt: number): void {
  const offsetWorld = chaseOffset.clone().applyQuaternion(aircraft.group.quaternion);
  chaseDesiredPos.copy(aircraft.group.position).add(offsetWorld);
  const lerp = 1 - Math.exp(-dt * 5);
  camera.position.lerp(chaseDesiredPos, lerp);
  chaseTargetLookAt.copy(aircraft.group.position);
  camera.lookAt(chaseTargetLookAt);
}

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
  advance(state, dt, controls, getGroundHeight);
  syncAircraftToState();
  aircraft.update(dt);
  world.update(dt);
  updateChaseCamera(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

camera.position.set(-WORLD_CONFIG.runway.length / 2 - 30, 6, 0);
camera.lookAt(aircraft.group.position);
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
    scene: THREE.Scene;
  };
}
globalThis.FLISYM = { state, controls, aircraft, world, camera, scene };
