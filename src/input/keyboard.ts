// Keyboard input → Controls. See physics-spec §9.
//
// Convention reminder: forward stick (W) = nose down → elevatorCmd = -1.
// Surface commands are produced as TARGETS in [-1..1]; the physics
// `updateControlSurfaces` slews the actual deflections at 4.0/s and
// self-centers at 3.0/s when no key is held. We mirror that self-centering
// here on the COMMAND so the command itself relaxes when the pilot lets go.

import type { Controls } from '../physics/state.js';

const COMMAND_RAMP_RATE = 4.0; // /s — how fast a held key drives the cmd to ±1
const COMMAND_CENTER_RATE = 3.0; // /s — how fast cmd relaxes to 0 on release

const FLAP_DETENTS = [0, 0.5, 1] as const;

// Keys we own and must not let the browser act on (scroll, etc.).
const GAME_KEYS = new Set<string>([
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  ' ', // space — could trigger page scroll
  'pageup',
  'pagedown',
  'home',
  'end',
]);

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Drive `current` toward `target` at `rampRate` /s. If `target === 0`,
 * relax toward 0 at `centerRate` /s instead (self-centering on release).
 */
function approach(
  current: number,
  target: number,
  dt: number,
  rampRate: number,
  centerRate: number,
): number {
  if (target === 0) {
    const step = centerRate * dt;
    if (current > step) return current - step;
    if (current < -step) return current + step;
    return 0;
  }
  const delta = target - current;
  const step = rampRate * dt;
  if (delta > step) return current + step;
  if (delta < -step) return current - step;
  return target;
}

export class KeyboardInput {
  private readonly pressed = new Set<string>();
  private flapIndex = 0;
  private boundKeyDown = (e: KeyboardEvent): void => this.onKeyDown(e);
  private boundKeyUp = (e: KeyboardEvent): void => this.onKeyUp(e);

  constructor() {
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Normalize to a stable lowercase key id (e.g. "w", "arrowup", "shift").
    const k = e.key.toLowerCase();

    // Suppress the browser's default action for game-relevant keys: arrow
    // keys would otherwise scroll the page (or the canvas / focused element)
    // and we'd never see the held-state for pitch/roll input.
    if (GAME_KEYS.has(k)) e.preventDefault();

    // Discrete actions trigger only on the leading edge (no autorepeat).
    if (!e.repeat) {
      if (k === 'f') {
        this.cycleFlaps(e.shiftKey);
      } else if (k === 'b') {
        this.pendingBrakeToggle = true;
      } else if (k === 'v') {
        window.dispatchEvent(new CustomEvent('camera:cycle'));
      } else if (k === 'g') {
        window.dispatchEvent(new CustomEvent('challenge:reset'));
      } else if (k.length === 1 && k >= '0' && k <= '9') {
        this.dispatchTimePreset(k);
      }
    }

    // Track held state for continuous controls.
    this.pressed.add(k);
  }

  private onKeyUp(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if (GAME_KEYS.has(k)) e.preventDefault();
    this.pressed.delete(k);
  }

  private pendingBrakeToggle = false;

  private cycleFlaps(reverse: boolean): void {
    const n = FLAP_DETENTS.length;
    this.flapIndex = reverse
      ? (this.flapIndex - 1 + n) % n
      : (this.flapIndex + 1) % n;
  }

  private dispatchTimePreset(digit: string): void {
    // 1 → 05:00, 2 → 07:00, ..., 9 → 21:00, 0 → 23:00
    let hour: number;
    if (digit === '0') {
      hour = 23;
    } else {
      const i = Number(digit); // 1..9
      hour = 5 + (i - 1) * 2;
    }
    window.dispatchEvent(new CustomEvent('time:set', { detail: hour }));
  }

  /** Mutates `controls` in place. Call once per frame BEFORE the physics step. */
  update(dt: number, controls: Controls): void {
    const held = (k: string): boolean => this.pressed.has(k);

    // --- Elevator: W or Down arrow → nose down (-1); S or Up arrow → nose up (+1).
    let elevatorTarget = 0;
    if (held('w') || held('arrowdown')) elevatorTarget -= 1;
    if (held('s') || held('arrowup')) elevatorTarget += 1;
    controls.elevatorCmd = approach(
      controls.elevatorCmd,
      elevatorTarget,
      dt,
      COMMAND_RAMP_RATE,
      COMMAND_CENTER_RATE,
    );

    // --- Aileron: A or Left → roll left (-1); D or Right → roll right (+1).
    let aileronTarget = 0;
    if (held('a') || held('arrowleft')) aileronTarget -= 1;
    if (held('d') || held('arrowright')) aileronTarget += 1;
    controls.aileronCmd = approach(
      controls.aileronCmd,
      aileronTarget,
      dt,
      COMMAND_RAMP_RATE,
      COMMAND_CENTER_RATE,
    );

    // --- Rudder: Q → yaw left (-1); E → yaw right (+1).
    let rudderTarget = 0;
    if (held('q')) rudderTarget -= 1;
    if (held('e')) rudderTarget += 1;
    controls.rudderCmd = approach(
      controls.rudderCmd,
      rudderTarget,
      dt,
      COMMAND_RAMP_RATE,
      COMMAND_CENTER_RATE,
    );

    // --- Throttle: Shift / PageUp = +0.5/s, Ctrl / PageDown = -0.5/s.
    //     Clamp [0,1]. No self-center.
    if (held('shift') || held('pageup')) controls.throttleCmd += 0.5 * dt;
    if (held('control') || held('pagedown')) controls.throttleCmd -= 0.5 * dt;
    controls.throttleCmd = clamp(controls.throttleCmd, 0, 1);

    // --- Flaps: discrete detents driven by keydown handler.
    controls.flapsCmd = FLAP_DETENTS[this.flapIndex] ?? 0;

    // --- Brake: toggle on B keydown (consume the pending edge).
    if (this.pendingBrakeToggle) {
      controls.brake = !controls.brake;
      this.pendingBrakeToggle = false;
    }
  }
}
