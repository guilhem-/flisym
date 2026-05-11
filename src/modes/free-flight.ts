// Free Flight — sandbox mode. v0.1 experience preserved.
//
// Spec: docs/modes/free-flight.md.
// - No win/lose conditions.
// - Score = airborne seconds (integer).
// - Headline = "FREE FLIGHT — hh:mm" of airborne time, or
//   "FREE FLIGHT — on ground" when on ground.
// - Adds no scene meshes, no extra HUD elements. Hides challenge panel +
//   finish overlay on init.

import type { Mode, ModeContext, ModeMeta, ModeStatus } from './types.js';

const META: ModeMeta = {
  id: 'free-flight',
  displayName: 'Free Flight',
  description: 'Sandbox flying — no clock, no threats. Take off, sightsee, land.',
};

function formatHhMm(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(safe);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total - h * 3600) / 60);
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${hh}:${mm}`;
}

export class FreeFlightMode implements Mode {
  readonly meta: ModeMeta = META;

  private ctx: ModeContext | null = null;
  private airborneSeconds = 0;
  private wasOnGround = true;

  init(ctx: ModeContext): void {
    this.ctx = ctx;
    this.airborneSeconds = 0;
    this.wasOnGround = ctx.playerState.onGround;

    // Hide v0.1 challenge panel + finish overlay — Free Flight owns neither.
    ctx.hud.setChallenge(null);
    ctx.hud.hideFinishOverlay();

    ctx.emit({ type: 'mode_started', mode: META.id, t: ctx.playerState.time });
  }

  update(dt: number, ctx: ModeContext): void {
    if (!ctx.playerState.onGround) {
      this.airborneSeconds += dt;
    }
    this.wasOnGround = ctx.playerState.onGround;
  }

  status(): ModeStatus {
    const ctx = this.ctx;
    const onGround = ctx ? ctx.playerState.onGround : this.wasOnGround;
    const headline = onGround
      ? 'FREE FLIGHT — on ground'
      : `FREE FLIGHT — ${formatHhMm(this.airborneSeconds)}`;
    return {
      id: META.id,
      won: false,
      lost: false,
      score: Math.floor(this.airborneSeconds),
      headline,
    };
  }

  dispose(): void {
    const ctx = this.ctx;
    if (ctx) {
      ctx.emit({
        type: 'mode_ended',
        mode: META.id,
        t: ctx.playerState.time,
        won: false,
        score: Math.floor(this.airborneSeconds),
      });
    }
    this.ctx = null;
    this.airborneSeconds = 0;
    this.wasOnGround = true;
  }
}
