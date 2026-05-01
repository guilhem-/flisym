import * as THREE from 'three';
import type { AircraftState } from '../physics/index.js';
import { buildCessna } from '../aircraft/cessna.js';

/** Send rate to the server, in Hz. Buffer dt and flush when exceeded. */
const SEND_RATE_HZ = 30;
const SEND_INTERVAL = 1 / SEND_RATE_HZ;

/**
 * Lerp factor for peer pose smoothing. Frames are dt-scaled, but the rate
 * we receive at is roughly 30 Hz; using `1 - exp(-k*dt)` gives a smooth
 * frame-rate independent approach. k ≈ 12 → ~half-life of ~58 ms.
 */
const PEER_LERP_K = 12;

export interface PeerEntry {
  mesh: THREE.Group;
  targetX: THREE.Vector3;
  targetQ: THREE.Quaternion;
}

interface HelloMsg {
  type: 'hello';
  id: string;
  peers: string[];
}
interface PeerMsg {
  type: 'peer';
  id: string;
  x: [number, number, number];
  q: [number, number, number, number];
}
interface LeaveMsg {
  type: 'leave';
  id: string;
}
type ServerMsg = HelloMsg | PeerMsg | LeaveMsg;

/**
 * Multiplayer presence client. Lazy: nothing is sent until {@link connect}
 * is called. Peer aircraft are added to {@link getRoot} as a side-effect
 * of receiving messages; each frame {@link update} both sends our state
 * (rate-limited) and lerps peer meshes toward their targets.
 */
export class NetClient {
  /** Local id assigned by the server on hello. Empty string until then. */
  public id = '';

  private socket: WebSocket | null = null;
  private readonly root = new THREE.Group();
  private readonly peers = new Map<string, PeerEntry>();
  private sendAccumulator = 0;

  /** Connect to a presence server. Idempotent: calling twice is a no-op. */
  connect(url: string): void {
    if (this.socket) return;
    this.root.name = 'NetPeers';
    const sock = new WebSocket(url);
    this.socket = sock;
    sock.addEventListener('message', (ev: MessageEvent) => {
      this.handleMessage(ev);
    });
    sock.addEventListener('close', () => {
      this.socket = null;
    });
    sock.addEventListener('error', () => {
      // Let close handler clear socket; nothing else to do.
    });
  }

  /** Parent group for all peer meshes. Always safe to add to a scene. */
  getRoot(): THREE.Group {
    return this.root;
  }

  /** Map of peer-id -> peer entry. Keys are server-assigned UUIDs. */
  getPeers(): Map<string, PeerEntry> {
    return this.peers;
  }

  /**
   * Per-frame update. Sends our own state at {@link SEND_RATE_HZ} when the
   * socket is open, and lerps each peer mesh toward its target pose. Safe
   * to call before {@link connect} (it just lerps existing peers, which
   * will be none).
   */
  update(state: AircraftState, dt: number): void {
    // 1) Rate-limited send of our state.
    this.sendAccumulator += dt;
    if (
      this.sendAccumulator >= SEND_INTERVAL &&
      this.socket &&
      this.socket.readyState === WebSocket.OPEN
    ) {
      const x = state.x_W;
      const q = state.q;
      this.socket.send(
        JSON.stringify({
          type: 'state',
          x: [x.x, x.y, x.z],
          q: [q.x, q.y, q.z, q.w],
        }),
      );
      this.sendAccumulator = 0;
    }

    // 2) Lerp peer meshes toward their target poses. Frame-rate independent.
    const t = 1 - Math.exp(-PEER_LERP_K * dt);
    for (const peer of this.peers.values()) {
      peer.mesh.position.lerp(peer.targetX, t);
      peer.mesh.quaternion.slerp(peer.targetQ, t);
    }
  }

  private handleMessage(ev: MessageEvent): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMsg;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        this.id = msg.id;
        // Pre-register placeholder peers so meshes appear on first state msg.
        // (Can't build the mesh yet — we don't know their poses; the first
        // 'peer' message will create it lazily.)
        break;
      case 'peer':
        this.applyPeer(msg);
        break;
      case 'leave':
        this.removePeer(msg.id);
        break;
    }
  }

  private applyPeer(msg: PeerMsg): void {
    let entry = this.peers.get(msg.id);
    const px = msg.x[0];
    const py = msg.x[1];
    const pz = msg.x[2];
    const qx = msg.q[0];
    const qy = msg.q[1];
    const qz = msg.q[2];
    const qw = msg.q[3];
    if (!entry) {
      const built = buildCessna();
      built.group.position.set(px, py, pz);
      built.group.quaternion.set(qx, qy, qz, qw);
      this.root.add(built.group);
      entry = {
        mesh: built.group,
        targetX: new THREE.Vector3(px, py, pz),
        targetQ: new THREE.Quaternion(qx, qy, qz, qw),
      };
      this.peers.set(msg.id, entry);
      return;
    }
    entry.targetX.set(px, py, pz);
    entry.targetQ.set(qx, qy, qz, qw);
  }

  private removePeer(id: string): void {
    const entry = this.peers.get(id);
    if (!entry) return;
    this.root.remove(entry.mesh);
    this.peers.delete(id);
  }
}
