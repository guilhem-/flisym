/**
 * CombatAudio — synthesized lock-tone and SAM warning via the Web Audio API.
 *
 * Mirrors the `src/audio/engine.ts` pattern: the AudioContext is built lazily
 * on the first `start()` call (which must come from a user gesture per the
 * browser autoplay policy). All public methods are idempotent — calling
 * `playLockSeeking()` while the seeking tone is already audible is a no-op,
 * and re-calling `stopLockTone()` is harmless.
 *
 * Voices:
 *   - lock-seeking: 1000 Hz sine, gain 0.04, pulsed 4 Hz (125 ms on / 125 ms
 *     off). Sync rhythm matches the HUD lock-LED's `.seeking` 4 Hz blink.
 *   - lock-locked: continuous 1200 Hz sine, gain 0.05. Matches the steady
 *     `.locked` LED.
 *   - sam-warning: descending two-tone 800 Hz → 500 Hz over 600 ms (frequency
 *     ramp on a one-shot oscillator) at gain 0.06. Auto-cleans up.
 */

const SEEKING_FREQ_HZ = 1000;
const SEEKING_GAIN = 0.04;
const SEEKING_PULSE_S = 0.125; // 4 Hz = 250 ms cycle → 125 ms on, 125 ms off.

const LOCKED_FREQ_HZ = 1200;
const LOCKED_GAIN = 0.05;

const SAM_GAIN = 0.06;
const SAM_F0 = 800;
const SAM_F1 = 500;
const SAM_DURATION_S = 0.6;

type LockMode = 'off' | 'seeking' | 'locked';

export class CombatAudio {
  private ctx: AudioContext | null = null;

  /** Shared lock-tone oscillator (lives for the audio context's lifetime). */
  private lockOsc: OscillatorNode | null = null;
  /** Gain stage for the lock tone — modulated to produce pulse + tone shifts. */
  private lockGain: GainNode | null = null;

  /** Current lock state — used to make the public methods idempotent. */
  private lockMode: LockMode = 'off';

  /** Real-time clock anchor for the seeking pulse driver. */
  private seekingPhaseStart = 0;
  /** Animation-frame loop handle; only running while seeking is active. */
  private rafHandle: number | null = null;

  /**
   * Lazily initialize the AudioContext + oscillator graph. Safe to call
   * multiple times — subsequent calls are no-ops. MUST be invoked from a
   * user-gesture handler.
   */
  start(): void {
    if (this.ctx) return;
    const Ctor: typeof AudioContext | undefined =
      (typeof window !== 'undefined' && window.AudioContext) ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (typeof window !== 'undefined' && (window as any).webkitAudioContext) ||
      undefined;
    if (!Ctor) return;

    const ctx = new Ctor();
    this.ctx = ctx;

    const lockGain = ctx.createGain();
    lockGain.gain.value = 0;

    const lockOsc = ctx.createOscillator();
    lockOsc.type = 'sine';
    lockOsc.frequency.value = SEEKING_FREQ_HZ;
    lockOsc.connect(lockGain);
    lockGain.connect(ctx.destination);
    lockOsc.start();

    this.lockOsc = lockOsc;
    this.lockGain = lockGain;
    this.seekingPhaseStart = ctx.currentTime;
  }

  /** Begin (or keep) the 4 Hz seeking beep. Idempotent. */
  playLockSeeking(): void {
    this.start();
    if (!this.ctx || !this.lockOsc || !this.lockGain) return;
    if (this.lockMode === 'seeking') return;
    this.lockMode = 'seeking';
    const now = this.ctx.currentTime;
    this.lockOsc.frequency.setTargetAtTime(SEEKING_FREQ_HZ, now, 0.01);
    this.lockGain.gain.cancelScheduledValues(now);
    this.lockGain.gain.setTargetAtTime(0, now, 0.005);
    this.seekingPhaseStart = now;
    this.ensurePulseLoop();
  }

  /** Engage continuous locked tone. Idempotent. */
  playLockSolid(): void {
    this.start();
    if (!this.ctx || !this.lockOsc || !this.lockGain) return;
    if (this.lockMode === 'locked') return;
    this.lockMode = 'locked';
    const now = this.ctx.currentTime;
    this.stopPulseLoop();
    this.lockOsc.frequency.cancelScheduledValues(now);
    this.lockOsc.frequency.setTargetAtTime(LOCKED_FREQ_HZ, now, 0.01);
    this.lockGain.gain.cancelScheduledValues(now);
    this.lockGain.gain.setTargetAtTime(LOCKED_GAIN, now, 0.01);
  }

  /** Silence whichever lock tone is playing. Idempotent. */
  stopLockTone(): void {
    if (this.lockMode === 'off') return;
    this.lockMode = 'off';
    this.stopPulseLoop();
    if (!this.ctx || !this.lockGain) return;
    const now = this.ctx.currentTime;
    this.lockGain.gain.cancelScheduledValues(now);
    this.lockGain.gain.setTargetAtTime(0, now, 0.02);
  }

  /**
   * Fire a one-shot descending two-tone SAM-launch warning. Spawns a fresh
   * oscillator + gain node and disconnects them on completion so concurrent
   * launches don't interfere with the lock-tone voice.
   */
  playSamWarning(): void {
    this.start();
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(ctx.destination);

    const t0 = ctx.currentTime;
    const tEnd = t0 + SAM_DURATION_S;
    osc.frequency.setValueAtTime(SAM_F0, t0);
    osc.frequency.linearRampToValueAtTime(SAM_F1, tEnd);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(SAM_GAIN, t0 + 0.03);
    gain.gain.setTargetAtTime(0, tEnd - 0.1, 0.05);

    osc.start(t0);
    osc.stop(tEnd + 0.2);
    osc.onended = (): void => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* already disconnected */
      }
    };
  }

  /**
   * Tear down the audio graph (for tests / dev hot-reload). After dispose
   * the next public-method call will re-create the context.
   */
  dispose(): void {
    this.stopPulseLoop();
    this.lockMode = 'off';
    try {
      this.lockOsc?.stop();
    } catch {
      /* already stopped */
    }
    this.lockOsc?.disconnect();
    this.lockGain?.disconnect();
    this.lockOsc = null;
    this.lockGain = null;
    if (this.ctx && typeof this.ctx.close === 'function') {
      // close() returns a promise; ignore.
      void this.ctx.close().catch(() => {
        /* swallow */
      });
    }
    this.ctx = null;
  }

  // ── Pulse driver for seeking mode ───────────────────────────────────────
  private ensurePulseLoop(): void {
    if (this.rafHandle !== null) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      // Non-browser host (vitest in Node) — just hold the gain at the
      // seeking level. The pulse is purely cosmetic; tests don't validate it.
      if (this.ctx && this.lockGain) {
        const now = this.ctx.currentTime;
        this.lockGain.gain.setTargetAtTime(SEEKING_GAIN, now, 0.01);
      }
      return;
    }
    const tick = (): void => {
      if (this.lockMode !== 'seeking' || !this.ctx || !this.lockGain) {
        this.rafHandle = null;
        return;
      }
      const now = this.ctx.currentTime;
      const cycle = SEEKING_PULSE_S * 2;
      const phase = (now - this.seekingPhaseStart) % cycle;
      const target = phase < SEEKING_PULSE_S ? SEEKING_GAIN : 0;
      this.lockGain.gain.setTargetAtTime(target, now, 0.005);
      this.rafHandle = window.requestAnimationFrame(tick);
    };
    this.rafHandle = window.requestAnimationFrame(tick);
  }

  private stopPulseLoop(): void {
    if (this.rafHandle !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(this.rafHandle);
    }
    this.rafHandle = null;
  }
}
