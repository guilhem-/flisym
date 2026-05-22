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

  // §2 Terrain mesh — far LOD covering the whole playable area.
  terrain: {
    size: 50_000,
    segments: 199, // 199x199 segments → 200x200 verts → ~80k tris
  },

  // §2b Terrain LOD layers (near + mid). The near LOD follows the aircraft
  // so high-detail vertices are concentrated where the camera looks. The
  // mid LOD covers a larger area at moderate density to make the seam
  // between near and the far mesh less jarring.
  terrainLod: {
    near: { size: 800, segments: 64, polygonOffsetFactor: -2 },  // ~8k tris
    mid:  { size: 6_000, segments: 96, polygonOffsetFactor: -1 }, // ~18k tris
  },

  // §2c Vegetation — instanced tree cover over grass biomes.
  trees: {
    count: 600,
    minHeight: 1,         // sand biome floor
    maxHeight: 200,       // below rock-mix start so we stick to grass/lower
    maxSlope: 0.30,       // skip steep ground (matches biome grassMaxSlope-ish)
    runwayExclusionXZ: 250, // skip near the runway/spawn for clean takeoff sight lines
    seed: 0xb1a17e,
    trunkRadius: 0.5,
    trunkHeight: 2.5,
    canopyRadius: 2.0,
    canopyHeight: 6.0,
    trunkColor: '#5C3A21',
    canopyColor: '#2C5C2A',
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

  // §12 Mountain bias — localized ridges added on top of the simplex noise
  // (BEFORE the runway flatten mask). Provides scale and reference points for
  // approach/departure. See `/AGENTS/challenge-mountains.md`.
  mountains: {
    primary: {
      cx: 0,
      cz: -12000,
      // Cosine envelope along x: full inside |x|<envelopeFull, zero past envelopeZero.
      envelopeFull: 10000,
      envelopeZero: 15000,
      // Gaussian falloff in z.
      sigmaZ: 1500,
      peakHeight: 1800,
      // Sharpening detail noise (uses the shared simplex instance).
      sharpenAmplitude: 250,
      sharpenScale: 2000,
    },
    secondary: {
      cx: 18000,
      cz: 0,
      // Length 8000m along z → cosine envelope along z.
      envelopeFull: 2000,
      envelopeZero: 4000,
      // Gaussian falloff in x.
      sigmaX: 2000,
      peakHeight: 800,
    },
  },
} as const;

export type WorldConfig = typeof WORLD_CONFIG;
