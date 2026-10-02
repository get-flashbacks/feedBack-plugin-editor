/*
 * Wiring test for the undo/redo shortcuts' typing-target gate (src/input.js
 * onKeyDown).
 *
 * Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Ctrl+Alt+Z are the editor's undo chords
 * (constitution §IV). A text field inside the editor — inspector numeric
 * entry, inline rename, the command-palette search — is a TEXT editor, not the
 * chart: those chords belong to the focused field, and must not dispatch into
 * S.history behind the user's back (nor preventDefault the browser's native
 * text undo).
 *
 * This drives the REAL onKeyDown with a stub DOM and a REAL EditHistory behind
 * the window entry points, so the two halves of the contract are asserted at
 * the stack level rather than at a dispatch counter:
 *
 *   - focus in a text field: nothing dispatches, the browser default stands,
 *     and the history stacks are exactly as they were;
 *   - focus on the chart: unchanged — every chord dispatches its window entry
 *     point, suppresses the browser default, and moves the stack.
 *
 * The fixture primes BOTH directions (a command applied on the undo stack, a
 * second command parked on the redo stack), so a chord that leaks can never
 * pass by hitting an empty stack.
 *
 * These assertions FAIL on pre-#6 input.js, where the three branches carried
 * no `_editorIsTypingTarget(e)` guard.
 *
 * Run: node --test tests/undo_typing_target.test.mjs
 */
import assert from 'node:assert';

// ── DOM/global stubs (BEFORE any src import) ────────────────────────────────
// onKeyDown reads three ids: the screen (must be active) and the two read-only
// lens modals (closed throughout — each has its own gate test).
const _screenEl = { classList: { contains: (c) => c === 'active' } };
const _hiddenEl = { classList: { contains: (c) => c === 'hidden' } };
globalThis.document = {
    getElementById(id) {
        if (id === 'plugin-editor') return _screenEl;
        if (id === 'editor-tab-preview-modal' || id === 'editor-user-guide-modal') return _hiddenEl;
        return null;
    },
    addEventListener: () => {},
    activeElement: null,
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { onKeyDown } = await import('../src/input.js');
const { S } = await import('../src/state.js');
const { EditHistory } = await import('../src/history.js');
const { seedState, trackHooks } = await import('./_history_env.mjs');

seedState({
    arrangements: [{ name: 'Lead', notes: [], chords: [] }],
    currentArr: 0,
    tempoMapMode: false,
    partsViewMode: false,
    drumEditMode: false,
    history: new EditHistory(),
});
trackHooks();

// The window entry points main.js installs, wired to the REAL history so a
// chord that leaks moves an actual command. The counters make a refusal
// distinguishable from a no-op dispatch on an empty stack.
const dispatched = { undo: 0, redo: 0, checkpoint: 0 };
window.editorUndo = () => { dispatched.undo++; S.history.doUndo(); };
window.editorRedo = () => { dispatched.redo++; S.history.doRedo(); };
window.editorUndoToCheckpoint = () => { dispatched.checkpoint++; S.history.undoToCheckpoint(); };

// The edit under test, and the shape of the stacks around it. `edit` is the
// one observable: each command's exec/rollback pair writes its own value, so
// any stack movement is visible in the number as well as in the stack depths.
const edit = { value: 0 };
const APPLIED = 1;                             // the edit sitting on the undo stack
const REDO_EXEC = 2, REDO_ROLLBACK = 3;       // the one parked on the redo stack
const cmdApplied = { exec() { edit.value = APPLIED; }, rollback() { edit.value = 0; } };
const cmdUndone = { exec() { edit.value = REDO_EXEC; }, rollback() { edit.value = REDO_ROLLBACK; } };

// `matches` is the only DOM surface `_editorIsTypingTarget` touches, so a tag
// name is the whole stand-in; the chart target matches nothing.
const target = tag => ({ matches: (sel) => sel.includes(tag) });
const CHART = { matches: () => false };
const TEXT_TARGETS = [target('input'), target('select'), target('textarea')];

const chord = over => ({
    key: 'z', code: '',
    ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
    _pd: false,
    preventDefault() { this._pd = true; },
    stopPropagation() {},
    ...over,
});

// Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, Ctrl+Alt+Z — and the macOS Cmd spelling of the
// plain undo. Each chord carries the state it must LEAVE behind on the chart:
// `cmdApplied` applied + `cmdUndone` waiting to be redone.
const CHORDS = [
    ['Ctrl+Z', { key: 'z' }, 'undo', { value: 0, undo: 0, redo: 2 }],
    ['Cmd+Z', { key: 'z', ctrlKey: false, metaKey: true }, 'undo', { value: 0, undo: 0, redo: 2 }],
    ['Ctrl+Shift+Z', { key: 'Z', shiftKey: true }, 'redo', { value: REDO_EXEC, undo: 2, redo: 0 }],
    ['Ctrl+Y', { key: 'y' }, 'redo', { value: REDO_EXEC, undo: 2, redo: 0 }],
    // With no checkpoint stamped on the stack, undoToCheckpoint degrades to a
    // single plain undo (src/history.js) — so it must land on the same state.
    ['Ctrl+Alt+Z', { key: 'z', altKey: true }, 'checkpoint', { value: 0, undo: 0, redo: 2 }],
];

// After priming, `cmdApplied` is applied (one command deep on the undo stack)
// and `cmdUndone` is rolled back (one deep on the redo stack).
const BEFORE = { value: REDO_ROLLBACK, undo: 1, redo: 1 };

// Two commands, then undo the second: one applied edit left on the undo stack
// (an undo that leaks rolls it back) and one parked on the redo stack (a redo
// that leaks re-applies it).
function resetStacks() {
    dispatched.undo = dispatched.redo = dispatched.checkpoint = 0;
    S.history.reset();
    S.history.exec(cmdApplied);
    S.history.exec(cmdUndone);
    S.history.doUndo();
}

function assertState(want, msg) {
    assert.strictEqual(edit.value, want.value, `${msg}: edit value`);
    assert.strictEqual(S.history.undo.length, want.undo, `${msg}: undo depth`);
    assert.strictEqual(S.history.redo.length, want.redo, `${msg}: redo depth`);
}

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

for (const [label, keys, action, afterChart] of CHORDS) {
    t(`${label} in a text field: no dispatch, the field keeps its own undo`, () => {
        for (const tgt of TEXT_TARGETS) {
            resetStacks();
            const e = chord({ ...keys, target: tgt });
            onKeyDown(e);
            assert.strictEqual(dispatched[action], 0,
                `${label} must not dispatch window.editor* while a text field has focus`);
            assert.ok(!e._pd, `${label} must stay unprevented so the field keeps its own undo`);
            assertState(BEFORE, `${label} while a text field has focus`);
        }
    });

    t(`${label} on the chart: dispatches and moves the history stack`, () => {
        resetStacks();
        const e = chord({ ...keys, target: CHART });
        onKeyDown(e);
        assert.strictEqual(dispatched[action], 1, `${label} must dispatch window.editor* on the chart`);
        assert.ok(e._pd, `${label} must preventDefault the browser default on the chart`);
        assertState(afterChart, `${label} on the chart`);
    });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);