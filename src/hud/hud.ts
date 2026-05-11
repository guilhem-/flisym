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
import type {
  CombatSnapshot,
  MissionHudState,
  TimeTrialHudState,
} from './types.js';
import type { ModeStatus } from '../modes/types.js';

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

/* ── v0.2 combat / mission / time-trial overlays ──────────────────────── */

.flisym-hud .mode-badge {
  position: absolute;
  left: 50%;
  bottom: 168px;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.45);
  border: 1px solid rgba(182,255,122,0.35);
  border-radius: 4px;
  padding: 3px 12px;
  font-size: 11px;
  letter-spacing: 0.25em;
  text-align: center;
  min-width: 160px;
}

.flisym-hud .radar {
  position: absolute;
  top: 110px;
  right: 14px;
  width: 240px;
  height: 240px;
  background: rgba(0,0,0,0.5);
  border: 1px solid rgba(182,255,122,0.4);
  border-radius: 50%;
  overflow: hidden;
  display: none;
}
.flisym-hud .radar.on { display: block; }

.flisym-hud .gun-pipper {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 24px;
  height: 24px;
  margin-left: -12px;
  margin-top: -12px;
  border: 1px solid #ffd23a;
  border-radius: 50%;
  box-sizing: border-box;
  display: none;
  pointer-events: none;
}
.flisym-hud .gun-pipper.on { display: block; }
.flisym-hud .gun-pipper.hot { border-color: #ff4444; }

.flisym-hud .target-box {
  position: absolute;
  width: 64px;
  height: 64px;
  margin-left: -32px;
  margin-top: -32px;
  border: 1px solid rgba(255, 68, 68, 0.8);
  box-sizing: border-box;
  display: none;
  pointer-events: none;
}
.flisym-hud .target-box.on { display: block; }

.flisym-hud .lock-led {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #444;
}
.flisym-hud .lock-led.seeking { background: #ffae00; animation: flisym-lock-blink 0.25s steps(2, start) infinite; }
.flisym-hud .lock-led.locked { background: #ff2828; }
@keyframes flisym-lock-blink { 50% { opacity: 0.25; } }

.flisym-hud .damage-panel {
  position: absolute;
  right: 14px;
  bottom: 14px;
  width: 200px;
  background: rgba(0,0,0,0.55);
  border: 1px solid rgba(182,255,122,0.35);
  border-radius: 4px;
  padding: 6px 8px;
  display: none;
}
.flisym-hud .damage-panel.on { display: block; }
.flisym-hud .damage-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  letter-spacing: 0.1em;
  margin-bottom: 2px;
}
.flisym-hud .damage-row:last-child { margin-bottom: 0; }
.flisym-hud .damage-row .label { width: 52px; opacity: 0.65; }
.flisym-hud .damage-bar {
  position: relative;
  flex: 1;
  height: 6px;
  background: rgba(255,255,255,0.08);
  overflow: hidden;
}
.flisym-hud .damage-bar > i {
  display: block;
  height: 100%;
  background: #6ddf6d;
  transition: width 0.1s linear;
}
.flisym-hud .damage-bar.amber > i { background: #ffae00; }
.flisym-hud .damage-bar.red   > i { background: #ff3838; }

.flisym-hud .ammo-readout {
  position: absolute;
  right: 14px;
  bottom: 110px;
  background: rgba(0,0,0,0.5);
  border: 1px solid rgba(182,255,122,0.3);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  letter-spacing: 0.1em;
  text-align: right;
  display: none;
}
.flisym-hud .ammo-readout.on { display: block; }

.flisym-hud .score {
  position: absolute;
  top: 14px;
  right: 270px; /* leave room for top-right panel + radar */
  background: rgba(0,0,0,0.5);
  border: 1px solid rgba(182,255,122,0.35);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 11px;
  letter-spacing: 0.2em;
  display: none;
}
.flisym-hud .score.on { display: block; }

.flisym-hud .kill-feed {
  position: absolute;
  top: 110px;
  left: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: none;
  max-width: 320px;
}
.flisym-hud .kill-feed-entry {
  background: rgba(0,0,0,0.55);
  border-left: 2px solid #ff3838;
  padding: 3px 8px;
  font-size: 11px;
  letter-spacing: 0.05em;
  opacity: 1;
  transition: opacity 0.6s ease-out;
}
.flisym-hud .kill-feed-entry.fading { opacity: 0; }

.flisym-hud .death-overlay {
  position: fixed;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(120, 0, 0, 0.4);
  z-index: 90;
  pointer-events: none;
  color: #fff;
  letter-spacing: 0.3em;
  font-size: 28px;
  font-weight: 700;
}
.flisym-hud .death-overlay.on { display: flex; }

.flisym-hud .waypoint-strip {
  position: absolute;
  top: 80px;
  left: 50%;
  transform: translateX(-50%);
  width: 320px;
  background: rgba(0,0,0,0.45);
  border: 1px solid rgba(182,255,122,0.3);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  letter-spacing: 0.15em;
  text-align: center;
  display: none;
}
.flisym-hud .waypoint-strip.on { display: block; }
.flisym-hud .waypoint-strip .dots {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 2px;
}
.flisym-hud .waypoint-strip .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: transparent;
  border: 1px solid rgba(182,255,122,0.65);
}
.flisym-hud .waypoint-strip .dot.done   { background: rgba(182,255,122,0.25); border-color: rgba(182,255,122,0.25); }
.flisym-hud .waypoint-strip .dot.active { background: #ffae00; border-color: #ffae00; }

.flisym-hud .bomb-readout {
  position: absolute;
  right: 14px;
  bottom: 150px;
  background: rgba(0,0,0,0.5);
  border: 1px solid rgba(182,255,122,0.3);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  letter-spacing: 0.15em;
  display: none;
}
.flisym-hud .bomb-readout.on { display: block; }

.flisym-hud .target-list {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  width: 180px;
  max-height: 140px;
  background: rgba(0,0,0,0.5);
  border: 1px solid rgba(182,255,122,0.3);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 10px;
  line-height: 1.4em;
  display: none;
  overflow: hidden;
}
.flisym-hud .target-list.on { display: block; }
.flisym-hud .target-list .row { display: flex; justify-content: space-between; }
.flisym-hud .target-list .row .st-LIVE  { color: #b6ff7a; }
.flisym-hud .target-list .row .st-HIT   { color: #ffae00; }
.flisym-hud .target-list .row .st-DEAD  { color: #888; text-decoration: line-through; }

.flisym-hud .sam-warn {
  position: absolute;
  top: 38%;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(120, 0, 0, 0.7);
  border: 1px solid #ff3838;
  color: #fff;
  padding: 10px 26px;
  letter-spacing: 0.3em;
  font-weight: 700;
  font-size: 16px;
  display: none;
}
.flisym-hud .sam-warn.on { display: block; animation: flisym-stall-blink 0.4s steps(2, start) infinite; }

.flisym-hud .pb-panel {
  position: absolute;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.45);
  border: 1px solid rgba(182,255,122,0.3);
  border-radius: 4px;
  padding: 3px 12px;
  font-size: 11px;
  letter-spacing: 0.2em;
  display: none;
}
.flisym-hud .pb-panel.on { display: block; }

.flisym-hud .ghost-distance {
  position: absolute;
  left: 14px;
  bottom: 14px;
  background: rgba(0,0,0,0.45);
  border: 1px solid rgba(182,255,122,0.3);
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  letter-spacing: 0.15em;
  display: none;
}
.flisym-hud .ghost-distance.on { display: block; }
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
  private readonly elFinishHeadline: HTMLDivElement;

  // v0.2 combat / mission / time-trial elements -----------------------------
  private readonly elModeBadge: HTMLDivElement;
  private readonly elRadar: SVGSVGElement;
  private readonly elRadarContacts: SVGGElement;
  private readonly elGunPipper: HTMLDivElement;
  private readonly elTargetBox: HTMLDivElement;
  private readonly elLockLed: HTMLDivElement;
  private readonly elDamagePanel: HTMLDivElement;
  private readonly elDmgBars: {
    airframe: { row: HTMLDivElement; fill: HTMLElement };
    engine:   { row: HTMLDivElement; fill: HTMLElement };
    aileron:  { row: HTMLDivElement; fill: HTMLElement };
    elevator: { row: HTMLDivElement; fill: HTMLElement };
    rudder:   { row: HTMLDivElement; fill: HTMLElement };
  };
  private readonly elKillFeed: HTMLDivElement;
  private readonly elAmmoReadout: HTMLDivElement;
  private readonly elScore: HTMLDivElement;
  private readonly elDeathOverlay: HTMLDivElement;
  private readonly elWaypointStrip: HTMLDivElement;
  private readonly elWaypointDots: HTMLDivElement;
  private readonly elWaypointLabel: HTMLDivElement;
  private readonly elBombReadout: HTMLDivElement;
  private readonly elTargetList: HTMLDivElement;
  private readonly elSamWarn: HTMLDivElement;
  private readonly elPbPanel: HTMLDivElement;
  private readonly elGhostDistance: HTMLDivElement;

  /** Radar update is throttled to ~10 Hz. */
  private radarLastUpdateMs = 0;
  /** Timer id for clearing SAM warning. */
  private samWarnTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.root.setAttribute('data-testid', 'flisym-hud');
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
      <div class="panel tc" data-h="challenge" data-testid="hud-gates-pass" data-gates-pass="0">
        <span class="title">CHALLENGE</span>
        <div class="stats" data-h="challenge-stats"></div>
      </div>
      <div class="finish-overlay" data-h="finish-overlay">
        <div class="finish-card">
          <div class="headline" data-h="finish-headline">COURSE COMPLETE</div>
          <div class="summary" data-h="finish-summary"></div>
          <div class="hint">Press G to restart</div>
        </div>
      </div>
      <div class="mode-badge" data-h="mode-badge" data-testid="hud-mode-name">FREE FLIGHT</div>
      <div class="score" data-h="score" data-testid="hud-score" data-kills="0" data-deaths="0">K:0 D:0</div>
      <div class="kill-feed" data-h="kill-feed"></div>
      <div class="gun-pipper" data-h="gun-pipper"></div>
      <div class="target-box" data-h="target-box" data-testid="hud-target-box">
        <div class="lock-led" data-h="lock-tone-led"></div>
      </div>
      <div class="ammo-readout" data-h="ammo-readout">GUN 0 · MSL 0/2</div>
      <div class="damage-panel" data-h="damage-panel">
        <div class="damage-row" data-h="dmg-airframe" data-testid="hud-damage-airframe" data-hp="100">
          <span class="label">AIRFRM</span><span class="damage-bar"><i style="width:100%"></i></span>
        </div>
        <div class="damage-row" data-h="dmg-engine" data-testid="hud-damage-engine" data-hp="100">
          <span class="label">ENGINE</span><span class="damage-bar"><i style="width:100%"></i></span>
        </div>
        <div class="damage-row" data-h="dmg-aileron" data-testid="hud-damage-aileron" data-hp="100">
          <span class="label">AILRN</span><span class="damage-bar"><i style="width:100%"></i></span>
        </div>
        <div class="damage-row" data-h="dmg-elevator" data-testid="hud-damage-elevator" data-hp="100">
          <span class="label">ELEVR</span><span class="damage-bar"><i style="width:100%"></i></span>
        </div>
        <div class="damage-row" data-h="dmg-rudder" data-testid="hud-damage-rudder" data-hp="100">
          <span class="label">RUDDR</span><span class="damage-bar"><i style="width:100%"></i></span>
        </div>
      </div>
      <div class="death-overlay" data-h="death-overlay">DESTROYED</div>
      <div class="waypoint-strip" data-h="waypoint-strip" data-testid="hud-waypoints" data-waypoint-count="0" data-current-waypoint="0">
        <div class="dots" data-h="waypoint-dots"></div>
        <div class="label" data-h="waypoint-label">→ WP1 · 0.0 km</div>
      </div>
      <div class="bomb-readout" data-h="bomb-readout" data-testid="hud-bombs" data-bombs-remaining="0" data-bombs-total="0">BOMBS 0/0</div>
      <div class="target-list" data-h="target-list"></div>
      <div class="sam-warn" data-h="sam-warn">MISSILE LAUNCH</div>
      <div class="pb-panel" data-h="pb-panel" data-testid="hud-pb">PB —</div>
      <div class="ghost-distance" data-h="ghost-distance">GHOST 0.0 m</div>
    `;

    // Radar is an SVG — easier to draw range rings + contacts than a canvas.
    const radarSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    radarSvg.setAttribute('class', 'radar');
    radarSvg.setAttribute('data-h', 'radar');
    radarSvg.setAttribute('viewBox', '-120 -120 240 240');
    radarSvg.setAttribute('width', '240');
    radarSvg.setAttribute('height', '240');
    radarSvg.innerHTML =
      '<circle cx="0" cy="0" r="40"  fill="none" stroke="rgba(182,255,122,0.18)" stroke-width="1"/>' +
      '<circle cx="0" cy="0" r="80"  fill="none" stroke="rgba(182,255,122,0.18)" stroke-width="1"/>' +
      '<circle cx="0" cy="0" r="118" fill="none" stroke="rgba(182,255,122,0.30)" stroke-width="1"/>' +
      '<line x1="-120" y1="0" x2="120" y2="0" stroke="rgba(182,255,122,0.12)" stroke-width="0.5"/>' +
      '<line x1="0" y1="-120" x2="0" y2="120" stroke="rgba(182,255,122,0.12)" stroke-width="0.5"/>' +
      '<circle cx="0" cy="0" r="3" fill="#b6ff7a"/>' +
      '<g data-h="radar-contacts"></g>';
    this.root.appendChild(radarSvg);

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
    this.elFinishHeadline = this.q<HTMLDivElement>('finish-headline');

    this.elModeBadge = this.q<HTMLDivElement>('mode-badge');
    this.elRadar = radarSvg;
    this.elRadarContacts = radarSvg.querySelector<SVGGElement>(
      '[data-h="radar-contacts"]',
    )!;
    this.elGunPipper = this.q<HTMLDivElement>('gun-pipper');
    this.elTargetBox = this.q<HTMLDivElement>('target-box');
    this.elLockLed = this.q<HTMLDivElement>('lock-tone-led');
    this.elDamagePanel = this.q<HTMLDivElement>('damage-panel');
    this.elKillFeed = this.q<HTMLDivElement>('kill-feed');
    this.elAmmoReadout = this.q<HTMLDivElement>('ammo-readout');
    this.elScore = this.q<HTMLDivElement>('score');
    this.elDeathOverlay = this.q<HTMLDivElement>('death-overlay');
    this.elWaypointStrip = this.q<HTMLDivElement>('waypoint-strip');
    this.elWaypointDots = this.q<HTMLDivElement>('waypoint-dots');
    this.elWaypointLabel = this.q<HTMLDivElement>('waypoint-label');
    this.elBombReadout = this.q<HTMLDivElement>('bomb-readout');
    this.elTargetList = this.q<HTMLDivElement>('target-list');
    this.elSamWarn = this.q<HTMLDivElement>('sam-warn');
    this.elPbPanel = this.q<HTMLDivElement>('pb-panel');
    this.elGhostDistance = this.q<HTMLDivElement>('ghost-distance');

    this.elDmgBars = {
      airframe: this.dmgPair('dmg-airframe'),
      engine:   this.dmgPair('dmg-engine'),
      aileron:  this.dmgPair('dmg-aileron'),
      elevator: this.dmgPair('dmg-elevator'),
      rudder:   this.dmgPair('dmg-rudder'),
    };

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

  /** Pair (row + fill) lookup for a damage row. */
  private dmgPair(name: string): { row: HTMLDivElement; fill: HTMLElement } {
    const row = this.q<HTMLDivElement>(name);
    const fill = row.querySelector<HTMLElement>('.damage-bar > i');
    if (!fill) throw new Error(`HUD: missing fill in [data-h="${name}"]`);
    return { row, fill };
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
      this.elChallenge.setAttribute('data-gates-pass', '0');
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
    // Playwright fast-read mirror.
    this.elChallenge.setAttribute(
      'data-gates-pass',
      String(state.totalCleared),
    );
  }

  /**
   * Show the end-of-course summary overlay. Optional `headline` replaces
   * the default "COURSE COMPLETE" string (e.g. "NEW PERSONAL BEST" from
   * Time Trial).
   */
  showFinishOverlay(
    time: number,
    missed: number,
    opts?: { headline?: string },
  ): void {
    this.elFinishHeadline.textContent = opts?.headline ?? 'COURSE COMPLETE';
    this.elFinishSummary.textContent =
      `Time ${formatCourseTime(time)} — Missed ${missed} gate${missed === 1 ? '' : 's'}`;
    this.elFinishOverlay.classList.add('on');
  }

  /** Hide the end-of-course summary overlay. */
  hideFinishOverlay(): void {
    this.elFinishOverlay.classList.remove('on');
  }

  // ── v0.2 mode badge ──────────────────────────────────────────────────────

  /** Update the bottom-center mode badge from a `ModeStatus`. */
  setMode(status: ModeStatus): void {
    this.elModeBadge.textContent = status.headline;
    this.elModeBadge.setAttribute('data-mode-id', status.id);
  }

  // ── v0.2 combat overlays ────────────────────────────────────────────────

  /**
   * Push a combat snapshot into the HUD. Passing `null` hides every
   * combat-only panel (radar, damage, pipper, target box, kill-feed,
   * ammo, score, death overlay). The mode calls this every frame; the
   * HUD internally throttles the radar to ~10 Hz.
   */
  setCombat(snapshot: CombatSnapshot | null): void {
    if (snapshot === null) {
      this.elRadar.classList.remove('on');
      this.elDamagePanel.classList.remove('on');
      this.elGunPipper.classList.remove('on');
      this.elTargetBox.classList.remove('on');
      this.elAmmoReadout.classList.remove('on');
      this.elScore.classList.remove('on');
      this.elDeathOverlay.classList.remove('on');
      this.elKillFeed.style.display = 'none';
      return;
    }
    this.elKillFeed.style.display = '';

    // Damage panel.
    this.elDamagePanel.classList.add('on');
    this.applyDamageBar(this.elDmgBars.airframe, snapshot.self.hp.airframe);
    this.applyDamageBar(this.elDmgBars.engine,   snapshot.self.hp.engine);
    this.applyDamageBar(this.elDmgBars.aileron,  snapshot.self.hp.aileron);
    this.applyDamageBar(this.elDmgBars.elevator, snapshot.self.hp.elevator);
    this.applyDamageBar(this.elDmgBars.rudder,   snapshot.self.hp.rudder);

    // Ammo + score.
    const gun = snapshot.self.gunRoundsL + snapshot.self.gunRoundsR;
    const msl = snapshot.self.missileRailsRemaining;
    // De-flicker bullet count: snap to nearest 10.
    const gunDisplay = Math.max(0, Math.floor(gun / 10) * 10);
    this.elAmmoReadout.textContent = `GUN ${gunDisplay} · MSL ${msl}/2`;
    this.elAmmoReadout.classList.add('on');

    this.elScore.textContent = `K:${snapshot.score.kills} D:${snapshot.score.deaths}`;
    this.elScore.setAttribute('data-kills', String(snapshot.score.kills));
    this.elScore.setAttribute('data-deaths', String(snapshot.score.deaths));
    this.elScore.classList.add('on');

    // Death overlay.
    this.elDeathOverlay.classList.toggle('on', !snapshot.self.isAlive);

    // Gun pipper — centre of viewport when alive.
    this.elGunPipper.classList.toggle('on', snapshot.self.isAlive);

    // Target box + lock LED.
    const lock = snapshot.lockState;
    this.elLockLed.classList.remove('seeking', 'locked');
    if (lock === 'seeking') this.elLockLed.classList.add('seeking');
    else if (lock === 'locked') this.elLockLed.classList.add('locked');

    if (snapshot.targetBox && snapshot.targetBox.onScreen) {
      this.elTargetBox.classList.add('on');
      this.elTargetBox.style.left = `${snapshot.targetBox.cx}px`;
      this.elTargetBox.style.top = `${snapshot.targetBox.cy}px`;
      this.elTargetBox.style.width = `${snapshot.targetBox.size}px`;
      this.elTargetBox.style.height = `${snapshot.targetBox.size}px`;
      this.elTargetBox.style.marginLeft = `${-snapshot.targetBox.size / 2}px`;
      this.elTargetBox.style.marginTop = `${-snapshot.targetBox.size / 2}px`;
      // Pipper turns hot when target is within ~24 px of screen centre.
      const cw = window.innerWidth / 2;
      const ch = window.innerHeight / 2;
      const dx = snapshot.targetBox.cx - cw;
      const dy = snapshot.targetBox.cy - ch;
      const hot = dx * dx + dy * dy < 24 * 24;
      this.elGunPipper.classList.toggle('hot', hot);
    } else {
      this.elTargetBox.classList.remove('on');
      this.elGunPipper.classList.remove('hot');
    }

    // Radar — throttled to ~10 Hz to keep DOM churn bounded.
    this.elRadar.classList.add('on');
    const now = typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
    if (now - this.radarLastUpdateMs >= 100) {
      this.radarLastUpdateMs = now;
      this.renderRadar(snapshot);
    }
  }

  /** Apply hp value to one bar: width % + colour bucket + data-hp mirror. */
  private applyDamageBar(
    pair: { row: HTMLDivElement; fill: HTMLElement },
    hp: number,
  ): void {
    const clamped = Math.max(0, Math.min(100, hp));
    pair.fill.style.width = `${clamped}%`;
    const bar = pair.fill.parentElement!;
    bar.classList.remove('amber', 'red');
    if (clamped < 30) bar.classList.add('red');
    else if (clamped < 60) bar.classList.add('amber');
    pair.row.setAttribute('data-hp', String(Math.round(clamped)));
  }

  /** Re-render radar contacts as red/blue triangles. 20 km full range. */
  private renderRadar(snapshot: CombatSnapshot): void {
    const RANGE_M = 20_000; // 20 km full radar radius
    const R_PX = 118;
    // Rebuild the contact `<g>`. Cheap — at most a dozen contacts.
    let svg = '';
    for (const c of snapshot.radarContacts) {
      // Body +X = forward = "up" on the radar. +Z = right = right on the radar.
      const px = (c.relZ / RANGE_M) * R_PX;
      const py = -(c.relX / RANGE_M) * R_PX;
      if (Math.abs(px) > R_PX || Math.abs(py) > R_PX) continue;
      const fill = c.hostile ? '#ff3838' : '#5fa8ff';
      // Up-pointing triangle of side ~6 px.
      svg += `<polygon points="${px.toFixed(1)},${(py - 4).toFixed(1)} ${(px - 3).toFixed(1)},${(py + 3).toFixed(1)} ${(px + 3).toFixed(1)},${(py + 3).toFixed(1)}" fill="${fill}"/>`;
    }
    this.elRadarContacts.innerHTML = svg;
  }

  /** Append one row to the kill feed; auto-fades after 5 s, max 4 visible. */
  addKillFeedRow(line: string): void {
    const row = document.createElement('div');
    row.className = 'kill-feed-entry';
    row.setAttribute('data-testid', 'hud-kill-feed-entry');
    row.textContent = line;
    this.elKillFeed.appendChild(row);
    // Cap visible rows.
    while (this.elKillFeed.childElementCount > 4) {
      this.elKillFeed.firstElementChild?.remove();
    }
    // Fade then remove after 5 s.
    setTimeout(() => row.classList.add('fading'), 4_400);
    setTimeout(() => row.remove(), 5_000);
  }

  /** Trigger the SAM-launch warning banner (3 s). Re-callable to refresh. */
  showSamWarning(): void {
    this.elSamWarn.classList.add('on');
    if (this.samWarnTimer !== null) clearTimeout(this.samWarnTimer);
    this.samWarnTimer = setTimeout(() => {
      this.elSamWarn.classList.remove('on');
      this.samWarnTimer = null;
    }, 3000);
  }

  // ── v0.2 mission overlays ──────────────────────────────────────────────

  /**
   * Set strike-mission HUD state. Pass `null` to hide every mission-only
   * panel (waypoint strip, bombs, target list).
   */
  setMission(state: MissionHudState | null): void {
    if (state === null) {
      this.elWaypointStrip.classList.remove('on');
      this.elBombReadout.classList.remove('on');
      this.elTargetList.classList.remove('on');
      return;
    }

    // Waypoint strip dots + label.
    let dots = '';
    for (let i = 0; i < state.waypoints.length; i += 1) {
      const cls =
        i < state.currentWaypoint ? 'dot done'
        : i === state.currentWaypoint ? 'dot active'
        : 'dot';
      dots += `<span class="${cls}"></span>`;
    }
    this.elWaypointDots.innerHTML = dots;
    const active = state.waypoints[state.currentWaypoint];
    const km = active ? active.distanceKm : 0;
    this.elWaypointLabel.textContent =
      `→ WP${state.currentWaypoint + 1} · ${km.toFixed(1)} km`;
    this.elWaypointStrip.classList.add('on');
    this.elWaypointStrip.setAttribute(
      'data-waypoint-count',
      String(state.waypoints.length),
    );
    this.elWaypointStrip.setAttribute(
      'data-current-waypoint',
      String(state.currentWaypoint),
    );

    // Bomb readout.
    this.elBombReadout.textContent =
      `BOMBS ${state.bombsRemaining}/${state.bombsTotal}`;
    this.elBombReadout.setAttribute(
      'data-bombs-remaining',
      String(state.bombsRemaining),
    );
    this.elBombReadout.setAttribute(
      'data-bombs-total',
      String(state.bombsTotal),
    );
    this.elBombReadout.classList.add('on');

    // Target list (5 Hz-ish, but cheap enough to redraw per frame).
    let listHtml = '';
    for (const t of state.targets) {
      listHtml += `<div class="row"><span class="id">${t.id}</span><span class="st-${t.status}">${t.status}</span></div>`;
    }
    this.elTargetList.innerHTML = listHtml;
    this.elTargetList.classList.add('on');
  }

  // ── v0.2 time-trial overlays ───────────────────────────────────────────

  /**
   * Set time-trial HUD state. Pass `null` to hide PB + ghost-distance
   * panels (e.g. when leaving Time Trial mode).
   */
  setTimeTrial(state: TimeTrialHudState | null): void {
    if (state === null) {
      this.elPbPanel.classList.remove('on');
      this.elGhostDistance.classList.remove('on');
      return;
    }
    this.elPbPanel.textContent =
      state.personalBest === null
        ? 'PB —'
        : `PB ${formatCourseTime(state.personalBest)}`;
    this.elPbPanel.classList.add('on');

    if (state.ghostDeltaMeters === null) {
      this.elGhostDistance.classList.remove('on');
    } else {
      const sign = state.ghostDeltaMeters >= 0 ? '+' : '−';
      const abs = Math.abs(state.ghostDeltaMeters);
      this.elGhostDistance.textContent = `GHOST ${sign}${abs.toFixed(1)} m`;
      this.elGhostDistance.classList.add('on');
    }
  }

  /** Remove the HUD root from the DOM. */
  dispose(): void {
    if (this.samWarnTimer !== null) {
      clearTimeout(this.samWarnTimer);
      this.samWarnTimer = null;
    }
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
