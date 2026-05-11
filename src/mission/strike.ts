// Strike Mission generator: combines waypoints + ground-target objectives.
//
// `generateStrikeMission(seed, world, targetField)` returns a `MissionDef`
// the Strike Mission Mode consumes verbatim. The generator owns the
// canonical mapping from a 32-bit seed to a reproducible mission — same
// seed → identical mission tree (same waypoints, same target ids).
//
// The targetField is built upstream by `spawnGroundTargets` (see
// `src/world/ground-targets.ts`); this generator just records which of
// its target ids are required objectives. v0.2: every live target is
// "required" — the win condition wants ≥ 80% destroyed.

import { generateWaypoints, type Waypoint, type MissionWorldRef } from './waypoints.js';
import type { GroundTargetField, GroundTargetSpec } from '../world/ground-targets.js';

/** Mission required-objective entry. */
export interface MissionObjective {
  readonly id: string;
  readonly kind: GroundTargetSpec['kind'];
  readonly pos: readonly [number, number, number];
  readonly value: number;
  readonly hpMax: number;
}

/** Full mission definition the Mode consumes. */
export interface MissionDef {
  readonly seed: number;
  readonly waypoints: ReadonlyArray<Waypoint>;
  /** Index into `waypoints` of the egress (always the last entry today). */
  readonly egressIndex: number;
  readonly objectives: ReadonlyArray<MissionObjective>;
}

/**
 * Build a `MissionDef`. Deterministic for any (seed, targetField) pair —
 * the field's target list is consumed verbatim so the only randomness
 * here is waypoint placement.
 */
export function generateStrikeMission(
  seed: number,
  world: MissionWorldRef,
  targetField: GroundTargetField,
): MissionDef {
  const waypoints = generateWaypoints(seed, world);

  const objectives: MissionObjective[] = [];
  for (const t of targetField.targets) {
    objectives.push({
      id: t.spec.id,
      kind: t.spec.kind,
      pos: t.spec.pos,
      value: t.spec.value,
      hpMax: t.spec.hp,
    });
  }

  return {
    seed: seed >>> 0,
    waypoints,
    egressIndex: waypoints.length - 1,
    objectives,
  };
}
