// WebGL availability detection tests. Verifies both the success path and the
// failure path that triggers the user-facing overlay. We synthesize a minimal
// Document-shaped fake so the tests run under Vitest's default Node env
// without bringing in JSDOM.

import { describe, test, expect } from 'vitest';
import { checkWebGL, showWebGLUnavailableOverlay } from '../src/webgl-check.js';

interface FakeElement {
  tagName: string;
  className: string;
  style: { cssText: string };
  innerHTML: string;
  attrs: Map<string, string>;
  children: FakeElement[];
  setAttribute(k: string, v: string): void;
  appendChild(c: FakeElement): FakeElement;
  getContext?(type: string): unknown;
}

function makeFakeElement(tag: string): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    className: '',
    style: { cssText: '' },
    innerHTML: '',
    attrs: new Map(),
    children: [],
    setAttribute(k, v) {
      this.attrs.set(k, v);
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  return el;
}

function makeFakeDocument(getContextImpl: (t: string) => unknown): {
  doc: Document;
  body: FakeElement;
} {
  const body = makeFakeElement('body');
  const doc = {
    createElement(tag: string) {
      const el = makeFakeElement(tag);
      if (tag === 'canvas') {
        el.getContext = getContextImpl;
        // Stub event listeners — checkWebGL listens for
        // webglcontextcreationerror but our fakes never fire it.
        (el as unknown as { addEventListener: () => void }).addEventListener =
          () => {};
        (el as unknown as { removeEventListener: () => void }).removeEventListener =
          () => {};
      }
      return el;
    },
    body,
  } as unknown as Document;
  return { doc, body };
}

interface FakeGLOptions {
  /** Pixel that readPixels writes back. Default: matches the clearColor. */
  readback?: [number, number, number, number];
  /** If true, isContextLost() returns true. Default: false. */
  lost?: boolean;
  /** If set, clearColor/clear/readPixels throw with this message. */
  throwOnRender?: string;
}

function makeFakeGL(opts: FakeGLOptions = {}): unknown {
  let lastClear: [number, number, number, number] = [0, 0, 0, 0];
  return {
    COLOR_BUFFER_BIT: 0x4000,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    isContextLost: () => opts.lost ?? false,
    clearColor(r: number, g: number, b: number, a: number) {
      if (opts.throwOnRender) throw new Error(opts.throwOnRender);
      lastClear = [
        Math.round(r * 255),
        Math.round(g * 255),
        Math.round(b * 255),
        Math.round(a * 255),
      ];
    },
    clear() {
      if (opts.throwOnRender) throw new Error(opts.throwOnRender);
    },
    readPixels(
      _x: number,
      _y: number,
      _w: number,
      _h: number,
      _f: number,
      _t: number,
      out: Uint8Array,
    ) {
      if (opts.throwOnRender) throw new Error(opts.throwOnRender);
      const px = opts.readback ?? lastClear;
      out[0] = px[0];
      out[1] = px[1];
      out[2] = px[2];
      out[3] = px[3];
    },
  };
}

describe('checkWebGL', () => {
  test('returns ok when WebGL2 context renders the clear-color round-trip', () => {
    const fakeGL = makeFakeGL();
    const { doc } = makeFakeDocument((t) => (t === 'webgl2' ? fakeGL : null));
    const result = checkWebGL(doc);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('falls through to webgl1 when webgl2 is null', () => {
    const fakeGL = makeFakeGL();
    const { doc } = makeFakeDocument((t) => (t === 'webgl' ? fakeGL : null));
    const result = checkWebGL(doc);
    expect(result.ok).toBe(true);
  });

  test('returns not-ok with a reason when getContext is null for all variants', () => {
    const { doc } = makeFakeDocument(() => null);
    const result = checkWebGL(doc);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/getContext returned null/);
  });

  test('returns not-ok when getContext throws', () => {
    const { doc } = makeFakeDocument(() => {
      throw new Error('Out of memory');
    });
    const result = checkWebGL(doc);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/getContext threw/);
    expect(result.reason).toMatch(/Out of memory/);
  });

  test('handles non-Error throws (string) without crashing', () => {
    const { doc } = makeFakeDocument(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string-error';
    });
    const result = checkWebGL(doc);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/string-error/);
  });

  test('returns not-ok when isContextLost returns true', () => {
    const fakeGL = makeFakeGL({ lost: true });
    const { doc } = makeFakeDocument(() => fakeGL);
    const result = checkWebGL(doc);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/context is lost/);
  });

  test('returns not-ok when readPixels does NOT round-trip the clear color (Chromium phantom-context case)', () => {
    // Simulate Chromium 137+ deprecated software fallback: getContext returns
    // a non-null object, but the context is a no-op — readPixels yields zeros
    // regardless of clearColor.
    const fakeGL = makeFakeGL({ readback: [0, 0, 0, 0] });
    const { doc } = makeFakeDocument(() => fakeGL);
    const result = checkWebGL(doc);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cannot render/);
    expect(result.reason).toMatch(/readPixels returned/);
  });

  test('returns not-ok when readPixels returns a non-green pixel', () => {
    // Phantom returns red instead of the cleared green.
    const fakeGL = makeFakeGL({ readback: [255, 0, 0, 255] });
    const { doc } = makeFakeDocument(() => fakeGL);
    const result = checkWebGL(doc);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cannot render/);
  });

  test('returns not-ok when render calls throw', () => {
    const fakeGL = makeFakeGL({ throwOnRender: 'INVALID_OPERATION' });
    const { doc } = makeFakeDocument(() => fakeGL);
    const result = checkWebGL(doc);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/clear\/readPixels failed/);
    expect(result.reason).toMatch(/INVALID_OPERATION/);
  });

  test('returns not-ok when getContext returns a non-WebGL object', () => {
    const fakeGL = { foo: 'bar' }; // missing clear / readPixels
    const { doc } = makeFakeDocument(() => fakeGL);
    const result = checkWebGL(doc);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/non-WebGL object/);
  });
});

describe('showWebGLUnavailableOverlay', () => {
  test('appends an overlay to document.body with the given reason', () => {
    const { doc, body } = makeFakeDocument(() => null);
    const overlay = showWebGLUnavailableOverlay('test-reason', doc);
    expect(body.children).toContain(overlay as unknown as FakeElement);
    expect((overlay as unknown as FakeElement).className).toBe('flisym-webgl-error');
    expect((overlay as unknown as FakeElement).attrs.get('role')).toBe('alert');
    expect((overlay as unknown as FakeElement).innerHTML).toContain('test-reason');
  });

  test('escapes HTML in the reason string', () => {
    const { doc } = makeFakeDocument(() => null);
    const overlay = showWebGLUnavailableOverlay('<script>x</script>', doc);
    const html = (overlay as unknown as FakeElement).innerHTML;
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('overlay is non-empty CSS-styled (positioned, full-screen, on top)', () => {
    const { doc } = makeFakeDocument(() => null);
    const overlay = showWebGLUnavailableOverlay('reason', doc);
    const css = (overlay as unknown as FakeElement).style.cssText;
    expect(css).toMatch(/position:fixed/);
    expect(css).toMatch(/inset:0/);
    expect(css).toMatch(/z-index:9999/);
  });

  test('overlay names the swiftshader workaround so the user can fix it', () => {
    const { doc } = makeFakeDocument(() => null);
    const overlay = showWebGLUnavailableOverlay('reason', doc);
    const html = (overlay as unknown as FakeElement).innerHTML;
    expect(html).toMatch(/swiftshader/i);
    expect(html).toMatch(/--use-angle=swiftshader/);
    expect(html).toMatch(/--enable-unsafe-swiftshader/);
    expect(html).toMatch(/--ignore-gpu-blocklist/);
  });

  test('overlay surfaces the launch helper script and VM-host advice', () => {
    const { doc } = makeFakeDocument(() => null);
    const overlay = showWebGLUnavailableOverlay('reason', doc);
    const html = (overlay as unknown as FakeElement).innerHTML;
    expect(html).toMatch(/launch-browser\.sh/);
    expect(html).toMatch(/VMware|vmsvga/i);
    expect(html).toMatch(/Firefox/);
  });
});
