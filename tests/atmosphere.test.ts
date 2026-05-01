// Atmosphere validation. See physics-spec.md §4.
// Sea-level density ≈ 1.225 within 0.1%; monotonic decrease with altitude;
// at 5 km still positive but well below sea-level value.

import { describe, expect, it } from 'vitest';
import {
  density,
  densityRatio,
  pressure,
  speedOfSound,
  temperature,
} from '../src/physics/index.js';

describe('atmosphere (ISA)', () => {
  it('sea-level density ≈ 1.225 kg/m³ within 0.1%', () => {
    const rho0 = density(0);
    expect(rho0).toBeGreaterThan(1.225 * 0.999);
    expect(rho0).toBeLessThan(1.225 * 1.001);
  });

  it('sea-level temperature = 288.15 K and pressure = 101325 Pa', () => {
    expect(temperature(0)).toBeCloseTo(288.15, 2);
    expect(pressure(0)).toBeCloseTo(101325, 0);
  });

  it('density ratio at sea level is 1.0', () => {
    expect(densityRatio(0)).toBeCloseTo(1.0, 3);
  });

  it('density is monotonic decreasing 0 → 5000 m', () => {
    let prev = density(0);
    for (let h = 250; h <= 5000; h += 250) {
      const rho = density(h);
      expect(rho).toBeLessThan(prev);
      expect(rho).toBeGreaterThan(0);
      prev = rho;
    }
  });

  it('at 5000 m density is still positive and below sea level', () => {
    const rho5k = density(5000);
    expect(rho5k).toBeGreaterThan(0);
    // ISA at 5 km gives ρ ≈ 0.7364 kg/m³ (~60% of sea level).
    expect(rho5k).toBeLessThan(1.0);
    expect(rho5k).toBeGreaterThan(0.6);
  });

  it('density "halve point" lies in the upper atmosphere (~6.5 km)', () => {
    // We can only test up to 5 km (clamp). At 5 km we should still be > 0.5*ρ0
    // because the half-density altitude in ISA is ~6.5 km.
    const rho5k = density(5000);
    expect(rho5k).toBeGreaterThan(0.5 * 1.225);
  });

  it('speed of sound decreases with altitude (cooler air)', () => {
    expect(speedOfSound(5000)).toBeLessThan(speedOfSound(0));
    expect(speedOfSound(0)).toBeGreaterThan(330);
    expect(speedOfSound(0)).toBeLessThan(345);
  });
});
