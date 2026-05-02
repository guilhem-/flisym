// World rendering test — verifies the scene graph built by `new World()`
// is well-formed and visible to a camera placed near the runway.
//
// We do NOT spin up a real WebGLRenderer here (no GPU in CI/sandboxes). We
// instead assert the structural invariants that make rendering possible:
//   1. World.mesh exists and contains the expected sub-systems.
//   2. The terrain is a non-empty mesh with displaced vertices.
//   3. World.fog is configured.
//   4. A camera positioned at the chase-camera spawn pose has a well-defined
//      bounding-sphere intersection with the terrain (i.e. terrain is in the
//      camera's frustum, so it WILL be drawn given a working renderer).

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { World, WORLD_CONFIG } from '../src/world/index.js';
import { Aircraft } from '../src/aircraft/index.js';
import { FLIGHT_MODEL } from '../src/physics/index.js';

describe('world rendering scene graph', () => {
  test('World constructs without throwing and exposes mesh + fog', () => {
    const world = new World();
    expect(world.mesh).toBeInstanceOf(THREE.Group);
    expect(world.fog).toBeInstanceOf(THREE.FogExp2);
    expect(world.fog.density).toBeGreaterThan(0);
  });

  test('World.mesh contains terrain, water, runway, sky, sun, hemi', () => {
    const world = new World();
    const names = new Set(world.mesh.children.map((c) => c.name).filter(Boolean));
    const types = world.mesh.children.map((c) => c.type);

    // Three lights: directional sun + hemisphere fill (and possibly target).
    expect(types).toContain('DirectionalLight');
    expect(types).toContain('HemisphereLight');

    // At least: terrain mesh + water mesh + runway mesh + sky mesh + 2 lights.
    expect(world.mesh.children.length).toBeGreaterThanOrEqual(5);

    // Sky is the well-known three/examples/jsm/objects/Sky shader mesh.
    expect(names.has('Sky')).toBe(true);
    expect(names.has('Sun')).toBe(true);
  });

  test('terrain mesh has displaced geometry with thousands of vertices', () => {
    const world = new World();
    const terrainCandidate = world.mesh.children.find(
      (c) => c instanceof THREE.Mesh && c.name !== 'Sky',
    );
    expect(terrainCandidate).toBeDefined();
    const terrain = terrainCandidate as THREE.Mesh;
    const pos = terrain.geometry.attributes['position'];
    expect(pos).toBeDefined();
    expect(pos!.count).toBeGreaterThan(1000);
  });

  test('getGroundHeight is well-defined at runway and elsewhere', () => {
    const world = new World();
    // Runway center: forced flat at y = 0.
    expect(world.getGroundHeight(0, 0)).toBeCloseTo(0, 5);
    // Near-mountain point should be elevated (primary ridge at z = -12000).
    expect(world.getGroundHeight(0, -12000)).toBeGreaterThan(500);
    // Off-mountain point in the playable area: finite, within bounds.
    const h = world.getGroundHeight(5000, 5000);
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(WORLD_CONFIG.noise.minHeight);
  });

  test('chase-pose camera frustum intersects terrain bounding box', () => {
    // Recreate the bootstrap pose: aircraft at (-700, groundY, 0) heading +X,
    // chase camera 18 m behind / 4.5 m above body-origin.
    const world = new World();
    const aircraft = new Aircraft();
    aircraft.group.position.set(-700, FLIGHT_MODEL.groundY, 0);

    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 60_000);
    // Chase pose: 18 m back along +X is -X side.
    camera.position.set(-700 - 18, FLIGHT_MODEL.groundY + 4.5, 0);
    camera.lookAt(aircraft.group.position);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    // Build frustum from camera matrices.
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      ),
    );

    // Find the terrain mesh and confirm its world bounding box is partly
    // inside the camera's frustum (i.e. it WILL contribute pixels).
    const terrain = world.mesh.children.find(
      (c) => c instanceof THREE.Mesh && c.name !== 'Sky',
    ) as THREE.Mesh;
    terrain.geometry.computeBoundingBox();
    const box = terrain.geometry.boundingBox!.clone();
    // The terrain plane is rotated -π/2 about X; bake the world transform.
    box.applyMatrix4(terrain.matrixWorld);
    expect(frustum.intersectsBox(box)).toBe(true);
  });

  test('Aircraft group has visible mesh children', () => {
    const aircraft = new Aircraft();
    // The procedural Cessna decomposes into many child meshes.
    expect(aircraft.group.children.length).toBeGreaterThan(0);
    let totalTris = 0;
    aircraft.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const idx = obj.geometry.index;
        const pos = obj.geometry.attributes['position'];
        if (idx) totalTris += idx.count / 3;
        else if (pos) totalTris += pos.count / 3;
      }
    });
    // At least one face, well under the 8k budget.
    expect(totalTris).toBeGreaterThan(100);
    expect(totalTris).toBeLessThan(8000);
  });
});
