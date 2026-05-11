// CombatNet — adapter wiring CombatSystem's events to/from a NetClient.
//
// Wave C scope (mp-combat). See:
//   - docs/combat-spec.md §7 (wire schemas, authority)
//   - docs/ai-spec.md §8 (bot retire / join handshake)
//   - AGENTS/mp-combat.md (this agent's brief)
//
// Authority: client-side hit detection, server pure relay. CombatNet
// translates between local CombatSystem state and the wire envelopes.
//
// Wire envelopes (outbound):
//   - ShootMsg     {type:'shoot', weapon, originPos, originVel, originQ, t, targetId?}
//   - HitMsg       {type:'hit', shooterId, targetId, weapon, zone, hpLoss, t}
//   - KillMsg      {type:'kill', shooterId, victimId, weapon, t}
//   - RespawnMsg   {type:'respawn', x, q, t}
//   - BotRetireMsg {type:'bot-retire', botId, t}            (host only)
//   - BotJoinMsg   {type:'bot-join', botId, t, x, q}        (host only)
//
// Inbound (NetClient typed emitter — relayed by server with sender `id`):
//   - 'peer-shoot'        → spawn projectile in local CombatSystem under shooterId
//   - 'peer-hit'          → if targetId == local id, apply damage to local state
//   - 'peer-kill'         → invoke kill-feed callback
//   - 'peer-respawn'      → reset peer participant pose / HP if registered
//   - 'peer-bot-retire'   → invoke bot envelope onRetire callback
//   - 'peer-bot-join'     → invoke bot envelope onJoin callback

import * as THREE from 'three';
import type { AircraftState } from '../physics/index.js';
import {
  COMBAT_TUNING,
  HARDPOINTS,
  applyBulletHit,
  applyMissileDirect,
  applyMissileProx,
  respawn,
  type CombatSystem,
  type DamageZone,
} from '../combat/index.js';
import type {
  NetClient,
  PeerShootMsg,
  PeerHitMsg,
  PeerKillMsg,
  PeerRespawnMsg,
  PeerBotRetireMsg,
  PeerBotJoinMsg,
} from './client.js';

const T = COMBAT_TUNING;

/** Weapon classes carried across the wire. */
export type CombatWireWeapon = 'gun' | 'missile' | 'bomb' | 'sam';

/** Local participant accessor — mode supplies a getter so CombatNet always
 *  sees fresh pose/velocity at send-time without holding stale snapshots. */
export type LocalStateGetter = () => Readonly<{
  x_W: THREE.Vector3;
  v_W: THREE.Vector3;
  q: THREE.Quaternion;
  time: number;
}>;

/** Kill feed entry shape passed to the mode's callback. */
export interface KillFeedEntry {
  shooterId: string;
  victimId: string;
  weapon: CombatWireWeapon;
  t: number;
}

/** Hooks the mode supplies for inbound bot lifecycle envelopes. */
export interface BotEnvelopeHandlers {
  onRetire?: (ev: PeerBotRetireMsg) => void;
  onJoin?: (ev: PeerBotJoinMsg) => void;
}

/**
 * Hooks the mode supplies for inbound combat events. All are optional —
 * CombatNet still handles the side-effect on its own combat-system
 * binding (spawn peer projectile, apply self-HP, etc.). The callbacks let
 * the HUD / mode react (kill feed, telemetry, etc.).
 */
export interface CombatNetHooks {
  /** Fired on inbound `peer-kill`. Mode appends to HUD kill feed. */
  onKill?: (ev: KillFeedEntry) => void;
  /** Fired on inbound `peer-hit` to self. After HP has been applied. */
  onSelfHit?: (ev: PeerHitMsg) => void;
  /** Fired on inbound `peer-shoot`. Mode may play tracer/cue. */
  onPeerShoot?: (ev: PeerShootMsg) => void;
  /** Fired on inbound `peer-respawn`. Mode may flash a respawn marker. */
  onPeerRespawn?: (ev: PeerRespawnMsg) => void;
}

const _scratchPos = new THREE.Vector3();
const _scratchVel = new THREE.Vector3();
const _scratchQuat = new THREE.Quaternion();
const _scratchMuzzleVel = new THREE.Vector3();

/**
 * CombatNet wraps a NetClient and CombatSystem so multiplayer dogfight
 * "just works" for the mode. Stateless except for:
 *   - local participant id + getState fn (set once by `setLocalParticipant`)
 *   - kill-feed / bot-envelope callbacks
 *   - unsubscribe handles for inbound listeners (cleared by `dispose()`)
 */
export class CombatNet {
  private localId: string | null = null;
  private getLocalState: LocalStateGetter | null = null;
  private hooks: CombatNetHooks = {};
  private botHandlers: BotEnvelopeHandlers = {};

  private readonly unsubs: Array<() => void> = [];

  constructor(
    private readonly net: NetClient,
    private readonly combat: CombatSystem,
  ) {
    // Subscribe ONCE at construction so message replay is deterministic.
    this.unsubs.push(this.net.on('peer-shoot', this.onPeerShoot));
    this.unsubs.push(this.net.on('peer-hit', this.onPeerHit));
    this.unsubs.push(this.net.on('peer-kill', this.onPeerKill));
    this.unsubs.push(this.net.on('peer-respawn', this.onPeerRespawn));
    this.unsubs.push(this.net.on('peer-bot-retire', this.onPeerBotRetire));
    this.unsubs.push(this.net.on('peer-bot-join', this.onPeerBotJoin));
  }

  /**
   * Register the local participant. The mode passes a stable id and a
   * pure getter so CombatNet can read fresh pose / velocity / time at the
   * moment a wire event is emitted.
   */
  setLocalParticipant(id: string, getState: LocalStateGetter): void {
    this.localId = id;
    this.getLocalState = getState;
  }

  /** Register mode-level hooks for HUD plumbing. */
  setHooks(hooks: CombatNetHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /**
   * Fetch the most recent local-state snapshot via the registered getter.
   * Returns null until `setLocalParticipant` has been called. Used by the
   * mode to derive shooter pose at the instant of fire without holding a
   * stale reference.
   */
  readLocalState(): ReturnType<LocalStateGetter> | null {
    return this.getLocalState ? this.getLocalState() : null;
  }

  /** True once `setLocalParticipant` has been called. */
  hasLocalParticipant(): boolean {
    return this.localId !== null && this.getLocalState !== null;
  }

  /** Register inbound bot-envelope callbacks (host registers; peers ignore). */
  subscribeBotEnvelope(handlers: BotEnvelopeHandlers): void {
    this.botHandlers = { ...this.botHandlers, ...handlers };
  }

  /** Drop all NetClient listeners. Idempotent. */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  // -------------------------------------------------------------------
  // Outbound — called by the mode (Dogfight) on local action.
  // -------------------------------------------------------------------

  /**
   * Local aircraft fired a weapon. Emits ShootMsg over the wire so peers
   * can spawn a matching projectile in their local CombatSystem.
   *
   * For guns: emit ONE message per trigger pull — peers compute both
   * tracers from the single origin/velocity pair (same convention as
   * `fireGun` which spawns L+R from a shared muzzle velocity).
   */
  sendShoot(
    weapon: 'gun' | 'missile' | 'bomb',
    originPos: THREE.Vector3,
    originVel: THREE.Vector3,
    originQ: THREE.Quaternion,
    t: number,
    targetId?: string | null,
  ): void {
    if (!this.localId) return;
    const payload: {
      type: 'shoot';
      weapon: 'gun' | 'missile' | 'bomb';
      originPos: [number, number, number];
      originVel: [number, number, number];
      originQ: [number, number, number, number];
      t: number;
      targetId?: string;
    } = {
      type: 'shoot',
      weapon,
      originPos: [originPos.x, originPos.y, originPos.z],
      originVel: [originVel.x, originVel.y, originVel.z],
      originQ: [originQ.x, originQ.y, originQ.z, originQ.w],
      t,
    };
    if (targetId) payload.targetId = targetId;
    this.net.send(payload);
  }

  /** Shooter detected a hit on a target (combat-spec §7.1 client-side detection). */
  sendHit(
    targetId: string,
    weapon: CombatWireWeapon,
    zone: DamageZone,
    hpLoss: number,
    t: number,
  ): void {
    if (!this.localId) return;
    this.net.send({
      type: 'hit',
      shooterId: this.localId,
      targetId,
      weapon,
      zone,
      hpLoss,
      t,
    });
  }

  /** Local airframe HP reached zero — announce who killed us. */
  sendKill(shooterId: string, weapon: CombatWireWeapon, t: number): void {
    if (!this.localId) return;
    this.net.send({
      type: 'kill',
      shooterId,
      victimId: this.localId,
      weapon,
      t,
    });
  }

  /** Local respawn — broadcast new pose. */
  sendRespawn(x: THREE.Vector3, q: THREE.Quaternion, t: number): void {
    if (!this.localId) return;
    this.net.send({
      type: 'respawn',
      x: [x.x, x.y, x.z],
      q: [q.x, q.y, q.z, q.w],
      t,
    });
  }

  /**
   * Host announces it is retiring a bot to free a slot for a human peer
   * (ai-spec §8.1). botId must match the id the host used when
   * registering the bot as a CombatParticipant.
   */
  sendBotRetire(botId: string, t: number): void {
    if (!this.localId) return;
    this.net.send({ type: 'bot-retire', botId, t });
  }

  /** Host announces a new bot spawn so peers can mirror it. */
  sendBotJoin(
    botId: string,
    t: number,
    x: THREE.Vector3,
    q: THREE.Quaternion,
  ): void {
    if (!this.localId) return;
    this.net.send({
      type: 'bot-join',
      botId,
      t,
      x: [x.x, x.y, x.z],
      q: [q.x, q.y, q.z, q.w],
    });
  }

  // -------------------------------------------------------------------
  // Inbound — handlers reflect peer events into local CombatSystem.
  // -------------------------------------------------------------------

  private onPeerShoot = (msg: PeerShootMsg): void => {
    // Spawn a foreign projectile in the local pool, attributed to msg.id.
    // The shooter side has its own pool — both sides simulate the same
    // initial conditions so trajectories match within numerical tolerance.
    _scratchPos.set(msg.originPos[0], msg.originPos[1], msg.originPos[2]);
    _scratchVel.set(msg.originVel[0], msg.originVel[1], msg.originVel[2]);
    _scratchQuat.set(msg.originQ[0], msg.originQ[1], msg.originQ[2], msg.originQ[3]);

    if (msg.weapon === 'gun') {
      // Replicate fireGun's L+R muzzle spawn: shared muzzle velocity, two
      // body-frame hardpoints rotated by shooter quaternion.
      _scratchMuzzleVel
        .set(T.bulletMuzzleVel, 0, 0)
        .applyQuaternion(_scratchQuat)
        .add(_scratchVel);
      const spawnPos = new THREE.Vector3();
      // Left hardpoint
      spawnPos
        .copy(HARDPOINTS.bulletL)
        .applyQuaternion(_scratchQuat)
        .add(_scratchPos);
      this.combat.bullets.spawn({
        x: spawnPos,
        v: _scratchMuzzleVel,
        shooterId: msg.id,
        t: msg.t,
      });
      // Right hardpoint
      const spawnPosR = new THREE.Vector3()
        .copy(HARDPOINTS.bulletR)
        .applyQuaternion(_scratchQuat)
        .add(_scratchPos);
      this.combat.bullets.spawn({
        x: spawnPosR,
        v: _scratchMuzzleVel,
        shooterId: msg.id,
        t: msg.t,
      });
    } else if (msg.weapon === 'missile') {
      const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(_scratchQuat);
      const launchVel = new THREE.Vector3(T.missileLaunchVel, 0, 0)
        .applyQuaternion(_scratchQuat)
        .add(_scratchVel);
      // Default to one of the two rails (rail selection is cosmetic for
      // visibility — peers cannot know which rail; left is fine).
      const spawnPos = new THREE.Vector3()
        .copy(HARDPOINTS.railL)
        .applyQuaternion(_scratchQuat)
        .add(_scratchPos);
      this.combat.missiles.spawn({
        x: spawnPos,
        v: launchVel,
        fwd_W: fwd,
        shooterId: msg.id,
        kind: 'ir',
        lockedTargetId: msg.targetId ?? null,
        t: msg.t,
      });
    } else if (msg.weapon === 'bomb') {
      const spawnPos = new THREE.Vector3()
        .copy(HARDPOINTS.bomb)
        .applyQuaternion(_scratchQuat)
        .add(_scratchPos);
      this.combat.bombs.spawn({
        x: spawnPos,
        v: _scratchVel.clone(),
        shooterId: msg.id,
        t: msg.t,
      });
    }

    this.hooks.onPeerShoot?.(msg);
  };

  private onPeerHit = (msg: PeerHitMsg): void => {
    // Apply HP loss locally ONLY if we are the target (authority model:
    // shooter detects, victim mutates). For other targets we let the
    // owning client mutate its own state. The host case where targetId
    // matches a participant we own (e.g. a bot) is also handled — we
    // mutate any participant we own and that includes ourselves.
    if (!this.localId) return;
    const me = this.localId;
    if (msg.targetId !== me) {
      // Not for us. If we host a bot with this id, apply damage on its
      // behalf — see edge cases in mp-combat-report.md.
      const p = this.combat.getParticipant(msg.targetId);
      if (p && p.state.hp) {
        applyByWeapon(p.state, msg);
      }
      return;
    }
    const meP = this.combat.getParticipant(me);
    if (meP && meP.state.hp) {
      applyByWeapon(meP.state, msg);
    }
    this.hooks.onSelfHit?.(msg);
  };

  private onPeerKill = (msg: PeerKillMsg): void => {
    this.hooks.onKill?.({
      shooterId: msg.shooterId,
      victimId: msg.victimId,
      weapon: msg.weapon,
      t: msg.t,
    });
  };

  private onPeerRespawn = (msg: PeerRespawnMsg): void => {
    // If the respawning peer is one of our combat participants (e.g. we
    // host a bot peer mirror), reset its HP + pose locally.
    const p = this.combat.getParticipant(msg.id);
    if (p) {
      _scratchPos.set(msg.x[0], msg.x[1], msg.x[2]);
      _scratchQuat.set(msg.q[0], msg.q[1], msg.q[2], msg.q[3]);
      respawn(p.state, _scratchPos, _scratchQuat);
    }
    this.hooks.onPeerRespawn?.(msg);
  };

  private onPeerBotRetire = (msg: PeerBotRetireMsg): void => {
    this.botHandlers.onRetire?.(msg);
  };

  private onPeerBotJoin = (msg: PeerBotJoinMsg): void => {
    this.botHandlers.onJoin?.(msg);
  };
}

/** Dispatch table for inbound HP application. Centralised for testability. */
function applyByWeapon(state: AircraftState, msg: PeerHitMsg): void {
  switch (msg.weapon) {
    case 'gun':
      // Range info is not on the wire; rely on the wire-supplied hpLoss as
      // an authoritative override when present, otherwise fall back to a
      // zero-range bullet hit on the announced zone.
      if (msg.hpLoss > 0) {
        applyDirectHpLoss(state, msg.zone, msg.hpLoss);
      } else {
        applyBulletHit(state, msg.zone, 0);
      }
      break;
    case 'missile':
    case 'sam':
      if (msg.hpLoss > 0) {
        // Direct hit, but distribute according to spec §4.1.
        applyMissileDirect(state);
      } else {
        // Prox hit — distance unknown; treat as airframe-grazing.
        applyMissileProx(state, 0, msg.t);
      }
      break;
    case 'bomb':
      // Bombs don't damage aircraft in v0.2 (ground only); ignore.
      break;
  }
}

/**
 * Apply an exact HP loss to the named zone. Used when the shooter
 * computed the falloff and we trust the wire value (authority §7.1).
 */
function applyDirectHpLoss(
  state: AircraftState,
  zone: DamageZone,
  hpLoss: number,
): void {
  if (!state.hp || state.isAlive === false) return;
  const c = state.hp.controls;
  switch (zone) {
    case 'engine':
      state.hp.engine = Math.max(0, state.hp.engine - hpLoss);
      break;
    case 'aileron':
      c.aileron = Math.max(0, c.aileron - hpLoss);
      break;
    case 'elevator':
      c.elevator = Math.max(0, c.elevator - hpLoss);
      break;
    case 'rudder':
      c.rudder = Math.max(0, c.rudder - hpLoss);
      break;
    case 'airframe':
    default:
      state.hp.airframe = Math.max(0, state.hp.airframe - hpLoss);
      break;
  }
  if (state.hp.airframe <= 0) {
    state.isAlive = false;
    state.respawnAt = state.time + COMBAT_TUNING.respawnDelay;
  }
}

/** Re-export for mode consumers. */
export type { PeerBotRetireMsg, PeerBotJoinMsg } from './client.js';
