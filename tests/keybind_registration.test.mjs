/*
 * Keybind registration (#38/#39) — the editor's keys handed to the Host's
 * `window.registerShortcut` API.
 *
 * Asserts, at the behavior level:
 *   - the seven keys (Delete / Backspace, drum G / F / K, Space, Escape)
 *     register once each, scoped to `plugin-editor`, with a description (so
 *     they surface in the global `?` panel),
 *   - no registration (and no crash) when the Host API is absent,
 *   - the handlers re-check the typing-target and read-only-lens guards,
 *   - the Delete ladder is shared: notes / parts-view region / tempo rungs all
 *     run through the registered handler,
 *   - G / F / K toggle drum articulation through the registered handler,
 *   - Space runs transport through the registered handler (live mid-take) and
 *     bails in a text field / under a lens / with the palette open,
 *   - Escape runs the shared dismissal ladder through the registered handler:
 *     lens close, menu close (selection intact), ghost-before-barline
 *     precedence, the parts-view/prompt guards, and no preventDefault when
 *     nothing owns it (so the Host's back-to-library survives),
 *   - with the registry active, `onKeyDown` stands down for every migrated key
 *     (no double-handling),
 *   - teardown calls every returned unregister handle,
 *   - without the host registry, onKeyDown's fallback path still acts.
 *
 * Run: node --test tests/keybind_registration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert';

// ── DOM/global stubs (BEFORE any src import) ────────────────────────────────
// id -> whether it currently carries the 'hidden' class. `_modalShown` (and
// hideContextMenu) read/write this so the Escape ladder sees the real state.
const _hidden = {
    'editor-tab-preview-modal': true,
    'editor-user-guide-modal': true,
    'editor-context-menu': true,
    'editor-add-note-dialog': true,
    'editor-load-modal': true,
    'editor-command-palette': true,
    'editor-tool-palette': true,
    'editor-text-prompt': true,
    'editor-choice-prompt': true,
};
const _overlayEl = (id) => ({
    id,
    classList: {
        add(c) { if (c === 'hidden') _hidden[id] = true; },
        remove(c) { if (c === 'hidden') _hidden[id] = false; },
        toggle(c, on) { _hidden[id] = on === undefined ? !_hidden[id] : !!on; },
        contains: (c) => (c === 'hidden' ? !!_hidden[id] : false),
    },
});
// The tool palette is the one overlay _renderPalette writes rows into.
const _paletteRows = { innerHTML: '' };
const _toolPaletteEl = {
    id: 'editor-tool-palette', style: {}, offsetHeight: 220,
    classList: {
        add(c) { if (c === 'hidden') _hidden['editor-tool-palette'] = true; },
        remove(c) { if (c === 'hidden') _hidden['editor-tool-palette'] = false; },
        toggle() {},
        contains: (c) => (c === 'hidden' ? !!_hidden['editor-tool-palette'] : false),
    },
    querySelector: () => _paletteRows,
};
const _els = {};
const _genericEl = (id) => (_els[id] ||= {
    id, disabled: false, value: '', textContent: '', innerHTML: '', style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    replaceChildren() {},
    focus() {}, blur() {},
});

globalThis.document = globalThis.document || {
    getElementById(id) {
        if (id === 'plugin-editor') return { classList: { contains: (c) => c === 'active' } };
        if (id === 'editor-tool-palette') return _toolPaletteEl;
        if (id in _hidden) return _overlayEl(id);
        return _genericEl(id);
    },
    createElement(tag) {
        return {
            tagName: tag, className: '', textContent: '', innerHTML: '', style: {},
            type: '', disabled: false,
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            appendChild() {}, replaceChildren() {}, setAttribute() {}, addEventListener() {},
            append() {}, remove() {},
            querySelector: () => null, querySelectorAll: () => [],
        };
    },
    addEventListener() {},
    activeElement: null,
};
globalThis.window = globalThis.window || globalThis;
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 0);
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {});

// The window entry points the Escape ladder / Space call. Recorders only.
const winCalls = { hideTabPreview: 0, toggleGuide: [], togglePlay: 0 };
window.editorHideTabPreview = () => { winCalls.hideTabPreview++; };
window.editorToggleUserGuide = (force) => { winCalls.toggleGuide.push(force); };
window.editorTogglePlay = () => { winCalls.togglePlay++; };

const { registerEditorShortcuts, unregisterEditorShortcuts } = await import('../src/shortcut-registry.js');
const { editorShortcutState } = await import('../src/shortcut-state.js');
const { _editorDeleteSelection, onKeyDown } = await import('../src/input.js');
const { _suggestCompute, _suggestActive, _suggestDismiss } = await import('../src/tempo-suggest.js');
const { editorOpenToolPalette, editorCloseToolPalette, editorToolPaletteOpen } = await import('../src/tools.js');
const { editorSetShortcutProfile } = await import('../src/shortcuts.js');
const { S } = await import('../src/state.js');
const { setHostHooks } = await import('../src/host.js');

// Host-callback recorders.
const hostCalls = { draw: 0, updateStatus: 0, regionDelete: 0, regionDeleteResult: true };
setHostHooks({
    draw: () => { hostCalls.draw++; },
    updateStatus: () => { hostCalls.updateStatus++; },
    ensureArr: () => true,
    partsViewRegionDelete: () => { hostCalls.regionDelete++; return hostCalls.regionDeleteResult; },
});

// `window.registerShortcut` capture. Each call returns a working handle.
let registrations = [];
let unregisterCalls = [];
let registerShortcutImpl = (spec) => {
    registrations.push(spec);
    return () => { unregisterCalls.push(spec.key); };
};
globalThis.registerShortcut = (spec) => registerShortcutImpl(spec);

let execs = 0;
function resetS(over = {}) {
    Object.assign(S, {
        arrangements: [{ name: 'Lead', notes: [{ time: 1, string: 2, fret: 3, sustain: 0, techniques: {} }], chords: [] }],
        currentArr: 0,
        sel: new Set([0]),
        drumEditMode: false,
        drumSel: new Set(),
        drumTab: null,
        tempoMapMode: false,
        partsViewMode: false,
        tempoSel: -1,
        tempoSelMulti: null,
        beats: [],
        history: { exec: () => { execs++; } },
        ...over,
    });
}

function ev(key, extra = {}) {
    return {
        key, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
        target: { matches: () => false },
        _pd: false,
        preventDefault() { this._pd = true; },
        stopPropagation() {},
        ...extra,
    };
}

// A 12-bar tempo grid at 120 BPM (beat = 0.5s) plus a uniform 16th-note onset
// train at 126 BPM — the fixture shape tests/tempo_suggest.test.mjs uses to
// make `_suggestCompute` propose ghosts.
function grid(bars, bpm) {
    const beat = 60 / bpm;
    const beats = [];
    for (let m = 0; m < bars; m++) {
        for (let b = 0; b < 4; b++) {
            beats.push({ time: (m * 4 + b) * beat, measure: b === 0 ? m + 1 : 0 });
        }
    }
    return beats;
}
function onsetsAllBeats(bpm, bars) {
    const beat = 60 / bpm;
    const out = [];
    for (let k = 0; k < bars * 4; k++) out.push({ t: k * beat, s: k % 4 === 0 ? 0.9 : 0.75 });
    return out;
}

function startRegistration() {
    unregisterEditorShortcuts();
    registrations = [];
    unregisterCalls = [];
    hostCalls.draw = 0;
    hostCalls.updateStatus = 0;
    hostCalls.regionDelete = 0;
    hostCalls.regionDeleteResult = true;
    winCalls.hideTabPreview = 0;
    winCalls.toggleGuide = [];
    winCalls.togglePlay = 0;
    for (const id of Object.keys(_hidden)) _hidden[id] = true;
    editorCloseToolPalette();
    _suggestDismiss();
    registerEditorShortcuts();
    const byKey = (k) => registrations.find(r => r.key === k);
    return byKey;
}

// ── Registration surface ────────────────────────────────────────────────────
test('registers the seven keys, scoped to plugin-editor', () => {
    const byKey = startRegistration();
    assert.strictEqual(registrations.length, 7, 'exactly seven registrations');
    for (const k of ['Delete', 'Backspace', 'g', 'f', 'k', 'Space', 'Escape']) {
        const r = byKey(k);
        assert.ok(r, `key ${k} registered`);
        assert.strictEqual(r.scope, 'plugin-editor');
        assert.strictEqual(typeof r.handler, 'function');
        assert.ok(r.description && r.description.length > 0, `${k} has a description`);
    }
    assert.strictEqual(byKey('Delete').description, 'Delete the current selection');
    assert.strictEqual(byKey('Backspace').description, 'Delete the current selection');
    assert.strictEqual(byKey('Space').description, 'Play / pause');
    assert.strictEqual(byKey('Escape').description, 'Close the top layer, or clear the selection');
    assert.strictEqual(editorShortcutState.registered, true);
});

test('no registration when the Host API is absent', () => {
    unregisterEditorShortcuts();
    registrations = [];
    const saved = globalThis.registerShortcut;
    delete globalThis.registerShortcut;
    try {
        registerEditorShortcuts();
        assert.strictEqual(registrations.length, 0);
        assert.strictEqual(editorShortcutState.registered, false);
    } finally {
        globalThis.registerShortcut = saved;
    }
});

test('teardown calls every returned unregister handle', () => {
    startRegistration();
    unregisterCalls = [];
    unregisterEditorShortcuts();
    assert.deepStrictEqual(
        unregisterCalls.slice().sort(),
        ['Backspace', 'Delete', 'Escape', 'Space', 'f', 'g', 'k'],
    );
    assert.strictEqual(editorShortcutState.registered, false);
});

// ── Delete / Backspace ladder through the registered handler ─────────────────
test('Delete handler: typing target does nothing, canvas target deletes', () => {
    const byKey = startRegistration();
    resetS();
    execs = 0;
    const typed = ev('Delete', { target: { matches: (sel) => String(sel).includes('input') } });
    byKey('Delete').handler(typed);
    assert.strictEqual(execs, 0, 'must not delete while a text field is focused');
    assert.strictEqual(typed._pd, false, 'no preventDefault on the typing guard');

    const canvas = ev('Delete');
    byKey('Delete').handler(canvas);
    assert.strictEqual(execs, 1, 'the note-delete rung execs a history command');
    assert.ok(canvas._pd, 'the consumed key is preventDefault-ed');
});

test('Delete handler: Tracks-overview region rung is the shared host callback', () => {
    const byKey = startRegistration();
    resetS({ partsViewMode: true, sel: new Set() });
    hostCalls.regionDelete = 0;
    hostCalls.regionDeleteResult = true;
    const e = ev('Delete');
    byKey('Delete').handler(e);
    assert.strictEqual(hostCalls.regionDelete, 1, 'partsViewRegionDelete consulted');
    assert.ok(e._pd, 'a consumed region delete prevents default');
});

test('Delete handler: tempo-map barline rung runs when a barline is selected', () => {
    const byKey = startRegistration();
    resetS({
        tempoMapMode: true,
        beats: [{ measure: 1 }, { measure: 2 }, { measure: 3 }, { measure: 4 }],
        tempoSel: 1,
    });
    execs = 0;
    const e = ev('Delete');
    byKey('Delete').handler(e);
    assert.strictEqual(execs, 1, 'the tempo rung execs a TempoGridCmd');
    assert.ok(e._pd);
});

test('_editorDeleteSelection ignores non-delete keys and empty selections', () => {
    resetS();
    assert.strictEqual(_editorDeleteSelection(ev('x')), false);
    assert.strictEqual(_editorDeleteSelection(ev('Delete', { target: { matches: () => false } })), true);
    S.sel = new Set();
    S.arrangements[0].notes = [];
    assert.strictEqual(_editorDeleteSelection(ev('Delete')), false);
});

// ── Modifier chords stay with the profile dispatch ───────────────────────────
test('registered Delete ignores modifier chords (Shift+Delete is EOF Cut)', () => {
    const byKey = startRegistration();
    resetS();
    execs = 0;
    byKey('Delete').handler(ev('Delete', { shiftKey: true }));
    byKey('Backspace').handler(ev('Backspace', { ctrlKey: true }));
    assert.strictEqual(execs, 0, 'a chord must not collapse to a plain note delete');
});

test('with the registry active, Shift+Delete still reaches the EOF Cut command', () => {
    startRegistration();
    resetS();
    editorSetShortcutProfile('eof');
    try {
        execs = 0;
        const e = ev('Delete', { shiftKey: true });
        onKeyDown(e);
        assert.strictEqual(execs, 1, 'cut execs DeleteNotesCmd through the EOF profile');
        assert.ok(e._pd);
    } finally {
        editorSetShortcutProfile('feedback');
    }
});

test('registered drum keys ignore modifier chords', () => {
    const byKey = startRegistration();
    resetS({ drumEditMode: true, drumSel: new Set([0]), drumTab: { hits: [{ t: 0, p: 'kick', v: 100 }] } });
    execs = 0;
    byKey('f').handler(ev('f', { ctrlKey: true }));
    byKey('g').handler(ev('g', { shiftKey: true }));
    assert.strictEqual(execs, 0, 'Ctrl+F / Shift+G stay with the profile dispatch');
});

// ── Space through the registered handler ─────────────────────────────────────
test('Space handler toggles the transport on the editor screen', () => {
    const byKey = startRegistration();
    resetS();
    winCalls.togglePlay = 0;
    const e = ev(' ');
    byKey('Space').handler(e);
    assert.strictEqual(winCalls.togglePlay, 1, 'Space runs togglePlay');
    assert.ok(e._pd, 'the consumed key is preventDefault-ed');
});

test('Space handler bails in a text field, under a lens, and with the palette open', () => {
    const byKey = startRegistration();
    resetS();
    winCalls.togglePlay = 0;
    byKey('Space').handler(ev(' ', { target: { matches: (sel) => String(sel).includes('input') } }));
    assert.strictEqual(winCalls.togglePlay, 0, 'typing target');

    _hidden['editor-user-guide-modal'] = false;
    byKey('Space').handler(ev(' '));
    assert.strictEqual(winCalls.togglePlay, 0, 'read-only lens swallows transport');
    _hidden['editor-user-guide-modal'] = true;

    editorOpenToolPalette('feedback');
    byKey('Space').handler(ev(' '));
    assert.strictEqual(winCalls.togglePlay, 0, 'palette is modal — Space stays out');
    editorCloseToolPalette();
});

test('Space handler ignores modifier chords', () => {
    const byKey = startRegistration();
    resetS();
    const e = ev(' ', { ctrlKey: true });
    byKey('Space').handler(e);
    assert.strictEqual(winCalls.togglePlay, 0);
    assert.strictEqual(e._pd, false);
});

// ── Escape through the registered handler ────────────────────────────────────
test('Escape handler closes the read-only lens: tab preview first, then guide', () => {
    const byKey = startRegistration();
    resetS();
    _hidden['editor-tab-preview-modal'] = false;
    const e = ev('Escape');
    byKey('Escape').handler(e);
    assert.strictEqual(winCalls.hideTabPreview, 1, 'tab-preview lens closed');
    assert.strictEqual(winCalls.toggleGuide.length, 0, 'guide untouched while preview is open');
    assert.ok(e._pd);

    _hidden['editor-tab-preview-modal'] = true;
    _hidden['editor-user-guide-modal'] = false;
    byKey('Escape').handler(ev('Escape'));
    assert.deepStrictEqual(winCalls.toggleGuide, [false], 'guide closed via toggle(false)');
});

test('Escape handler closes the context menu without clearing the selection', () => {
    const byKey = startRegistration();
    resetS();
    _hidden['editor-context-menu'] = false;
    const e = ev('Escape');
    byKey('Escape').handler(e);
    assert.strictEqual(_hidden['editor-context-menu'], true, 'menu closed');
    assert.strictEqual(S.sel.size, 1, 'selection left intact — the menu owned the key');
    assert.ok(e._pd);
});

test('Escape handler closes the tool palette', () => {
    const byKey = startRegistration();
    resetS();
    editorOpenToolPalette('feedback');
    assert.ok(editorToolPaletteOpen(), 'palette opened for the test');
    const e = ev('Escape');
    byKey('Escape').handler(e);
    assert.ok(!editorToolPaletteOpen(), 'palette closed');
    assert.ok(e._pd);
});

test('Escape handler: suggested-fit ghosts win over a barline multi-selection', () => {
    const byKey = startRegistration();
    resetS({ tempoMapMode: true, beats: grid(12, 120), tempoSelMulti: new Set([1, 2]) });
    _suggestCompute(0, onsetsAllBeats(126, 12));
    assert.ok(_suggestActive(), 'precondition: ghosts are showing');
    const e = ev('Escape');
    byKey('Escape').handler(e);
    assert.ok(!_suggestActive(), 'ghosts dismissed');
    assert.strictEqual(S.tempoSelMulti.size, 2, 'barline selection untouched — ghosts own Escape first');
    assert.ok(e._pd);
});

test('Escape handler clears a barline multi-selection when no ghosts show', () => {
    const byKey = startRegistration();
    resetS({ tempoMapMode: true, tempoSelMulti: new Set([1, 2]) });
    const e = ev('Escape');
    byKey('Escape').handler(e);
    assert.strictEqual(S.tempoSelMulti.size, 0, 'barline selection cleared');
    assert.ok(e._pd);
});

test('Escape handler clears the note selection as the last rung', () => {
    const byKey = startRegistration();
    resetS();
    const e = ev('Escape');
    byKey('Escape').handler(e);
    assert.strictEqual(S.sel.size, 0, 'note selection cleared');
    assert.ok(e._pd);
});

test('Escape handler with nothing to dismiss leaves the key to the Host', () => {
    const byKey = startRegistration();
    resetS({ sel: new Set() });
    const e = ev('Escape');
    byKey('Escape').handler(e);
    assert.strictEqual(e._pd, false, 'unowned Escape is not consumed — back-to-library survives');
});

test('Escape handler bails while a transient modal is open (selection intact)', () => {
    const byKey = startRegistration();
    resetS();
    _hidden['editor-command-palette'] = false;
    const e = ev('Escape');
    byKey('Escape').handler(e);
    assert.strictEqual(S.sel.size, 1, 'must not clear behind the palette');
    assert.strictEqual(e._pd, false, 'the modal owns the key');
});

test('Escape handler ignores modifier chords', () => {
    const byKey = startRegistration();
    resetS();
    const e = ev('Escape', { shiftKey: true });
    byKey('Escape').handler(e);
    assert.strictEqual(S.sel.size, 1);
    assert.strictEqual(e._pd, false);
});

test('Escape handler leaves the read-only Tracks overview to the Host', () => {
    const byKey = startRegistration();
    resetS({ partsViewMode: true });
    const e = ev('Escape');
    byKey('Escape').handler(e);
    assert.strictEqual(S.sel.size, 1, 'parts-view selection untouched, as before #39');
    assert.strictEqual(e._pd, false);
});

test('Escape handler yields to the in-app text and choice prompts', () => {
    const byKey = startRegistration();
    resetS();
    _hidden['editor-text-prompt'] = false;
    const e1 = ev('Escape');
    byKey('Escape').handler(e1);
    assert.strictEqual(S.sel.size, 1, 'selection not cleared behind a text prompt');
    assert.strictEqual(e1._pd, false);

    _hidden['editor-text-prompt'] = true;
    _hidden['editor-choice-prompt'] = false;
    const e2 = ev('Escape');
    byKey('Escape').handler(e2);
    assert.strictEqual(S.sel.size, 1, 'selection not cleared behind a choice prompt');
    assert.strictEqual(e2._pd, false);
});

test('Space handler accepts the Host token / code form of the event', () => {
    const byKey = startRegistration();
    resetS();
    winCalls.togglePlay = 0;
    byKey('Space').handler(ev('Space'));
    assert.strictEqual(winCalls.togglePlay, 1, 'token-shaped key string');
    byKey('Space').handler(ev('', { code: 'Space' }));
    assert.strictEqual(winCalls.togglePlay, 2, 'e.code === Space');
});

// ── No double-handling while the registry is active ──────────────────────────
test('with the registry active, onKeyDown stands down for every migrated key', () => {
    startRegistration();
    resetS();
    winCalls.togglePlay = 0;
    hostCalls.regionDelete = 0;
    execs = 0;

    onKeyDown(ev(' '));
    assert.strictEqual(winCalls.togglePlay, 0, 'Space not double-fired by the fallback listener');

    const esc = ev('Escape');
    onKeyDown(esc);
    assert.strictEqual(S.sel.size, 1, 'Escape not double-fired by the fallback listener');
    assert.strictEqual(esc._pd, false);

    onKeyDown(ev('Delete'));
    assert.strictEqual(execs, 0, 'Delete not double-fired by the fallback listener');
    assert.strictEqual(hostCalls.regionDelete, 0);
});

// ── Registration atomicity ────────────────────────────────────────────────────
test('a partial registration rolls back and keeps the onKeyDown fallback', () => {
    unregisterEditorShortcuts();
    registrations = [];
    unregisterCalls = [];
    const realImpl = registerShortcutImpl;
    let n = 0;
    registerShortcutImpl = (spec) => {
        registrations.push(spec);
        n++;
        if (n === 4) throw new Error('host rejects one key');
        return () => { unregisterCalls.push(spec.key); };
    };
    try {
        registerEditorShortcuts();
        assert.strictEqual(editorShortcutState.registered, false, 'a throw must not enable the fallback stand-down');
        assert.deepStrictEqual(unregisterCalls.slice().sort(), ['Backspace', 'Delete', 'g'],
            'the already-accepted handles are released');
    } finally {
        registerShortcutImpl = realImpl;
    }
});

test('Delete handler in tempo-map mode with no selection shows the hint', () => {
    const byKey = startRegistration();
    resetS({ tempoMapMode: true, tempoSel: -1 });
    execs = 0;
    const e = ev('Delete');
    byKey('Delete').handler(e);
    assert.strictEqual(execs, 0, 'nothing to delete');
    assert.ok(e._pd, 'consumed so the profile dispatch cannot double-handle it');
});

// ── Drum G / F / K through the registered handler ────────────────────────────
test('drum handler toggles articulation only with a drum selection', () => {
    const byKey = startRegistration();
    resetS();
    execs = 0;
    byKey('g').handler(ev('g'));
    assert.strictEqual(execs, 0, 'no drum selection → no-op');

    resetS({ drumEditMode: true, drumSel: new Set([0]), drumTab: { hits: [{ t: 0, p: 'kick', v: 100 }] } });
    execs = 0;
    const e = ev('g');
    byKey('g').handler(e);
    assert.strictEqual(execs, 1, 'a drum selection toggles ghost-note');
    assert.ok(e._pd);
});

// ── Fallback when the host registry is inactive ───────────────────────────────
test('onKeyDown fallback still runs the drum toggle without a host registry', () => {
    resetS({ drumEditMode: true, drumSel: new Set([0]), drumTab: { hits: [{ t: 0, p: 'kick', v: 100 }] } });
    unregisterEditorShortcuts();
    assert.strictEqual(editorShortcutState.registered, false);
    execs = 0;
    const e = ev('f');
    onKeyDown(e);
    assert.strictEqual(execs, 1, 'fallback path toggles flam');
    assert.ok(e._pd);
});

test('onKeyDown fallback still deletes the note selection without a host registry', () => {
    resetS();
    unregisterEditorShortcuts();
    execs = 0;
    const e = ev('Backspace');
    onKeyDown(e);
    assert.strictEqual(execs, 1, 'fallback path deletes the selected notes');
    assert.ok(e._pd);
});
