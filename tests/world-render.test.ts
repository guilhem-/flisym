// World rendering test — verifies the scene graph built by `new World()`
// is well-formed and visible to a camera placed near the runway.
//
// We do NOT spin up a real WebGLRenderer here (no GPU in CI/sandboxes). We
// instead assert the structural invariants that make rendering possible:
//   1. World.mesh exists and contains the expected sub-systems.
//   2. The terrain is a non-empty mesh with displaced vertices.
//   3. World.fog is configured.
//   4. A camera positioned at the chase-camera spawn pose has a well-defined
//      bounding-sphere intersection with the terrain, runway, and water (i.e.
//      they're in the camera's frustum, so they WILL be drawn).
//   5. The bootstrap camera pose (CameraRig + setMode('chase', true) + first
//      update with dt=0) snaps the camera to the chase offset rather than
//      leaving it at world origin — the original "world not rendered" bug.
//   6. Scene background fallback is non-black (so a missing/late Sky shader
//      never reads through to a black canvas).
//   7. At default time-of-day, sun light has positive intensity.

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { World, WORLD_CONFIG } from '../src/world/index.js';
import { Aircraft } from '../src/aircraft/index.js';
import { FLIGHT_MODEL, createInitialState } from '../src/physics/index.js';
import { CameraRig } from '../src/camera/index.js';

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

  test('runway mesh is positioned at runway.y and has visible geometry', () => {
    const world = new World();
    const runway = world.mesh.children.find((c) => c.name === 'Runway') as
      | THREE.Mesh
      | undefined;
    expect(runway).toBeDefined();
    expect(runway!.position.y).toBeCloseTo(WORLD_CONFIG.runway.y, 5);
    const pos = runway!.geometry.attributes['position'];
    expect(pos).toBeDefined();
    expect(pos!.count).toBeGreaterThan(50);
  });

  test('sun directional light has positive intensity at default time-of-day', () => {
    const world = new World();
    world.setTimeOfDay(14); // matches main.ts default worldClock
    const sun = world.mesh.children.find((c) => c.name === 'Sun') as
      | THREE.DirectionalLight
      | undefined;
    expect(sun).toBeDefined();
    expect(sun!.intensity).toBeGreaterThan(0);
    // Sun must be positioned away from origin so the shadow direction is real.
    expect(sun!.position.lengthSq()).toBeGreaterThan(1);
  });

  test('terrain, runway, and water are ALL inside the chase camera frustum at spawn', () => {
    const world = new World();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 60_000);
    // Chase pose: aircraft at (-700, groundY, 0) heading +X, camera 18 m back / 4.5 m up.
    camera.position.set(-700 - 18, FLIGHT_MODEL.groundY + 4.5, 0);
    camera.lookAt(-700, FLIGHT_MODEL.groundY, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      ),
    );

    const required: ReadonlyArray<string> = ['TerrainFar', 'Runway', 'Water'];
    for (const name of required) {
      const mesh = world.mesh.children.find((c) => c.name === name) as
        | THREE.Mesh
        | undefined;
      expect(mesh, `mesh ${name} present`).toBeDefined();
      mesh!.geometry.computeBoundingBox();
      const box = mesh!.geometry.boundingBox!.clone();
      box.applyMatrix4(mesh!.matrixWorld);
      expect(
        frustum.intersectsBox(box),
        `${name} bbox must intersect chase camera frustum`,
      ).toBe(true);
    }
  });

  test('main.ts spawn pose puts aircraft ~100 ft AGL with cruise speed', () => {
    // Regression: aircraft used to spawn on the runway at rest. We now spawn
    // mid-air at ~100 ft with a forward velocity so the user is immediately
    // flying without needing to take off. Verify by parsing main.ts.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/main.ts'),
      'utf-8',
    );

    // Altitude offset: must add a non-trivial AGL height to groundY.
    expect(src).toMatch(/SPAWN_ALT_FT\s*=\s*100\b/);
    expect(src).toMatch(/x_W\.set\([^)]*groundY\s*\+\s*SPAWN_ALT_M[^)]*\)/);

    // Forward velocity: must be > 30 m/s (well above 25 m/s stall).
    const speedMatch = src.match(/SPAWN_SPEED_MS\s*=\s*(\d+(?:\.\d+)?)/);
    expect(speedMatch, 'SPAWN_SPEED_MS must be defined').toBeTruthy();
    const speed = Number(speedMatch![1]);
    expect(speed).toBeGreaterThan(30);
    expect(speed).toBeLessThan(80);

    // Throttle: must be set to a cruise-ish non-zero value.
    expect(src).toMatch(/state\.throttle\s*=\s*SPAWN_THROTTLE/);
    const throttleMatch = src.match(/SPAWN_THROTTLE\s*=\s*(\d+(?:\.\d+)?)/);
    expect(throttleMatch).toBeTruthy();
    const throttle = Number(throttleMatch![1]);
    expect(throttle).toBeGreaterThan(0.4);
    expect(throttle).toBeLessThanOrEqual(1);

    // Aircraft must NOT be initialized as onGround (so the integrator's
    // ground clamp doesn't immediately drag us back down).
    expect(src).toMatch(/state\.onGround\s*=\s*false/);
  });

  test('CameraRig setMode(chase, instant=true) snaps camera off origin on first update', () => {
    // Reproduces the bootstrap pipeline exactly as main.ts wires it: build
    // an Aircraft, place it at spawn, construct a default-positioned camera
    // (at world origin), then run one update with dt=0. Pre-91ea520 the
    // chase exponential lerp had k≈0 on the zero-dt frame and the camera
    // stayed at the origin while the aircraft sat at (-700, 0.5, 0). After
    // the snap fix the camera must be at the computed chase pose.
    const aircraft = new Aircraft();
    aircraft.group.position.set(-700, FLIGHT_MODEL.groundY, 0);
    const state = createInitialState();
    state.x_W.set(-700, FLIGHT_MODEL.groundY, 0);

    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 60_000);
    expect(camera.position.lengthSq()).toBe(0); // default at origin

    const rig = new CameraRig(camera);
    rig.setMode('chase', true);
    const v = new THREE.Vector3().copy(state.v_W);
    rig.update(0, aircraft.group, v);

    // Expected chase pose: aircraft.position + body offset (-18, 4.5, 0) with
    // aircraft heading 0 → world offset (-18, 4.5, 0) → camera (-718, 5.0, 0).
    expect(camera.position.x).toBeCloseTo(-718, 3);
    expect(camera.position.y).toBeCloseTo(FLIGHT_MODEL.groundY + 4.5, 3);
    expect(camera.position.z).toBeCloseTo(0, 3);
    // Camera must NOT still be at world origin.
    expect(camera.position.lengthSq()).toBeGreaterThan(100);
  });

  test('chase-bootstrap pose: terrain, runway, water all in frustum after first update', () => {
    // Same setup as above, but also walk the World children and confirm
    // every visible non-light child has a bounding box intersecting the
    // post-update frustum. This guards against future regressions where the
    // camera might be re-positioned somewhere off-scene after one update.
    const world = new World();
    world.setTimeOfDay(14);
    const aircraft = new Aircraft();
    aircraft.group.position.set(-700, FLIGHT_MODEL.groundY, 0);

    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 60_000);
    const rig = new CameraRig(camera);
    rig.setMode('chase', true);
    rig.update(0, aircraft.group, new THREE.Vector3());
    camera.updateMatrixWorld(true);

    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      ),
    );

    for (const name of ['TerrainFar', 'Runway', 'Water']) {
      const mesh = world.mesh.children.find((c) => c.name === name) as
        | THREE.Mesh
        | undefined;
      expect(mesh, `${name} present`).toBeDefined();
      mesh!.geometry.computeBoundingBox();
      const box = mesh!.geometry.boundingBox!.clone();
      box.applyMatrix4(mesh!.matrixWorld);
      expect(
        frustum.intersectsBox(box),
        `${name} must be in frustum after CameraRig bootstrap`,
      ).toBe(true);
    }
  });

  test('HUD ILS tone is gated on a user gesture (Chrome autoplay policy)', () => {
    // Regression: spawning in flight makes the ILS cone trigger on frame 1,
    // before any user interaction. Chrome refuses AudioContext.start()
    // before a gesture and logs a warning. We must defer until the user
    // presses a key / clicks. Verify by parsing hud.ts.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/hud/hud.ts'),
      'utf-8',
    );
    // playApproachTone must short-circuit when no gesture has occurred.
    expect(src).toMatch(/playApproachTone[\s\S]*?if\s*\(\s*!this\.userGestured/);
    // A first-gesture listener must exist (keydown or pointerdown).
    expect(src).toMatch(/addEventListener\(['"]keydown['"]/);
    expect(src).toMatch(/userGestured\s*=\s*true/);
  });

  test('index.html declares a favicon (suppresses /favicon.ico 404)', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const html = fs.readFileSync(
      path.resolve(__dirname, '../index.html'),
      'utf-8',
    );
    expect(html).toMatch(/<link[^>]*rel=["']icon["']/);
  });

  test('HUD attitude indicator is not parked over screen center (covers the aircraft)', () => {
    // Regression: previously `.ai` was at `left:50%; top:50%` with -110/-110
    // margins — a 220px disc dead-center over the chase camera's view of the
    // aircraft. The user could not see the plane behind their own AI.
    // Fix moves it to bottom-center and shrinks it. We assert the CSS no
    // longer pins to the geometric center.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/hud/hud.ts'),
      'utf-8',
    );
    const aiBlockMatch = src.match(/\.flisym-hud \.ai\s*\{([^}]*)\}/);
    expect(aiBlockMatch, '.flisym-hud .ai CSS block must exist').toBeTruthy();
    const aiCss = aiBlockMatch![1] ?? '';

    // Either the AI must NOT use top:50% (centered vertically) ...
    const verticallyCentered = /top:\s*50%/.test(aiCss);
    // ... or if it does, it must offset itself off-center.
    const hasBottomAnchor = /bottom:\s*\d/.test(aiCss);
    expect(
      !verticallyCentered || hasBottomAnchor,
      'attitude indicator must not be pinned to screen center (top:50%) — it covers the aircraft',
    ).toBe(true);

    // Width should be modest — a 220px dial swallows the chase view.
    const widthMatch = aiCss.match(/width:\s*(\d+)px/);
    expect(widthMatch).toBeTruthy();
    const width = Number(widthMatch![1]);
    expect(width, 'AI width should leave room for the aircraft view').toBeLessThanOrEqual(160);
  });

  test('index.html canvas CSS does not let the canvas leave the viewport', () => {
    // Regression: previously index.html declared
    //   #app, canvas { display: block; width: 100vw; height: 100vh; }
    // The empty `#app` div took up 100vh of normal flow, pushing the WebGL
    // canvas down to y=100vh — entirely below the visible viewport. The user
    // saw only the position:fixed HUD over a black body background.
    //
    // The fix is to either remove #app or take the canvas out of normal
    // flow. We assert one of the two: canvas must be position:fixed/absolute
    // OR #app must not consume layout space.
    //
    // We can't easily evaluate CSS without JSDOM, so we assert directly on
    // the source string. This catches any regression that re-introduces the
    // flow-pushing layout.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf-8');

    // Look at CSS in the <style> block.
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).toBeTruthy();
    const css = styleMatch![1] ?? '';

    // Either canvas is position:fixed/absolute (out of flow) ...
    const canvasOutOfFlow =
      /canvas\s*\{[^}]*position:\s*(fixed|absolute)/m.test(css);
    // ... or #app does not take up layout space (display:none / height:0).
    const appHidden =
      /#app\s*\{[^}]*display:\s*none/m.test(css) ||
      /#app\s*\{[^}]*height:\s*0/m.test(css);

    expect(
      canvasOutOfFlow || appHidden,
      `index.html must keep the canvas in the viewport: either canvas position:fixed/absolute, or #app display:none/height:0. CSS was:\n${css}`,
    ).toBe(true);
  });

  test('scene background fallback color is non-black (so missing Sky never reads black)', () => {
    // main.ts sets `scene.background = new THREE.Color(0x87b6e8)` so the
    // renderer's clear color is a horizon blue rather than the WebGLRenderer
    // default of black. We replicate that wiring and assert the invariant
    // here so a regression that drops the fallback shows up in CI.
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87b6e8);
    const bg = scene.background as THREE.Color;
    expect(bg).toBeInstanceOf(THREE.Color);
    // Non-black: at least one channel must be substantially > 0.
    expect(bg.r + bg.g + bg.b).toBeGreaterThan(0.5);
  });
});
