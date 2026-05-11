// ModeSwitcher: owns the active mode instance and drives its lifecycle.
//
// The switcher is intentionally dumb. `setMode(id)` disposes the previous
// mode (if any) and initialises the new one with the same `ModeContext`.
// `update` and `status` forward to the current mode; both throw when no
// mode is active so callers can't silently no-op a missing init.

import { MODE_REGISTRY, type ModeId } from './registry.js';
import type { Mode, ModeContext, ModeStatus } from './types.js';

export class ModeSwitcher {
  private current: Mode | null = null;
  private readonly ctx: ModeContext;

  constructor(ctx: ModeContext) {
    this.ctx = ctx;
  }

  /** Active mode, or null before the first `setMode` call. */
  getCurrent(): Mode | null {
    return this.current;
  }

  /**
   * Replace the active mode. Disposes the previous mode before initializing
   * the next one. Throws synchronously if the id is unknown or the factory
   * throws (e.g. unimplemented Dogfight / Strike Mission slots).
   */
  setMode(id: ModeId): void {
    const factory = MODE_REGISTRY.get(id);
    if (!factory) {
      throw new Error(`ModeSwitcher: unknown mode id "${id}"`);
    }
    if (this.current) {
      this.current.dispose();
      this.current = null;
    }
    const next = factory();
    next.init(this.ctx);
    this.current = next;
  }

  /** Per-frame tick. Forwards to the active mode. */
  update(dt: number): void {
    if (!this.current) {
      throw new Error('ModeSwitcher: update() called before setMode()');
    }
    this.current.update(dt, this.ctx);
  }

  /** Cheap snapshot for HUD + tests. */
  status(): ModeStatus {
    if (!this.current) {
      throw new Error('ModeSwitcher: status() called before setMode()');
    }
    return this.current.status();
  }

  /** Tear down the active mode (if any). Idempotent. */
  dispose(): void {
    if (this.current) {
      this.current.dispose();
      this.current = null;
    }
  }
}
