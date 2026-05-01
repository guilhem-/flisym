// Cockpit HUD overlay. Plain DOM/CSS, no canvas.
//
// Conventions (per physics-spec):
//  - Heading: 000° = -Z (north), 090° = +X (east).
//    Forward dir derived from body +X rotated by state.q.
//    heading = atan2(dirX, -dirZ) * 180/π, normalized to [0,360).
//  - knots = m/s × 1.94384, feet = m × 3.28084, fpm = m/s × 196.8504.
//  - Pitch (for attitude indicator): asin(forward.y), positive nose-up.
//  - Roll (for attitude indicator): tilt of body +Y around forward axis,
//    derived from the body-up vector projected into the plane normal to fwd.

import * as THREE from 'three';
import type { AircraftState } from '../physics/state.js';

const MS_TO_KNOTS = 1.94384;
const M_TO_FEET = 3.28084;
const MS_TO_FPM = 196.8504; // 60 * 3.28084

const HUD_CSS = `
.flisym-hud {
  position: fixed;
  inset: 0;
  pointer-events: none;
  font-family: 'Consolas', 'Menlo', 'DejaVu Sans Mono', monospace;
  font-size: 14px;
  color: #b6ff7a;
  text-shadow: 0 0 4px rgba(0,0,0,0.85);
  z-index: 50;
  user-select: none;
}
.flisym-hud .panel {
  position: absolute;
  background: rgba(0,0,0,0.35);
  border: 1px solid rgba(182,255,122,0.35);
  border-radius: 4px;
  padding: 6px 10px;
  line-height: 1.4em;
  min-width: 140px;
}
.flisym-hud .panel.tl { top: 14px; left: 14px; }
.flisym-hud .panel.tr { top: 14px; right: 14px; text-align: right; }
.flisym-hud .panel .row { display: flex; justify-content: space-between; gap: 12px; }
.flisym-hud .panel .label { opacity: 0.65; }
.flisym-hud .panel .value { font-weight: 600; font-variant-numeric: tabular-nums; }

.flisym-hud .ai {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 220px;
  height: 220px;
  margin-left: -110px;
  margin-top: -110px;
  border: 2px solid rgba(182,255,122,0.55);
  border-radius: 50%;
  overflow: hidden;
  background: #102030;
}
.flisym-hud .ai-horizon {
  position: absolute;
  left: -200%;
  top: -200%;
  width: 500%;
  height: 500%;
  background: linear-gradient(to bottom, #5fa8d3 0%, #5fa8d3 50%, #7a4a1f 50%, #7a4a1f 100%);
  transform-origin: 50% 50%;
}
.flisym-hud .ai-center {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 60px;
  height: 2px;
  margin-left: -30px;
  margin-top: -1px;
  background: #ffd23a;
  box-shadow: 0 0 4px rgba(0,0,0,0.8);
}
.flisym-hud .ai-center::before,
.flisym-hud .ai-center::after {
  content: '';
  position: absolute;
  top: -1px;
  width: 12px;
  height: 4px;
  background: #ffd23a;
}
.flisym-hud .ai-center::before { left: -16px; }
.flisym-hud .ai-center::after  { right: -16px; }

.flisym-hud .stall {
  position: absolute;
  left: 50%;
  bottom: 60px;
  transform: translateX(-50%);
  background: rgba(180,30,30,0.85);
  color: #fff;
  border: 1px solid #ff6b6b;
  border-radius: 4px;
  padding: 6px 14px;
  letter-spacing: 0.2em;
  font-weight: 700;
  display: none;
}
.flisym-hud .stall.on { display: block; animation: flisym-stall-blink 0.5s steps(2, start) infinite; }
@keyframes flisym-stall-blink { 50% { opacity: 0.35; } }
`;

function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '---';
  return n.toFixed(digits);
}

function headingLabel(deg: number): string {
  // Normalize and pick a cardinal letter for context.
  const d = ((deg % 360) + 360) % 360;
  const cardinals = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(d / 45) % 8;
  return `${fmt(d, 0).padStart(3, '0')}° ${cardinals[idx]}`;
}

export class HUD {
  readonly root: HTMLDivElement;

  private readonly elAirspeed: HTMLSpanElement;
  private readonly elAltitude: HTMLSpanElement;
  private readonly elHeading: HTMLSpanElement;
  private readonly elVSpeed: HTMLSpanElement;
  private readonly elThrottle: HTMLSpanElement;
  private readonly elFlaps: HTMLSpanElement;
  private readonly elHorizon: HTMLDivElement;
  private readonly elStall: HTMLDivElement;

  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor() {
    this.injectStyle();
    this.root = document.createElement('div');
    this.root.className = 'flisym-hud';
    this.root.innerHTML = `
      <div class="panel tl">
        <div class="row"><span class="label">IAS</span><span class="value" data-h="airspeed">0</span><span class="label">kt</span></div>
        <div class="row"><span class="label">ALT</span><span class="value" data-h="altitude">0</span><span class="label">ft</span></div>
        <div class="row"><span class="label">HDG</span><span class="value" data-h="heading">000° N</span></div>
      </div>
      <div class="panel tr">
        <div class="row"><span class="label">VSI</span><span class="value" data-h="vspeed">0</span><span class="label">fpm</span></div>
        <div class="row"><span class="label">THR</span><span class="value" data-h="throttle">0</span><span class="label">%</span></div>
        <div class="row"><span class="label">FLAPS</span><span class="value" data-h="flaps">UP</span></div>
      </div>
      <div class="ai">
        <div class="ai-horizon" data-h="horizon"></div>
        <div class="ai-center"></div>
      </div>
      <div class="stall" data-h="stall">STALL</div>
    `;

    this.elAirspeed = this.q('airspeed');
    this.elAltitude = this.q('altitude');
    this.elHeading = this.q('heading');
    this.elVSpeed = this.q('vspeed');
    this.elThrottle = this.q('throttle');
    this.elFlaps = this.q('flaps');
    this.elHorizon = this.q<HTMLDivElement>('horizon');
    this.elStall = this.q<HTMLDivElement>('stall');
  }

  private q<T extends HTMLElement = HTMLSpanElement>(name: string): T {
    const el = this.root.querySelector<T>(`[data-h="${name}"]`);
    if (!el) throw new Error(`HUD: missing element [data-h="${name}"]`);
    return el;
  }

  private injectStyle(): void {
    if (document.getElementById('flisym-hud-style')) return;
    const style = document.createElement('style');
    style.id = 'flisym-hud-style';
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
  }

  /** Refresh all instruments from the current aircraft state. */
  update(state: AircraftState): void {
    // --- Airspeed (true airspeed used here; close enough for v1).
    const v = state.v_W.length();
    this.elAirspeed.textContent = fmt(v * MS_TO_KNOTS, 0);

    // --- Altitude (above sea level reference; physics uses world-Y meters).
    const altFt = state.x_W.y * M_TO_FEET;
    this.elAltitude.textContent = fmt(altFt, 0);

    // --- Heading: project body-+X into the world XZ plane.
    this.fwd.set(1, 0, 0).applyQuaternion(state.q);
    const hdg =
      ((Math.atan2(this.fwd.x, -this.fwd.z) * 180) / Math.PI + 360) % 360;
    this.elHeading.textContent = headingLabel(hdg);

    // --- Vertical speed.
    this.elVSpeed.textContent = fmt(state.v_W.y * MS_TO_FPM, 0);

    // --- Throttle (use actual lagged value, not command).
    this.elThrottle.textContent = fmt(state.throttle * 100, 0);

    // --- Flaps notch.
    this.elFlaps.textContent = flapsLabel(state.delta_f);

    // --- Attitude indicator.
    // Pitch in radians from forward.y (positive = nose up).
    const pitchRad = Math.asin(
      Math.max(-1, Math.min(1, this.fwd.y)),
    );
    // Roll from body-up and body-right vectors expressed in world frame.
    // Body +Y is "up out of cabin", body +Z is "right wingtip" (spec §1.2).
    // When level, up=(0,1,0), right=(0,0,1). Bank right → up.y stays high
    // and right.y goes positive (right wingtip drops? no — we choose sign
    // so a right bank rotates the horizon counter-clockwise on screen).
    this.up.set(0, 1, 0).applyQuaternion(state.q);
    this.right.set(0, 0, 1).applyQuaternion(state.q);
    const rollRad = Math.atan2(this.right.y, this.up.y);

    const rollDeg = (rollRad * 180) / Math.PI;
    // Pitch translation: ~2 px per degree feels right for a 220px disk.
    const pitchPx = (pitchRad * 180) / Math.PI * 2;
    // Counter-rotate horizon for roll (right-bank → horizon tilts left).
    this.elHorizon.style.transform = `translate(0, ${pitchPx}px) rotate(${-rollDeg}deg)`;

    // --- Stall flag.
    this.elStall.classList.toggle('on', state.stallFlag);
  }

  /** Remove the HUD root from the DOM. */
  dispose(): void {
    this.root.remove();
  }
}

function flapsLabel(delta_f: number): string {
  if (delta_f < 0.25) return 'UP';
  if (delta_f < 0.75) return '1 (10°)';
  return '2 (20°)';
}
