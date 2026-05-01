/**
 * Runway — flat plane 1500×30 at y = 0.5.
 * Asphalt grey base via vertex colors, white centerline stripes, white
 * threshold bars at the two short ends.
 *
 * Geometry is 60×4 segments (per spec §6) so stripe edges land on vertices.
 * Note: at 60 segments along X = 25 m per segment, while stripe pitch is
 * 30 m, so stripe edges land approximately on vertices and the centerline
 * appears as a regularly-broken white line — adequate for cruise visuals.
 *
 * See `/docs/world-spec.md` §6.
 */

import * as THREE from 'three';
import { WORLD_CONFIG } from './config.js';

const ASPHALT = new THREE.Color(WORLD_CONFIG.runway.color);
const STRIPE = new THREE.Color(WORLD_CONFIG.runway.stripeColor);

export class Runway {
  readonly mesh: THREE.Mesh;

  constructor() {
    const r = WORLD_CONFIG.runway;
    const geometry = new THREE.PlaneGeometry(
      r.length,
      r.width,
      r.segmentsX,
      r.segmentsZ,
    );
    geometry.rotateX(-Math.PI / 2);

    const positions = geometry.attributes.position;
    if (!positions) throw new Error('Runway plane built without positions');
    const vertCount = positions.count;
    const colors = new Float32Array(vertCount * 3);

    const halfL = r.length / 2;
    const stripeHalfPainted = r.stripePainted / 2;

    for (let i = 0; i < vertCount; i++) {
      const x = positions.getX(i); // local X (-halfL..halfL)
      const z = positions.getZ(i); // local Z (-15..15)

      const tipDistance = halfL - Math.abs(x); // 0 at threshold, halfL at center
      const isThresholdBar = tipDistance < r.thresholdLength;

      // Centerline test: nearest stripe center on the pitch grid.
      // Stripe centers sit at x = k * pitch (k = 0, ±1, ±2 …).
      const nearestStripeCenter = Math.round(x / r.stripePitch) * r.stripePitch;
      const distToStripeX = Math.abs(x - nearestStripeCenter);
      const isCenterlineStripe =
        distToStripeX < stripeHalfPainted && Math.abs(z) < r.stripeHalfWidth;

      const c = isThresholdBar || isCenterlineStripe ? STRIPE : ASPHALT;
      const o = i * 3;
      colors[o] = c.r;
      colors[o + 1] = c.g;
      colors[o + 2] = c.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: r.roughness,
      metalness: 0.0,
      flatShading: false,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.y = r.y;
    // Heading 090° = +X axis = the geometry's long axis already → no rotation.
    this.mesh.name = 'Runway';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }
}
