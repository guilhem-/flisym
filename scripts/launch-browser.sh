#!/usr/bin/env bash
# Launch Chromium / Chrome / Firefox with WebGL flags that work in environments
# with no real GPU (VMware vmsvga, Hyper-V, headless servers, etc.).
#
# Usage:
#   ./scripts/launch-browser.sh                     # auto-detect, default URL
#   ./scripts/launch-browser.sh http://host:5173
#   BROWSER=firefox ./scripts/launch-browser.sh
#   BROWSER=chromium ./scripts/launch-browser.sh

set -eu

URL="${1:-http://127.0.0.1:5173/}"
BROWSER="${BROWSER:-}"

# Auto-detect.
if [[ -z "$BROWSER" ]]; then
  for cand in chromium chromium-browser google-chrome firefox; do
    if command -v "$cand" >/dev/null 2>&1; then
      BROWSER="$cand"
      break
    fi
  done
fi

if [[ -z "$BROWSER" ]]; then
  echo "No supported browser found (chromium / chrome / firefox)." >&2
  exit 1
fi

case "$BROWSER" in
  chromium|chromium-browser|google-chrome|chrome)
    # SwiftShader = software rasterizer that ships with Chromium. ANGLE on top
    # of it gives us a real WebGL2 / ES3 context even when the GPU is blocklisted.
    # `--ignore-gpu-blocklist` is needed because vmsvga / vboxvideo are typically
    # on Chromium's blocklist.
    exec "$BROWSER" \
      --use-angle=swiftshader \
      --enable-unsafe-swiftshader \
      --ignore-gpu-blocklist \
      --enable-features=Vulkan \
      "$URL"
    ;;
  firefox)
    # Firefox: force software WebRender path so a missing real GPU still works.
    export MOZ_WEBRENDER=0
    exec "$BROWSER" "$URL"
    ;;
  *)
    echo "Unknown browser: $BROWSER" >&2
    exit 2
    ;;
esac
