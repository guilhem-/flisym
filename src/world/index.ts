/**
 * World — composes terrain, water, runway, sky, sun, and hemi fill into a
 * single THREE.Group plus a small API: `update`, `setTimeOfDay`,
 * `getGroundHeight`.
 *
 * Fog is owned by the Scene (THREE.FogExp2) — World exposes a setter so
 * `setTimeOfDay` can re-tint fog at dawn/dusk/night.
 *
 * See `/docs/world-spec.md` §9.
 */

import * as THREE from 'three';
import { WORLD_CONFIG } from './config.js';
import { Terrain } from './terrain.js';
import { Water } from './water.js';
import { Runway } from './runway.js';
import { createSky, type SkySystem } from './sky.js';

export { WORLD_CONFIG } from './config.js';
export { getHeightAt, createNoise } from './heightmap.js';

const FOG_DAY = new THREE.Color(WORLD_CONFIG.fog.color);
const FOG_DUSK = new THREE.Color(WORLD_CONFIG.fog.duskColor);
const FOG_NIGHT = new THREE.Color(WORLD_CONFIG.fog.nightColor);

export class World {
  readonly mesh: THREE.Group;
  readonly fog: THREE.FogExp2;

  private readonly terrain: Terrain;
  private readonly water: Water;
  private readonly runway: Runway;
  private readonly skySys: SkySystem;

  constructor() {
    this.mesh = new THREE.Group();
    this.mesh.name = 'World';

    this.terrain = new Terrain();
    this.water = new Water();
    this.runway = new Runway();
    this.skySys = createSky();

    this.mesh.add(this.terrain.mesh);
    this.mesh.add(this.water.mesh);
    this.mesh.add(this.runway.mesh);
    this.mesh.add(this.skySys.sky);
    this.mesh.add(this.skySys.sun);
    this.mesh.add(this.skySys.sun.target);
    this.mesh.add(this.skySys.hemi);

    this.fog = new THREE.FogExp2(FOG_DAY.getHex(), WORLD_CONFIG.fog.density);
    this.applyFogTint();
  }

  /**
   * Per-frame update. Currently only water (placeholder) animates.
   */
  update(dt: number): void {
    this.water.update(dt);
  }

  /**
   * Drive the sun, sky, and fog tint from a 0–24 h clock.
   */
  setTimeOfDay(hours: number): void {
    this.skySys.setTimeOfDay(hours);
    this.applyFogTint();
  }

  /**
   * Ground height at world (x, z), using the terrain's noise instance — same
   * data the mesh was built from. Use this for physics / aircraft contact.
   */
  getGroundHeight(x: number, z: number): number {
    return this.terrain.getGroundHeight(x, z);
  }

  /**
   * Choose fog color from current sun elevation:
   *  - elevation > 15°  → day color
   *  - 0..15°           → blend day → dusk
   *  - elevation ≤ 0°   → blend dusk → night (deepest at -10°)
   */
  private applyFogTint(): void {
    const elev = this.skySys.getSunElevation();
    const tinted = new THREE.Color();
    if (elev > 15) {
      tinted.copy(FOG_DAY);
    } else if (elev > 0) {
      const t = 1 - elev / 15;
      tinted.copy(FOG_DAY).lerp(FOG_DUSK, t);
    } else {
      const t = Math.min(1, -elev / 10);
      tinted.copy(FOG_DUSK).lerp(FOG_NIGHT, t);
    }
    this.fog.color.copy(tinted);
  }
}
