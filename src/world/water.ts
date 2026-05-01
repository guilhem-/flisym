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
