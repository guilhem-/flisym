// Deterministic waypoint generator for Strike Mission.
//
// Per `docs/modes/strike-mission.md` §6/§7: 3–5 waypoints. The final
// waypoint (the "egress") is always pinned over the runway threshold so
// the player has a fixed return target. Earlier waypoints route the
// player out toward the target cluster (≈ 6 km east of spawn — see
// `src/world/ground-targets.ts` GROUND_TARGETS_TUNING.clusterCenter) and
// back.
//
// Determinism: the only randomness is the mulberry32 PRNG seeded from
// `seed`. Same seed → identical waypoint list. No `Math.random()`.

import { mulberry32 } from '../ai/prng.js';

/** A single waypoint in the strike mission. World-frame meters. */
export interface Waypoint {
  /** World-X (east). */
  readonly x: number;
  /** World-Y (up, AGL+terrain — generator places at ~150 m). */
  readonly y: number;
  /** World-Z (south). */
  readonly z: number;
  /** Trigger radius in metres. */
  readonly r: number;
}

/** Minimal world reference — only ground sampling is consumed. */
export interface MissionWorldRef {
  getGroundHeight(x: number, z: number): number;
}

/** Tunables for waypoint generation. */
export const WAYPOINT_TUNING = {
  /** Inclusive bounds on the waypoint count (the spec mandates 3..5). */
  minCount: 3,
  maxCount: 5,
  /** Default trigger radius in metres. */
  triggerRadiusM: 200,
  /** Cruise altitude above ground level for ingress waypoints. */
  cruiseAGL: 150,
  /** Egress waypoint sits over the runway threshold (Free-Flight spawn). */
  egress: { x: -700, z: 0 } as const,
  /** Centre of the target cluster (mirrors GROUND_TARGETS_TUNING). */
  clusterCenter: { x: 6000, z: 0 } as const,
  /** Half-edge of the corridor we may scatter ingress waypoints within. */
  corridorHalfM: 1500,
} as const;

/**
 * Generate 3–5 waypoints. The first 2..4 are scatter points along a path
 * out to the cluster centre; the last is pinned to the egress point over
 * the runway. Waypoint 0 is placed on the player's spawn trajectory so
 * the spec's 60 s "neutral controls reach WP 0" test hook holds.
 *
 * @param seed   32-bit unsigned mission seed
 * @param world  ground-sampler for altitude-above-terrain placement
 */
export function generateWaypoints(seed: number, world: MissionWorldRef): Waypoint[] {
  const rand = mulberry32(seed >>> 0);
  const T = WAYPOINT_TUNING;

  // Count ∈ [3, 5].
  const count = T.minCount + Math.floor(rand() * (T.maxCount - T.minCount + 1));

  const out: Waypoint[] = [];

  // Waypoint 0: ahead of the player's spawn trajectory. The player starts
  // at (-700, _, 0) with v_W = (50, 0, 0). At cruise that's 3 km east in
  // 60 s, so place WP0 between 1500 m and 2500 m east of spawn at z≈0.
  {
    const x = -700 + 1500 + rand() * 1000;
    const z = (rand() * 2 - 1) * 200;
    const y = Math.max(world.getGroundHeight(x, z), 0) + T.cruiseAGL;
    out.push({ x, y, z, r: T.triggerRadiusM });
  }

  // Middle waypoints (count - 2 of them): scatter inside a corridor that
  // points from the player to the cluster centre.
  const middle = count - 2;
  for (let i = 0; i < middle; i++) {
    // Lerp from WP0 toward the cluster centre (fraction 0..1, exclusive
    // of endpoints so we always have headroom for the egress + WP0).
    const t = (i + 1) / (middle + 1);
    const cx = -700 + (T.clusterCenter.x - -700) * t;
    const cz = 0 + (T.clusterCenter.z - 0) * t;
    const x = cx + (rand() * 2 - 1) * T.corridorHalfM * 0.5;
    const z = cz + (rand() * 2 - 1) * T.corridorHalfM * 0.5;
    const y = Math.max(world.getGroundHeight(x, z), 0) + T.cruiseAGL;
    out.push({ x, y, z, r: T.triggerRadiusM });
  }

  // Egress waypoint — fixed at the runway threshold so the win-test is
  // stable and humans always know where home is.
  {
    const x = T.egress.x;
    const z = T.egress.z;
    const y = Math.max(world.getGroundHeight(x, z), 0) + T.cruiseAGL;
    out.push({ x, y, z, r: T.triggerRadiusM });
  }

  return out;
}
