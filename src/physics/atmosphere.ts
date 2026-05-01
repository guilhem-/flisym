// ISA atmosphere model, valid 0–5000 m. Pure functions. See spec §4.

import { FLIGHT_MODEL } from './flightModel.js';

const { T0, p0, rho0, lapse, R_air, gravity, altMax } = {
  T0: FLIGHT_MODEL.T0,
  p0: FLIGHT_MODEL.p0,
  rho0: FLIGHT_MODEL.rho0,
  lapse: FLIGHT_MODEL.lapse,
  R_air: FLIGHT_MODEL.R_air,
  gravity: FLIGHT_MODEL.gravity,
  altMax: FLIGHT_MODEL.altMax,
};

const GAMMA = 1.4;

function clampAlt(h: number): number {
  if (h < 0) return 0;
  if (h > altMax) return altMax;
  return h;
}

export function temperature(altitudeMeters: number): number {
  const h = clampAlt(altitudeMeters);
  return T0 - lapse * h;
}

export function pressure(altitudeMeters: number): number {
  const T = temperature(altitudeMeters);
  // p = p0 * (T/T0)^(g/(R*L))
  return p0 * Math.pow(T / T0, gravity / (R_air * lapse));
}

export function density(altitudeMeters: number): number {
  const T = temperature(altitudeMeters);
  const p = pressure(altitudeMeters);
  return p / (R_air * T);
}

export function densityRatio(altitudeMeters: number): number {
  return density(altitudeMeters) / rho0;
}

export function speedOfSound(altitudeMeters: number): number {
  const T = temperature(altitudeMeters);
  return Math.sqrt(GAMMA * R_air * T);
}
