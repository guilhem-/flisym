// HelpOverlay unit tests. Runs in node-with-jsdom-via-vitest? Actually vitest
// default env is node — no DOM. The class guards on `typeof document` and
// produces a stub root in non-DOM hosts, which is what we exercise here.
// The rich-DOM render path is implicitly covered by the existing e2e specs
// when they boot the page.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { HelpOverlay } from '../src/hud/help-overlay.js';
import type { ModeStatus } from '../src/modes/index.js';

function status(id: ModeStatus['id'] = 'free-flight'): ModeStatus {
  return { id, won: false, lost: false, score: 0, headline: `Mode ${id}` };
}

// Set up a minimal jsdom-like document so the overlay's DOM path runs.
interface FakeEl {
  className: string;
  innerHTML: string;
  setAttribute(k: string, v: string): void;
  textContent: string;
  id: string;
  parentNode: FakeEl | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  _classes: Set<string>;
}

function makeEl(): FakeEl {
  const classes = new Set<string>();
  const el: FakeEl = {
    className: '',
    innerHTML: '',
    textContent: '',
    id: '',
    parentNode: null,
    _classes: classes,
    setAttribute() {},
    appendChild(c) {
      c.parentNode = el;
      return c;
    },
    removeChild(c) {
      c.parentNode = null;
      return c;
    },
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
  };
  return el;
}

const head = makeEl();
const fakeDocument = {
  head,
  getElementById: (id: string): FakeEl | null => (id === 'flisym-help-style' ? null : null),
  createElement: () => makeEl(),
};

let originalDocument: unknown;
beforeEach(() => {
  originalDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fakeDocument;
});
afterEach(() => {
  (globalThis as { document?: unknown }).document = originalDocument;
});

describe('HelpOverlay', () => {
  test('starts closed', () => {
    const h = new HelpOverlay();
    expect(h.isOpen()).toBe(false);
  });

  test('show(status) opens it; hide() closes', () => {
    const h = new HelpOverlay();
    h.show(status('dogfight'));
    expect(h.isOpen()).toBe(true);
    expect((h.root as unknown as FakeEl)._classes.has('on')).toBe(true);
    h.hide();
    expect(h.isOpen()).toBe(false);
    expect((h.root as unknown as FakeEl)._classes.has('on')).toBe(false);
  });

  test('toggle() flips state', () => {
    const h = new HelpOverlay();
    h.toggle(status());
    expect(h.isOpen()).toBe(true);
    h.toggle(status());
    expect(h.isOpen()).toBe(false);
  });

  test('renders content that mentions the current mode display name', () => {
    const h = new HelpOverlay();
    h.show(status('dogfight'));
    const html = (h.root as unknown as FakeEl).innerHTML;
    expect(html).toContain('Dogfight');
    // Generic key labels should also be present.
    expect(html).toContain('W');
    expect(html).toContain('Pitch down');
    expect(html).toContain('Roll right');
    // Mode-specific dogfight key:
    expect(html).toContain('Fire guns');
  });

  test('switching mode between shows re-renders the mode-specific section', () => {
    const h = new HelpOverlay();
    h.show(status('strike-mission'));
    expect((h.root as unknown as FakeEl).innerHTML).toContain('Drop bomb');
    h.hide();
    h.show(status('dogfight'));
    expect((h.root as unknown as FakeEl).innerHTML).toContain('Fire guns');
    expect((h.root as unknown as FakeEl).innerHTML).not.toContain('Drop bomb');
  });

  test('dispose detaches from parent and closes', () => {
    const h = new HelpOverlay();
    const parent = makeEl();
    parent.appendChild(h.root as unknown as FakeEl);
    h.show(status());
    h.dispose();
    expect(h.isOpen()).toBe(false);
    expect((h.root as unknown as FakeEl).parentNode).toBe(null);
  });
});
