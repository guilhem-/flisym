/**
 * Sky — Three.js Preetham `Sky` shader + sun directional + hemi fill.
 *
 * `setTimeOfDay(hours)` maps 0–24 h to a sun elevation curve (-10° → +60°
 * → -10°) and tweaks turbidity/rayleigh at dawn/dusk for a warmer horizon.
 * Default 14:00.
 *
 * See `/docs/world-spec.md` §7-8.
 */

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { WORLD_CONFIG } from './config.js';

export interface SkySystem {
  sky: Sky;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  setTimeOfDay(hours: number): void;
  /** Current sun elevation in degrees (read by other systems for fog tint etc.). */
  getSunElevation(): number;
}

/**
 * Build the sky system. Returns the Sky mesh, sun directional light, and
 * hemisphere fill light, plus a `setTimeOfDay` setter that drives all three.
 */
export function createSky(): SkySystem {
  const cfg = WORLD_CONFIG.sky;
  const sky = new Sky();
  sky.scale.setScalar(cfg.scale);
  sky.name = 'Sky';

  const u = sky.material.uniforms;
  // Sky is a ShaderMaterial — uniforms are Record<string, IUniform>; values
  // are mutable so we just assign through them.
  (u['turbidity'] as { value: number }).value = cfg.turbidity;
  (u['rayleigh'] as { value: number }).value = cfg.rayleigh;
  (u['mieCoefficient'] as { value: number }).value = cfg.mieCoefficient;
  (u['mieDirectionalG'] as { value: number }).value = cfg.mieDirectionalG;

  const sun = new THREE.DirectionalLight(
    new THREE.Color(WORLD_CONFIG.lighting.sunColor),
    WORLD_CONFIG.lighting.sunIntensity,
  );
  sun.name = 'Sun';

  const hemi = new THREE.HemisphereLight(
    new THREE.Color(WORLD_CONFIG.lighting.hemiSky),
    new THREE.Color(WORLD_CONFIG.lighting.hemiGround),
    WORLD_CONFIG.lighting.hemiIntensity,
  );
  hemi.name = 'HemisphereFill';

  let currentElevationDeg: number = cfg.sunElevationDegDefault;

  function applyElevation(elevationDeg: number): void {
    currentElevationDeg = elevationDeg;
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(cfg.sunAzimuthDeg);
    const dir = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta),
    );
    (u['sunPosition'] as { value: THREE.Vector3 }).value.copy(dir);
    sun.position.copy(dir).multiplyScalar(cfg.sunDistance);
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();

    // Dim the sun smoothly as it sets — no light below the horizon.
    const k = Math.max(0, Math.sin(THREE.MathUtils.degToRad(elevationDeg)));
    sun.intensity = WORLD_CONFIG.lighting.sunIntensity * k;
  }

  /**
   * Map hours-of-day → sun elevation degrees. Sinusoid that peaks at noon
   * (+60°), bottoms at midnight (-10°). Crosses horizon ~6:00 and ~18:00.
   */
  function elevationForHours(hours: number): number {
    const h = ((hours % 24) + 24) % 24;
    // 0h → -10°, 6h → ~25°, 12h → +60°, 18h → ~25°, 24h → -10°.
    const t = (h / 24) * Math.PI * 2; // 0..2π
    // amplitude 35°, mid 25°: midnight = 25-35 = -10, noon = 25+35 = 60.
    return 25 - 35 * Math.cos(t);
  }

  function setTimeOfDay(hours: number): void {
    const elev = elevationForHours(hours);
    applyElevation(elev);

    // Dawn/dusk tweak: when |elev| is small, lean toward dusk values.
    const duskness = 1 - Math.min(1, Math.abs(elev) / 15); // 1 at horizon, 0 at >=15°.
    const turb =
      cfg.turbidity + (cfg.duskTurbidity - cfg.turbidity) * duskness;
    const ray = cfg.rayleigh + (cfg.duskRayleigh - cfg.rayleigh) * duskness;
    (u['turbidity'] as { value: number }).value = turb;
    (u['rayleigh'] as { value: number }).value = ray;
  }

  // Default 14:00 — gives ~+50° elevation, well clear of the dusk band.
  setTimeOfDay(14);

  return {
    sky,
    sun,
    hemi,
    setTimeOfDay,
    getSunElevation: () => currentElevationDeg,
  };
}
