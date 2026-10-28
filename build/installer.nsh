; JShell custom NSIS fragment (included via nsis.include)
;
; Why: builds up to 0.10.x shipped WITHOUT rewriting exe resources, so the
; installer created an "Electron" shortcut. Overwriting with a newer version
; does not remove it, leaving a stale "Electron" entry in the Start Menu.
;
; This removes only shortcuts literally named Electron.lnk - no other product
; creates that name, it is our own legacy artifact.
;
; NOTE: keep this file ASCII-only. makensis reads includes as ANSI and a
; UTF-8 multibyte comment can break compilation (that is what failed CI once).

!macro customInstall
  DetailPrint "Cleaning up legacy shortcuts..."
  ; $SMPROGRAMS = Start Menu\Programs for the current shell context
  Delete "$SMPROGRAMS\Electron.lnk"
  ; literal path as a fallback when the shell context is "all users"
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Electron.lnk"
  Delete "$DESKTOP\Electron.lnk"
!macroend
