// Help overlay shown on H or ? — pauses the sim and lists controls.
//
// Self-contained DOM component. The host (main.ts) is responsible for
// appending `root` to the document, toggling visibility via show/hide,
// and gating the physics step on `isOpen()`. Wiring keys (h/?/Escape) is
// the host's job too so the overlay stays passive.

import type { ModeStatus } from '../modes/index.js';

const HELP_CSS = `
.flisym-help {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.78);
  color: #b6ff7a;
  font-family: 'Consolas', 'Menlo', 'DejaVu Sans Mono', monospace;
  z-index: 100;
  display: none;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  user-select: none;
}
.flisym-help.on { display: flex; }
.flisym-help .card {
  background: rgba(8, 16, 24, 0.95);
  border: 1px solid rgba(182, 255, 122, 0.4);
  border-radius: 8px;
  padding: 22px 28px;
  min-width: 460px;
  max-width: 720px;
  max-height: 88vh;
  overflow-y: auto;
  box-shadow: 0 0 24px rgba(0, 0, 0, 0.6);
}
.flisym-help h1 {
  margin: 0 0 4px 0;
  font-size: 18px;
  letter-spacing: 0.05em;
  color: #d8ffb0;
}
.flisym-help .subtitle {
  font-size: 12px;
  opacity: 0.7;
  margin-bottom: 14px;
}
.flisym-help h2 {
  margin: 14px 0 6px 0;
  font-size: 13px;
  letter-spacing: 0.06em;
  color: #ffd23a;
  text-transform: uppercase;
  border-bottom: 1px solid rgba(255, 210, 58, 0.25);
  padding-bottom: 2px;
}
.flisym-help .grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 14px;
  row-gap: 3px;
  font-size: 13px;
}
.flisym-help .key {
  background: rgba(182, 255, 122, 0.14);
  border: 1px solid rgba(182, 255, 122, 0.35);
  border-radius: 3px;
  padding: 1px 6px;
  font-weight: 600;
  color: #d8ffb0;
  white-space: nowrap;
}
.flisym-help .desc { opacity: 0.92; }
.flisym-help .foot {
  margin-top: 18px;
  font-size: 12px;
  opacity: 0.65;
  text-align: center;
}
`;

interface KeyRow {
  keys: string[];
  desc: string;
}

const FLIGHT_CONTROLS: KeyRow[] = [
  { keys: ['W', '↑'], desc: 'Pitch down (stick forward)' },
  { keys: ['S', '↓'], desc: 'Pitch up (stick back)' },
  { keys: ['A', '←'], desc: 'Roll left' },
  { keys: ['D', '→'], desc: 'Roll right' },
  { keys: ['Q'], desc: 'Yaw left (rudder)' },
  { keys: ['E'], desc: 'Yaw right (rudder)' },
  { keys: ['Shift', 'PgUp'], desc: 'Throttle up' },
  { keys: ['Ctrl', 'PgDn'], desc: 'Throttle down' },
  { keys: ['F'], desc: 'Flaps next detent (Shift+F = previous)' },
  { keys: ['B'], desc: 'Toggle parking brake' },
];

const GENERAL_CONTROLS: KeyRow[] = [
  { keys: ['V'], desc: 'Cycle camera (cockpit / chase / free)' },
  { keys: ['G'], desc: 'Reset gate course' },
  { keys: ['M'], desc: 'Connect to multiplayer relay' },
  { keys: ['5-9', '0'], desc: 'Time-of-day preset (5 = 13:00 … 9 = 21:00, 0 = 23:00)' },
  { keys: ['H', '?'], desc: 'Toggle this help (Esc closes)' },
];

const MODE_HOTKEYS: KeyRow[] = [
  { keys: ['1'], desc: 'Free Flight' },
  { keys: ['2'], desc: 'Time Trial' },
  { keys: ['3'], desc: 'Dogfight' },
  { keys: ['4'], desc: 'Strike Mission' },
];

const MODE_SPECIFIC: Record<string, KeyRow[]> = {
  'free-flight': [],
  'time-trial': [
    { keys: ['G'], desc: 'Reset gate course / personal-best run' },
  ],
  dogfight: [
    { keys: ['Space'], desc: 'Fire guns (hold)' },
    { keys: ['X'], desc: 'Fire heat-seeking missile' },
    { keys: ['T'], desc: 'Cycle target' },
    { keys: ['L'], desc: 'Refresh missile lock' },
    { keys: ['R'], desc: 'Request respawn (after death)' },
  ],
  'strike-mission': [
    { keys: ['Space'], desc: 'Drop bomb' },
  ],
};

const MODE_DISPLAY_NAMES: Record<string, string> = {
  'free-flight': 'Free Flight',
  'time-trial': 'Time Trial',
  dogfight: 'Dogfight',
  'strike-mission': 'Strike Mission',
};

function renderGrid(rows: KeyRow[]): string {
  if (rows.length === 0) {
    return `<div class="desc" style="opacity:0.55;">(none)</div>`;
  }
  return rows
    .map(
      (r) =>
        `<span>${r.keys.map((k) => `<span class="key">${k}</span>`).join(' ')}</span>` +
        `<span class="desc">${r.desc}</span>`,
    )
    .join('');
}

export class HelpOverlay {
  public readonly root: HTMLElement;
  private open = false;
  private currentModeId: ModeStatus['id'] | null = null;

  constructor() {
    if (typeof document === 'undefined') {
      // Defensive — non-DOM hosts get a stub element they never see.
      this.root = {} as HTMLElement;
      return;
    }
    if (!document.getElementById('flisym-help-style')) {
      const style = document.createElement('style');
      style.id = 'flisym-help-style';
      style.textContent = HELP_CSS;
      document.head.appendChild(style);
    }
    this.root = document.createElement('div');
    this.root.className = 'flisym-help';
    this.root.setAttribute('data-testid', 'flisym-help');
    this.render();
  }

  /** Show the overlay; mode id drives the mode-specific keys section. */
  show(status: ModeStatus): void {
    this.currentModeId = status.id;
    this.render();
    this.root.classList.add('on');
    this.open = true;
  }

  hide(): void {
    this.root.classList.remove('on');
    this.open = false;
  }

  toggle(status: ModeStatus): void {
    if (this.open) this.hide();
    else this.show(status);
  }

  isOpen(): boolean {
    return this.open;
  }

  dispose(): void {
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.open = false;
  }

  private render(): void {
    if (typeof document === 'undefined') return;
    const modeId = this.currentModeId ?? 'free-flight';
    const modeName = MODE_DISPLAY_NAMES[modeId] ?? modeId;
    const modeRows = MODE_SPECIFIC[modeId] ?? [];
    this.root.innerHTML = `
      <div class="card" data-testid="flisym-help-card">
        <h1>FLISYM — Controls</h1>
        <div class="subtitle">Paused · Current mode: <strong>${modeName}</strong></div>

        <h2>Flight</h2>
        <div class="grid">${renderGrid(FLIGHT_CONTROLS)}</div>

        <h2>Mode hotkeys</h2>
        <div class="grid">${renderGrid(MODE_HOTKEYS)}</div>

        <h2>${modeName} — mode-specific</h2>
        <div class="grid">${renderGrid(modeRows)}</div>

        <h2>General</h2>
        <div class="grid">${renderGrid(GENERAL_CONTROLS)}</div>

        <div class="foot">Press <span class="key">H</span> / <span class="key">?</span> or <span class="key">Esc</span> to resume.</div>
      </div>
    `;
  }
}
