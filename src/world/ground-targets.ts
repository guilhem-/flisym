/**
 * ground-targets.ts — procedural Strike-Mission target field.
 *
 * Builds a clustered set of SAM sites, tanks, and hangars roughly 6 km east
 * of spawn. All meshes are procedural (vertex colors, no textures) and share
 * exactly four materials — one per kind (sam / tank / hangar / debris) — so
 * the whole field stays within the graphics budget headroom reserved for
 * Strike Mission in `docs/modes/strike-mission.md` §6.
 *
 * Placement is deterministic from `seed` via a local mulberry32 (duplicated
 * from `src/ai/prng.ts` to keep `world/` decoupled from `ai/`).
 *
 * Ground contact: each target's Y is `world.getGroundHeight(x, z) + h/2`
 * where `h/2` is the half-extent of its base box, so the target sits ON the
 * terrain rather than half-buried.
 *
 * Colliders are world-frame AABBs (targets don't rotate in v0.2). The
 * `pointInsideAABB` helper in `./collision.ts` consumes the same tuple
 * shape that `GroundTargetInstance.collider.halfExtents` exposes.
 *
 * See `docs/modes/strike-mission.md` §6 and `docs/combat-spec.md` §3.3.
 */

import * as THREE from 'three';

/** Minimal world shape consumed for ground-height queries. Decouples this
 *  module from the heavyweight `World` import (and makes tests trivial). */
export interface GroundHeightSource {
  getGroundHeight(x: number, z: number): number;
}

export type GroundTargetKind = 'sam' | 'tank' | 'hangar';

export interface GroundTargetSpec {
  id: string;
  kind: GroundTargetKind;
  pos: [number, number, number];
  value: number;
  hp: number;
}

export interface GroundTargetInstance {
  spec: GroundTargetSpec;
  mesh: THREE.Group;
  collider: { halfExtents: [number, number, number] };
  destroyed: boolean;
  hp: number;
}

export interface SpawnGroundTargetsOpts {
  count: number;
  seed: number;
  world?: GroundHeightSource | undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Tunables — exported as a const-object so tests / callers can read them.
// ───────────────────────────────────────────────────────────────────────────

export const GROUND_TARGETS_TUNING = {
  /** Clamp `count` into [minCount, maxCount] per strike-mission §11. */
  minCount: 5,
  maxCount: 10,

  /** Cluster center in world frame (m). 6 km east of spawn (spawn ≈ -700). */
  clusterCenter: [6000, 0, 0] as const,
  /** Square half-edge (m) — placements drawn uniformly inside this box. */
  clusterHalfEdge: 750,
  /** Minimum spacing between any two targets (m) to avoid overlapping meshes. */
  minSpacing: 60,
  /** Max placement-rejection attempts per target before relaxing spacing. */
  maxPlacementAttempts: 24,

  /** Mix-of-kinds floor. Always >= 1 SAM, >= 2 tanks, >= 1 hangar. */
  minSAM: 1,
  minTank: 2,
  minHangar: 1,

  /** Per `docs/combat-spec.md` §3.3. */
  hp: { sam: 300, tank: 200, hangar: 1200 } as const,
  /** Mission-score values (per strike-mission §2). */
  value: { sam: 500, tank: 100, hangar: 300 } as const,

  /** Visual base half-extents (m) — used for collider AND for ground-sit Y. */
  half: {
    sam:    [4.0, 2.0, 4.0] as const,
    tank:   [3.0, 1.0, 1.6] as const,
    hangar: [12.0, 4.0, 8.0] as const,
    debris: [2.0, 0.5, 2.0] as const,
  },
} as const;

// ───────────────────────────────────────────────────────────────────────────
// Deterministic PRNG — local mulberry32 (duplicated from src/ai/prng.ts).
// ───────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Shared materials — exactly four, one per kind. Cached at module scope so
// repeated GroundTargetField instances in the same process share GPU buffers.
// ───────────────────────────────────────────────────────────────────────────

let MATS: {
  sam: THREE.MeshStandardMaterial;
  tank: THREE.MeshStandardMaterial;
  hangar: THREE.MeshStandardMaterial;
  debris: THREE.MeshStandardMaterial;
} | null = null;

function getMaterials(): NonNullable<typeof MATS> {
  if (MATS) return MATS;
  MATS = {
    // Olive-drab military gear.
    sam: new THREE.MeshStandardMaterial({
      color: 0x4a5238,
      roughness: 0.85,
      metalness: 0.1,
      flatShading: true,
    }),
    tank: new THREE.MeshStandardMaterial({
      color: 0x3a4029,
      roughness: 0.9,
      metalness: 0.05,
      flatShading: true,
    }),
    // Lighter corrugated-steel grey.
    hangar: new THREE.MeshStandardMaterial({
      color: 0x6e7480,
      roughness: 0.7,
      metalness: 0.3,
      flatShading: true,
    }),
    // Charred dark grey/black.
    debris: new THREE.MeshStandardMaterial({
      color: 0x222024,
      roughness: 1.0,
      metalness: 0.0,
      flatShading: true,
    }),
  };
  return MATS;
}

// ───────────────────────────────────────────────────────────────────────────
// Procedural mesh builders. Each returns a THREE.Group with <= 5 sub-meshes
// and a triangle count well under the cap noted in the brief.
// ───────────────────────────────────────────────────────────────────────────

/** Tank — hull + turret + barrel. Total ≈ 48 tris (cap 200). */
function buildTank(): THREE.Group {
  const mat = getMaterials().tank;
  const g = new THREE.Group();
  g.name = 'Tank';

  // Hull: 6 × 2 × 3.2 m box.
  const hullGeo = new THREE.BoxGeometry(6.0, 2.0, 3.2);
  const hull = new THREE.Mesh(hullGeo, mat);
  hull.position.y = 1.0; // sit hull center 1 m above base
  g.add(hull);

  // Turret: 2.2 × 1.0 × 2.0 m box, on top of hull.
  const turretGeo = new THREE.BoxGeometry(2.2, 1.0, 2.0);
  const turret = new THREE.Mesh(turretGeo, mat);
  turret.position.set(-0.2, 2.5, 0);
  g.add(turret);

  // Barrel: cylinder pointing along +X (turret aim).
  const barrelGeo = new THREE.CylinderGeometry(0.12, 0.12, 2.5, 6);
  // CylinderGeometry's axis is +Y; rotate to align with +X.
  barrelGeo.rotateZ(Math.PI / 2);
  const barrel = new THREE.Mesh(barrelGeo, mat);
  barrel.position.set(2.1, 2.5, 0);
  g.add(barrel);

  return g;
}

/** SAM — half-dome radar dish + box launcher + 2 missile cigars + tent.
 *  Total ≈ 120 tris (cap 400). 5 sub-meshes. */
function buildSAM(): THREE.Group {
  const mat = getMaterials().sam;
  const g = new THREE.Group();
  g.name = 'SAM';

  // Half-dome radar dish: a hemisphere (thetaLength = PI/2).
  const dishGeo = new THREE.SphereGeometry(1.6, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  const dish = new THREE.Mesh(dishGeo, mat);
  dish.position.set(-2.0, 1.6, 0);
  g.add(dish);

  // Launcher base box.
  const launcherGeo = new THREE.BoxGeometry(2.4, 1.2, 2.4);
  const launcher = new THREE.Mesh(launcherGeo, mat);
  launcher.position.set(1.2, 0.6, 0);
  g.add(launcher);

  // Two missile cigars on rails, pointing up at a slight angle.
  const cigarGeo = new THREE.CylinderGeometry(0.18, 0.18, 2.4, 6);
  const cigarL = new THREE.Mesh(cigarGeo, mat);
  cigarL.position.set(1.2, 2.4, -0.6);
  cigarL.rotation.z = -0.25;
  g.add(cigarL);
  const cigarR = new THREE.Mesh(cigarGeo, mat);
  cigarR.position.set(1.2, 2.4, +0.6);
  cigarR.rotation.z = -0.25;
  g.add(cigarR);

  // Crew tent: low box.
  const tentGeo = new THREE.BoxGeometry(1.6, 0.6, 1.6);
  const tent = new THREE.Mesh(tentGeo, mat);
  tent.position.set(-2.0, 0.3, 2.4);
  g.add(tent);

  return g;
}

/** Hangar — long rectangular shed + half-cylinder arched roof.
 *  Total ≈ 44 tris (cap 300). 2 sub-meshes. */
function buildHangar(): THREE.Group {
  const mat = getMaterials().hangar;
  const g = new THREE.Group();
  g.name = 'Hangar';

  // Main shed.
  const shedGeo = new THREE.BoxGeometry(24.0, 6.0, 16.0);
  const shed = new THREE.Mesh(shedGeo, mat);
  shed.position.y = 3.0;
  g.add(shed);

  // Arched roof: open-ended half cylinder lying along X.
  // CylinderGeometry axis is +Y; we rotate +PI/2 about Z so the axis points
  // along +X, then we use thetaLength = PI to get a half-cylinder dome.
  const roofGeo = new THREE.CylinderGeometry(8.0, 8.0, 24.0, 8, 1, true, 0, Math.PI);
  roofGeo.rotateZ(Math.PI / 2);
  // After rotZ +90°, the cylinder's old +Y axis points along +X. The
  // theta-sweep was around the old +Y axis, but with thetaLength=PI we have
  // an open half-shell that we now need oriented so the flat (open) side
  // faces DOWN (i.e. sits on top of the shed). The default thetaStart=0 puts
  // the open side facing +X (now world +Y after rotation). Empirically,
  // rotating about X by +PI/2 brings the open side to face -Y as desired
  // before we lift it onto the shed roof.
  roofGeo.rotateX(Math.PI / 2);
  const roof = new THREE.Mesh(roofGeo, mat);
  roof.position.y = 6.0;
  g.add(roof);

  return g;
}

/** Debris — two small charred boxes. Total = 24 tris (cap 30). */
function buildDebris(): THREE.Group {
  const mat = getMaterials().debris;
  const g = new THREE.Group();
  g.name = 'Debris';

  const a = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.6, 1.8), mat);
  a.position.set(0, 0.3, 0);
  a.rotation.y = 0.4;
  g.add(a);

  const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 1.0), mat);
  b.position.set(0.8, 0.2, -0.6);
  b.rotation.y = -0.6;
  g.add(b);

  return g;
}

// ───────────────────────────────────────────────────────────────────────────
// Field assembly.
// ───────────────────────────────────────────────────────────────────────────

function buildMesh(kind: GroundTargetKind): THREE.Group {
  switch (kind) {
    case 'sam':    return buildSAM();
    case 'tank':   return buildTank();
    case 'hangar': return buildHangar();
  }
}

/** Decide the mix of kinds satisfying the floor (≥1 SAM, ≥2 tanks, ≥1 hangar)
 *  and add `count - 4` extra picks weighted toward tanks (the strike-mission
 *  baseline of "1 SAM, 3-5 tanks, 2-3 hangars"). */
function pickKinds(count: number, rand: () => number): GroundTargetKind[] {
  const out: GroundTargetKind[] = [];
  // Floor first.
  out.push('sam');
  out.push('tank');
  out.push('tank');
  out.push('hangar');
  // Fill remainder with weighted picks. Weights: tank 0.55, sam 0.15,
  // hangar 0.30 — matches the "tanks dominate, 2-3 hangars" mission archetype.
  const remainder = count - out.length;
  for (let i = 0; i < remainder; i++) {
    const r = rand();
    if (r < 0.15) out.push('sam');
    else if (r < 0.45) out.push('hangar');
    else out.push('tank');
  }
  // Shuffle so IDs aren't ordered "all SAMs first" — Fisher-Yates with `rand`.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const ai = out[i] as GroundTargetKind;
    const aj = out[j] as GroundTargetKind;
    out[i] = aj;
    out[j] = ai;
  }
  return out;
}

/** Pick a 2D placement inside the cluster box, rejecting points closer than
 *  `minSpacing` to any already-placed target. Falls through after
 *  `maxPlacementAttempts` and accepts whatever was last drawn — guarantees
 *  termination even at the smallest cluster sizes. */
function pickPosition(
  taken: Array<readonly [number, number]>,
  rand: () => number,
): readonly [number, number] {
  const T = GROUND_TARGETS_TUNING;
  const [cx, , cz] = T.clusterCenter;
  let last: readonly [number, number] = [cx, cz];
  for (let attempt = 0; attempt < T.maxPlacementAttempts; attempt++) {
    const x = cx + (rand() * 2 - 1) * T.clusterHalfEdge;
    const z = cz + (rand() * 2 - 1) * T.clusterHalfEdge;
    last = [x, z];
    let ok = true;
    for (let i = 0; i < taken.length; i++) {
      const p = taken[i]!;
      const dx = p[0] - x;
      const dz = p[1] - z;
      if (dx * dx + dz * dz < T.minSpacing * T.minSpacing) { ok = false; break; }
    }
    if (ok) return last;
  }
  return last;
}

/** Clamp `count` per `docs/modes/strike-mission.md` §11 ([5, 10]). */
function clampCount(n: number): number {
  if (!Number.isFinite(n)) return GROUND_TARGETS_TUNING.minCount;
  return Math.max(
    GROUND_TARGETS_TUNING.minCount,
    Math.min(GROUND_TARGETS_TUNING.maxCount, Math.floor(n)),
  );
}

export class GroundTargetField {
  readonly group: THREE.Group;
  readonly targets: GroundTargetInstance[];

  constructor(opts: SpawnGroundTargetsOpts) {
    const count = clampCount(opts.count);
    const rand = mulberry32(opts.seed >>> 0);

    this.group = new THREE.Group();
    this.group.name = 'GroundTargetField';
    this.targets = [];

    const kinds = pickKinds(count, rand);
    const T = GROUND_TARGETS_TUNING;
    const taken: Array<readonly [number, number]> = [];

    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i] as GroundTargetKind;
      const [x, z] = pickPosition(taken, rand);
      taken.push([x, z]);

      const half = T.half[kind];
      const groundY = opts.world ? opts.world.getGroundHeight(x, z) : 0;
      // Sit base of the target on the ground. Builders place their meshes so
      // y=0 in the group corresponds to the bottom of the visual base.
      const y = groundY;

      const mesh = buildMesh(kind);
      mesh.position.set(x, y, z);
      // Random yaw so the field doesn't read as a grid of identical props.
      mesh.rotation.y = rand() * Math.PI * 2;
      this.group.add(mesh);

      // Collider center is the AABB center (y + half height). Half-extents
      // come from the tuning table.
      const spec: GroundTargetSpec = {
        id: `${kind}:${i.toString().padStart(2, '0')}`,
        kind,
        // pos is the base point — combat layer adds the collider half-extent
        // when it needs the AABB center.
        pos: [x, y, z],
        value: T.value[kind],
        hp: T.hp[kind],
      };
      this.targets.push({
        spec,
        mesh,
        collider: { halfExtents: [half[0], half[1], half[2]] },
        destroyed: false,
        hp: spec.hp,
      });
    }
  }
}

/** Factory matching the call signature in `docs/test-strategy.md` §2.2. */
export function spawnGroundTargets(opts: SpawnGroundTargetsOpts): GroundTargetField {
  return new GroundTargetField(opts);
}

/** Swap a target's visual to a smoldering-debris pile, mark it destroyed.
 *  Idempotent: calling twice does nothing the second time. */
export function destroyTarget(target: GroundTargetInstance): void {
  if (target.destroyed) return;
  target.destroyed = true;
  target.hp = 0;

  const old = target.mesh;
  const debris = buildDebris();
  debris.position.copy(old.position);
  debris.rotation.copy(old.rotation);

  // Splice the debris into the same parent slot.
  const parent = old.parent;
  if (parent) {
    parent.add(debris);
    parent.remove(old);
  }
  // Dispose owned geometries on the old mesh; materials are shared at module
  // scope so we deliberately do NOT dispose them.
  old.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
    }
  });

  target.mesh = debris;
  // Shrink collider to debris half-extents — mostly cosmetic since the combat
  // layer reads `destroyed` first anyway.
  const dh = GROUND_TARGETS_TUNING.half.debris;
  target.collider = { halfExtents: [dh[0], dh[1], dh[2]] };
}
