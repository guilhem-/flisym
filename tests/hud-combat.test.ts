// HUD v0.2 combat / mission / time-trial overlay tests.
//
// Vitest runs in node by default and no DOM library (jsdom / happy-dom) is
// installed. To avoid adding a dev-dep just for these tests we ship a
// minimal DOM stub tuned to the exact surface `src/hud/hud.ts` and
// `src/hud/ils.ts` use:
//   - document.createElement / createElementNS / getElementById
//   - document.head.appendChild
//   - element.className / setAttribute / getAttribute / textContent
//   - element.innerHTML = "<html>...</html>" → recursive parse
//   - element.appendChild / remove / style / classList
//   - element.querySelector / querySelectorAll for [attr="value"], `.cls`,
//     and `tag > .cls > tag` patterns hud.ts actually emits
//   - element.childElementCount / firstElementChild / children
//   - window.addEventListener / removeEventListener / innerWidth / innerHeight
//   - performance.now()
//
// This is just enough to exercise HUD's public API.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type {
  CombatSnapshot,
  MissionHudState,
  TimeTrialHudState,
} from '../src/hud/types.js';
import type { ModeStatus } from '../src/modes/types.js';

// ── Minimal DOM stub ─────────────────────────────────────────────────────

class FakeClassList {
  private readonly el: FakeElement;
  constructor(el: FakeElement) { this.el = el; }
  add(...names: string[]): void {
    const set = new Set(this.el.classes);
    for (const n of names) set.add(n);
    this.el.classes = [...set];
  }
  remove(...names: string[]): void {
    const set = new Set(this.el.classes);
    for (const n of names) set.delete(n);
    this.el.classes = [...set];
  }
  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const shouldHave = force ?? !has;
    if (shouldHave && !has) this.add(name);
    if (!shouldHave && has) this.remove(name);
    return shouldHave;
  }
  contains(name: string): boolean {
    return this.el.classes.includes(name);
  }
}

class FakeStyle {
  cssText = '';
  display = '';
  width = '';
  height = '';
  left = '';
  top = '';
  marginLeft = '';
  marginTop = '';
  transform = '';
}

class FakeElement {
  tagName: string;
  ns: string | null;
  classes: string[] = [];
  attrs: Map<string, string> = new Map();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContentInternal = '';
  style = new FakeStyle();
  classList = new FakeClassList(this);
  id = '';

  constructor(tagName: string, ns: string | null = null) {
    this.tagName = tagName.toUpperCase();
    this.ns = ns;
  }

  get className(): string { return this.classes.join(' '); }
  set className(v: string) {
    this.classes = v.trim().length ? v.trim().split(/\s+/) : [];
  }

  setAttribute(k: string, v: string): void {
    if (k === 'class') { this.className = v; return; }
    if (k === 'id') { this.id = v; }
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    if (k === 'class') return this.className;
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    if (k === 'class') { this.classes = []; return; }
    this.attrs.delete(k);
  }

  appendChild<T extends FakeElement>(child: T): T {
    if (child.parent) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    }
  }

  get childElementCount(): number { return this.children.length; }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get parentElement(): FakeElement | null { return this.parent; }

  get textContent(): string {
    if (this.children.length === 0) return this.textContentInternal;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.textContentInternal = v;
  }

  /** Replace children by parsing a tiny subset of HTML. */
  set innerHTML(html: string) {
    this.children = [];
    this.textContentInternal = '';
    const nodes = parseHtmlFragment(html);
    for (const n of nodes) this.appendChild(n);
  }
  get innerHTML(): string {
    return this.children.map(serialize).join('');
  }

  // Selectors --------------------------------------------------------------

  querySelector<T extends FakeElement = FakeElement>(sel: string): T | null {
    let found: FakeElement | null = null;
    const matcher = compileSelector(sel);
    walk(this, (el) => {
      if (el === this) return;
      if (matcher(el)) { found = el; return true; }
      return false;
    });
    return found as T | null;
  }

  querySelectorAll<T extends FakeElement = FakeElement>(sel: string): T[] {
    const out: FakeElement[] = [];
    const matcher = compileSelector(sel);
    walk(this, (el) => {
      if (el === this) return;
      if (matcher(el)) out.push(el);
      return false;
    });
    return out as T[];
  }
}

function walk(
  root: FakeElement,
  visit: (el: FakeElement) => boolean | void,
): void {
  if (visit(root)) return;
  for (const c of root.children) walk(c, visit);
}

/**
 * Compile a CSS-ish selector — supports only the fragments hud.ts uses:
 *   `[attr="value"]`           — attribute eq
 *   `.cls`                     — class
 *   `tag`                      — tag name
 *   simple compound (e.g. `.damage-bar > i`)
 */
function compileSelector(sel: string): (el: FakeElement) => boolean {
  // Split on combinator ">".
  const parts = sel.split('>').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1) {
    return compileSimple(parts[0]!);
  }
  // Right-most part must match the element; ancestors must match parents.
  const compiled = parts.map(compileSimple);
  return (el: FakeElement): boolean => {
    if (!compiled[compiled.length - 1]!(el)) return false;
    let cur = el.parentElement;
    for (let i = compiled.length - 2; i >= 0; i -= 1) {
      while (cur && !compiled[i]!(cur)) cur = cur.parentElement;
      if (!cur) return false;
      cur = cur.parentElement;
    }
    return true;
  };
}

function compileSimple(part: string): (el: FakeElement) => boolean {
  // Tokenize on `[`/`]` and `.`.
  let tag: string | null = null;
  const cls: string[] = [];
  const attrs: Array<{ k: string; v: string }> = [];
  let i = 0;
  while (i < part.length) {
    const c = part[i]!;
    if (c === '[') {
      const end = part.indexOf(']', i);
      const body = part.slice(i + 1, end);
      const eq = body.indexOf('=');
      if (eq < 0) {
        attrs.push({ k: body, v: '*' });
      } else {
        const k = body.slice(0, eq);
        let v = body.slice(eq + 1);
        if ((v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        attrs.push({ k, v });
      }
      i = end + 1;
    } else if (c === '.') {
      let j = i + 1;
      while (j < part.length && part[j] !== '.' && part[j] !== '[') j += 1;
      cls.push(part.slice(i + 1, j));
      i = j;
    } else {
      let j = i;
      while (j < part.length && part[j] !== '.' && part[j] !== '[') j += 1;
      tag = part.slice(i, j).toUpperCase();
      i = j;
    }
  }
  return (el: FakeElement): boolean => {
    if (tag && tag !== '*' && el.tagName !== tag) return false;
    for (const c of cls) if (!el.classes.includes(c)) return false;
    for (const a of attrs) {
      const got = el.getAttribute(a.k);
      if (a.v === '*') { if (got === null) return false; }
      else if (got !== a.v) return false;
    }
    return true;
  };
}

// ── Tiny HTML parser ----------------------------------------------------
//
// Supports only what hud.ts emits:
//   <tag attr="value" attr2="value2">children…</tag>
//   <tag/> or self-closing tags (br, hr, img — we don't use any)
//   plain text between tags
// No comments, no script, no entities other than the obvious passthrough.

function parseHtmlFragment(html: string): FakeElement[] {
  const out: FakeElement[] = [];
  let i = 0;
  const stack: FakeElement[] = [];

  const append = (el: FakeElement): void => {
    if (stack.length === 0) out.push(el);
    else stack[stack.length - 1]!.appendChild(el);
  };
  const appendText = (txt: string): void => {
    if (!txt) return;
    if (stack.length === 0) return; // ignore text at fragment root
    const parent = stack[stack.length - 1]!;
    parent.textContentInternal += txt;
  };

  while (i < html.length) {
    if (html[i] === '<') {
      // Tag.
      const end = html.indexOf('>', i);
      if (end < 0) break;
      const inner = html.slice(i + 1, end).trim();
      if (inner.startsWith('/')) {
        stack.pop();
      } else {
        const selfClose = inner.endsWith('/');
        const body = selfClose ? inner.slice(0, -1).trim() : inner;
        // Tag name + attrs.
        const tagEnd = body.search(/\s/);
        const tagName = tagEnd < 0 ? body : body.slice(0, tagEnd);
        const attrPart = tagEnd < 0 ? '' : body.slice(tagEnd + 1);
        const el = new FakeElement(tagName);
        for (const a of parseAttrs(attrPart)) {
          if (a.k === 'class') el.className = a.v;
          else el.setAttribute(a.k, a.v);
        }
        append(el);
        if (!selfClose) stack.push(el);
      }
      i = end + 1;
    } else {
      const next = html.indexOf('<', i);
      const text = next < 0 ? html.slice(i) : html.slice(i, next);
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (trimmed) appendText(trimmed);
      i = next < 0 ? html.length : next;
    }
  }
  return out;
}

function parseAttrs(s: string): Array<{ k: string; v: string }> {
  const out: Array<{ k: string; v: string }> = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i += 1;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && s[j] !== '=' && !/\s/.test(s[j]!)) j += 1;
    const k = s.slice(i, j);
    if (s[j] !== '=') { out.push({ k, v: '' }); i = j; continue; }
    j += 1;
    const quote = s[j];
    if (quote === '"' || quote === "'") {
      const end = s.indexOf(quote, j + 1);
      const v = end < 0 ? s.slice(j + 1) : s.slice(j + 1, end);
      out.push({ k, v });
      i = end < 0 ? s.length : end + 1;
    } else {
      let end = j;
      while (end < s.length && !/\s/.test(s[end]!)) end += 1;
      out.push({ k, v: s.slice(j, end) });
      i = end;
    }
  }
  return out;
}

function serialize(el: FakeElement): string {
  const tag = el.tagName.toLowerCase();
  let attrs = '';
  if (el.className) attrs += ` class="${el.className}"`;
  for (const [k, v] of el.attrs) attrs += ` ${k}="${v}"`;
  if (el.children.length === 0 && !el.textContentInternal) {
    return `<${tag}${attrs}></${tag}>`;
  }
  const body = el.children.length
    ? el.children.map(serialize).join('')
    : el.textContentInternal;
  return `<${tag}${attrs}>${body}</${tag}>`;
}

// ── Document / window globals ───────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

interface FakeDocument {
  head: FakeElement;
  body: FakeElement;
  createElement(tag: string): FakeElement;
  createElementNS(ns: string, tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
}

function makeFakeDocument(): FakeDocument {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const byId = new Map<string, FakeElement>();
  return {
    head,
    body,
    createElement(tag) {
      const el = new FakeElement(tag);
      const origSet = el.setAttribute.bind(el);
      el.setAttribute = (k: string, v: string): void => {
        origSet(k, v);
        if (k === 'id') byId.set(v, el);
      };
      return el;
    },
    createElementNS(ns, tag) {
      return new FakeElement(tag, ns);
    },
    getElementById(id) {
      // Also walk head/body so id-set via .id getter works.
      if (byId.has(id)) return byId.get(id)!;
      let found: FakeElement | null = null;
      walk(head, (el) => { if (el.id === id) { found = el; return true; } return false; });
      if (found) return found;
      walk(body, (el) => { if (el.id === id) { found = el; return true; } return false; });
      return found;
    },
  };
}

interface FakeWindow {
  innerWidth: number;
  innerHeight: number;
  addEventListener(t: string, h: (e: unknown) => void, opts?: unknown): void;
  removeEventListener(t: string, h: (e: unknown) => void): void;
  listeners: Map<string, Array<(e: unknown) => void>>;
}
function makeFakeWindow(): FakeWindow {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    innerWidth: 1280,
    innerHeight: 720,
    listeners,
    addEventListener(t, h) {
      const arr = listeners.get(t) ?? [];
      arr.push(h);
      listeners.set(t, arr);
    },
    removeEventListener(t, h) {
      const arr = listeners.get(t);
      if (!arr) return;
      listeners.set(t, arr.filter((x) => x !== h));
    },
  };
}

// ── Install globals before importing HUD ───────────────────────────────

type WithGlobals = {
  document?: unknown;
  window?: unknown;
  performance?: unknown;
};

const _g = globalThis as unknown as WithGlobals;
const _origDocument = _g.document;
const _origWindow = _g.window;
const _origPerformance = _g.performance;

let fakeDocument: FakeDocument;
let fakeWindow: FakeWindow;

beforeEach(() => {
  fakeDocument = makeFakeDocument();
  fakeWindow = makeFakeWindow();
  _g.document = fakeDocument;
  _g.window = fakeWindow;
  if (!_g.performance) {
    _g.performance = { now: () => Date.now() };
  }
});

afterEach(() => {
  _g.document = _origDocument;
  _g.window = _origWindow;
  _g.performance = _origPerformance;
});

// Import HUD AFTER first test setup has run so any module-init time DOM
// access is satisfied. We use a dynamic import + cast to a typed surface.
type HUDClass = {
  new (): {
    root: FakeElement;
    setMode(s: ModeStatus): void;
    setCombat(s: CombatSnapshot | null): void;
    setMission(s: MissionHudState | null): void;
    setTimeTrial(s: TimeTrialHudState | null): void;
    addKillFeedRow(line: string): void;
    showSamWarning(): void;
    showFinishOverlay(t: number, m: number, opts?: { headline?: string }): void;
    dispose(): void;
  };
};

async function loadHUD(): Promise<HUDClass> {
  const mod = await import('../src/hud/hud.js');
  return mod.HUD as unknown as HUDClass;
}

// ── Fixtures ───────────────────────────────────────────────────────────

function makeSnapshot(over?: Partial<CombatSnapshot>): CombatSnapshot {
  const base: CombatSnapshot = {
    self: {
      id: 'player',
      isAlive: true,
      hp: { airframe: 80, engine: 50, aileron: 25, elevator: 100, rudder: 100 },
      gunRoundsL: 200,
      gunRoundsR: 200,
      missileRailsRemaining: 2,
      bombsRemaining: 0,
    },
    score: { kills: 1, deaths: 0 },
    lockState: 'seeking',
    targetBox: null,
    radarContacts: [],
  };
  return { ...base, ...over };
}

function makeMission(over?: Partial<MissionHudState>): MissionHudState {
  const base: MissionHudState = {
    waypoints: [
      { distanceKm: 4.2 },
      { distanceKm: 8.6 },
      { distanceKm: 12.0 },
      { distanceKm: 16.4 },
      { distanceKm: 20.0 },
    ],
    currentWaypoint: 1,
    bombsRemaining: 3,
    bombsTotal: 4,
    targets: [
      { id: 'tank-1', status: 'LIVE' },
      { id: 'hangar-1', status: 'DEAD' },
    ],
  };
  return { ...base, ...over };
}

function makeStatus(over?: Partial<ModeStatus>): ModeStatus {
  const base: ModeStatus = {
    id: 'dogfight',
    won: false,
    lost: false,
    score: 0,
    headline: 'DOGFIGHT — Bandits 2',
  };
  return { ...base, ...over };
}

// Helpers --------------------------------------------------------------

function $testid(root: FakeElement, id: string): FakeElement | null {
  return root.querySelector(`[data-testid="${id}"]`);
}

function $allTestid(root: FakeElement, id: string): FakeElement[] {
  return root.querySelectorAll(`[data-testid="${id}"]`);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('HUD v0.2 combat / mission / time-trial overlays', () => {
  test('hud root carries data-testid="flisym-hud"', async () => {
    const HUD = await loadHUD();
    const hud = new HUD();
    expect(hud.root.getAttribute('data-testid')).toBe('flisym-hud');
    hud.dispose();
  });

  test('setMode(status) updates [data-testid="hud-mode-name"] text', async () => {
    const HUD = await loadHUD();
    const hud = new HUD();
    hud.setMode(makeStatus({ headline: 'DOGFIGHT — Bandits 3' }));
    const badge = $testid(hud.root, 'hud-mode-name');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('DOGFIGHT — Bandits 3');
    expect(badge!.getAttribute('data-mode-id')).toBe('dogfight');
    hud.dispose();
  });

  test('setCombat(snapshot) shows damage panel + correct hp mirrors', async () => {
    const HUD = await loadHUD();
    const hud = new HUD();
    hud.setCombat(makeSnapshot());
    const panel = hud.root.querySelector('[data-h="damage-panel"]');
    expect(panel).not.toBeNull();
    expect(panel!.classes).toContain('on');

    const airframe = $testid(hud.root, 'hud-damage-airframe');
    const engine = $testid(hud.root, 'hud-damage-engine');
    const aileron = $testid(hud.root, 'hud-damage-aileron');
    const elevator = $testid(hud.root, 'hud-damage-elevator');
    const rudder = $testid(hud.root, 'hud-damage-rudder');
    expect(airframe!.getAttribute('data-hp')).toBe('80');
    expect(engine!.getAttribute('data-hp')).toBe('50');
    expect(aileron!.getAttribute('data-hp')).toBe('25');
    expect(elevator!.getAttribute('data-hp')).toBe('100');
    expect(rudder!.getAttribute('data-hp')).toBe('100');

    // Score mirror.
    const score = $testid(hud.root, 'hud-score');
    expect(score!.getAttribute('data-kills')).toBe('1');
    expect(score!.getAttribute('data-deaths')).toBe('0');
    expect(score!.textContent).toBe('K:1 D:0');
    hud.dispose();
  });

  test('setCombat(null) hides damage panel + combat overlays', async () => {
    const HUD = await loadHUD();
    const hud = new HUD();
    hud.setCombat(makeSnapshot());
    hud.setCombat(null);
    const panel = hud.root.querySelector('[data-h="damage-panel"]');
    expect(panel!.classes).not.toContain('on');
    const score = $testid(hud.root, 'hud-score');
    expect(score!.classes).not.toContain('on');
    const ammo = hud.root.querySelector('[data-h="ammo-readout"]');
    expect(ammo!.classes).not.toContain('on');
    hud.dispose();
  });

  test('addKillFeedRow appends row with testid + caps at 4 entries', async () => {
    const HUD = await loadHUD();
    const hud = new HUD();
    hud.addKillFeedRow('PLAYER ⨂ BANDIT [Gun]');
    let rows = $allTestid(hud.root, 'hud-kill-feed-entry');
    expect(rows.length).toBe(1);
    expect(rows[0]!.textContent).toBe('PLAYER ⨂ BANDIT [Gun]');

    // Push 5 more — oldest must be evicted, leaving exactly 4 visible.
    for (let i = 0; i < 5; i += 1) {
      hud.addKillFeedRow(`KILL ${i}`);
    }
    rows = $allTestid(hud.root, 'hud-kill-feed-entry');
    expect(rows.length).toBe(4);
    // The very first row should be gone; the second-to-last must be "KILL 3".
    expect(rows[rows.length - 1]!.textContent).toBe('KILL 4');
    hud.dispose();
  });

  test('setMission shows waypoint strip with right dot count + label', async () => {
    const HUD = await loadHUD();
    const hud = new HUD();
    hud.setMission(makeMission());
    const strip = $testid(hud.root, 'hud-waypoints');
    expect(strip).not.toBeNull();
    expect(strip!.classes).toContain('on');
    expect(strip!.getAttribute('data-waypoint-count')).toBe('5');
    expect(strip!.getAttribute('data-current-waypoint')).toBe('1');

    const dots = strip!.querySelectorAll('.dot');
    expect(dots.length).toBe(5);
    // Index 0 is done, 1 is active, 2..4 are future.
    expect(dots[0]!.classes).toContain('done');
    expect(dots[1]!.classes).toContain('active');
    expect(dots[2]!.classes).not.toContain('active');

    // Bombs mirror.
    const bombs = $testid(hud.root, 'hud-bombs');
    expect(bombs!.getAttribute('data-bombs-remaining')).toBe('3');
    expect(bombs!.getAttribute('data-bombs-total')).toBe('4');
    expect(bombs!.textContent).toBe('BOMBS 3/4');

    // Hide via null.
    hud.setMission(null);
    expect(strip!.classes).not.toContain('on');
    expect(bombs!.classes).not.toContain('on');
    hud.dispose();
  });

  test('setTimeTrial shows PB panel; null hides it', async () => {
    const HUD = await loadHUD();
    const hud = new HUD();
    // First with a personal best.
    hud.setTimeTrial({ personalBest: 67.42, ghostDeltaMeters: 12.3 });
    const pb = hud.root.querySelector('[data-h="pb-panel"]');
    const ghost = hud.root.querySelector('[data-h="ghost-distance"]');
    expect(pb!.classes).toContain('on');
    expect(pb!.textContent).toBe('PB 1:07.42');
    expect(ghost!.classes).toContain('on');
    expect(ghost!.textContent).toMatch(/GHOST \+12\.3 m/);

    // Then with no PB (placeholder) — ghost null hides ghost panel.
    hud.setTimeTrial({ personalBest: null, ghostDeltaMeters: null });
    expect(pb!.classes).toContain('on');
    expect(pb!.textContent).toBe('PB —');
    expect(ghost!.classes).not.toContain('on');

    // Finally — full hide.
    hud.setTimeTrial(null);
    expect(pb!.classes).not.toContain('on');
    expect(ghost!.classes).not.toContain('on');
    hud.dispose();
  });

  test('showFinishOverlay accepts optional headline', async () => {
    const HUD = await loadHUD();
    const hud = new HUD();
    hud.showFinishOverlay(45.2, 0, { headline: 'NEW PERSONAL BEST' });
    const overlay = hud.root.querySelector('[data-h="finish-overlay"]');
    const headline = hud.root.querySelector('[data-h="finish-headline"]');
    const summary = hud.root.querySelector('[data-h="finish-summary"]');
    expect(overlay!.classes).toContain('on');
    expect(headline!.textContent).toBe('NEW PERSONAL BEST');
    expect(summary!.textContent).toBe('Time 0:45.20 — Missed 0 gates');

    // Default headline path.
    hud.showFinishOverlay(63.0, 1);
    expect(headline!.textContent).toBe('COURSE COMPLETE');
    expect(summary!.textContent).toBe('Time 1:03.00 — Missed 1 gate');
    hud.dispose();
  });
});
