// AI pilot orchestrator. See docs/ai-spec.md §2.
//
// `createAIPilot(seed, tuning)` returns the `AIPilot` interface required by
// the spec. The pilot owns its scratch `Controls`, scratch `Percepts`,
// reaction-lag ring (4 elements), FSM memory, PID integrators, and an
// `AIRng`. Tick is zero-alloc after warm-up.

import type { AI_TUNING } from './tuning.js';
import type { Controls } from '../physics/state.js';
import { createAIRng, type AIRng } from './prng.js';
import {
  createPercepts,
  type Percepts,
  wrapPi,
} from './percepts.js';
import {
  createFsmMemory,
  transition,
  type FsmMemory,
  type FsmState,
  type Goal,
} from './fsm.js';
import {
  altitudeToPitch,
  bankToRollRate,
  clamp,
  createControllerState,
  headingToBank,
  pitchToElevator,
  quantize,
  rollRateToAileron,
  slew,
  speedToThrottle,
  yawCoordinator,
  type ControllerState,
} from './controllers.js';

export interface AIPilot {
  tick(percepts: Percepts, dt_ai: number): Controls;
  getState(): {
    fsmState: FsmState;
    lastGoal: Goal;
    rng_cursor: number;
  };
  snapshot(): AIPilotSnapshot;
  restore(snap: AIPilotSnapshot): void;
  /** Allocate-once `Percepts` the caller fills via `observe()`. */
  scratchPercepts(): Percepts;
  /** Simulated tick index (monotonic). */
  getTickIndex(): number;
}

/**
 * Compact snapshot. Field names are intentionally short — see ai-spec.md §7
 * (T16: JSON.stringify(snapshot).length < 1024). The reaction-lag ring is
 * encoded as a packed numeric array (`ring`) holding only the percept-fields
 * the ring read-path actually consumes: roll/pitch/hdg/alt/V/α/β/p/q,
 * targetBearingRad, targetRangeM, primaryTargetFlag, hasIncomingMissile,
 * incomingMissileBearing, threatLevel. Other fields are recomputed by the
 * host's next `observe()` call.
 */
export interface AIPilotSnapshot {
  rngState: number;
  rngCursor: number;
  rngCarry: number | null;
  fsm: FsmState;
  gi: Goal['intent'];
  gt: string | null;
  ps: FsmState | null;
  lt: number;
  ec: number;
  ra: number;
  ai: number;
  ti: number;
  // Last-emitted controls packed: [a, e, r, thr, fl, brake0/1].
  lc: number[];
  wp: number;
  wo: number;
  ws: number;
  tk: number;
  rh: number;
  ring: number[];
}

const RING_SIZE = 8; // 8 slots ≥ Rookie's reactionDelayTicks=8 cap.

function shallowCopyPerceptsInto(dst: Percepts, src: Percepts): void {
  dst.selfHdgRad = src.selfHdgRad;
  dst.selfPitchRad = src.selfPitchRad;
  dst.selfRollRad = src.selfRollRad;
  dst.selfAlt = src.selfAlt;
  dst.selfV = src.selfV;
  dst.selfAlpha = src.selfAlpha;
  dst.selfBeta = src.selfBeta;
  dst.selfHp = src.selfHp;
  dst.selfOnGround = src.selfOnGround;
  dst.selfStall = src.selfStall;
  dst.selfP = src.selfP;
  dst.selfQ = src.selfQ;
  dst.selfR = src.selfR;
  dst.selfX = src.selfX;
  dst.selfY = src.selfY;
  dst.selfZ = src.selfZ;
  dst.primaryTargetId = src.primaryTargetId;
  dst.targetRangeM = src.targetRangeM;
  dst.targetBearingRad = src.targetBearingRad;
  dst.targetElevRad = src.targetElevRad;
  dst.targetClosingMs = src.targetClosingMs;
  dst.targetAspectRad = src.targetAspectRad;
  dst.targetLeadX = src.targetLeadX;
  dst.targetLeadY = src.targetLeadY;
  dst.targetLeadZ = src.targetLeadZ;
  dst.targetAltM = src.targetAltM;
  dst.incomingMissileRange = src.incomingMissileRange;
  dst.incomingMissileTti = src.incomingMissileTti;
  dst.incomingMissileBearing = src.incomingMissileBearing;
  dst.hasIncomingMissile = src.hasIncomingMissile;
  dst.inFrontQuadrant = src.inFrontQuadrant;
  dst.inGunCone = src.inGunCone;
  dst.hasMissileLock = src.hasMissileLock;
  dst.threatLevel = src.threatLevel;
  dst.tickIndex = src.tickIndex;
}

/**
 * Construct an AI pilot. The returned object owns all its scratch state and
 * exposes a zero-alloc `tick()`.
 *
 * @param seed    32-bit unsigned seed for the PRNG
 * @param tuning  one of AI_TUNING_VETERAN / _ROOKIE / _ACE (or a subclass)
 */
export function createAIPilot(seed: number, tuning: AI_TUNING): AIPilot {
  const rng: AIRng = createAIRng(seed);

  // Scratch percepts (caller writes via observe()).
  const scratch: Percepts = createPercepts();

  // FSM + controllers.
  const mem: FsmMemory = createFsmMemory();
  const ctrl: ControllerState = createControllerState();
  let goal: Goal = { state: 'Patrol', intent: 'cruise', targetId: null };
  // Double-buffered Goal so transition() can read prev while writing next.
  const goalScratch: Goal = { state: 'Patrol', intent: 'cruise', targetId: null };

  // Reaction-lag ring (8 slots; tuning chooses how many ticks back to read).
  const ring: Percepts[] = new Array(RING_SIZE);
  for (let i = 0; i < RING_SIZE; i += 1) ring[i] = createPercepts();
  let ringHead = 0;

  // Wander state — sampled every wanderPeriodS.
  let wanderHdgOffset = 0;
  let lastWanderSampleT = -Infinity;
  let wanderPhase = 0;

  // Emit / slew state.
  const lastControls: Controls = {
    aileronCmd: 0,
    elevatorCmd: 0,
    rudderCmd: 0,
    throttleCmd: 0,
    flapsCmd: 0,
    brake: false,
  };

  // Sim time accumulated by ticks (used for wander cadence + respawn deadlines).
  let simTime = 0;
  let tickIndex = 0;

  function pickDelayedPercepts(current: Percepts): Percepts {
    // Push the current sample into the ring, then read back `delay` ticks ago.
    // The Veteran sees delay=2, Rookie=8, Ace=0.
    const head = ring[ringHead]!;
    shallowCopyPerceptsInto(head, current);
    ringHead = (ringHead + 1) % RING_SIZE;
    const delay = Math.min(tuning.reactionDelayTicks, RING_SIZE - 1);
    // Read index (delay ticks ago). After the push above, ring[ringHead] is
    // the oldest slot, so index = (ringHead - delay + RING_SIZE) mod size,
    // but with the just-written tick being one back from ringHead.
    const idx = (ringHead - 1 - delay + RING_SIZE) % RING_SIZE;
    return delay === 0 ? current : ring[idx]!;
  }

  function planHdgAndAlt(p: Percepts, g: Goal, out: { hdgCmd: number; altCmd: number; vCmd: number; bankCapDeg: number; combatMode: boolean }): void {
    switch (g.state) {
      case 'Patrol': {
        // Sample wander dither every wanderPeriodS.
        if (simTime - lastWanderSampleT >= tuning.wanderPeriodS) {
          lastWanderSampleT = simTime;
          const u = rng.next();
          wanderHdgOffset = (u * 2 - 1) * tuning.wanderAmpRad;
          wanderPhase += 1;
        }
        out.hdgCmd = p.selfHdgRad + wanderHdgOffset;
        out.altCmd = tuning.patrolAltM;
        out.vCmd = tuning.cruiseV;
        out.bankCapDeg = 30;
        out.combatMode = false;
        break;
      }
      case 'Engage': {
        // Lead-pursuit: aim heading at target lead point.
        if (p.primaryTargetId !== null) {
          // Bearing from self toward target lead point.
          // Using same convention as percepts: forward = (cos h, -sin h).
          const dx = p.targetLeadX - p.selfX;
          const dz = p.targetLeadZ - p.selfZ;
          out.hdgCmd = Math.atan2(-dz, dx);
          // Altitude follow with small offset upward in pure pursuit.
          out.altCmd = clamp(
            p.targetAltM + (g.intent === 'gun-attack' ? 0 : 10),
            tuning.altMin,
            tuning.altMax,
          );
        } else {
          out.hdgCmd = p.selfHdgRad;
          out.altCmd = tuning.patrolAltM;
        }
        out.vCmd = tuning.combatV;
        out.bankCapDeg = g.intent === 'gun-attack' ? 70 : g.intent === 'missile-attack' ? 50 : 60;
        out.combatMode = true;
        break;
      }
      case 'Evade': {
        const sign = g.intent === 'break-right' ? +1 : -1;
        out.hdgCmd = p.selfHdgRad + sign * (Math.PI / 2);
        out.altCmd = Math.max(p.selfAlt - tuning.evadeAltDropM, tuning.altMin);
        out.vCmd = tuning.evadeV;
        out.bankCapDeg = tuning.evadeBankDeg;
        out.combatMode = true;
        break;
      }
      case 'RTB': {
        // Bearing back to origin (spawn pos) — host can override by passing
        // spawn coords through percepts, but the spec says spawnPos. v0.2:
        // we use (0,0) as the spawn fallback.
        const sx = 0;
        const sz = 0;
        out.hdgCmd = Math.atan2(-(sz - p.selfZ), sx - p.selfX);
        out.altCmd = tuning.rtbAltM;
        out.vCmd = tuning.rtbV;
        out.bankCapDeg = 25;
        out.combatMode = false;
        break;
      }
      case 'Crashed':
      default: {
        out.hdgCmd = p.selfHdgRad;
        out.altCmd = p.selfAlt;
        out.vCmd = 0;
        out.bankCapDeg = 0;
        out.combatMode = false;
        break;
      }
    }
  }

  // Plan-scratch — reused every tick.
  const _planScratch = {
    hdgCmd: 0,
    altCmd: 0,
    vCmd: 0,
    bankCapDeg: 30,
    combatMode: false,
  };

  function tick(percepts: Percepts, dt_ai: number): Controls {
    // Use the lagged sample (reaction delay). Push current → ring.
    const p = pickDelayedPercepts(percepts);

    // FSM transition (writes into goalScratch, then swap into goal).
    transition(goalScratch, goal, mem, p, tuning, simTime, dt_ai);
    // Swap goal ↔ scratch by copying — no reassignment to avoid escape.
    goal.state = goalScratch.state;
    goal.intent = goalScratch.intent;
    goal.targetId = goalScratch.targetId;

    // Plan desired pose.
    planHdgAndAlt(p, goal, _planScratch);

    if (goal.state === 'Crashed') {
      // Freeze controls — slew to zero so we don't snap discontinuously.
      const q = tuning.aiCmdQuantum;
      const slewRate = tuning.aiCommandSlewPerS;
      lastControls.aileronCmd = quantize(slew(lastControls.aileronCmd, 0, slewRate, dt_ai), q);
      lastControls.elevatorCmd = quantize(slew(lastControls.elevatorCmd, 0, slewRate, dt_ai), q);
      lastControls.rudderCmd = quantize(slew(lastControls.rudderCmd, 0, slewRate, dt_ai), q);
      lastControls.throttleCmd = quantize(slew(lastControls.throttleCmd, 0, slewRate, dt_ai), q);
      lastControls.flapsCmd = 0;
      lastControls.brake = false;
      simTime += dt_ai;
      tickIndex += 1;
      return lastControls;
    }

    // Cascades.
    // Vertical world velocity for altitude damping: derive from selfV*sin(pitch)
    // as a cheap proxy (host can pass v_W.y instead via percepts but the
    // current Percepts doesn't carry it explicitly — use selfV * sin(pitch)).
    const selfVy = p.selfV * Math.sin(p.selfPitchRad);
    const pitchCmd = altitudeToPitch(_planScratch.altCmd, p.selfAlt, selfVy, ctrl, tuning, dt_ai);
    const elevatorRaw = pitchToElevator(pitchCmd, p.selfPitchRad, p.selfQ, tuning);

    const bankCmd = headingToBank(_planScratch.hdgCmd, p.selfHdgRad, _planScratch.bankCapDeg, tuning);
    const rollRateCmd = bankToRollRate(bankCmd, p.selfRollRad, tuning);
    const aileronRaw = rollRateToAileron(rollRateCmd, p.selfP, tuning);

    const rudderRaw = yawCoordinator(p.selfBeta, p.selfP, tuning);

    const throttleRaw = speedToThrottle(
      _planScratch.vCmd,
      p.selfV,
      pitchCmd,
      _planScratch.combatMode,
      ctrl,
      tuning,
      dt_ai,
    );

    // Quantize emitted commands.
    const q = tuning.aiCmdQuantum;
    const slewRate = tuning.aiCommandSlewPerS;
    // Slew (against previous emitted command) then quantize.
    const newAileron = quantize(slew(lastControls.aileronCmd, clamp(aileronRaw, -1, 1), slewRate, dt_ai), q);
    const newElevator = quantize(slew(lastControls.elevatorCmd, clamp(elevatorRaw, -1, 1), slewRate, dt_ai), q);
    const newRudder = quantize(slew(lastControls.rudderCmd, clamp(rudderRaw, -1, 1), slewRate, dt_ai), q);
    const newThrottle = quantize(slew(lastControls.throttleCmd, clamp(throttleRaw, 0, 1), slewRate, dt_ai), q);

    lastControls.aileronCmd = clamp(newAileron, -1, 1);
    lastControls.elevatorCmd = clamp(newElevator, -1, 1);
    lastControls.rudderCmd = clamp(newRudder, -1, 1);
    lastControls.throttleCmd = clamp(newThrottle, 0, 1);
    lastControls.flapsCmd = 0; // Wave B: always 0 (spec Appendix C #3).
    lastControls.brake = false;

    simTime += dt_ai;
    tickIndex += 1;
    return lastControls;
  }

  function getState(): { fsmState: FsmState; lastGoal: Goal; rng_cursor: number } {
    return { fsmState: goal.state, lastGoal: goal, rng_cursor: rng.getCursor() };
  }

  // Number of "useful" fields persisted per ring slot. Order is fixed and
  // must match unpack order in restore().
  const RING_FIELDS = 9;
  function round6(x: number): number {
    // Round to 6 decimal places to bound JSON length without losing the
    // 0.05-quantum precision that downstream cares about.
    return Math.round(x * 1e6) / 1e6;
  }

  function snapshot(): AIPilotSnapshot {
    // Only store the slots that affect the next reactionDelayTicks reads.
    const slots = Math.min(tuning.reactionDelayTicks + 1, RING_SIZE);
    const ringPacked: number[] = new Array(slots * RING_FIELDS);
    for (let i = 0; i < slots; i += 1) {
      // Walk back from ringHead so slot 0 is the most-recent push.
      const r = ring[(ringHead - 1 - i + RING_SIZE) % RING_SIZE]!;
      const base = i * RING_FIELDS;
      ringPacked[base + 0] = round6(r.selfHdgRad);
      ringPacked[base + 1] = round6(r.selfPitchRad);
      ringPacked[base + 2] = round6(r.selfRollRad);
      ringPacked[base + 3] = round6(r.selfAlt);
      ringPacked[base + 4] = round6(r.selfV);
      ringPacked[base + 5] = round6(r.selfP);
      ringPacked[base + 6] = round6(r.selfQ);
      ringPacked[base + 7] = round6(r.selfBeta);
      ringPacked[base + 8] = round6(r.selfHp);
    }
    return {
      rngState: rng.getState(),
      rngCursor: rng.getCursor(),
      rngCarry: rng.getGaussianCarry(),
      fsm: goal.state,
      gi: goal.intent,
      gt: goal.targetId,
      ps: mem.pushedState,
      lt: round6(mem.loseTargetTimer),
      ec: round6(mem.evadeClearTimer),
      ra: round6(mem.respawnAt),
      ai: round6(ctrl.altInteg),
      ti: round6(ctrl.throttleInteg),
      lc: [
        round6(lastControls.aileronCmd),
        round6(lastControls.elevatorCmd),
        round6(lastControls.rudderCmd),
        round6(lastControls.throttleCmd),
        round6(lastControls.flapsCmd),
        lastControls.brake ? 1 : 0,
      ],
      wp: wanderPhase,
      wo: round6(wanderHdgOffset),
      ws: round6(lastWanderSampleT),
      tk: tickIndex,
      rh: ringHead,
      ring: ringPacked,
    };
  }

  function restore(s: AIPilotSnapshot): void {
    rng.setState(s.rngState, s.rngCursor, s.rngCarry);
    goal.state = s.fsm;
    goal.intent = s.gi;
    goal.targetId = s.gt;
    mem.pushedState = s.ps;
    mem.loseTargetTimer = s.lt;
    mem.evadeClearTimer = s.ec;
    mem.respawnAt = s.ra;
    ctrl.altInteg = s.ai;
    ctrl.throttleInteg = s.ti;
    lastControls.aileronCmd = s.lc[0]!;
    lastControls.elevatorCmd = s.lc[1]!;
    lastControls.rudderCmd = s.lc[2]!;
    lastControls.throttleCmd = s.lc[3]!;
    lastControls.flapsCmd = s.lc[4]!;
    lastControls.brake = (s.lc[5]! === 1);
    wanderPhase = s.wp;
    wanderHdgOffset = s.wo;
    lastWanderSampleT = s.ws;
    tickIndex = s.tk;
    ringHead = s.rh;
    // Reset all ring slots to neutral then write back the packed slots.
    for (let i = 0; i < RING_SIZE; i += 1) {
      const r = ring[i]!;
      r.selfHdgRad = 0;
      r.selfPitchRad = 0;
      r.selfRollRad = 0;
      r.selfAlt = 0;
      r.selfV = 0;
      r.selfP = 0;
      r.selfQ = 0;
      r.selfBeta = 0;
      r.selfHp = 1;
      r.primaryTargetId = null;
      r.targetRangeM = Infinity;
      r.hasIncomingMissile = false;
      r.threatLevel = 0;
    }
    const slots = s.ring.length / RING_FIELDS;
    for (let i = 0; i < slots; i += 1) {
      const r = ring[(ringHead - 1 - i + RING_SIZE) % RING_SIZE]!;
      const base = i * RING_FIELDS;
      r.selfHdgRad = s.ring[base + 0]!;
      r.selfPitchRad = s.ring[base + 1]!;
      r.selfRollRad = s.ring[base + 2]!;
      r.selfAlt = s.ring[base + 3]!;
      r.selfV = s.ring[base + 4]!;
      r.selfP = s.ring[base + 5]!;
      r.selfQ = s.ring[base + 6]!;
      r.selfBeta = s.ring[base + 7]!;
      r.selfHp = s.ring[base + 8]!;
    }
    // simTime: not in snapshot; tick index is the canonical clock proxy.
    simTime = tickIndex / Math.max(tuning.tickHz, 1);
  }

  return {
    tick,
    getState,
    snapshot,
    restore,
    scratchPercepts: () => scratch,
    getTickIndex: () => tickIndex,
  };
}

// Re-export for convenience.
export { wrapPi };
