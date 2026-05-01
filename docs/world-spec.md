# World Specification — FLISYM

## 1. Scale & Coordinate System
- 1 Three.js unit = 1 meter (SI throughout).
- Right-handed coords: +X = east, +Y = up, +Z = south. Heading is measured clockwise from +X (so heading 090° = +X axis).
- Playable area: 50,000 m × 50,000 m centered on origin. Skybox at effective infinity (camera-locked).
- World origin (0,0,0) sits at the **center of the runway**.

## 2. Terrain Mesh — Decision: SINGLE DISPLACED PLANE
- **Choice**: one `PlaneGeometry(50000, 50000, 199, 199)` rotated −π/2 about X, with per-vertex Y displacement from the noise function.
- 200×200 segments → 40,401 verts → ~80,000 triangles. Stays under the 100k budget.
- A single static plane avoids LOD bookkeeping, chunk seams, and streaming complexity — fits the 8h budget. Frustum culling on the bounding box is sufficient because the entire mesh is one draw call.
- Normals: `geometry.computeVertexNormals()` after displacement.

## 3. Procedural Heightmap — Exact Noise Recipe
Use `simplex-noise` (npm `simplex-noise@4`). Seed = `0xF11574` (FLISYM).

```
height(x, z) =
    sea_level
  + 220.0 * simplex(x / 4096, z / 4096)        // continental shape
  + 110.0 * simplex(x / 1024, z / 1024)        // hills
  +  28.0 * simplex(x /  256, z /  256)        // bumps
  +   7.0 * simplex(x /   64, z /   64)        // micro-detail
```

- Octaves (frequency_meters / amplitude_meters):
  - 4096 / 220
  - 1024 / 110
  -  256 /  28
  -   64 /   7
- `sea_level = 0` (water plane y = 0).
- Clamp height ≥ −5 m so the seabed near shore is not absurd.
- After computing raw height, apply a **runway flatten mask** (see §6) before assignment.

## 4. Terrain Materials (Vertex-Color Biomes)
Per-vertex RGB chosen from height (h) and slope (s = 1 − normal.y):
- h < 1 m → sand `#C8B584`
- 1 ≤ h < 80 m, s < 0.35 → grass `#4F7A3A`
- 80 ≤ h < 250 m → mixed grass/rock blend toward `#6B6258`
- s ≥ 0.45 (any height) → rock `#544B43`
- h ≥ 350 m → snow `#E8ECF0`

Use `MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0, flatShading: false })`.

## 5. Water
- Single `PlaneGeometry(50000, 50000, 1, 1)` at y = -0.05, rotated to horizontal.
- Material: `MeshStandardMaterial` color `#1E3A5F`, roughness 0.25, metalness 0.0.
- Optional procedural normal map: two scrolling simplex-derived normal layers offset by `time * (0.4, 0.25)` and `time * (-0.2, 0.15)`.
- No reflections (cost). Looks fine from cruise altitude.

## 6. Runway
- Position: origin (0, 0, 0). Long axis along +X. Heading 090°.
- Dimensions: 1500 m (X) × 30 m (Z).
- Rectangle bounds: x ∈ [−750, +750], z ∈ [−15, +15].
- **Flatten rule**: when sampling terrain heights, if `(x, z)` falls inside a 1700 m × 80 m rectangle (40 m flatten transition margin), force `h = 0`. Outside that but inside 1900 × 120, smoothstep-blend toward natural noise to avoid a vertical wall.
- **Runway render**: separate `PlaneGeometry(1500, 30, 60, 4)` at y = 0.5, rotated horizontal.
  - Asphalt-grey base via vertex color `#3A3A3C`, roughness 0.85.
  - Centerline: white stripes every 30 m (10 m painted, 20 m gap), drawn by setting vertex color `#F0F0F0` for vertices whose local-X falls within stripe windows AND |local-Z| < 0.2 m. Use the 60×4 subdivision so stripe edges fall on vertices.
  - Threshold bars: white blocks at the two short ends (last 6 m), full width.
- The 0.5 m lift prevents z-fighting with the terrain plateau and approximates real runway camber.

## 7. Sky — Three.js `Sky` Shader
Use `three/examples/jsm/objects/Sky.js`. Scale = 45000 (sphere radius).

Default daylight params:
- `turbidity` = 4.0
- `rayleigh` = 2.0
- `mieCoefficient` = 0.005
- `mieDirectionalG` = 0.8
- Sun position from elevation 35°, azimuth 135° (SE morning sun):
  - `phi = (90 − 35) * π/180`
  - `theta = 135 * π/180`
  - `sunPos = (sin φ cos θ, cos φ, sin φ sin θ)` then scaled.
- Time-of-day: expose `setTimeOfDay(hours)` that maps 0–24 h to elevation curve `−10° → +60° → −10°` and adjusts turbidity/rayleigh slightly at dawn/dusk (turbidity 8, rayleigh 3).

## 8. Lighting
- `DirectionalLight` color `#FFF4E0`, intensity 3.2, position from sun direction at 10,000 m. Shadows OFF in v1.
- `HemisphereLight` sky `#88AACC`, ground `#3A3328`, intensity 0.55.
- No point lights.

## 9. Fog
- `THREE.FogExp2(color, density)`:
  - `density = 0.00012`
  - `color = #A8B8C4` (matches Sky horizon haze at default params).
- Re-tint fog color when time-of-day changes: dawn/dusk → `#D4A07A`, night → `#0A1018`.

## 10. Clouds (stretch — optional, low priority)
- 80 transparent billboard sprites of a 256×256 procedural puff texture (radial falloff + simplex noise alpha) scattered between 1200–1800 m AGL across the playable area. Skip if behind schedule.

## 11. Spawn
- Aircraft initial transform: position `(-700, 0, 0)`, heading +X (yaw 0). Gear contact at runway top y = 0.5; aircraft model origin is at gear contact, so its world Y = 0.5.
- Linear velocity (0, 0, 0). Angular velocity zero. Throttle idle.

## 12. Performance Budget — 60 FPS on Integrated GPU
- Terrain ≤ 80,000 tris (single draw call).
- Water 2 tris.
- Runway ≈ 480 tris.
- Sky 1 inverted sphere (~1000 tris).
- Cloud sprites (if enabled) 80 quads = 160 tris.
- Total static world < 82k tris, ≤ 5 draw calls.
- No shadow maps in v1. No post-processing in v1.
- Frustum culling enabled (default). Disable matrix auto-update on the static terrain after first build.

## 13. Asset List — All Procedural
- Terrain heightmap: runtime simplex noise.
- Terrain colors: per-vertex.
- Water normals: runtime simplex (or one in-memory 256×256 DataTexture).
- Runway: vertex colors only.
- Sky: shader-based.
- Clouds (optional): one 256×256 generated DataTexture.
- **No binary assets in repo.**

## 14. Determinism & Seed
Single seed `0xF11574` flows into the simplex constructor and into the cloud distribution RNG. Re-running yields identical terrain — important for predictable testing.

## 15. Handoff Notes for TerrainCoder
- Build order: heightmap function → flatten mask → plane geometry displacement → vertex color pass → normals → water → runway → sky → lights → fog.
- Expose `getHeightAt(x, z): number` so physics can query ground height — must use the same function (including runway flatten) the mesh used.
- Keep all magic numbers in a `WORLD_CONFIG` const so PhysicsDesigner can read them.
