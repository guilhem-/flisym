// WebGL availability detection + user-facing overlay.
//
// Three.js's WebGLRenderer constructor throws ("Error creating WebGL context.")
// on hosts where WebGL is unavailable (no GPU, blocked driver, headless
// Chrome without --use-angle=swiftshader, etc.). Without this guard the page
// just goes black and the user has no signal as to why.

export interface WebGLCheckResult {
  ok: boolean;
  /** Two-line description if not ok, suitable for showing to the user. */
  reason?: string;
}

/**
 * Probe WebGL availability with a real clear+readPixels round-trip.
 *
 * Just calling `canvas.getContext('webgl')` is NOT enough: Chromium 137+
 * removed automatic software-WebGL fallback, but a request for a context
 * still returns a non-null phantom that silently fails at draw time. To
 * tell a working context from a phantom we clear with a known color and
 * read it back. If the pixel doesn't match, the context can't actually
 * render and the user needs `--use-angle=swiftshader --enable-unsafe-swiftshader`
 * (or a real GPU).
 *
 * Pass a `documentRef` to inject a DOM in tests. In production the global
 * `document` is used.
 */
export function checkWebGL(documentRef: Document = document): WebGLCheckResult {
  let canvas: HTMLCanvasElement;
  try {
    canvas = documentRef.createElement('canvas');
  } catch (e) {
    return { ok: false, reason: `canvas element unavailable: ${describe(e)}` };
  }

  // Listen for webglcontextcreationerror to capture the driver's reason.
  let creationError = '';
  const onCreationError = (e: Event): void => {
    const ev = e as Event & { statusMessage?: string };
    if (ev.statusMessage) creationError = ev.statusMessage;
  };
  canvas.addEventListener?.('webglcontextcreationerror', onCreationError);

  let gl: RenderingContext | null;
  try {
    gl =
      (canvas.getContext('webgl2') as RenderingContext | null) ??
      (canvas.getContext('webgl') as RenderingContext | null) ??
      (canvas.getContext('experimental-webgl') as RenderingContext | null);
  } catch (e) {
    canvas.removeEventListener?.('webglcontextcreationerror', onCreationError);
    return { ok: false, reason: `getContext threw: ${describe(e)}` };
  }
  canvas.removeEventListener?.('webglcontextcreationerror', onCreationError);

  if (gl === null) {
    const why = creationError
      ? `getContext returned null (${creationError})`
      : 'getContext returned null (WebGL not supported on this host)';
    return { ok: false, reason: why };
  }

  // Real-render probe: clear to a known color, read it back. If readPixels
  // can't reproduce the clear color, the context is a phantom (Chromium's
  // post-deprecation no-op software fallback) and rendering won't work.
  try {
    if (!isWebGLLike(gl)) {
      return { ok: false, reason: 'getContext returned non-WebGL object' };
    }
    if (gl.isContextLost?.()) {
      return { ok: false, reason: 'WebGL context is lost immediately after creation' };
    }
    gl.clearColor(0, 1, 0, 1); // pure green
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    // Allow some slack for color-space conversions; just require G≫R/B.
    const r = pixel[0] ?? 0;
    const g = pixel[1] ?? 0;
    const b = pixel[2] ?? 0;
    if (g < 128 || g <= r || g <= b) {
      const extra = creationError ? ` (driver: ${creationError})` : '';
      return {
        ok: false,
        reason: `WebGL context cannot render — readPixels returned [${r},${g},${b}] after clear to green${extra}`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `clear/readPixels failed: ${describe(e)}` };
  }
}

interface WebGLLike {
  COLOR_BUFFER_BIT: number;
  RGBA: number;
  UNSIGNED_BYTE: number;
  clearColor(r: number, g: number, b: number, a: number): void;
  clear(mask: number): void;
  readPixels(
    x: number,
    y: number,
    w: number,
    h: number,
    format: number,
    type: number,
    pixels: ArrayBufferView,
  ): void;
  isContextLost?(): boolean;
}

type RenderingContext = WebGLLike & object;

function isWebGLLike(o: unknown): o is WebGLLike {
  return (
    !!o &&
    typeof (o as WebGLLike).clear === 'function' &&
    typeof (o as WebGLLike).clearColor === 'function' &&
    typeof (o as WebGLLike).readPixels === 'function'
  );
}

/**
 * Render a full-page overlay describing the missing-WebGL situation and how
 * to enable software WebGL. Returns the overlay element so callers can test
 * or remove it.
 */
export function showWebGLUnavailableOverlay(
  reason: string,
  documentRef: Document = document,
): HTMLElement {
  const overlay = documentRef.createElement('div');
  overlay.className = 'flisym-webgl-error';
  overlay.setAttribute('role', 'alert');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'background:#0a1220',
    'color:#e8eef4',
    'font-family:system-ui,-apple-system,sans-serif',
    'padding:48px',
    'box-sizing:border-box',
    'z-index:9999',
    'overflow:auto',
  ].join(';');
  overlay.innerHTML = [
    '<h1 style="margin:0 0 16px;font-size:28px;color:#ff7a59">FLISYM cannot start: WebGL is unavailable</h1>',
    `<p style="margin:0 0 24px;color:#9aa6b4">Reason: <code>${escapeHtml(reason)}</code></p>`,
    '<h2 style="font-size:18px;margin:24px 0 8px">One-shot launcher</h2>',
    '<pre style="background:#101a2c;padding:12px;border-radius:6px;overflow:auto"><code>./scripts/launch-browser.sh</code></pre>',
    '<p style="color:#9aa6b4">Wraps Chromium with the right SwiftShader / ANGLE / blocklist flags. Falls back to Firefox if Chromium isn\'t installed.</p>',
    '<h2 style="font-size:18px;margin:24px 0 8px">Manual: force software WebGL (Chromium / Chrome)</h2>',
    '<pre style="background:#101a2c;padding:12px;border-radius:6px;overflow:auto"><code>chromium --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --enable-features=Vulkan</code></pre>',
    '<p style="color:#9aa6b4">SwiftShader is a software rasterizer — slower than a real GPU, but it lets the simulator run on hosts without graphics hardware. <code>--ignore-gpu-blocklist</code> is required when the host has a virtual GPU like VMware vmsvga or VirtualBox vboxvideo.</p>',
    '<h2 style="font-size:18px;margin:24px 0 8px">Quick diagnostics</h2>',
    '<ul style="line-height:1.6">',
    '<li>Open <code>chrome://gpu</code> (or <code>about:support</code> in Firefox) and check WebGL status.</li>',
    '<li>If running in a VMware VM, enable <em>Accelerate 3D graphics</em> + ≥ 768 MB graphics memory.</li>',
    '<li>Install Mesa drivers: <code>sudo apt install libgl1-mesa-dri mesa-vulkan-drivers</code>.</li>',
    '<li>Try Firefox — independent WebGL stack: <code>MOZ_WEBRENDER=0 firefox</code>.</li>',
    '</ul>',
  ].join('');
  documentRef.body.appendChild(overlay);
  return overlay;
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
