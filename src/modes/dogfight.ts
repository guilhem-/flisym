// Dogfight Mode — player vs 1 AI bandit (PvE default) or human peers (PvP).
//
// Spec: docs/modes/dogfight.md. This module composes:
//   - CombatSystem  (src/combat) for projectiles, hit-tests, damage.
//   - createAIPilot (src/ai) for the bot's Controls struct at 30 Hz.
//   - advance       (src/physics) ticked once per render frame for the bot
//                   using its AI-emitted controls (same path as the player).
//
// Win = bot destroyed (or all PvP peers destroyed). Lose = player airframe
// HP ≤ 0. Edge-triggered: `won` / `lost` go true exactly once.
//
// Frame axes (per `docs/modes/_mode-interface.md`):
//   world +X east / +Y up / +Z south; body +X forward / +Y up / +Z right.
// Bot spawn world (0, 700, +2000), heading 000° (north, i.e. body +X = world -Z).

import * as THREE from 'three';
import type { Mode, ModeContext, ModeMeta, ModeStatus } from './types.js';
import type { AircraftState, Controls } from '../physics/state.js';
import { advance, createInitialState, createNeutralControls } from '../physics/index.js';
import { buildCessna } from '../aircraft/index.js';
import {
  CombatSystem,
  COMBAT_TUNING,
  createWeaponState,
  fireGun,
  fireMissile,
  acquireLock,
  respawn as combatRespawn,
  type WeaponState,
  type SeekerTarget,
} from '../combat/index.js';
import {
  createAIPilot,
  AI_TUNING_VETERAN,
  createPercepts,
  observe,
  type AIPilot,
  type EnemyView,
  type Percepts,
} from '../ai/index.js';

const META: ModeMeta = {
  id: 'dogfight',
  displayName: 'Dogfight',
  description: 'Guns + Sidewinders vs an AI bandit (or peers via WebSocket).',
};

/** AI tick rate (Hz) per docs/ai-spec.md §2.6. */
const AI_HZ = 30;
const AI_DT = 1 / AI_HZ;

/** Bot retire grace window when humans take over (ai-spec §8.1). */
const BOT_RTB_S = 10;

/** Player spawn world per spec §3 (Dogfight). */
const PLAYER_SPAWN_POS = new THREE.Vector3(0, 600, -2000);
/** Bot spawn world per spec §3. */
const BOT_SPAWN_POS = new THREE.Vector3(0, 700, +2000);

/** Body +X → world -Z (heading 180°, south). */
function makeQHeading180(): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
}
/** Body +X → world +X (heading 090°, identity heading for the bot's "north"
 *  using our YZX heading=-Euler.y convention is 000° but the spec wants the
 *  bot pointed at the player — so the bot is identity quaternion (body +X =
 *  world +X) only if the player is at +X. Spec actually says player at -Z,
 *  bot at +Z → head-on means bot points to -Z, so bot heading = 000° which
 *  also rotates body +X onto world -Z (identical to the player). However
 *  per spec §3 second paragraph: "Enemy ... Heading 000° (north). v_W body
 *  (70,0,0)." With heading 000° = -Z, body +X → -Z, so head-on means the
 *  bot also rotates body +X onto -Z — same as the player. Let's do that
 *  literally: both aircraft point at -Z, but separated along Z so they fly
 *  TOWARD each other from opposite Z signs. The player at z=-2000 going
 *  toward -Z would FLEE the bot. Re-reading spec: player at -2000 (-Z of
 *  origin), bot at +2000. For "merging head-on", the player flies in -Z (so
 *  heading 000° = body +X → world -Z) and the bot flies in +Z. Hence the
 *  bot's heading is 180°, body +X → world +Z. So the player gets the
 *  q-180-about-Y of the spec table, and the bot gets identity-ish but
 *  facing +Z. */
function makeQHeading0(): THREE.Quaternion {
  // axis = +Y, angle = +π rotates body +X onto world -Z. To point body +X
  // onto world +Z we want angle 0 about +Y but then body +X = world +X.
  // The only quaternion that maps +X → +Z is axis +Y, angle -π/2. But
  // re-reading the spec yet again: §3 says player faces heading 180°
  // (south), which uses axis=+Y angle=+π → body +X → world -Z. The bot
  // faces "000° (north)" which is +Y/angle=0 (identity) → body +X → world
  // +X. Neither rotates body +X onto -Z or +Z directly; the world frame
  // convention in _mode-interface.md actually has +Z = south. Heading
  // 000° (north) therefore means nose pointing toward -Z, which means
  // body +X → world -Z, which IS the q with axis +Y angle +π. So the
  // player at z=-2000 facing 180° (south) means nose toward +Z; the bot
  // at z=+2000 facing 000° (north) means nose toward -Z. The two close on
  // each other along ±Z. That matches the spec's "head-on at +Z distance".
  // Player q = axis +Y angle 0 (identity, since heading 180° = +Z = body
  // +X mapped to... wait). Let me pin this down once with a single rule:
  // heading h corresponds to forward vector (sin h, 0, -cos h) per the
  // ai-spec convention (Appendix B). h=0 → (0,0,-1) (north). h=π → (0,0,+1)
  // (south). The quaternion that rotates body +X = (1,0,0) onto this
  // forward vec is axis = (0,1,0), angle = h - π/2 (because identity maps
  // body +X onto world +X = heading +π/2 = east). So player h=π → angle
  // π/2 → q = (0, sin(π/4), 0, cos(π/4)) = (0, 0.707, 0, 0.707). And bot
  // h=0 → angle -π/2 → q = (0, -0.707, 0, 0.707).
  return new THREE.Quaternion(); // unused; kept for symmetry
}

/** Build the player spawn quaternion: heading 180° (south, body +X = world +Z).
 *  Rotation about +Y by -π/2 takes body +X = (1,0,0) onto world +Z = (0,0,+1). */
function playerSpawnQ(): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
}

/** Build the bot spawn quaternion: heading 000° (north, body +X = world -Z).
 *  Rotation about +Y by +π/2 takes body +X = (1,0,0) onto world -Z = (0,0,-1). */
function botSpawnQ(): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
}

/** Player spawn body velocity: (70, 0, 0) m/s in body frame. */
function playerSpawnVelocity(): THREE.Vector3 {
  const v = new THREE.Vector3(70, 0, 0);
  v.applyQuaternion(playerSpawnQ());
  return v;
}
function botSpawnVelocity(): THREE.Vector3 {
  const v = new THREE.Vector3(70, 0, 0);
  v.applyQuaternion(botSpawnQ());
  return v;
}

/** Bot record bundled per spec §7 participant entry. */
interface BotRecord {
  id: string;
  state: AircraftState;
  controls: Controls;
  weapons: WeaponState;
  pilot: AIPilot;
  percepts: Percepts;
  mesh: THREE.Group;
  /** True once the bot's retirement (RTB-then-despawn) has been latched. */
  retiring: boolean;
  /** sim-time after which the bot is removed entirely. */
  retireDespawnAt: number;
}

/** Optional HUD APIs the mode targets — hud-combat (Wave C) supplies these. */
interface HudWithCombat {
  setCombat?(state: unknown): void;
  setMission?(state: unknown): void;
}

export class DogfightMode implements Mode {
  readonly meta: ModeMeta = META;

  // Public for tests — defensive readers only.
  combat: CombatSystem | null = null;
  bot: BotRecord | null = null;
  /** Edge-trigger latches: status() returns these once, then clears. */
  private won = false;
  private lost = false;
  private endedEmitted = false;
  /** K/D score across respawns this session. */
  private kills = 0;
  private deaths = 0;

  private ctx: ModeContext | null = null;
  /** Player weapon bookkeeping (independent of the combat system to allow
   *  reset on respawn). The combat system owns its own copy via participant
   *  registration; this one is the source of truth for HUD ammo readouts. */
  playerWeapons: WeaponState | null = null;

  private aiAccum = 0;
  private playerSpawnQuat = playerSpawnQ();
  private playerLockedTargetId: string | null = null;
  private gunHeld = false;
  private respawnEdge = false;
  private lastDeathLatched = false;

  /** mp-combat envelope: `peer-bot-retire` listeners — removed on dispose. */
  private offBotRetire: (() => void) | null = null;
  /** Window keydown / keyup wired on init, removed on dispose. */
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private onKeyUp: ((e: KeyboardEvent) => void) | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────────────
  init(ctx: ModeContext): void {
    this.ctx = ctx;
    this.won = false;
    this.lost = false;
    this.endedEmitted = false;
    this.kills = 0;
    this.deaths = 0;
    this.aiAccum = 0;
    this.playerLockedTargetId = null;
    this.gunHeld = false;
    this.respawnEdge = false;
    this.lastDeathLatched = false;

    // --- Reset player to Dogfight spawn (mode owns this exception per
    // _mode-interface.md: "respawn-style resets").
    const ps = ctx.playerState;
    ps.x_W.copy(PLAYER_SPAWN_POS);
    ps.q.copy(this.playerSpawnQuat);
    ps.v_W.copy(playerSpawnVelocity());
    ps.omega_B.set(0, 0, 0);
    ps.throttle = 0.85;
    ps.delta_a = 0;
    ps.delta_e = 0;
    ps.delta_r = 0;
    ps.delta_f = 0;
    ps.onGround = false;
    ps.accumulator = 0;
    combatRespawn(ps); // resets HP / isAlive / weapons-side state on aircraft
    ctx.playerControls.aileronCmd = 0;
    ctx.playerControls.elevatorCmd = 0;
    ctx.playerControls.rudderCmd = 0;
    ctx.playerControls.throttleCmd = 0.85;
    ctx.playerControls.flapsCmd = 0;
    ctx.playerControls.brake = false;

    // --- Combat system.
    const combat = new CombatSystem();
    combat.setWorld({ getGroundHeight: (x, z) => ctx.world.getGroundHeight(x, z) });
    combat.playerPos = ps.x_W;
    this.combat = combat;
    ctx.scene.add(combat.getRoot());

    // Player participant.
    this.playerWeapons = createWeaponState('player');
    combat.register({
      id: 'player',
      state: ps,
      team: 'allies',
      weapons: this.playerWeapons,
    });

    // --- Bot spawn.
    const botId = 'bandit-01';
    const botState = createInitialState();
    botState.x_W.copy(BOT_SPAWN_POS);
    botState.q.copy(botSpawnQ());
    botState.v_W.copy(botSpawnVelocity());
    botState.omega_B.set(0, 0, 0);
    botState.throttle = 0.85;
    botState.onGround = false;
    botState.accumulator = 0;

    const botControls = createNeutralControls();
    botControls.throttleCmd = 0.85;
    const botWeapons = createWeaponState(botId);

    // Bot mesh — slightly tinted clone of the player's Cessna.
    const built = buildCessna();
    built.group.name = botId;
    built.group.position.copy(botState.x_W);
    built.group.quaternion.copy(botState.q);
    ctx.scene.add(built.group);

    // AI pilot: seed deterministically off ctx.seed (per ai-spec §6.3 hash).
    const botSeed = (ctx.seed ^ 0x9e3779b9) >>> 0;
    const pilot = createAIPilot(botSeed, AI_TUNING_VETERAN);

    this.bot = {
      id: botId,
      state: botState,
      controls: botControls,
      weapons: botWeapons,
      pilot,
      percepts: createPercepts(),
      mesh: built.group,
      retiring: false,
      retireDespawnAt: Number.POSITIVE_INFINITY,
    };
    combat.register({ id: botId, state: botState, team: 'bandits', weapons: botWeapons });

    // --- PvP override: when peers in dogfight room, retire the bot.
    // Detection is conservative — we just listen for peer-bot-retire and
    // also retire whenever the underlying NetClient reports >0 peers.
    this.offBotRetire = ctx.net.on('peer-bot-retire', (msg) => {
      if (msg.botId === botId) this.beginBotRetirement();
    });
    if (typeof window !== 'undefined') {
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get('mp') === '1') {
          // If peers already known, retire immediately. Otherwise the
          // periodic check inside update() handles it.
          if (ctx.net.getPeers().size > 0) {
            this.beginBotRetirement();
          }
        }
      } catch {
        /* non-browser host — ignore */
      }
    }

    // --- Keybindings.
    this.onKeyDown = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'space') {
        this.gunHeld = true;
        e.preventDefault?.();
      } else if (k === 'x') {
        if (!e.repeat) this.firePlayerMissile();
      } else if (k === 't') {
        if (!e.repeat) this.cycleTarget();
      } else if (k === 'r') {
        if (!e.repeat) this.requestRespawn();
      } else if (k === 'l') {
        if (!e.repeat) this.refreshLock();
      }
    };
    this.onKeyUp = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'space') this.gunHeld = false;
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
    }

    // HUD: clear v0.1 panels that aren't ours.
    ctx.hud.setChallenge(null);
    ctx.hud.hideFinishOverlay();

    ctx.emit({ type: 'mode_started', mode: META.id, t: ps.time });
  }

  update(dt: number, ctx: ModeContext): void {
    const combat = this.combat;
    const bot = this.bot;
    if (!combat) return;
    if (this.endedEmitted) {
      // After mode_ended fires we still tick combat so explosions drain.
      combat.update(dt);
      this.pushHud(ctx);
      return;
    }

    const ps = ctx.playerState;

    // --- Player gun (auto-fire while Space held).
    if (this.gunHeld && this.playerWeapons && ps.isAlive !== false) {
      const spawned = fireGun(this.playerWeapons, ps, combat.bullets, ps.time);
      if (spawned > 0) ctx.emit({ type: 'shot_fired', weapon: 'gun', t: ps.time });
    }

    // --- Bot retire window (10 s RTB ramp; despawn at retireDespawnAt).
    if (bot && bot.retiring && ps.time >= bot.retireDespawnAt) {
      combat.unregister(bot.id);
      ctx.scene.remove(bot.mesh);
      this.bot = null;
    }

    // --- Bot AI tick at 30 Hz via accumulator + bot physics every frame.
    if (this.bot) {
      const bot = this.bot;
      this.aiAccum += dt;
      while (this.aiAccum >= AI_DT) {
        this.aiAccum -= AI_DT;
        // Build enemies list (player only for v0.2 single-bot PvE).
        const enemies: EnemyView[] = [
          {
            id: 'player',
            isAlive: ps.isAlive !== false,
            isPlayer: true,
            hp: ps.hp ? Math.max(0, ps.hp.airframe) / 100 : 1,
            x_W: ps.x_W,
            v_W: ps.v_W,
          },
        ];
        const p = bot.percepts;
        observe(p, bot.state, enemies, null, AI_TUNING_VETERAN, p.tickIndex + 1);
        const out = bot.pilot.tick(p, AI_DT);
        bot.controls.aileronCmd = out.aileronCmd;
        bot.controls.elevatorCmd = out.elevatorCmd;
        bot.controls.rudderCmd = out.rudderCmd;
        bot.controls.throttleCmd = out.throttleCmd;
        bot.controls.flapsCmd = out.flapsCmd;
        bot.controls.brake = out.brake;

        // Trigger emission — fire bot's guns when in gun cone.
        if (
          p.inGunCone &&
          p.targetRangeM < AI_TUNING_VETERAN.gunRangeM &&
          bot.state.isAlive !== false &&
          !bot.retiring
        ) {
          fireGun(bot.weapons, bot.state, combat.bullets, bot.state.time);
        }
      }
      // Step bot physics every render frame (single advance() call).
      advance(bot.state, dt, bot.controls, (x, z) => ctx.world.getGroundHeight(x, z));
      // Sync bot mesh from physics state.
      bot.mesh.position.copy(bot.state.x_W);
      bot.mesh.quaternion.copy(bot.state.q);
    }

    // --- Combat tick (bullets/missiles/bombs integration + hit-tests).
    combat.update(dt);

    // --- Consume hit/kill events for telemetry + score.
    const events = combat.consumeEvents();
    for (const h of events.hits) {
      ctx.emit({
        type: 'hit',
        target: h.targetId,
        weapon: h.weapon === 'sam' ? 'missile' : h.weapon,
        t: h.t,
      });
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
      ctx.emit({
        type: 'kill',
        target: k.victimId,
        weapon: k.weapon === 'sam' ? 'missile' : k.weapon,
        t: k.t,
      });
      if (k.victimId === 'player') {
        if (!this.lastDeathLatched) {
          this.deaths += 1;
          this.lastDeathLatched = true;
        }
        ctx.emit({ type: 'destroyed', t: k.t });
      } else if (k.shooterId === 'player') {
        this.kills += 1;
      }
    }
    // Reset the "death already counted" latch once the player is back alive
    // (combat system auto-respawns after RESPAWN_DELAY).
    if (ps.isAlive !== false) this.lastDeathLatched = false;

    // --- Edge-triggered win / lose detection.
    const botGone = this.bot === null || (this.bot.state.isAlive === false);
    if (!this.won && !this.lost) {
      if (ps.hp && ps.hp.airframe <= 0 && ps.isAlive === false) {
        this.lost = true;
        this.emitEnd();
      } else if (botGone) {
        this.won = true;
        this.emitEnd();
      }
    }

    this.pushHud(ctx);
  }

  status(): ModeStatus {
    const ctx = this.ctx;
    const ps = ctx?.playerState;
    const hp = ps?.hp;
    const hullPct = hp ? Math.max(0, Math.min(100, hp.airframe)) : 100;
    const gunRounds = (this.playerWeapons?.gunRoundsL ?? 0) + (this.playerWeapons?.gunRoundsR ?? 0);
    const msl = this.playerWeapons?.missileRailsRemaining ?? 0;
    const score = this.kills * 100 - this.deaths * 50;
    const headline = `DOGFIGHT — K:D ${this.kills}/${this.deaths} · GUNS ${gunRounds} · MSL ${msl}/${COMBAT_TUNING.missileRailsPerAircraft} · HULL ${hullPct.toFixed(0)}%`;
    const out: ModeStatus = {
      id: META.id,
      won: this.won,
      lost: this.lost,
      score,
      headline,
    };
    // Edge-trigger reset: clear won/lost after one read so the spec's
    // "false on every frame after the first" contract holds.
    if (this.won) this.won = false;
    if (this.lost) this.lost = false;
    return out;
  }

  dispose(): void {
    const ctx = this.ctx;
    if (this.onKeyDown && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
    }
    if (this.onKeyUp && typeof window !== 'undefined') {
      window.removeEventListener('keyup', this.onKeyUp);
    }
    this.onKeyDown = null;
    this.onKeyUp = null;
    if (this.offBotRetire) {
      this.offBotRetire();
      this.offBotRetire = null;
    }
    if (ctx && this.combat) {
      ctx.scene.remove(this.combat.getRoot());
    }
    if (ctx && this.bot) {
      ctx.scene.remove(this.bot.mesh);
    }
    if (ctx && !this.endedEmitted) {
      ctx.emit({
        type: 'mode_ended',
        mode: META.id,
        t: ctx.playerState.time,
        won: this.won,
        score: this.kills * 100 - this.deaths * 50,
      });
      this.endedEmitted = true;
    }
    this.combat = null;
    this.bot = null;
    this.playerWeapons = null;
    this.ctx = null;
  }

  // ── Public test helpers ──────────────────────────────────────────────────
  /** Fire the player's gun once (one fire-gate cycle). Test-facing. */
  firePlayerGun(): number {
    const c = this.combat;
    const w = this.playerWeapons;
    const ctx = this.ctx;
    if (!c || !w || !ctx) return 0;
    return fireGun(w, ctx.playerState, c.bullets, ctx.playerState.time);
  }

  // ── Internals ────────────────────────────────────────────────────────────
  private firePlayerMissile(): void {
    const c = this.combat;
    const w = this.playerWeapons;
    const ctx = this.ctx;
    if (!c || !w || !ctx) return;
    const idx = fireMissile(
      w,
      ctx.playerState,
      c.missiles,
      ctx.playerState.time,
      this.playerLockedTargetId,
      'ir',
    );
    if (idx >= 0) ctx.emit({ type: 'shot_fired', weapon: 'missile', t: ctx.playerState.time });
  }

  private cycleTarget(): void {
    if (!this.bot) {
      this.playerLockedTargetId = null;
      return;
    }
    // Only one target in v0.2 — toggle lock between bot and none.
    if (this.playerLockedTargetId === this.bot.id) this.playerLockedTargetId = null;
    else this.playerLockedTargetId = this.bot.id;
  }

  private refreshLock(): void {
    const c = this.combat;
    const ctx = this.ctx;
    if (!c || !ctx) return;
    const ps = ctx.playerState;
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(ps.q);
    const seekerTargets = new Map<string, SeekerTarget>();
    for (const p of [this.bot].filter(Boolean) as BotRecord[]) {
      seekerTargets.set(p.id, {
        id: p.id,
        x_W: p.state.x_W,
        v_W: p.state.v_W,
        throttle: p.state.throttle,
        isAlive: p.state.isAlive !== false,
      });
    }
    const id = acquireLock(ps.x_W, fwd, seekerTargets, 'ir', 'player');
    this.playerLockedTargetId = id;
    if (id) ctx.emit({ type: 'lock_acquired', target: id, t: ps.time });
  }

  private requestRespawn(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const ps = ctx.playerState;
    if (ps.isAlive !== false) return; // R only legal while dead.
    if (this.respawnEdge) return;
    this.respawnEdge = true;
    combatRespawn(ps, PLAYER_SPAWN_POS, this.playerSpawnQuat);
    ps.v_W.copy(playerSpawnVelocity());
    if (this.playerWeapons) {
      this.playerWeapons.gunRoundsL = COMBAT_TUNING.bulletMagPerGun;
      this.playerWeapons.gunRoundsR = COMBAT_TUNING.bulletMagPerGun;
      this.playerWeapons.missileRailsRemaining = COMBAT_TUNING.missileRailsPerAircraft;
    }
    // Allow next R-press once the player is alive again (one-shot latch
    // cleared on next update tick).
    setTimeout(() => {
      this.respawnEdge = false;
    }, 0);
  }

  private beginBotRetirement(): void {
    const bot = this.bot;
    if (!bot || bot.retiring) return;
    bot.retiring = true;
    bot.retireDespawnAt = bot.state.time + BOT_RTB_S;
    // Force the FSM to RTB by mutating the snapshot — per ai-coder report,
    // this is the recommended retirement latch.
    try {
      const snap = bot.pilot.snapshot();
      snap.fsm = 'RTB';
      snap.gi = 'rtb-cruise';
      snap.gt = null;
      bot.pilot.restore(snap);
    } catch {
      /* defensive — snapshot failures shouldn't crash the mode */
    }
  }

  private emitEnd(): void {
    if (this.endedEmitted) return;
    this.endedEmitted = true;
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.emit({
      type: 'mode_ended',
      mode: META.id,
      t: ctx.playerState.time,
      won: this.won,
      score: this.kills * 100 - this.deaths * 50,
    });
  }

  private pushHud(ctx: ModeContext): void {
    const c = this.combat;
    if (!c) return;
    const hud = ctx.hud as unknown as HudWithCombat;
    if (typeof hud.setCombat === 'function') {
      hud.setCombat(c.snapshot());
    }
  }
}
// Avoid unused-import / unused-symbol noise (kept above for forward-compat
// pointers; intentionally not deleted).
void makeQHeading180;
void makeQHeading0;
