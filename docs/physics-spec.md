# FLISYM Physics Specification (v1, Cessna-172 class)

## 0. Scope and design intent

A 6-DOF rigid-body flight model for a Cessna-172-class GA aircraft, biased toward forgiving handling. Closed-form aerodynamic coefficients (no tables). Implementable in <500 LoC TypeScript. Cannon-es is **not** used for the aircraft itself — we integrate the rigid-body equations ourselves. Numbers are loosely sourced from the C172N POH and standard aircraft dynamics literature; ballpark, not certified.

## 1. Coordinate frames and conventions

### 1.1 World frame (W)
- Right-handed, Y-up (Three.js default).
- +X east, +Y up, +Z south. Heading 000° = -Z, heading 090° = +X.
- Units: meters, seconds, radians, kg, N.
- Gravity: `g_W = (0, -9.80665, 0)` m/s².

### 1.2 Body frame (B), anchored at CG
- +X_B forward (out the spinner)
- +Y_B up (out the top of the cabin)
- +Z_B right (out the right wingtip)

Right-handed. Deliberately deviates from textbook (X-fwd, Y-right, Z-down) so body-Y matches world-Y when level — simpler Three.js mesh authoring. Sign conventions for moments adjusted accordingly.

### 1.3 Quaternion convention
- `q = (x, y, z, w)` Three.js order; rotates body→world: `v_W = q · v_B · q⁻¹`.
- `THREE.Quaternion` and `Vector3.applyQuaternion` follow this exactly.
- Initial `q = (0,0,0,1)` aligns body axes with world → aircraft heading +X.

### 1.4 Angular rates
- `p` = roll rate about +X_B, positive = right wing down.
- `q` = pitch rate about +Z_B, positive = nose up.
- `r` = yaw rate about +Y_B, positive = nose right.

Implementer note: `ω_B` stored as `THREE.Vector3` where `.x = p`, `.y = r`, `.z = q`. Document this once; never confuse it again.

### 1.5 Aerodynamic angles
Let `v_B = (u, v, w_b)` be linear velocity in body frame.
- `V = ||v_B||`, clamp `V > 0.1` before evaluating below.
- `α = atan2(-v, u)` (positive when relative wind from below, i.e. body-Y velocity component negative).
- `β = asin(w_b / V)` (positive when wind from the right).

## 2. State variables

| Symbol | Type | Init | Notes |
|---|---|---|---|
| `x_W` | Vec3 | `(0, 0.5, 0)` | CG position, world. |
| `v_W` | Vec3 | `(0,0,0)` | linear velocity, world. |
| `q` | Quat | identity | body→world. |
| `ω_B` | Vec3 | `(0,0,0)` | body angular rates (p, r, q packed in x,y,z). |
| `throttle` | scalar | 0 | 1st-order lag τ=0.3s toward command. |
| `δ_a` | scalar | 0 | aileron [-1..1], +1 = right roll. |
| `δ_e` | scalar | 0 | elevator [-1..1], +1 = nose up. |
| `δ_r` | scalar | 0 | rudder [-1..1], +1 = nose right. |
| `δ_f` | scalar | 0 | flaps [0..1], 3 detents 0/0.5/1. |
| `onGround` | bool | true | for ground reaction. |
| `stallFlag` | bool | false | latches when |α|>α_stall. |

Surface commands rate-limited at 4.0 /s. Self-centering at 3.0 /s when key released (throttle does NOT self-center).

## 3. Aircraft constants (Cessna-172N class)

| Constant | Value | Units |
|---|---|---|
| Mass m | 1100 | kg |
| Wing area S | 16.2 | m² |
| Span b | 11.0 | m |
| MAC c̄ | 1.5 | m |
| AR | 7.47 | — |
| Oswald e | 0.80 | — |
| Ixx | 1285 | kg·m² |
| Iyy | 1825 | kg·m² (pitch, body +Z) |
| Izz | 2667 | kg·m² (yaw, body +Y) |
| Ixz | 0 | (ignored) |

Inertia tensor `I_B = diag(Ixx, Izz, Iyy)` because of axis remap (Y=yaw, Z=pitch).

## 4. Atmosphere (ISA, 0–5000 m)

T0=288.15 K, p0=101325 Pa, ρ0=1.225 kg/m³, L=0.0065 K/m, R=287.058 J/(kg·K), g=9.80665.

```
T = T0 - L*h          (clamp h ∈ [0, 5000])
p = p0 * (T/T0)^(g/(R*L))
ρ = p / (R*T)
σ = ρ / ρ0
a = sqrt(1.4 * R * T)
```

## 5. Aerodynamics

Dynamic pressure `q̄ = ½ ρ V²`.

### 5.1 Lift
```
CL_0 = 0.31; CL_α = 5.7; CL_δe = 0.43; ΔCL_flaps(δ_f) = 0.4*δ_f
α_stall_clean = 0.2618 (15°); α_stall = α_stall_clean - 0.0349*δ_f (-2°/unit flap)
CL_max = 1.4 + 0.3*δ_f

CL_linear = CL_0 + CL_α*α + CL_δe*δ_e + ΔCL_flaps

if |α| <= α_stall: CL = CL_linear
elif |α|-α_stall < 0.262: CL = sign(α) * (CL_max - 2.0*(|α|-α_stall))
else:                    CL = sign(α) * 0.9 * sin(2*α)   ; stallFlag = true
```

### 5.2 Drag
```
CD0 = 0.027; ΔCD_flaps = 0.04*δ_f; ΔCD_gear = 0.015 (always on)
CD_induced = CL² / (π*AR*e)
CD = CD0 + ΔCD_gear + ΔCD_flaps + CD_induced + 0.05*|β|
```

### 5.3 Side force
```
CY = -0.31*β + 0.187*δ_r
```

### 5.4 Force assembly (wind→body)
```
L = q̄·S·CL ; D = q̄·S·CD ; Y = q̄·S·CY
F_aero_B.x = -D*cos(α) + L*sin(α)
F_aero_B.y =  L*cos(α) + D*sin(α)
F_aero_B.z =  Y
```

### 5.5 Aero moments
Non-dimensional rates: `p̂=p·b/(2V)`, `q̂=q·c̄/(2V)`, `r̂=r·b/(2V)` (clamp V>5).

```
Cl = -0.089*β - 0.47*p̂ + 0.096*r̂ + Cl_δa*δ_a + 0.0147*δ_r
Cm =  0.04 - 0.89*α - 12.4*q̂ + Cm_δe*δ_e - 0.05*δ_f
Cn =  0.065*β - 0.03*p̂ - 0.099*r̂ - 0.053*δ_a + Cn_δr*δ_r

L_roll  = q̄·S·b·Cl
M_pitch = q̄·S·c̄·Cm
N_yaw   = q̄·S·b·Cn
```

Sign flips (vs textbook Z-down): `Cm_δe = +1.28` (positive elevator → nose up), `Cn_δr = +0.074` (positive rudder → nose right).

**Caution** (V5): textbook `Cl_δa=0.178` is too twitchy. Start at **`Cl_δa=0.04`** and tune up until full-aileron roll rate at V=50 m/s is 30–60°/s. Same risk on `Cm_δe`: drop to ~0.5 if pitch is twitchy.

Moment vector body frame (recall packing): `M_B.x=L_roll, M_B.y=N_yaw, M_B.z=M_pitch`.

### 5.6 Stall buffet (cosmetic)
While stallFlag: `M_pitch += 0.6*sin(t*18)*(|α|-α_stall)/0.1` N·m (pseudo-shake).

## 6. Propulsion

```
T_static(σ) = 2800 * σ                          [N]
v_factor    = max(0, 1 - V / 75)
T(thr, V, σ) = T_static(σ) * thr * (0.75 + 0.25 * v_factor)
```

Thrust along +X_B at CG. Throttle 1st-order lag τ=0.3s. Optional prop torque: `M_B.x += -0.05*T` (rolls left under power).

## 7. Equations of motion

```
F_B = F_aero_B + (T, 0, 0)
F_W = q.rotate(F_B) + m*g_W
a_W = F_W / m

M_B = M_aero_B + M_thrust_B
ω_dot.x = (M_B.x - (Iyy - Izz)*ω_B.y*ω_B.z) / Ixx
ω_dot.y = (M_B.y - (Ixx - Iyy)*ω_B.x*ω_B.z) / Izz
ω_dot.z = (M_B.z - (Izz - Ixx)*ω_B.x*ω_B.y) / Iyy
```

## 8. Integration — semi-implicit Euler

```
PHYSICS_DT = 1/240
acc += min(dtRender, 0.1)
while (acc >= PHYSICS_DT) { physicsStep(PHYSICS_DT); acc -= PHYSICS_DT }

physicsStep(dt):
  computeForcesAndMoments()
  v_W += a_W * dt
  ω_B += ω_dot * dt
  x_W += v_W * dt
  ω_W = q.rotate(ω_B)
  dq  = Quat(ω_W.x*dt*0.5, ω_W.y*dt*0.5, ω_W.z*dt*0.5, 0).multiply(q)
  q   = q.add(dq).normalize()
  throttle += (throttleCmd - throttle) * (1 - exp(-dt/0.3))
  if (x_W.y < groundY) { x_W.y = groundY; v_W.y = max(0, v_W.y); onGround=true; ... }
```

Ground: clamp `x_W.y >= 0.5`, zero negative vertical velocity, rolling friction `-0.02 * v_W_horizontal` while on ground, kill rates when groundspeed <0.5 m/s.

## 9. Inputs → control surfaces

| Key | Action |
|---|---|
| W/S or ↓/↑ | elevator (W = nose down, S = nose up); commands `δ_e_cmd` |
| A/D or ←/→ | aileron |
| Q / E | rudder |
| Shift / Ctrl | throttle up/down (0.5 /s) |
| F / Shift+F | flaps cycle (0 → 0.5 → 1) |
| B | parking brake |
| R | reset spawn (dev) |
| V | camera cycle (HUDCoder dispatches event) |

Stick convention: forward stick = nose down. Self-centering at 3.0 /s on release; throttle does NOT center.

## 10. The FLIGHT_MODEL constant (paste verbatim)

```ts
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

  physicsDt: 1/240, maxSubsteps: 8,
} as const;
```

## 11. Validation cases (Vitest)

1. **Trim**: throttle 0.65, elevator-trimmed level flight at h=500m → V settles 42–55 m/s.
2. **Stall clean**: V_stall theoretical ≈ 24.7 m/s. Test: V=26, full back stick, no thrust → α exceeds α_stall in <5s, stallFlag latches.
3. **Stall flaps**: V_stall ≈ 22.4 m/s; same test with δ_f=1.
4. **Climb full power SL**: 3.5–6 m/s rate of climb.
5. **Roll**: full aileron at V=50 → steady roll 30–60°/s.
6. **Phugoid**: brief elevator pulse, release → 20–40s oscillation, lightly damped.

## 12. File layout

```
src/physics/
  flightModel.ts   (~70 LoC) — FLIGHT_MODEL const
  atmosphere.ts    (~30 LoC) — ISA
  aero.ts          (~150 LoC) — coefficients & forces/moments
  propulsion.ts    (~30 LoC) — thrust
  state.ts         (~50 LoC) — AircraftState interface + init
  step.ts          (~120 LoC) — integrator
  controls.ts      (~50 LoC) — input slew
  index.ts         (~20 LoC) — public API
```

## 13. Out of scope (v1)
Wind/turbulence, ground-effect, P-factor, gyroscopic, slipstream, compressibility, mixture/prop pitch, engine failure.

## 14. Open questions
1. Hand-roll ground clamp (y=0.5) — recommended over Cannon for v1.
2. Buffet: visual shake vs force shake — coordinate w/ HUD/Camera.
3. ω_B axis packing (p,r,q in x,y,z). Document at top of file.
