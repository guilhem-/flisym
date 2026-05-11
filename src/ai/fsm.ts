// AI pilot FSM. See docs/ai-spec.md §1.2 / §1.3.
//
// Five states (Patrol, Engage, Evade, RTB, Crashed) and a 1-deep state stack
// so an Evade-pop returns the pilot to its prior state.
//
// `transition()` is a pure function — no closures, no allocations beyond the
// reuse of a single scratch `Goal` object owned by the caller.

import type { AI_TUNING } from './tuning.js';
import type { Percepts } from './percepts.js';

export type FsmState = 'Patrol' | 'Engage' | 'Evade' | 'RTB' | 'Crashed';

export type GoalIntent =
  | 'cruise'
  | 'pursue'
  | 'gun-attack'
  | 'missile-attack'
  | 'break-left'
  | 'break-right'
  | 'rtb-cruise'
  | 'idle';

export interface Goal {
  state: FsmState;
  intent: GoalIntent;
  targetId: string | null;
}

/** Bookkeeping the FSM needs across ticks (caller-owned). */
export interface FsmMemory {
  /** 1-deep state stack — non-null only while `state === 'Evade'`. */
  pushedState: FsmState | null;
  /** Wallclock-sim time since target was last visible, in seconds. */
  loseTargetTimer: number;
  /** Wallclock-sim time since the last missile threat was present. */
  evadeClearTimer: number;
  /** Time when the bot died — `state.time + respawnDelay`. -1 = not crashed. */
  respawnAt: number;
}

export function createFsmMemory(): FsmMemory {
  return {
    pushedState: null,
    loseTargetTimer: 0,
    evadeClearTimer: 0,
    respawnAt: -1,
  };
}

/**
 * Pure FSM transition. Mutates the caller-owned `goal` and `mem` in place
 * (zero allocations) and returns the same `goal` for convenience.
 *
 * @param goal       caller-owned scratch Goal (will be overwritten)
 * @param prev       current goal (read for state continuity)
 * @param mem        caller-owned FSM memory
 * @param p          current percepts
 * @param tuning     AI_TUNING preset
 * @param simTime    current simulated time (seconds)
 * @param dt_ai      AI tick step (seconds)
 */
export function transition(
  goal: Goal,
  prev: Goal,
  mem: FsmMemory,
  p: Percepts,
  tuning: AI_TUNING,
  simTime: number,
  dt_ai: number,
): Goal {
  goal.targetId = p.primaryTargetId;
  // Default carry-through.
  goal.state = prev.state;
  goal.intent = prev.intent;

  // ---- Hard overrides ----
  // Crashed: airframe HP exhausted or ground impact past ground threshold.
  if (p.selfHp <= 0) {
    if (prev.state !== 'Crashed') {
      mem.respawnAt = simTime + tuning.respawnDelayS;
    }
    goal.state = 'Crashed';
    goal.intent = 'idle';
    goal.targetId = null;
    return goal;
  }
  if (prev.state === 'Crashed') {
    if (simTime >= mem.respawnAt) {
      mem.respawnAt = -1;
      mem.pushedState = null;
      goal.state = 'Patrol';
      goal.intent = 'cruise';
      goal.targetId = null;
      return goal;
    }
    goal.state = 'Crashed';
    goal.intent = 'idle';
    goal.targetId = null;
    return goal;
  }

  // ---- Bookkeeping timers ----
  if (p.primaryTargetId === null) {
    mem.loseTargetTimer += dt_ai;
  } else {
    mem.loseTargetTimer = 0;
  }
  if (p.hasIncomingMissile) {
    mem.evadeClearTimer = 0;
  } else if (prev.state === 'Evade') {
    mem.evadeClearTimer += dt_ai;
  } else {
    mem.evadeClearTimer = 0;
  }

  // ---- Evade entry & exit ----
  if (p.hasIncomingMissile && prev.state !== 'Evade' && prev.state !== 'RTB') {
    // Push prior state for return-after-break.
    mem.pushedState = prev.state;
    goal.state = 'Evade';
    // Break direction: away from missile bearing — negative bearing means
    // missile is to the left, so break right (and vice versa).
    goal.intent = p.incomingMissileBearing < 0 ? 'break-right' : 'break-left';
    return goal;
  }
  if (prev.state === 'Evade') {
    if (mem.evadeClearTimer >= tuning.evadeClearT) {
      const popTo: FsmState = mem.pushedState ?? 'Patrol';
      mem.pushedState = null;
      goal.state = popTo;
      goal.intent = popTo === 'Engage' ? 'pursue' : 'cruise';
      return goal;
    }
    // Stay in Evade with the prior intent (break-left/right keeps).
    goal.state = 'Evade';
    goal.intent = prev.intent === 'break-left' || prev.intent === 'break-right'
      ? prev.intent
      : 'break-right';
    return goal;
  }

  // ---- RTB latching ----
  if (prev.state === 'RTB') {
    // Stay RTB unless HP somehow recovers (host respawn).
    if (p.selfHp >= tuning.engageHpFloor + 0.05) {
      goal.state = 'Patrol';
      goal.intent = 'cruise';
      return goal;
    }
    goal.state = 'RTB';
    goal.intent = 'rtb-cruise';
    return goal;
  }

  // ---- HP gates ----
  if (p.selfHp < tuning.disengageHp) {
    goal.state = 'RTB';
    goal.intent = 'rtb-cruise';
    return goal;
  }

  // ---- Engage / Patrol ----
  if (prev.state === 'Engage') {
    if (mem.loseTargetTimer > tuning.loseTargetT) {
      goal.state = 'Patrol';
      goal.intent = 'cruise';
      return goal;
    }
    // Choose engagement sub-intent.
    goal.state = 'Engage';
    if (p.inGunCone && p.targetRangeM < tuning.gunRangeM) {
      goal.intent = 'gun-attack';
    } else if (
      p.hasMissileLock &&
      p.targetRangeM > tuning.missileRangeMinM &&
      p.targetRangeM < tuning.missileRangeMaxM
    ) {
      goal.intent = 'missile-attack';
    } else {
      goal.intent = 'pursue';
    }
    return goal;
  }

  // Patrol → Engage transition.
  if (
    prev.state === 'Patrol' &&
    p.primaryTargetId !== null &&
    p.targetRangeM < tuning.detectRangeM &&
    p.selfHp >= tuning.engageHpFloor
  ) {
    goal.state = 'Engage';
    goal.intent = 'pursue';
    return goal;
  }

  // Default: Patrol / cruise.
  goal.state = 'Patrol';
  goal.intent = 'cruise';
  return goal;
}
