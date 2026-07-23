# Improvement Plan — Song Editor (feedBack)

Derived from an in-depth comparison against `slopsmith-plugin-editor`, the
earlier, smaller-scale ancestor of this plugin (this repo's own
`src/chords.js` header still reads "Slopsmith Arrangement Editor" — confirmed
fork lineage, though git history was reset independently on each side). This
repo is architecturally far more mature overall, but the comparison surfaced
a handful of concrete gaps and one real regression relative to the ancestor.
Ordered by leverage vs. cost.

## P0 — Bug fixes shared with the ancestor (unfixed on both sides)

Cross-checking the ancestor's `KNOWN_ISSUES.md` (a catalog of 8 frontend bugs
found in its monolithic `screen.js`) against this repo's modularized
equivalents found that only 3 of 8 were actually fixed here — the rest carry
over unchanged. Worth fixing here first since the codebase is easier to patch
precisely (modules vs. one IIFE), then the same diagnosis can be applied
upstream.

1. **Ctrl+Z/Ctrl+Y fire while a text input has focus**
   (`src/input.js:1989-2003`). The checkpoint-undo/undo/redo branches have
   no `!_editorIsTypingTarget(e)` guard, while nearly every neighboring
   branch (delete, duplicate, escape-clear, tempo insert) does carry it.
   `_editorIsTypingTarget` already exists (`shortcuts.js:628`) and is used
   elsewhere (`input.js:1683`) — just apply it here too.
2. **Stale note index across an arrangement switch**
   (context menu / add-note popover). Neither `editorSelectArrangement`
   (`main.js:1847-1879`) nor `editorSwitcherSelect` (`main.js:1886-1933`)
   call `hideContextMenu()`/`hideAddNote()` before switching, so a menu
   opened on the old arrangement still holds an `idx` into the new
   arrangement's `notes()` (`notes.js:15`) if the switch happens via the
   `<select>` (outside the canvas, so `mouse.js:37-38`'s click-based close
   never fires).
3. **No double-submit guard on "Export to Library"**
   (`create.js:2614`, `editorBuild()`, wired via bare
   `onclick="editorBuild()"` at `screen.html:67`). No in-flight flag or
   `.disabled` set at entry, despite `.disabled` guards being used at ~20
   other sites in the same file — apply the same pattern here.
4. **Context menu / add-note dialog not clamped to viewport**
   (`context-menu.js:103-104`, `add-note.js:18-19`). Positioned directly
   from event coordinates; clamp against `window.innerWidth/Height`.
5. **`DPR` captured once at module load, never refreshed**
   (`canvas.js:16`). No `matchMedia('(resolution...)')` listener anywhere
   in the codebase to catch a monitor/zoom change.

## P1 — Finish a pattern already started here

6. **`_installModalKeyboard` (`ui.js:39-85`) is only wired to dynamically-
   built modals.** It gives Escape + focus-trap to ~10 dynamic modals (bend
   editor, prompt dialogs, song-fit, etc.) but the ~9 static modals in
   `screen.html` (Replace Audio, Add Drums, Add Keys, Import Guitar,
   Strings, Save Format, Tones, Record MIDI, New Track) were never migrated
   through it. Finish the rollout — route every modal's open/close through
   the shared helper rather than leaving a two-tier system.

## P2 — Backend session sweep (regression vs. the ancestor)

7. **The in-memory `sessions` dict (`routes.py:979`) has no TTL eviction.**
   The ancestor's equivalent dict has a background task
   (`@app.on_event("startup")`, sleeps 5 min, evicts anything idle >1 hour
   and deletes its temp dir) that this repo's `routes.py` does not carry
   over. What exists instead is (a) an explicit
   `POST /api/plugins/editor/session/close` fired from
   `disposeBackendSession()` (`src/session-lifecycle.js:96-107`), which is
   best-effort only, and (b) ad hoc TTL cleanup of unrelated *temp upload
   sandboxes* (`routes.py:7350-7361`, `8613-8622`) — not the session dict
   itself. A comment in `session-lifecycle.js` says leaked sessions are
   handled by backend expiry, but that expiry isn't actually implemented
   for the main dict. **Port the ancestor's periodic sweep** — same idle
   threshold and shared-cache exception (don't evict a session whose dir is
   the shared extraction cache) — so long-running server instances don't
   accumulate abandoned sessions indefinitely.

## P3 — Optional: server-side chord/key analysis

8. This repo's chord logic (`src/chords.js`, `src/theory.js`, `main.js`) is
   entirely client-side and display-only — there is no Python equivalent of
   the ancestor's `chord_analysis.py` (Krumhansl-Schmuckler key detection,
   interval→chord-quality naming), and no `krumhansl`/`detect_key`-style
   hits anywhere in `routes.py` or `goplayalong.py`. If there's ever a need
   for offline/batch analysis (e.g. a headless import/export path, or
   server-side auto-naming at save time the way the ancestor does), the
   ancestor's module is a ready reference to port from rather than
   reinventing. **Not recommending this proactively** — only pursue it if a
   concrete use case appears; the current client-only approach is fine for
   an interactive editor.

## Explicitly not recommended

- Importing the ancestor's `SHARP_KEYS`-style hardcoded enharmonic table —
  this repo's `theory.js` formula-based approach (relative-major position,
  covering 7 modes) is already the more capable design; no action needed
  here, if anything the ancestor should adopt this repo's approach.
- Any change to the command-pattern undo/redo architecture
  (`state.js`/`history.js`/`commands.js`) — this repo's version (capped
  stack, `_arrIdx` tagging, lock/opt-out flags, checkpoints) is already
  more mature than the ancestor's; nothing to backport in that direction.
