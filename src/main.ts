import * as THREE from 'three';
import { World, WORLD_CONFIG } from './world/index.js';

// Scene
const scene = new THREE.Scene();

// World — terrain, water, runway, sky, sun, hemi.
const world = new World();
scene.add(world.mesh);
scene.fog = world.fog;

// Camera — 200 m above and 600 m behind the runway approach threshold,
// looking down the runway (toward +X). Runway threshold at x = -750.
const RUNWAY_HALF_LENGTH = WORLD_CONFIG.runway.length / 2;
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.5,
  60_000,
);
camera.position.set(-RUNWAY_HALF_LENGTH - 600, 200, 0);
camera.lookAt(0, 0, 0);

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Animate
const clock = new THREE.Clock();
function animate(): void {
  const dt = clock.getDelta();
  world.update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
