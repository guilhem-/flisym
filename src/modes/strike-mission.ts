// Strike Mission Mode — fly waypoints, drop bombs, run for home.
//
// Spec: docs/modes/strike-mission.md.
//
// Composes:
//   - generateStrikeMission (src/mission) for waypoints + objective list.
//   - GroundTargetField (src/world/ground-targets) for visible targets.
//   - CombatSystem (src/combat) for bomb physics + SAM missile flight.
//
// Bombs are dropped on Space (one per keydown). On ground-impact we
// enumerate ground targets within `bombBlastRadius` and decrement HP
// per combat-spec §3.3 (falloff²). Targets at HP≤0 are visually swapped
// to debris via `destroyTarget()`.
//
// SAM defender (minimal v0.2): one chosen 'sam' target every
// `SAM_FIRE_INTERVAL` seconds emits a single radar-guided missile via
// CombatSystem.missiles.spawn — when the player is within
// `samDetectRangeM` (8 km) AND within the radar cone.

import * as THREE from 'three';
import type { Mode, ModeContext, ModeMeta, ModeStatus } from './types.js';
import {
  CombatSystem,
  COMBAT_TUNING,
  createWeaponState,
  dropBomb,
  type WeaponState,
} from '../combat/index.js';
import {
  GroundTargetField,
  destroyTarget,
  type GroundTargetInstance,
} from '../world/ground-targets.js';
import {
  generateStrikeMission,
  type MissionDef,
} from '../mission/index.js';
import { mulberry32 } from '../ai/prng.js';

const META: ModeMeta = {
  id: 'strike-mission',
  displayName: 'Strike Mission',
  description: 'Hit the target area then run for the runway. 4 bombs, one shot.',
};

/** SAM tunables — minimal AI per spec §5.2; not the full FSM. */
const SAM_TUNING = {
  detectRangeM: 8000,
  /** Radar half-cone (rad) the player must lie within to be tracked. */
  coneRad: Math.PI, // omni-directional — SAMs sit at fixed sites with rotating radar
  /** Seconds between launches per site. */
  fireIntervalS: 10,
  /** SAM missile drop velocity from the launcher (vertical). */
  launchVel: 400,
} as const;

/** Bomb damage center constant from combat-spec §3.3. */
const BOMB_DAMAGE_CENTER = COMBAT_TUNING.bombDamageCenter;
const BOMB_BLAST_RADIUS = COMBAT_TUNING.bombBlastRadius;

interface SamSiteState {
  /** Ground-target this SAM corresponds to. */
  target: GroundTargetInstance;
  /** Stable id (shared with ground-target spec). */
  id: string;
  /** Last fire timestamp (sim seconds). */
  lastFireT: number;
}

interface MissionHudShape {
  setMission?(state: {
    waypoints: ReadonlyArray<{ distanceKm: number }>;
    currentWaypoint: number;
    bombsRemaining: number;
    bombsTotal: number;
    targets: ReadonlyArray<{ id: string; status: 'LIVE' | 'HIT' | 'DEAD' }>;
  }): void;
}

export class StrikeMissionMode implements Mode {
  readonly meta: ModeMeta = META;

  // Public for tests.
  combat: CombatSystem | null = null;
  field: GroundTargetField | null = null;
  mission: MissionDef | null = null;
  playerWeapons: WeaponState | null = null;
  /** Current waypoint index (0-based). */
  currentWaypoint = 0;
  /** Bombs released so far. */
  bombsDropped = 0;
  /** Pickle quantity per Space (v0.2: always 1). */
  pickleQty: 1 | 2 | 4 = 1;
  destroyedTargetCount = 0;
  /** True once status() has emitted `won` or `lost` exactly once. */
  private won = false;
  private lost = false;
  private endedEmitted = false;
  private elapsedSeconds = 0;
  private ctx: ModeContext | null = null;

  private waypointMeshes: THREE.Mesh[] = [];
  private waypointGroup: THREE.Group | null = null;

  private sams: SamSiteState[] = [];
  /** Map bomb-pool slot index → seen-this-frame age (used to detect impact). */
  private bombPrevAge: Map<number, number> = new Map();
  /** Sim-seconds when SAM warn banner should clear (HUD hint).
   *  Read only by the HUD wiring path; intentionally left available even
   *  when no `setMission` consumer is present. */
  samWarnUntil = 0;

  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────────────
  init(ctx: ModeContext): void {
    this.ctx = ctx;
    this.won = false;
    this.lost = false;
    this.endedEmitted = false;
    this.currentWaypoint = 0;
    this.bombsDropped = 0;
    this.pickleQty = 1;
    this.destroyedTargetCount = 0;
    this.elapsedSeconds = 0;
    this.bombPrevAge.clear();
    this.samWarnUntil = 0;

    // --- Player loadout (no guns / missiles in this mode).
    this.playerWeapons = createWeaponState('player');
    this.playerWeapons.gunRoundsL = 0;
    this.playerWeapons.gunRoundsR = 0;
    this.playerWeapons.missileRailsRemaining = 0;
    this.playerWeapons.bombsRemaining = COMBAT_TUNING.bombPerAircraft;

    // --- Ground target field: deterministic, count drawn from seed.
    const fieldRand = mulberry32((ctx.seed ^ 0xa5a5a5a5) >>> 0);
    const count = 5 + Math.floor(fieldRand() * 6); // 5..10 inclusive
    this.field = new GroundTargetField({
      count,
      seed: ctx.seed,
      world: { getGroundHeight: (x, z) => ctx.world.getGroundHeight(x, z) },
    });
    ctx.scene.add(this.field.group);

    // --- Mission definition.
    this.mission = generateStrikeMission(
      ctx.seed,
      { getGroundHeight: (x, z) => ctx.world.getGroundHeight(x, z) },
      this.field,
    );

    // --- Waypoint ring meshes (vertical green rings).
    this.waypointGroup = new THREE.Group();
    this.waypointGroup.name = 'StrikeWaypoints';
    const ringGeom = new THREE.RingGeometry(120, 130, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x6dff6d,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    for (const wp of this.mission.waypoints) {
      const ring = new THREE.Mesh(ringGeom, ringMat);
      ring.position.set(wp.x, wp.y, wp.z);
      // Stand the ring vertical — face the runway approach (X axis).
      ring.rotation.y = Math.PI / 2;
      this.waypointMeshes.push(ring);
      this.waypointGroup.add(ring);
    }
    ctx.scene.add(this.waypointGroup);

    // --- SAM defenders: one per 'sam' ground target (cap at 1 per the spec
    // "1 SAM site"). v0.2 keeps things minimal so the rest are inert.
    let samCount = 0;
    for (const t of this.field.targets) {
      if (t.spec.kind === 'sam' && samCount < 1) {
        this.sams.push({ target: t, id: t.spec.id, lastFireT: -SAM_TUNING.fireIntervalS });
        samCount += 1;
      }
    }

    // --- Combat system (for bomb physics + SAM missile flight).
    const combat = new CombatSystem();
    combat.setWorld({ getGroundHeight: (x, z) => ctx.world.getGroundHeight(x, z) });
    combat.playerPos = ctx.playerState.x_W;
    combat.register({
      id: 'player',
      state: ctx.playerState,
      team: 'allies',
      weapons: this.playerWeapons,
    });
    this.combat = combat;
    ctx.scene.add(combat.getRoot());

    // --- Keybindings: Space drops one bomb.
    this.onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'space') {
        this.dropOneBomb();
        e.preventDefault?.();
      } else if (k === 'z') {
        // Pickle quantity cycle — v0.2 keeps single-bomb only but the
        // HUD/state machine respects the value.
        this.pickleQty = this.pickleQty === 1 ? 2 : this.pickleQty === 2 ? 4 : 1;
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
    }

    ctx.hud.setChallenge(null);
    ctx.hud.hideFinishOverlay();
    ctx.emit({ type: 'mode_started', mode: META.id, t: ctx.playerState.time });
  }

  update(dt: number, ctx: ModeContext): void {
    const c = this.combat;
    const m = this.mission;
    const f = this.field;
    if (!c || !m || !f) return;
    if (this.endedEmitted) {
      c.update(dt);
      this.pushHud(ctx);
      return;
    }
    this.elapsedSeconds += dt;

    // --- Track bomb-pool slots for impact detection. We pre-record each
    // active slot's pre-step age, then step combat, then check which
    // slots transitioned from active to inactive AND had a non-trivial
    // age — those are this frame's impacts. Combat already drops the
    // bombs internally; we just need the impact positions.
    const bombs = c.bombs;
    const activeBefore: { idx: number; px: number; py: number; pz: number }[] = [];
    for (let i = 0; i < bombs.capacity; i++) {
      if (bombs.isActive(i)) {
        activeBefore.push({
          idx: i,
          px: bombs.px[i]!,
          py: bombs.py[i]!,
          pz: bombs.pz[i]!,
        });
      }
    }

    // --- Tick combat.
    c.update(dt);

    // Detect impacts: slots active-before that are now inactive AND were
    // below or near ground after the step.
    for (const a of activeBefore) {
      if (!bombs.isActive(a.idx)) {
        // The slot was consumed — that's either expiration or a ground
        // impact. Resolve blast damage if the last known position is at
        // or below the ground height (with a tolerance).
        const g = ctx.world.getGroundHeight(a.px, a.pz);
        if (a.py <= g + 5) {
          // Approximate impact at last known XZ + ground Y.
          this.applyBombBlast(a.px, g, a.pz, ctx);
        }
      }
    }

    // --- SAM logic: fire one missile every SAM_TUNING.fireIntervalS if
    //     the player is within the detect range.
    for (const sam of this.sams) {
      if (sam.target.destroyed) continue;
      const tgt = sam.target;
      const px = tgt.spec.pos[0];
      const pz = tgt.spec.pos[2];
      const dx = ctx.playerState.x_W.x - px;
      const dz = ctx.playerState.x_W.z - pz;
      const dy = ctx.playerState.x_W.y - tgt.spec.pos[1];
      const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (range > SAM_TUNING.detectRangeM) continue;
      if (ctx.playerState.time - sam.lastFireT < SAM_TUNING.fireIntervalS) continue;
      // Launch one radar-guided missile from the site, upward then tracking.
      const launchPos = new THREE.Vector3(px, tgt.spec.pos[1] + 4, pz);
      const launchVel = new THREE.Vector3(0, SAM_TUNING.launchVel, 0);
      const fwd = new THREE.Vector3(0, 1, 0);
      const slot = c.missiles.spawn({
        x: launchPos,
        v: launchVel,
        fwd_W: fwd,
        shooterId: sam.id,
        kind: 'radar',
        lockedTargetId: 'player',
        t: ctx.playerState.time,
      });
      if (slot >= 0) {
        sam.lastFireT = ctx.playerState.time;
        this.samWarnUntil = ctx.playerState.time + 3.0;
        ctx.emit({ type: 'lock_acquired', target: 'player', t: ctx.playerState.time });
      }
    }

    // --- Drain combat events.
    const events = c.consumeEvents();
    for (const h of events.hits) {
      if (h.targetId === 'player') {
        ctx.emit({
          type: 'damage_taken',
          zone: h.zone === 'airframe' || h.zone === 'engine' ? h.zone : 'control',
          amount: h.hpLoss,
          t: h.t,
        });
      }
    }
    for (const k of events.kills) {
      if (k.victimId === 'player') ctx.emit({ type: 'destroyed', t: k.t });
    }

    // --- Waypoint advance.
    if (this.currentWaypoint < m.waypoints.length) {
      const wp = m.waypoints[this.currentWaypoint]!;
      const dx = ctx.playerState.x_W.x - wp.x;
      const dz = ctx.playerState.x_W.z - wp.z;
      // Horizontal proximity is enough — altitude is harder to hit and the
      // spec only requires "crossing" the egress.
      if (Math.sqrt(dx * dx + dz * dz) <= wp.r) {
        ctx.emit({ type: 'waypoint_reached', index: this.currentWaypoint, t: ctx.playerState.time });
        this.currentWaypoint += 1;
        // Egress crossing with success criteria ⇒ win.
        if (this.currentWaypoint > m.egressIndex) {
          this.evaluateWinOrLoseOnEgress(ctx);
        }
      }
    }

    // --- Pure lose conditions (regardless of egress).
    if (!this.won && !this.lost) {
      const ps = ctx.playerState;
      if (ps.hp && ps.hp.airframe <= 0 && ps.isAlive === false) {
        this.lost = true;
        this.emitEnd();
      } else if (this.bombsDropped >= COMBAT_TUNING.bombPerAircraft) {
        const required = Math.ceil(this.totalTargetCount() * 0.5);
        if (this.destroyedTargetCount < required) {
          this.lost = true;
          this.emitEnd();
        }
      }
    }

    this.pushHud(ctx);
  }

  status(): ModeStatus {
    const m = this.mission;
    const f = this.field;
    const hp = this.ctx?.playerState.hp;
    const hullPct = hp ? Math.max(0, Math.min(100, hp.airframe)) : 100;
    const bombsRem = COMBAT_TUNING.bombPerAircraft - this.bombsDropped;
    const totalTargets = f ? f.targets.length : 0;
    const score = this.computeScore(hullPct);
    const headline = `STRIKE — WP ${Math.min(this.currentWaypoint, (m?.waypoints.length ?? 1))}/${m?.waypoints.length ?? 0} · TGT ${this.destroyedTargetCount}/${totalTargets} · BMB ${bombsRem}/${COMBAT_TUNING.bombPerAircraft} · HULL ${hullPct.toFixed(0)}%`;
    const out: ModeStatus = {
      id: META.id,
      won: this.won,
      lost: this.lost,
      score,
      headline,
    };
    if (this.won) this.won = false;
    if (this.lost) this.lost = false;
    return out;
  }

  dispose(): void {
    const ctx = this.ctx;
    if (this.onKeyDown && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
    }
    this.onKeyDown = null;
    if (ctx && this.combat) ctx.scene.remove(this.combat.getRoot());
    if (ctx && this.field) ctx.scene.remove(this.field.group);
    if (ctx && this.waypointGroup) ctx.scene.remove(this.waypointGroup);
    if (ctx && !this.endedEmitted) {
      ctx.emit({
        type: 'mode_ended',
        mode: META.id,
        t: ctx.playerState.time,
        won: this.won,
        score: 0,
      });
      this.endedEmitted = true;
    }
    this.waypointMeshes = [];
    this.waypointGroup = null;
    this.sams = [];
    this.combat = null;
    this.field = null;
    this.mission = null;
    this.playerWeapons = null;
    this.ctx = null;
  }

  // ── Internals ────────────────────────────────────────────────────────────
  /** Drop one bomb and increment counters. Public-ish for tests. */
  dropOneBomb(): boolean {
    const c = this.combat;
    const ctx = this.ctx;
    const w = this.playerWeapons;
    if (!c || !ctx || !w) return false;
    if (w.bombsRemaining <= 0) return false;
    const idx = dropBomb(w, ctx.playerState, c.bombs, ctx.playerState.time);
    if (idx < 0) return false;
    this.bombsDropped += 1;
    ctx.emit({ type: 'shot_fired', weapon: 'bomb', t: ctx.playerState.time });
    return true;
  }

  private applyBombBlast(x: number, y: number, z: number, ctx: ModeContext): void {
    const f = this.field;
    if (!f) return;
    let anyHit = false;
    for (const t of f.targets) {
      if (t.destroyed) continue;
      const dx = t.spec.pos[0] - x;
      const dy = t.spec.pos[1] - y;
      const dz = t.spec.pos[2] - z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= BOMB_BLAST_RADIUS) continue;
      const falloff = Math.max(0, 1 - dist / BOMB_BLAST_RADIUS);
      const dmg = BOMB_DAMAGE_CENTER * falloff * falloff;
      t.hp = Math.max(0, t.hp - dmg);
      anyHit = true;
      ctx.emit({ type: 'hit', target: t.spec.id, weapon: 'bomb', t: ctx.playerState.time });
      if (t.hp <= 0) {
        destroyTarget(t);
        this.destroyedTargetCount += 1;
        ctx.emit({ type: 'kill', target: t.spec.id, weapon: 'bomb', t: ctx.playerState.time });
      }
    }
    void anyHit;
  }

  private totalTargetCount(): number {
    return this.field ? this.field.targets.length : 0;
  }

  private evaluateWinOrLoseOnEgress(ctx: ModeContext): void {
    if (this.won || this.lost) return;
    const required = Math.ceil(this.totalTargetCount() * 0.8);
    const ps = ctx.playerState;
    const alive = ps.hp ? ps.hp.airframe > 0 : true;
    if (this.destroyedTargetCount >= required && alive) {
      this.won = true;
    } else {
      this.lost = true;
    }
    this.emitEnd();
  }

  private computeScore(hullPct: number): number {
    const targetScore = this.destroyedTargetCount * 100;
    const timeBonus = Math.max(0, 600 - this.elapsedSeconds);
    const survivalBonus = Math.round(hullPct);
    return Math.round(targetScore + timeBonus + survivalBonus);
  }

  private emitEnd(): void {
    if (this.endedEmitted) return;
    this.endedEmitted = true;
    const ctx = this.ctx;
    if (!ctx) return;
    const hullPct = ctx.playerState.hp ? Math.max(0, Math.min(100, ctx.playerState.hp.airframe)) : 100;
    ctx.emit({
      type: 'mode_ended',
      mode: META.id,
      t: ctx.playerState.time,
      won: this.won,
      score: this.computeScore(hullPct),
    });
  }

  private pushHud(ctx: ModeContext): void {
    const m = this.mission;
    const f = this.field;
    if (!m || !f) return;
    const hud = ctx.hud as unknown as MissionHudShape;
    if (typeof hud.setMission !== 'function') return;
    const playerXZ = ctx.playerState.x_W;
    const waypoints = m.waypoints.map((wp) => {
      const dx = wp.x - playerXZ.x;
      const dz = wp.z - playerXZ.z;
      return { distanceKm: Math.sqrt(dx * dx + dz * dz) / 1000 };
    });
    const targets = f.targets.map((t) => ({
      id: t.spec.id,
      status: t.destroyed ? 'DEAD' as const : t.hp < t.spec.hp ? 'HIT' as const : 'LIVE' as const,
    }));
    hud.setMission({
      waypoints,
      currentWaypoint: Math.min(this.currentWaypoint, m.waypoints.length - 1),
      bombsRemaining: COMBAT_TUNING.bombPerAircraft - this.bombsDropped,
      bombsTotal: COMBAT_TUNING.bombPerAircraft,
      targets,
    });
  }
}
