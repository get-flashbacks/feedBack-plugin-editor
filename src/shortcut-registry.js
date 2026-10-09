// Host shortcut bridge (#38). Registers the editor's hardcoded editing keys
// (Delete / Backspace and the drum G / F / K articulation toggles) with the
// Host's `window.registerShortcut` API so they surface in the global `?` help
// panel and are scoped to this screen (`plugin-editor`). The Host dispatches
// them independently of the plugin's own `document` keydown listener, so each
// handler re-checks the read-only-lens / recording / mode guards `onKeyDown`
// applies — the registration is not a licence to act behind a modal.
//
// Degrades to a no-op under node / a Host without the API:
// `registerEditorShortcuts` only flips `editorShortcutState.registered` when
// the API exists, which is also the signal input.js's `onKeyDown` fallback
// path reads (while unregistered, input.js acts on the key itself).
//
// Rule 43 of the plugin best-practices guide: keep the returned handle and
// unregister when the screen tears down, so a re-injection doesn't stack
// stale shortcuts.

import { _recState } from './midi-record.js';
import { _editorIsTypingTarget } from './shortcuts.js';
import { editorToolPaletteOpen } from './tools.js';
import { editorShortcutState } from './shortcut-state.js';
import { _editorDeleteSelection, _editorDrumArticulation } from './input.js';

const SCOPE = 'plugin-editor';

// { key, handle } for every registration made by the live injection.
let _registered = [];

function _lensOpen(id) {
    if (typeof document === 'undefined') return false;
    const el = document.getElementById(id);
    return !!el && !el.classList.contains('hidden');
}

// The guards the host-dispatched handlers must reproduce: the editor screen is
// the active one, focus is not in a text field, no read-only lens is up, the
// tool palette isn't capturing keys, and a take isn't recording (onKeyDown
// blocks every mutating shortcut mid-take).
function _editorShortcutAllowed(e) {
    if (_editorIsTypingTarget(e)) return false;
    if (_recState === 'recording') return false;
    if (typeof document !== 'undefined') {
        const screen = document.getElementById('plugin-editor');
        if (!screen || !screen.classList.contains('active')) return false;
        if (_lensOpen('editor-tab-preview-modal') || _lensOpen('editor-user-guide-modal')) return false;
    }
    let paletteOpen = false;
    try { paletteOpen = editorToolPaletteOpen(); } catch (_) { paletteOpen = false; }
    return !paletteOpen;
}

// The registration carries no modifier field, so the Host may hand us a chord
// (Ctrl+F, Shift+Delete, …). Those belong to the shortcut-profile dispatch:
// Shift+Delete is the EOF "Cut", and a plain-key registration must never
// shadow a chord into a plain action — onKeyDown only ever claimed the
// unmodified key too.
function _hasModifier(e) {
    return !!(e && (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey));
}

// Delete / Backspace — one ordered ladder (see _editorDeleteSelection). The
// ladder owns the "claim without acting" cases internally; the handler only
// suppresses the browser default when the key was actually consumed.
function _onDeleteShortcut(e) {
    if (_hasModifier(e)) return;
    if (!_editorShortcutAllowed(e)) return;
    if (_editorDeleteSelection(e)) e.preventDefault();
}

// G / F / K — drum-edit articulation. `_editorDrumArticulation` re-checks the
// drum-mode + selection + modifier guard, so a stray press outside a drum
// selection (or a chord the profile owns) falls through untouched.
function _onDrumShortcut(kind) {
    return (e) => {
        if (_hasModifier(e)) return;
        if (!_editorShortcutAllowed(e)) return;
        if (_editorDrumArticulation(kind, e)) e.preventDefault();
    };
}

const _SHORTCUT_SPECS = [
    { key: 'Delete', description: 'Delete the current selection', handler: _onDeleteShortcut },
    { key: 'Backspace', description: 'Delete the current selection', handler: _onDeleteShortcut },
    { key: 'g', description: 'Toggle ghost notes on the selected drum hits', handler: _onDrumShortcut('g') },
    { key: 'f', description: 'Toggle flam on the selected drum hits', handler: _onDrumShortcut('f') },
    { key: 'k', description: 'Toggle choke on the selected cymbals', handler: _onDrumShortcut('k') },
];

export function registerEditorShortcuts() {
    if (editorShortcutState.registered) return;
    if (typeof window === 'undefined' || typeof window.registerShortcut !== 'function') return;
    const entries = [];
    try {
        for (const spec of _SHORTCUT_SPECS) {
            entries.push({
                key: spec.key,
                handle: window.registerShortcut({
                    key: spec.key,
                    handler: spec.handler,
                    description: spec.description,
                    scope: SCOPE,
                }),
            });
        }
    } catch (_) {
        // A partial registration is worse than none: the keys the host accepted
        // would double-fire (their handler plus the still-live onKeyDown
        // fallback) while the key that threw would be silently dead. Roll back
        // so onKeyDown owns every editing key exactly as before.
        _registered = entries;
        unregisterEditorShortcuts();
        return;
    }
    _registered = entries;
    editorShortcutState.registered = true;
}

export function unregisterEditorShortcuts() {
    for (const entry of _registered) {
        try {
            if (typeof entry.handle === 'function') entry.handle();
            else if (entry.handle && typeof entry.handle.unregister === 'function') entry.handle.unregister();
            else if (typeof window !== 'undefined' && typeof window.unregisterShortcut === 'function') {
                window.unregisterShortcut(entry.key, SCOPE);
            }
        } catch (_) { /* teardown must never throw */ }
    }
    _registered = [];
    editorShortcutState.registered = false;
}
