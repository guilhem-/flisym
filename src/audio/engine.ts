/**
 * EngineSound — synthesized engine + stall horn via the Web Audio API.
 *
 * Engine voice:
 *   - main triangle oscillator, pitch from RPM (200..2400 → 60..400 Hz)
 *   - sub-bass triangle at 40 Hz for body
 *   - mixed into a WaveShaper (soft saturation) → LowPass (~1.2 kHz) → master gain
 *   - master gain proportional to throttle (0..1 → 0..0.3)
 *
 * Stall horn:
 *   - 1000 Hz square at 0.05 gain, pulsed 250 ms on / 250 ms off when active.
 *
 * AudioContext is created lazily in `start()` — must be invoked from a user
 * gesture handler (browser autoplay policy).
 */

const RPM_MIN = 200;
const RPM_MAX = 2400;
const FREQ_MIN = 60;
const FREQ_MAX = 400;
const THROTTLE_GAIN_MAX = 0.3;

const HORN_FREQ_HZ = 1000;
const HORN_GAIN = 0.05;
const HORN_PULSE_S = 0.25;

export class EngineSound {
  private ctx: AudioContext | null = null;

  // Engine chain (we only need to mutate mainOsc.frequency and master.gain
  // after start; the other nodes stay live but unreferenced).
  private mainOsc: OscillatorNode | null = null;
  private master: GainNode | null = null;

  // Stall horn chain
  private hornGain: GainNode | null = null;

  // Pulse driver state for the horn (uses real-time clock).
  private hornActive = false;
  private hornPhaseStart = 0;

  /**
   * Lazily build the audio graph. Safe to call multiple times — subsequent
   * calls are no-ops. MUST be invoked from a user-gesture handler.
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

    // --- Engine chain -------------------------------------------------------
    const master = ctx.createGain();
    master.gain.value = 0;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1200;
    lowpass.Q.value = 0.7;

    const shaper = ctx.createWaveShaper();
    // Build the curve into a fresh ArrayBuffer-backed Float32Array so it is
    // assignable to WaveShaperNode.curve regardless of TS lib variants.
    const curveBuf = new ArrayBuffer(1024 * 4);
    const curve = new Float32Array(curveBuf);
    fillSaturationCurve(curve, 2.5);
    shaper.curve = curve;
    shaper.oversample = '2x';

    const engineMix = ctx.createGain();
    engineMix.gain.value = 0.7;

    const mainOsc = ctx.createOscillator();
    mainOsc.type = 'triangle';
    mainOsc.frequency.value = FREQ_MIN;

    const subOsc = ctx.createOscillator();
    subOsc.type = 'triangle';
    subOsc.frequency.value = 40;

    mainOsc.connect(engineMix);
    subOsc.connect(engineMix);
    engineMix.connect(shaper);
    shaper.connect(lowpass);
    lowpass.connect(master);
    master.connect(ctx.destination);

    mainOsc.start();
    subOsc.start();

    // --- Stall horn chain ---------------------------------------------------
    const hornGain = ctx.createGain();
    hornGain.gain.value = 0;

    const hornOsc = ctx.createOscillator();
    hornOsc.type = 'square';
    hornOsc.frequency.value = HORN_FREQ_HZ;
    hornOsc.connect(hornGain);
    hornGain.connect(ctx.destination);
    hornOsc.start();

    this.master = master;
    this.mainOsc = mainOsc;
    this.hornGain = hornGain;
    this.hornPhaseStart = ctx.currentTime;
    // Reference the rest so linters don't flag them; they remain live in the
    // graph and audible regardless.
    void engineMix;
    void shaper;
    void lowpass;
    void subOsc;
    void hornOsc;
  }

  /**
   * Per-frame update. Pass throttle in [0..1], propeller RPM, and stall flag.
   * No-op if `start()` hasn't been called yet.
   */
  update(throttle: number, rpm: number, stall: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.mainOsc || !this.hornGain) return;

    const t = ctx.currentTime;
    const rampTo = t + 0.05;

    // Map RPM (clamped) → frequency.
    const rpmClamped = clamp(rpm, RPM_MIN, RPM_MAX);
    const freq = mapRange(rpmClamped, RPM_MIN, RPM_MAX, FREQ_MIN, FREQ_MAX);
    this.mainOsc.frequency.linearRampToValueAtTime(freq, rampTo);

    // Master gain ∝ throttle.
    const g = clamp(throttle, 0, 1) * THROTTLE_GAIN_MAX;
    this.master.gain.linearRampToValueAtTime(g, rampTo);

    // Stall horn pulse: 250 ms on / 250 ms off while stall flag is active.
    this.updateHornPulse(stall, t);
  }

  private updateHornPulse(stall: boolean, now: number): void {
    if (!this.hornGain) return;
    if (stall && !this.hornActive) {
      this.hornActive = true;
      this.hornPhaseStart = now;
    } else if (!stall && this.hornActive) {
      this.hornActive = false;
      this.hornGain.gain.cancelScheduledValues(now);
      this.hornGain.gain.setTargetAtTime(0, now, 0.01);
      return;
    }

    if (!this.hornActive) return;

    const cycle = HORN_PULSE_S * 2;
    const phase = (now - this.hornPhaseStart) % cycle;
    const target = phase < HORN_PULSE_S ? HORN_GAIN : 0;
    this.hornGain.gain.setTargetAtTime(target, now, 0.01);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function mapRange(
  x: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (inMax === inMin) return outMin;
  const t = (x - inMin) / (inMax - inMin);
  return outMin + t * (outMax - outMin);
}

/**
 * Fill a soft tanh-like saturation curve for the WaveShaper. Higher
 * `amount` = more harmonic distortion ("dirtier" engine).
 */
function fillSaturationCurve(curve: Float32Array, amount: number): void {
  const N = curve.length;
  for (let i = 0; i < N; i += 1) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = Math.tanh(amount * x);
  }
}
