// Deterministic seeded PRNG for AI pilots. See docs/ai-spec.md §6.
//
// Uses mulberry32 — a 32-bit state PRNG with good statistical properties for
// the small numbers we need (gunnery dispersion, wander dither, coin flips).
// Zero allocations after construction; bit-reproducible across hosts.
//
// CRITICAL: All AI randomness MUST route through here. No Math.random(), no
// Date.now(). Sums computed in a fixed order so seedN reproduces bit-for-bit.

/**
 * Construct a uniform [0, 1) PRNG closure from a 32-bit seed.
 * Pure function — repeated calls with the same seed yield identical streams.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Typed wrapper around a mulberry32 stream that also exposes a Gaussian
 * sampler (Box-Muller). Internal `cursor` counts the number of `next()` calls
 * since construction/restore — useful for replay tests asserting
 * "same seed and same cursor ⇒ same value next".
 */
export interface AIRng {
  /** Uniform [0, 1) draw. */
  next(): number;
  /** Standard-normal draw via Box-Muller (consumes 2 uniforms per pair). */
  nextGaussian(): number;
  /** Number of `next()` calls since construction or last restore. */
  getCursor(): number;
  /** Internal 32-bit state — used by snapshot/restore. */
  getState(): number;
  /** Reset state and cursor (used by snapshot restore). */
  setState(state: number, cursor: number, gaussianCarry: number | null): void;
  /** Carry value for Box-Muller second sample, or null. */
  getGaussianCarry(): number | null;
}

/**
 * Construct an `AIRng` wrapper. The Box-Muller path caches the second sample
 * so two consecutive `nextGaussian()` calls cost two `next()` calls total.
 * snapshot/restore preserves the carry state so determinism is exact.
 */
export function createAIRng(seed: number): AIRng {
  let state = seed >>> 0;
  let cursor = 0;
  let carry: number | null = null;

  function rawNext(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next(): number {
      cursor += 1;
      return rawNext();
    },
    nextGaussian(): number {
      if (carry !== null) {
        const out = carry;
        carry = null;
        return out;
      }
      // Box-Muller. Clamp u1 to avoid log(0).
      let u1 = rawNext();
      cursor += 1;
      if (u1 < 1e-12) u1 = 1e-12;
      const u2 = rawNext();
      cursor += 1;
      const mag = Math.sqrt(-2.0 * Math.log(u1));
      const ang = 2 * Math.PI * u2;
      carry = mag * Math.sin(ang);
      return mag * Math.cos(ang);
    },
    getCursor(): number {
      return cursor;
    },
    getState(): number {
      return state;
    },
    setState(s: number, c: number, gc: number | null): void {
      state = s >>> 0;
      cursor = c;
      carry = gc;
    },
    getGaussianCarry(): number | null {
      return carry;
    },
  };
}
