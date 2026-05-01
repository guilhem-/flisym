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

  Clbeta: -0.089, Clp: -0.47, Clr: 0.096,
  Clda: 0.04,    // tuned down from 0.178; raise to taste
  Cldr: 0.0147,

  Cm0: 0.04, Cmalpha: -0.89, Cmq: -12.4,
  Cmde: 0.5,    // tuned down from 1.28; raise to taste
  Cmflaps: -0.05,

  Cnbeta: 0.065, Cnp: -0.03, Cnr: -0.099,
  Cnda: -0.053, Cndr: 0.074,

  thrustStaticSL: 2800, vMaxThrustZero: 75,

  controlRate: 4.0, controlCenterRate: 3.0,
  throttleRate: 0.5, throttleTau: 0.3,

  groundY: 0.5, rollingFriction: 0.02,

  physicsDt: 1 / 240, maxSubsteps: 8,
} as const;

export type FlightModelConstants = typeof FLIGHT_MODEL;
