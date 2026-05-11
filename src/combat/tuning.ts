// COMBAT_TUNING — single source of truth for all combat numerics.
// Verbatim from docs/combat-spec.md §8. No magic numbers anywhere else in
// src/combat/.

export const COMBAT_TUNING = {
  // pools (graphics-budget-load-bearing)
  bulletPool: 256,
  missilePool: 8,
  bombPool: 8,
  explosionPool: 16,

  // M2 .50-cal bullet
  bulletMass: 0.046,
  bulletCdA: 0.00015,
  bulletMuzzleVel: 890,
  bulletRoFPerGun: 600,
  bulletMagPerGun: 400,
  bulletLifetime: 3.0,
  bulletDamageAtMuzzle: 6,
  bulletDamageEngine: 8,
  bulletDamageControl: 8,
  bulletFalloffRange: 800,
  bulletFalloffFloor: 0.3,
  bulletTracerStride: 5,
  bulletCullRadius: 4000,

  // AIM-9-class missile
  missileMass: 85.0,
  missileCdA: 0.04,
  missileLaunchVel: 50,
  missileThrust: 17000,
  missileMotorBurnTime: 3.0,
  missileLifetime: 30.0,
  missileMaxTurnRate: 1.40,
  missileFuseArmTime: 0.4,
  missileProxRadius: 12,
  missileDirectHpLoss: 200,
  missileSeekerHalfFov: 0.524,
  missileLockRange: 4000,
  missileLockDropTime: 1.0,
  missileSeekerHotThrottle: 0.2,
  missileRailsPerAircraft: 2,

  // Mk-82 bomb
  bombMass: 227.0,
  bombCdA: 0.05,
  bombLifetime: 30.0,
  bombBlastRadius: 25,
  bombDamageCenter: 800,
  bombPerAircraft: 4,

  // damage
  airframeHpMax: 100,
  engineHpMax: 100,
  controlHpMax: 100,
  damagedAuthorityScale: 0.4,
  respawnDelay: 5.0,

  // hull AABB (body frame)
  hullHalfExtents: { x: 4.5, y: 1.6, z: 5.6 } as const,

  // HUD / scoring
  killFeedMaxLines: 6,
  killFeedLineLifetime: 6.0,
  radarRangeM: 20000,
  radarTickHz: 10,
} as const;

export type CombatTuning = typeof COMBAT_TUNING;
