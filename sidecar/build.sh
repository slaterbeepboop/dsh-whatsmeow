#!/bin/sh
# Build the whatsmeow sidecar into bin/. Needs Go 1.26 or newer on PATH; the
# binary is static (CGO off) so the plugin runs without a C toolchain.
set -eu
cd "$(dirname "$0")"

GO=${GO:-go}
if ! command -v "$GO" >/dev/null 2>&1; then
  echo "build.sh: $GO not found. Install Go 1.26+ from https://go.dev/dl/ and retry." >&2
  exit 1
fi

VERSION=$("$GO" version | awk '{print $3}' | sed 's/^go//')
echo "building whatsmeow sidecar with go $VERSION"

cd ../sidecar
CGO_ENABLED=0 "$GO" build -trimpath -ldflags="-s -w" -o ../bin/whatsmeow-sidecar .
echo "wrote bin/whatsmeow-sidecar"
