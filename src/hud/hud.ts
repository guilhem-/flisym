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
import type { GateState } from '../challenge/gates.js';
import { ILSIndicator } from './ils.js';

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
  bottom: 18px;
  width: 140px;
  height: 140px;
  margin-left: -70px;
  border: 2px solid rgba(182,255,122,0.55);
  border-radius: 50%;
  overflow: hidden;
  background: rgba(16, 32, 48, 0.78);
  opacity: 0.92;
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
  width: 40px;
  height: 2px;
  margin-left: -20px;
  margin-top: -1px;
  background: #ffd23a;
  box-shadow: 0 0 4px rgba(0,0,0,0.8);
}
.flisym-hud .ai-center::before,
.flisym-hud .ai-center::after {
  content: '';
  position: absolute;
  top: -1px;
  width: 8px;
  height: 4px;
  background: #ffd23a;
}
.flisym-hud .ai-center::before { left: -10px; }
.flisym-hud .ai-center::after  { right: -10px; }

.flisym-hud .stall {
  position: absolute;
  left: 50%;
  bottom: 180px;
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

.flisym-hud .panel.tc {
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  min-width: 280px;
  display: none;
}
.flisym-hud .panel.tc.on { display: block; }
.flisym-hud .panel.tc .title {
  display: block;
  font-size: 11px;
  letter-spacing: 0.25em;
  opacity: 0.7;
  margin-bottom: 2px;
}
.flisym-hud .panel.tc .stats {
  display: flex;
  justify-content: center;
  gap: 18px;
  font-variant-numeric: tabular-nums;
}
.flisym-hud .panel.tc .stats .seg .label { opacity: 0.65; margin-right: 4px; }
.flisym-hud .panel.tc.finished { border-color: rgba(255, 0, 255, 0.6); }

.flisym-hud .finish-overlay {
  position: fixed;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  z-index: 100;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.6s ease-in;
}
.flisym-hud .finish-overlay.on { display: flex; opacity: 1; }
.flisym-hud .finish-card {
  background: rgba(0, 0, 0, 0.7);
  border: 1px solid rgba(255, 0, 255, 0.6);
  border-radius: 8px;
  padding: 24px 36px;
  text-align: center;
  color: #b6ff7a;
  box-shadow: 0 0 24px rgba(255, 0, 255, 0.25);
}
.flisym-hud .finish-card .headline {
  font-size: 22px;
  letter-spacing: 0.2em;
  margin-bottom: 12px;
  color: #ff7aff;
}
.flisym-hud .finish-card .summary {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  margin-bottom: 8px;
}
.flisym-hud .finish-card .hint {
  font-size: 12px;
  opacity: 0.7;
  margin-top: 10px;
}
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
  private readonly elChallenge: HTMLDivElement;
  private readonly elChallengeStats: HTMLSpanElement;
  private readonly elFinishOverlay: HTMLDivElement;
  private readonly elFinishSummary: HTMLDivElement;

  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  private readonly ils: ILSIndicator;
  private ilsWasActive = false;
  private approachAudioCtx: AudioContext | null = null;
  private approachAudioFailed = false;
  // Browsers (Chrome / Safari) refuse to start an AudioContext until the user
  // has interacted with the page. We listen once for the first gesture and
  // unblock any deferred audio after that.
  private userGestured = false;
  // If a tone was requested before the first gesture, fire it on unlock.
  private pendingTone = false;

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
      <div class="panel tc" data-h="challenge">
        <span class="title">CHALLENGE</span>
        <div class="stats" data-h="challenge-stats"></div>
      </div>
      <div class="finish-overlay" data-h="finish-overlay">
        <div class="finish-card">
          <div class="headline">COURSE COMPLETE</div>
          <div class="summary" data-h="finish-summary"></div>
          <div class="hint">Press G to restart</div>
        </div>
      </div>
    `;

    this.elAirspeed = this.q('airspeed');
    this.elAltitude = this.q('altitude');
    this.elHeading = this.q('heading');
    this.elVSpeed = this.q('vspeed');
    this.elThrottle = this.q('throttle');
    this.elFlaps = this.q('flaps');
    this.elHorizon = this.q<HTMLDivElement>('horizon');
    this.elStall = this.q<HTMLDivElement>('stall');
    this.elChallenge = this.q<HTMLDivElement>('challenge');
    this.elChallengeStats = this.q<HTMLSpanElement>('challenge-stats');
    this.elFinishOverlay = this.q<HTMLDivElement>('finish-overlay');
    this.elFinishSummary = this.q<HTMLDivElement>('finish-summary');

    this.ils = new ILSIndicator();
    this.root.appendChild(this.ils.root);

    // Listen ONCE for the first user gesture. After it fires, AudioContext
    // creation is allowed by Chrome's autoplay policy.
    const onFirstGesture = (): void => {
      this.userGestured = true;
      // If a tone was queued while we were locked, play it now.
      if (this.pendingTone) {
        this.pendingTone = false;
        this.playApproachTone();
      }
      // Resume any context that was created suspended.
      if (this.approachAudioCtx?.state === 'suspended') {
        void this.approachAudioCtx.resume();
      }
      window.removeEventListener('keydown', onFirstGesture);
      window.removeEventListener('pointerdown', onFirstGesture);
    };
    window.addEventListener('keydown', onFirstGesture, { once: false });
    window.addEventListener('pointerdown', onFirstGesture, { once: false });
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

    // --- ILS approach guidance (lower-left). Single-edge tone on activation.
    const reading = this.ils.update(state);
    if (reading.active && !this.ilsWasActive) {
      this.playApproachTone();
    }
    this.ilsWasActive = reading.active;
  }

  /** One-shot 1200 Hz sine beep (200 ms, gain 0.05). Silently no-ops on failure. */
  private playApproachTone(): void {
    if (this.approachAudioFailed) return;
    // Defer until the user has gestured — Chrome rejects AudioContext.start()
    // before that and logs a noisy warning. Queue the tone so it fires on
    // first interaction.
    if (!this.userGestured) {
      this.pendingTone = true;
      return;
    }
    try {
      let ctx = this.approachAudioCtx;
      if (!ctx) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const C = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!C) { this.approachAudioFailed = true; return; }
        ctx = new C() as AudioContext;
        this.approachAudioCtx = ctx;
      }
      if (ctx.state === 'suspended') void ctx.resume();
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.01);
      g.gain.setValueAtTime(0.05, t + 0.19);
      g.gain.linearRampToValueAtTime(0, t + 0.2);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.21);
    } catch {
      this.approachAudioFailed = true;
    }
  }

  /**
   * Update the CHALLENGE panel. Pass `null` to hide it.
   * Total gate count is inferred as `state.activeIndex + state.totalCleared
   * + state.missed` clamped — but we can also trust the cleared/missed sum
   * relative to the fixed course length encoded by the caller. To keep the
   * HUD oblivious to course length we display X/12 using the well-known
   * count from the brief.
   */
  setChallenge(state: GateState | null): void {
    if (state === null) {
      this.elChallenge.classList.remove('on');
      return;
    }
    this.elChallenge.classList.add('on');
    this.elChallenge.classList.toggle('finished', state.finished);

    const courseLen = 12;
    const gateNum = state.finished
      ? courseLen
      : Math.min(state.activeIndex + 1, courseLen);
    const time = formatCourseTime(state.courseTime);
    this.elChallengeStats.innerHTML =
      `<span class="seg"><span class="label">Gate</span>${gateNum}/${courseLen}</span>` +
      `<span class="seg"><span class="label">Time</span>${time}</span>` +
      `<span class="seg"><span class="label">Missed</span>${state.missed}</span>`;
  }

  /** Show the end-of-course summary overlay. */
  showFinishOverlay(time: number, missed: number): void {
    this.elFinishSummary.textContent =
      `Time ${formatCourseTime(time)} — Missed ${missed} gate${missed === 1 ? '' : 's'}`;
    this.elFinishOverlay.classList.add('on');
  }

  /** Hide the end-of-course summary overlay. */
  hideFinishOverlay(): void {
    this.elFinishOverlay.classList.remove('on');
  }

  /** Remove the HUD root from the DOM. */
  dispose(): void {
    this.root.remove();
  }
}

function formatCourseTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function flapsLabel(delta_f: number): string {
  if (delta_f < 0.25) return 'UP';
  if (delta_f < 0.75) return '1 (10°)';
  return '2 (20°)';
}
