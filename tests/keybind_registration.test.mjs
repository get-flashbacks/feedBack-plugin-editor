/*
 * Keybind registration (#38) — the editing keys (Delete / Backspace, drum
 * G / F / K) handed to the Host's `window.registerShortcut` API.
 *
 * Asserts, at the behavior level:
 *   - the five keys register once each, scoped to `plugin-editor`, with a
 *     description (so they surface in the global `?` panel),
 *   - no registration (and no crash) when the Host API is absent,
 *   - the handlers re-check the typing-target and read-only-lens guards,
 *   - the Delete ladder is shared: notes / parts-view region / tempo rungs all
 *     run through the registered handler,
 *   - G / F / K toggle drum articulation through the registered handler,
 *   - teardown calls every returned unregister handle,
 *   - without the host registry, onKeyDown's fallback path still acts.
 *
 * Run: node --test tests/keybind_registration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert';

// ── DOM/global stubs (BEFORE any src import) ────────────────────────────────
const _lensHidden = { 'editor-tab-preview-modal': true, 'editor-user-guide-modal': true };
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
        if (id in _lensHidden) return { classList: { contains: (c) => (c === 'hidden' ? _lensHidden[id] : false) } };
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

const { registerEditorShortcuts, unregisterEditorShortcuts } = await import('../src/shortcut-registry.js');
const { editorShortcutState } = await import('../src/shortcut-state.js');
const { _editorDeleteSelection, onKeyDown } = await import('../src/input.js');
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

function startRegistration() {
    unregisterEditorShortcuts();
    registrations = [];
    unregisterCalls = [];
    hostCalls.draw = 0;
    hostCalls.updateStatus = 0;
    hostCalls.regionDelete = 0;
    hostCalls.regionDeleteResult = true;
    registerEditorShortcuts();
    const byKey = (k) => registrations.find(r => r.key === k);
    return byKey;
}

// ── Registration surface ────────────────────────────────────────────────────
test('registers the five editing keys, scoped to plugin-editor', () => {
    const byKey = startRegistration();
    assert.strictEqual(registrations.length, 5, 'exactly five registrations');
    for (const k of ['Delete', 'Backspace', 'g', 'f', 'k']) {
        const r = byKey(k);
        assert.ok(r, `key ${k} registered`);
        assert.strictEqual(r.scope, 'plugin-editor');
        assert.strictEqual(typeof r.handler, 'function');
        assert.ok(r.description && r.description.length > 0, `${k} has a description`);
    }
    assert.strictEqual(byKey('Delete').description, 'Delete the current selection');
    assert.strictEqual(byKey('Backspace').description, 'Delete the current selection');
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
        ['Backspace', 'Delete', 'f', 'g', 'k'],
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
