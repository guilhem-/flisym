/**
 * WORLD_CONFIG — single source of truth for every spec number.
 * Read by: heightmap, terrain, sky, water, runway, and (later) physics.
 * See `/docs/world-spec.md`.
 */

export const WORLD_CONFIG = {
  // §1 Scale
  scale: {
    metersPerUnit: 1,
    playableSize: 50_000,
  },

  // §2 Terrain mesh
  terrain: {
    size: 50_000,
    segments: 199, // 199x199 segments → 200x200 verts → ~80k tris
  },

  // §3 Heightmap noise
  noise: {
    seed: 0xf11574,
    seaLevel: 0,
    minHeight: -5,
    octaves: [
      { frequency: 4096, amplitude: 220 },
      { frequency: 1024, amplitude: 110 },
      { frequency: 256, amplitude: 28 },
      { frequency: 64, amplitude: 7 },
    ] as const,
  },

  // §4 Biome thresholds (RGB hex strings)
  biomes: {
    sand: '#C8B584',
    grass: '#4F7A3A',
    rockMixHi: '#6B6258',
    rock: '#544B43',
    snow: '#E8ECF0',
    sandMaxHeight: 1,
    grassMaxHeight: 80,
    rockMixMaxHeight: 250,
    snowMinHeight: 350,
    grassMaxSlope: 0.35,
    rockMinSlope: 0.45,
  },

  // §5 Water
  water: {
    size: 50_000,
    y: -0.05,
    color: '#1E3A5F',
    roughness: 0.25,
    metalness: 0.0,
  },

  // §6 Runway
  runway: {
    length: 1500,
    width: 30,
    y: 0.5,
    headingDeg: 90,
    flattenLength: 1700,
    flattenWidth: 80,
    blendLength: 1900,
    blendWidth: 120,
    color: '#3A3A3C',
    roughness: 0.85,
    stripeColor: '#F0F0F0',
    stripePainted: 10,
    stripeGap: 20,
    stripePitch: 30, // painted + gap
    stripeHalfWidth: 0.2,
    thresholdLength: 6,
    segmentsX: 60,
    segmentsZ: 4,
  },

  // §7 Sky
  sky: {
    scale: 45_000,
    turbidity: 4.0,
    rayleigh: 2.0,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.8,
    sunElevationDegDefault: 35,
    sunAzimuthDeg: 135,
    sunDistance: 10_000,
    duskTurbidity: 8,
    duskRayleigh: 3,
  },

  // §8 Lighting
  lighting: {
    sunColor: '#FFF4E0',
    sunIntensity: 3.2,
    hemiSky: '#88AACC',
    hemiGround: '#3A3328',
    hemiIntensity: 0.55,
  },

  // §9 Fog
  fog: {
    color: '#A8B8C4',
    duskColor: '#D4A07A',
    nightColor: '#0A1018',
    density: 0.00012,
  },

  // §11 Spawn
  spawn: {
    position: [-700, 0.5, 0] as const,
    headingDeg: 0,
  },
} as const;

export type WorldConfig = typeof WORLD_CONFIG;
