; installer.nsh — Custom NSIS script for Demo Assistant
; Included by electron-builder during Windows installer creation

; ── Auto-start on login (optional, user can disable) ──────────────────────────
!macro customInstall
  ; Write registry key for auto-start (HKCU — no elevation needed)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
    "DemoAssistant" "$INSTDIR\Demo Assistant.exe"
!macroend

!macro customUninstall
  ; Remove auto-start registry key on uninstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "DemoAssistant"
!macroend
