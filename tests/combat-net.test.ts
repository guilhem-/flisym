// CombatNet tests (mp-combat brief §Test additions). 5 mandatory cases.
//
// We construct a real CombatSystem (with a stub world) and a *mock*
// NetClient that exposes the same on/send/emit surface but no WebSocket.
// All routing is verified through the typed emitter.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CombatNet } from '../src/net/combat-net.js';
import {
  CombatSystem,
  COMBAT_TUNING,
  createWeaponState,
} from '../src/combat/index.js';
import { createInitialState } from '../src/physics/state.js';
import type {
  NetClient,
  NetEvents,
  PeerShootMsg,
  PeerHitMsg,
  PeerKillMsg,
  PeerRespawnMsg,
  PeerBotRetireMsg,
  PeerBotJoinMsg,
} from '../src/net/client.js';

type SendablePayload = { type: string; [k: string]: unknown };

/** Test double for NetClient — captures sends, exposes a manual emit() so
 *  tests can simulate inbound server-relayed messages. */
class MockNet {
  public readonly sent: SendablePayload[] = [];
  public id = 'local-host';
  private readonly listeners: {
    [K in keyof NetEvents]: Array<(ev: NetEvents[K]) => void>;
  } = {
    'peer-shoot': [],
    'peer-hit': [],
    'peer-kill': [],
    'peer-respawn': [],
    'peer-bot-retire': [],
    'peer-bot-join': [],
  };
  on<K extends keyof NetEvents>(t: K, fn: (ev: NetEvents[K]) => void): () => void {
    this.listeners[t].push(fn);
    return () => {
      const arr = this.listeners[t];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }
  send(payload: SendablePayload): void {
    this.sent.push(payload);
  }
  /** Tests call this directly to fake a server-relayed inbound message. */
  emit<K extends keyof NetEvents>(t: K, ev: NetEvents[K]): void {
    for (const fn of this.listeners[t]) fn(ev);
  }
  /** No-op compat fields to satisfy NetClient duck-typing. */
  getRoot(): THREE.Group { return new THREE.Group(); }
}

function makeFixture(): {
  net: MockNet;
  cn: CombatNet;
  combat: CombatSystem;
  localId: string;
} {
  const net = new MockNet();
  const combat = new CombatSystem();
  combat.setWorld({ getGroundHeight: () => 0 });
  const cn = new CombatNet(net as unknown as NetClient, combat);
  const localId = 'pilot-A';
  const localState = createInitialState();
  // Spawn at altitude with forward velocity so projectile spawning is sensible.
  localState.x_W.set(0, 500, 0);
  localState.v_W.set(50, 0, 0);
  combat.register({
    id: localId,
    state: localState,
    weapons: createWeaponState(localId),
  });
  cn.setLocalParticipant(localId, () => ({
    x_W: localState.x_W,
    v_W: localState.v_W,
    q: localState.q,
    time: localState.time,
  }));
  return { net, cn, combat, localId };
}

describe('CombatNet — outbound (mode → wire)', () => {
  it('sendShoot emits a ShootMsg matching combat-spec §7.2', () => {
    const { net, cn } = makeFixture();
    const x = new THREE.Vector3(1, 500, 2);
    const v = new THREE.Vector3(50, 0, 0);
    const q = new THREE.Quaternion(0, 0, 0, 1);
    cn.sendShoot('gun', x, v, q, 1.25, 'pilot-B');
    expect(net.sent).toHaveLength(1);
    const msg = net.sent[0]!;
    expect(msg.type).toBe('shoot');
    expect(msg.weapon).toBe('gun');
    expect(msg.t).toBe(1.25);
    expect(msg.targetId).toBe('pilot-B');
    expect(msg.originPos).toEqual([1, 500, 2]);
    expect(msg.originVel).toEqual([50, 0, 0]);
    expect(msg.originQ).toEqual([0, 0, 0, 1]);
  });
});

describe('CombatNet — inbound peer-shoot', () => {
  it('spawns a peer projectile in the local CombatSystem under shooterId', () => {
    const { net, combat } = makeFixture();
    expect(combat.bullets.active).toBe(0);
    const shooter = 'pilot-B';
    const msg: PeerShootMsg = {
      type: 'peer-shoot',
      id: shooter,
      weapon: 'gun',
      originPos: [10, 500, 0],
      originVel: [55, 0, 0],
      originQ: [0, 0, 0, 1],
      t: 2.0,
    };
    net.emit('peer-shoot', msg);
    // gun spawn replicates L+R hardpoints → 2 bullets active.
    expect(combat.bullets.active).toBe(2);
    // Walk the slots and verify shooterId attribution.
    let found = 0;
    for (let i = 0; i < combat.bullets.capacity; i += 1) {
      if (!combat.bullets.isActive(i)) continue;
      expect(combat.bullets.shooterId[i]).toBe(shooter);
      // Velocity should be muzzle (890 m/s along +X with identity q) +
      // inherited (55,0,0) = (945, 0, 0).
      expect(combat.bullets.vx[i]).toBeCloseTo(945, 3);
      found += 1;
    }
    expect(found).toBe(2);
  });

  it('spawns a missile with locked target id from peer-shoot', () => {
    const { net, combat } = makeFixture();
    const msg: PeerShootMsg = {
      type: 'peer-shoot',
      id: 'pilot-B',
      weapon: 'missile',
      originPos: [0, 500, 0],
      originVel: [80, 0, 0],
      originQ: [0, 0, 0, 1],
      t: 3.0,
      targetId: 'pilot-A',
    };
    net.emit('peer-shoot', msg);
    expect(combat.missiles.active).toBe(1);
    for (let i = 0; i < combat.missiles.capacity; i += 1) {
      if (!combat.missiles.isActive(i)) continue;
      expect(combat.missiles.shooterId[i]).toBe('pilot-B');
      expect(combat.missiles.lockedTargetId[i]).toBe('pilot-A');
    }
  });
});

describe('CombatNet — inbound peer-hit to self', () => {
  it('applies HP loss to the local participant via combat helpers', () => {
    const { net, combat, localId } = makeFixture();
    const me = combat.getParticipant(localId)!;
    expect(me.state.hp!.airframe).toBe(100);
    const msg: PeerHitMsg = {
      type: 'peer-hit',
      id: 'pilot-B',           // sender (relay id)
      shooterId: 'pilot-B',
      targetId: localId,
      weapon: 'gun',
      zone: 'airframe',
      hpLoss: 6,
      t: 5.0,
    };
    net.emit('peer-hit', msg);
    expect(me.state.hp!.airframe).toBe(94);
    // Missile direct: airframe 200 → clamped at 0.
    net.emit('peer-hit', {
      type: 'peer-hit',
      id: 'pilot-B',
      shooterId: 'pilot-B',
      targetId: localId,
      weapon: 'missile',
      zone: 'airframe',
      hpLoss: 200,
      t: 5.1,
    });
    expect(me.state.hp!.airframe).toBe(0);
    expect(me.state.isAlive).toBe(false);
    expect(me.state.respawnAt).toBeCloseTo(me.state.time + COMBAT_TUNING.respawnDelay, 6);
  });

  it('ignores peer-hit whose targetId is unknown (no exception)', () => {
    const { net, combat, localId } = makeFixture();
    const me = combat.getParticipant(localId)!;
    const before = me.state.hp!.airframe;
    net.emit('peer-hit', {
      type: 'peer-hit',
      id: 'pilot-B',
      shooterId: 'pilot-B',
      targetId: 'unknown-peer',
      weapon: 'gun',
      zone: 'airframe',
      hpLoss: 6,
      t: 1.0,
    });
    expect(me.state.hp!.airframe).toBe(before);
  });
});

describe('CombatNet — inbound peer-kill → kill-feed callback', () => {
  it('invokes onKill hook with the wire payload', () => {
    const { net, cn } = makeFixture();
    const seen: Array<{ shooterId: string; victimId: string }> = [];
    cn.setHooks({
      onKill: (ev) => seen.push({ shooterId: ev.shooterId, victimId: ev.victimId }),
    });
    const msg: PeerKillMsg = {
      type: 'peer-kill',
      id: 'pilot-B',
      shooterId: 'pilot-B',
      victimId: 'pilot-C',
      weapon: 'missile',
      t: 7.5,
    };
    net.emit('peer-kill', msg);
    expect(seen).toEqual([{ shooterId: 'pilot-B', victimId: 'pilot-C' }]);
  });
});

describe('CombatNet — peer-respawn', () => {
  it('resets HP + pose of a known participant', () => {
    const { net, combat } = makeFixture();
    // Pretend pilot-B is a peer we render locally.
    const peerState = createInitialState();
    peerState.hp!.airframe = 0;
    peerState.isAlive = false;
    peerState.respawnAt = 10;
    combat.register({
      id: 'pilot-B',
      state: peerState,
      weapons: createWeaponState('pilot-B'),
    });
    const msg: PeerRespawnMsg = {
      type: 'peer-respawn',
      id: 'pilot-B',
      x: [100, 800, 200],
      q: [0, 0, 0, 1],
      t: 12,
    };
    net.emit('peer-respawn', msg);
    expect(peerState.isAlive).toBe(true);
    expect(peerState.hp!.airframe).toBe(100);
    expect(peerState.x_W.x).toBe(100);
    expect(peerState.x_W.y).toBe(800);
  });
});

describe('CombatNet — bot-retire / bot-join wire roundtrip', () => {
  it('outbound bot-retire / bot-join JSON-serialise cleanly', () => {
    const { net, cn } = makeFixture();
    cn.sendBotRetire('bot-7', 42);
    cn.sendBotJoin('bot-9', 43, new THREE.Vector3(1, 2, 3), new THREE.Quaternion(0, 0, 0, 1));
    expect(net.sent).toHaveLength(2);
    const retire = net.sent[0]!;
    const join = net.sent[1]!;
    expect(retire.type).toBe('bot-retire');
    expect(retire.botId).toBe('bot-7');
    expect(retire.t).toBe(42);
    expect(join.type).toBe('bot-join');
    expect(join.botId).toBe('bot-9');
    expect(join.t).toBe(43);
    expect(join.x).toEqual([1, 2, 3]);
    expect(join.q).toEqual([0, 0, 0, 1]);
    // Round-trip through JSON to confirm wire-safety.
    const wireRetire = JSON.parse(JSON.stringify(retire));
    const wireJoin = JSON.parse(JSON.stringify(join));
    expect(wireRetire).toEqual(retire);
    expect(wireJoin).toEqual(join);
  });

  it('inbound peer-bot-retire / peer-bot-join hit the registered handlers', () => {
    const { net, cn } = makeFixture();
    const retired: PeerBotRetireMsg[] = [];
    const joined: PeerBotJoinMsg[] = [];
    cn.subscribeBotEnvelope({
      onRetire: (ev) => retired.push(ev),
      onJoin: (ev) => joined.push(ev),
    });
    const retireMsg: PeerBotRetireMsg = {
      type: 'peer-bot-retire',
      id: 'pilot-B',
      botId: 'bot-3',
      t: 11,
    };
    const joinMsg: PeerBotJoinMsg = {
      type: 'peer-bot-join',
      id: 'pilot-B',
      botId: 'bot-3',
      t: 12,
      x: [10, 500, 0],
      q: [0, 0, 0, 1],
    };
    net.emit('peer-bot-retire', retireMsg);
    net.emit('peer-bot-join', joinMsg);
    expect(retired).toEqual([retireMsg]);
    expect(joined).toEqual([joinMsg]);
  });
});

describe('CombatNet — dispose cleans up listeners', () => {
  it('drops inbound handlers so post-dispose emits are inert', () => {
    const { net, cn } = makeFixture();
    const seen: PeerKillMsg[] = [];
    cn.setHooks({ onKill: (ev) => seen.push(ev as unknown as PeerKillMsg) });
    cn.dispose();
    net.emit('peer-kill', {
      type: 'peer-kill',
      id: 'pilot-B',
      shooterId: 'pilot-B',
      victimId: 'pilot-C',
      weapon: 'gun',
      t: 1,
    });
    expect(seen).toHaveLength(0);
  });
});
