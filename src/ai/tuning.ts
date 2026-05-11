// AI pilot tuning constants. Verbatim from docs/ai-spec.md §3.6 / §4.1 / §4.3.
//
// Three presets:
//   - AI_TUNING_VETERAN — canonical default (§3.6).
//   - AI_TUNING_ROOKIE  — sluggish reactions, wider gunnery, slow break-off (§4.1).
//   - AI_TUNING_ACE     — sharp reactions, tight gunnery, aggressive (§4.3).
//
// Gains were derived against the FLISYM physics envelope (§3.6 derivation
// notes). Do not edit without re-validating T1/T3 in tests/ai-pilot.test.ts.

export interface AI_TUNING {
  // tick & timing
  tickHz: number;
  reactionDelayTicks: number;
  aiCommandSlewPerS: number;
  aiCmdQuantum: number;

  // altitude / pitch cascade
  Kp_alt: number;
  Ki_alt: number;
  Kd_alt: number;
  pitchMaxRad: number;
  altIntegMax: number;
  Kp_pitch: number;
  Kd_pitch: number;

  // heading / bank cascade
  Kp_hdg: number;
  Kp_bank: number;
  rollRateMax: number;
  Kp_p: number;

  // yaw coordinator
  Kp_beta: number;
  Kff_yawCoord: number;

  // throttle / airspeed
  Kp_v: number;
  Ki_v: number;
  throttleBase: number;
  throttleMin: number;
  throttleIntegMax: number;
  pitchClimbThresh: number;
  combatVMax: number;

  // envelope clamps
  altMin: number;
  altMax: number;
  patrolAltM: number;
  cruiseV: number;
  combatV: number;
  evadeV: number;

  // targeting / engagement
  detectRangeM: number;
  loseTargetT: number;
  engageHpFloor: number;
  disengageHp: number;
  gunRangeM: number;
  gunConeRad: number;
  missileRangeMaxM: number;
  missileRangeMinM: number;
  lockConeRad: number;
  lockHoldT: number;
  fireRateMinIntervalS: number;
  missileCooldownS: number;

  // gunnery dispersion
  gunnerySigmaRad: number;
  gunneryBiasRad: number;

  // evade
  evadeClearT: number;
  evadeBankDeg: number;
  evadeAltDropM: number;

  // patrol wander
  wanderAmpRad: number;
  wanderPeriodS: number;

  // crash / RTB
  respawnDelayS: number;
  rtbAltM: number;
  rtbV: number;
}

export const AI_TUNING_VETERAN: AI_TUNING = {
  // tick & timing
  tickHz: 30,
  reactionDelayTicks: 2,            // 0.067 s
  aiCommandSlewPerS: 4.0,
  aiCmdQuantum: 0.05,

  // altitude / pitch cascade
  Kp_alt: 0.015,
  Ki_alt: 0.001,
  Kd_alt: 0.05,
  pitchMaxRad: 0.349,               // 20°
  altIntegMax: 200,

  Kp_pitch: 2.5,
  Kd_pitch: 0.6,

  // heading / bank cascade
  Kp_hdg: 1.2,
  Kp_bank: 2.5,
  rollRateMax: 1.75,                // rad/s (~100°/s)
  Kp_p: 0.45,

  // yaw coordinator
  Kp_beta: 1.8,
  Kff_yawCoord: 0.20,

  // throttle / airspeed
  Kp_v: 0.04,
  Ki_v: 0.005,
  throttleBase: 0.65,
  throttleMin: 0.15,
  throttleIntegMax: 40,
  pitchClimbThresh: 0.087,          // 5°
  combatVMax: 70,

  // envelope clamps
  altMin: 80,
  altMax: 3500,
  patrolAltM: 500,
  cruiseV: 42,
  combatV: 55,
  evadeV: 70,

  // targeting / engagement
  detectRangeM: 3500,
  loseTargetT: 6.0,
  engageHpFloor: 0.20,
  disengageHp: 0.25,
  gunRangeM: 350,
  gunConeRad: 0.087,                // ±5°
  missileRangeMaxM: 4000,
  missileRangeMinM: 400,
  lockConeRad: 0.349,               // ±20°
  lockHoldT: 1.5,
  fireRateMinIntervalS: 0.10,
  missileCooldownS: 6.0,

  // gunnery dispersion (deterministic per seed)
  gunnerySigmaRad: 0.005,           // 0.29° — Veteran tight
  gunneryBiasRad: 0.0,

  // evade
  evadeClearT: 3.0,
  evadeBankDeg: 75,
  evadeAltDropM: 50,

  // patrol wander
  wanderAmpRad: 0.524,              // ±30°
  wanderPeriodS: 12.0,

  // crash / RTB
  respawnDelayS: 15.0,
  rtbAltM: 200,
  rtbV: 50,
};

export const AI_TUNING_ROOKIE: AI_TUNING = {
  ...AI_TUNING_VETERAN,
  reactionDelayTicks: 8,            // 0.267 s
  Kp_hdg: 0.7,
  Kp_bank: 1.5,
  Kp_alt: 0.008,
  Ki_alt: 0.0003,
  detectRangeM: 2200,
  gunRangeM: 250,
  gunneryBiasRad: 0.020,            // 1.15°
  gunnerySigmaRad: 0.025,           // 1.43° (5× Veteran)
  missileCooldownS: 10.0,
  lockHoldT: 2.5,
  evadeClearT: 5.0,
  wanderAmpRad: 0.873,              // ±50°
  engageHpFloor: 0.35,
  disengageHp: 0.40,
};

export const AI_TUNING_ACE: AI_TUNING = {
  ...AI_TUNING_VETERAN,
  reactionDelayTicks: 0,
  Kp_hdg: 1.6,
  Kp_bank: 3.2,
  Kp_alt: 0.020,
  Kd_alt: 0.07,
  detectRangeM: 5000,
  gunRangeM: 500,
  gunConeRad: 0.122,                // ±7°
  gunneryBiasRad: 0.0,
  gunnerySigmaRad: 0.002,           // 0.11°
  missileCooldownS: 4.0,
  lockHoldT: 0.8,
  evadeClearT: 2.0,
  wanderAmpRad: 0.262,              // ±15°
  engageHpFloor: 0.10,
  disengageHp: 0.15,
  combatVMax: 80,
};
