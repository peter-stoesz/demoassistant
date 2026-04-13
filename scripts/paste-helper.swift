#!/usr/bin/env swift
//
// paste-helper.swift
// ------------------
// Tiny helper binary that sends a Cmd+V (paste) keystroke via CGEvent.
//
// Why a separate binary?
// ----------------------
// macOS ties Accessibility permission to a specific code signature.
// The Electron dev binary often has an ad-hoc/unsigned signature that
// macOS won't recognise even after granting Accessibility in System
// Settings.  This standalone helper has its own clean signature,
// making the permission grant reliable.
//
// Usage:
//   ./paste-helper paste        Send Cmd+V
//   ./paste-helper paste-match  Send Cmd+Shift+Alt+V (Paste and Match Style)
//   ./paste-helper check        Exit 0 if Accessibility is granted, 1 if not
//
// Build:
//   swiftc -O -o paste-helper paste-helper.swift
//
// Sign (ad-hoc, enough for Accessibility):
//   codesign --force --sign - paste-helper
//

import Cocoa

// ── Accessibility check ─────────────────────────────────────────────────────

func isAccessibilityGranted() -> Bool {
    // AXIsProcessTrusted() checks without prompting
    return AXIsProcessTrusted()
}

// ── Send a keystroke via CGEvent ────────────────────────────────────────────

func sendKeyCombo(virtualKey: CGKeyCode, flags: CGEventFlags) -> Bool {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        fputs("ERROR: Could not create CGEventSource\n", stderr)
        return false
    }

    guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: true),
          let keyUp   = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: false) else {
        fputs("ERROR: Could not create CGEvent\n", stderr)
        return false
    }

    keyDown.flags = flags
    keyUp.flags = flags

    keyDown.post(tap: .cghidEventTap)
    usleep(50_000)  // 50ms between down and up
    keyUp.post(tap: .cghidEventTap)

    return true
}

// ── Main ────────────────────────────────────────────────────────────────────

let args = CommandLine.arguments

guard args.count >= 2 else {
    fputs("Usage: paste-helper <paste|paste-match|check>\n", stderr)
    exit(2)
}

let command = args[1]

switch command {
case "check":
    if isAccessibilityGranted() {
        print("ACCESSIBILITY_GRANTED")
        exit(0)
    } else {
        print("ACCESSIBILITY_NOT_GRANTED")
        exit(1)
    }

case "paste":
    // Virtual key 9 = 'v' on macOS
    if sendKeyCombo(virtualKey: 9, flags: .maskCommand) {
        exit(0)
    } else {
        fputs("ERROR: Failed to send Cmd+V\n", stderr)
        exit(1)
    }

case "paste-match":
    // Cmd+Shift+Alt+V — "Paste and Match Style"
    let flags: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate]
    if sendKeyCombo(virtualKey: 9, flags: flags) {
        exit(0)
    } else {
        fputs("ERROR: Failed to send Cmd+Shift+Alt+V\n", stderr)
        exit(1)
    }

default:
    fputs("Unknown command: \(command)\nUsage: paste-helper <paste|paste-match|check>\n", stderr)
    exit(2)
}
