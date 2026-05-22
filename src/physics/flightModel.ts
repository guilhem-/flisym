// FLIGHT_MODEL — Cessna-172N class constants. Pasted verbatim from
// docs/physics-spec.md §10. Do not modify without updating the spec.

export const FLIGHT_MODEL = {
  mass: 1100, wingArea: 16.2, span: 11.0, mac: 1.5,
  aspectRatio: 7.47, oswald: 0.80,
  Ixx: 1285, Iyy: 1825, Izz: 2667,

  rho0: 1.225, T0: 288.15, p0: 101325, lapse: 0.0065,
  R_air: 287.058, gravity: 9.80665, altMax: 5000,

  CL0: 0.31, CLalpha: 5.7, CLde: 0.43, CLflaps: 0.4,
  alphaStallClean: 0.2618, alphaStallFlapsDelta: -0.0349,
  CLmaxClean: 1.4, CLmaxFlapsBonus: 0.3,

  CD0: 0.027, CDgear: 0.015, CDflaps: 0.04, CDsideslip: 0.05,

  CYbeta: -0.31, CYdr: 0.187,

  // Cl_β reduced ~3× from textbook Cessna (-0.089 → -0.03): high dihedral
  // is the main source of Dutch-roll coupling (sideslip → roll → yaw → ...
  // exponential growth). Cl_da raised for snappier roll response — the
  // remaining Dutch-roll growth is suppressed by the SAS in step.ts.
  Clbeta: -0.03, Clp: -0.80, Clr: 0.04,
  Clda: 0.14,    // strong roll authority — paired with SAS for stability
  Cldr: 0.0147,

  Cm0: 0.04, Cmalpha: -0.89, Cmq: -12.4,
  Cmde: 0.5,    // tuned down from 1.28; raise to taste
  Cmflaps: -0.05,
  // Static elevator-trim offset (radians, applied to delta_e inside the pitch-
  // moment calc only — does not affect the surface state itself). Represents
  // the elevator trim tab a real pilot sets for level cruise. Tuned so the
  // airframe trims hands-off at α ≈ 0.022 rad and V ≈ 50 m/s, matching the
  // spawn condition in main.ts. Without this, Cm0 = +0.04 alone drives the
  // airframe to climb to α ≈ 0.045 rad (2.6°) — well above the speed-balanced
  // α at 50 m/s — and it pitches up uncontrollably before stalling.
  pitchTrim: -0.04,

  // Cn_da slashed from -0.053 → -0.008 (typical Cessna adverse-yaw value).
  // Cn_β raised, Cn_r raised, Cn_p boosted (cross-axis damping) to suppress
  // Dutch-roll oscillation. Combined with the reduced Cl_β above, the slow
  // lateral mode no longer grows hands-off.
  // Cn_dr lowered from 0.074 → 0.015 so sustained full rudder yields a small
  // equilibrium β (~10°): previously the rudder authority far exceeded the
  // weathercock yaw stiffness Cn_β, so β grew past 60° dynamically and the
  // velocity vector ended up along body ±Z. At that point u → 0 and the
  // alpha calculation (`atan2(-v, u)`) became meaningless — the wing was
  // experiencing pure side-flow, not a stall, but the HUD reported STALL.
  Cnbeta: 0.08, Cnp: -0.10, Cnr: -0.30,
  Cnda: -0.008, Cndr: 0.015,

  thrustStaticSL: 2800, vMaxThrustZero: 75,

  controlRate: 4.0, controlCenterRate: 3.0,
  throttleRate: 0.5, throttleTau: 0.3,

  groundY: 0.5, rollingFriction: 0.02,

  physicsDt: 1 / 240, maxSubsteps: 8,
} as const;

export type FlightModelConstants = typeof FLIGHT_MODEL;
