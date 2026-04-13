#!/bin/bash
#
# Build and sign the paste-helper binary.
# Run this once on your Mac before using Demo Assistant.
#
# Usage:
#   cd Demo_Assistant_Source_New
#   bash scripts/build-paste-helper.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/paste-helper.swift"
OUT="$SCRIPT_DIR/paste-helper"

echo "=== Building paste-helper ==="
echo "Source: $SRC"
echo "Output: $OUT"

# Compile with optimizations
swiftc -O -o "$OUT" "$SRC"
echo "✓ Compiled"

# Sign with ad-hoc signature (sufficient for Accessibility grant)
codesign --force --sign - "$OUT"
echo "✓ Signed (ad-hoc)"

# Make executable
chmod +x "$OUT"
echo "✓ Executable"

# Quick test — check accessibility (will return exit 1 if not granted yet)
echo ""
echo "=== Testing ==="
"$OUT" check && echo "✓ Accessibility is GRANTED" || echo "⚠ Accessibility NOT YET GRANTED for paste-helper"
echo ""
echo "=== Done ==="
echo ""
echo "If Accessibility is not granted:"
echo "  1. Open System Settings → Privacy & Security → Accessibility"
echo "  2. Click '+' and add: $OUT"
echo "  3. Make sure the toggle is ON"
echo "  4. No restart needed — it takes effect immediately"
echo ""
echo "Test it manually:"
echo "  # Open a text editor, focus a text field, copy some text, then:"
echo "  $OUT paste"
