// ILS indicator overlay (lower-left). Active when in approach cone for
// runway 09 (threshold (-750,0,0), heading 090°). See challenge-ils.md.

import type { AircraftState } from '../physics/state.js';

const ILS_CSS =
  ".flisym-ils{position:fixed;left:24px;bottom:24px;width:200px;height:200px;pointer-events:none;display:none;background:rgba(0,0,0,.45);border:1px solid rgba(182,255,122,.45);border-radius:4px;z-index:55;box-sizing:border-box;font:10px 'Consolas','Menlo','DejaVu Sans Mono',monospace;color:#b6ff7a}" +
  ".flisym-ils.on{display:block}" +
  ".flisym-ils .ih,.flisym-ils .iv{position:absolute;background:rgba(182,255,122,.35)}" +
  ".flisym-ils .ih{left:10%;right:10%;top:50%;height:1px}" +
  ".flisym-ils .iv{top:10%;bottom:10%;left:50%;width:1px}" +
  ".flisym-ils .il,.flisym-ils .ig{position:absolute;background:#ffd23a;will-change:transform}" +
  ".flisym-ils .il{top:8%;bottom:8%;left:50%;width:2px;margin-left:-1px}" +
  ".flisym-ils .ig{left:8%;right:8%;top:50%;height:2px;margin-top:-1px}" +
  ".flisym-ils .ilbl{position:absolute;top:4px;left:6px;letter-spacing:.2em;opacity:.75}" +
  ".flisym-ils .idme{position:absolute;bottom:4px;right:6px;font-variant-numeric:tabular-nums;opacity:.85}";

const TAN_3DEG = Math.tan((3 * Math.PI) / 180);

export interface ILSReading {
  active: boolean;
  locDeflection: number;
  gsDeflection: number;
  dme: number;
}

export class ILSIndicator {
  readonly root: HTMLDivElement;
  private readonly elLoc: HTMLDivElement;
  private readonly elGs: HTMLDivElement;
  private readonly elDme: HTMLSpanElement;

  private locShown = 0;
  private gsShown = 0;
  private lastTime: number | null = null;

  constructor() {
    if (!document.getElementById('flisym-ils-style')) {
      const s = document.createElement('style');
      s.id = 'flisym-ils-style';
      s.textContent = ILS_CSS;
      document.head.appendChild(s);
    }
    this.root = document.createElement('div');
    this.root.className = 'flisym-ils';
    this.root.innerHTML =
      '<div class="ilbl">ILS</div><div class="ih"></div><div class="iv"></div>' +
      '<div class="il"></div><div class="ig"></div>' +
      '<span class="idme">DME ---</span>';
    const c = this.root.children;
    this.elLoc = c[3] as HTMLDivElement;
    this.elGs = c[4] as HTMLDivElement;
    this.elDme = c[5] as HTMLSpanElement;
  }

  /** Compute ILS reading from aircraft state and update DOM. Lerps needles. */
  update(state: AircraftState): ILSReading {
    const x = state.x_W.x;
    const z = state.x_W.z;
    const altitude = state.x_W.y;

    const active =
      x >= -30000 && x <= -300 && Math.abs(z) < 8000 && altitude < 2500;

    const locRaw = clamp(-z / 200, -1, 1);
    const desired = Math.max(0, -x * TAN_3DEG);
    const gsRaw = clamp((altitude - desired) / 50, -1, 1);

    const dx = x - -750;
    const dme = Math.sqrt(dx * dx + altitude * altitude + z * z);

    if (!active) {
      this.root.classList.remove('on');
      this.locShown = locRaw;
      this.gsShown = gsRaw;
      this.lastTime = null;
      return { active, locDeflection: locRaw, gsDeflection: gsRaw, dme };
    }

    const now =
      typeof performance !== 'undefined' && performance.now
        ? performance.now() / 1000
        : Date.now() / 1000;
    const dt =
      this.lastTime === null ? 1 / 60 : Math.min(0.1, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    const a = 1 - Math.exp(-8 * dt);
    this.locShown += (locRaw - this.locShown) * a;
    this.gsShown += (gsRaw - this.gsShown) * a;

    this.root.classList.add('on');
    this.elLoc.style.transform = `translateX(${(-this.locShown * 40).toFixed(2)}%)`;
    this.elGs.style.transform = `translateY(${(this.gsShown * 40).toFixed(2)}%)`;
    const nm = dme / 1852;
    this.elDme.textContent = `DME ${nm >= 10 ? nm.toFixed(1) : nm.toFixed(2)} nm`;

    return { active, locDeflection: locRaw, gsDeflection: gsRaw, dme };
  }

  dispose(): void {
    this.root.remove();
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
