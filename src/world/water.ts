/**
 * Water — single flat 50km plane at y = -0.05.
 * Plain blue MeshStandardMaterial per spec — no reflections, no shader.
 *
 * See `/docs/world-spec.md` §5.
 */

import * as THREE from 'three';
import { WORLD_CONFIG } from './config.js';

export class Water {
  readonly mesh: THREE.Mesh;

  constructor() {
    const cfg = WORLD_CONFIG.water;
    const geometry = new THREE.PlaneGeometry(cfg.size, cfg.size, 1, 1);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(cfg.color),
      roughness: cfg.roughness,
      metalness: cfg.metalness,
      // Water sits at y = -0.05 m, 0.55 m below the runway and well below
      // the runway-flatten plane (y=0). At grazing angles the depth-buffer
      // slop can still let it punch through. Push it slightly back so the
      // terrain wins ties.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.y = cfg.y;
    this.mesh.name = 'Water';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  // Hook for future scrolling normal animation. Underscore name keeps tsc
  // happy under noUnusedParameters.
  update(_dt: number): void {
    // No animation in v1 — kept so World.update stays uniform.
  }
}
