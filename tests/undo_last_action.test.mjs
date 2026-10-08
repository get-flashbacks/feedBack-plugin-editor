/*
 * Undo last-action label + Revert verb (issue #43: make the undo state
 * visible in the UI).
 *
 * A user who didn't watch the status line can't tell which key or button
 * would undo the last edit, or what it would undo. This suite pins the
 * mechanism that fixes that:
 *
 *   1. _commandLabelPure names a command from its class name (fallback) or its
 *      own `label` (override), with the override table winning for the
 *      ~40 named classes.
 *   2. EditHistory._afterEdit records the label on S.lastAction after every
 *      committed edit (exec, redo, and a coalesced merge).
 *   3. reset() and an empty stack clear S.lastAction (no stale label).
 *   4. editorRevertLastAction undoes the top entry, names what it reverted
 *      (or refused), and the label moves to the previous action after undo.
 *
 * Run: node --test tests/undo_last_action.test.mjs
 */
import assert from 'node:assert';

const screen = { classList: { contains: v => v === 'active' } };
const statusEl = { textContent: '' };
globalThis.document = {
    getElementById(id) {
        if (id === 'plugin-editor') return screen;
        if (id === 'editor-status') return statusEl;
        return null;
    },
    addEventListener: () => {}, activeElement: null,
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { S } = await import('../src/state.js');
const { setHostHooks } = await import('../src/host.js');
const { EditHistory, _commandLabelPure } = await import('../src/history.js');
const { DeleteNotesCmd, AddNoteCmd } = await import('../src/commands.js');
const { TrackOffsetCmd, MoveRegionCmd, PlaceRegionCmd, DeleteRegionCmd } = await import('../src/region-commands.js');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// Minimal command whose class name has no override entry.
class FooBarCmd { exec() {} rollback() {} }

// The two verb entry points the tests drive, wired like main.js does.
setHostHooks({ draw: () => {}, updateStatus: () => {}, ensureArr: () => true });
const setStatus = (m) => { statusEl.textContent = m; };
window.editorUndo = () => S.history && S.history.doUndo();
window.editorRevertLastAction = () => {
    if (!S.history || !S.history.undo.length) { setStatus('Nothing to revert.'); return; }
    const what = S.lastAction || 'this edit';
    const before = S.history.undo.length;
    S.history.doUndo();
    setStatus(S.history.undo.length < before
        ? `Reverted ${what}.`
        : `Could not revert ${what} — undo refused.`);
};

function seed() {
    Object.assign(S, {
        arrangements: [{ name: 'Gtr', notes: [1, 2, 3], chords: [] }],
        currentArr: 0,
        sel: new Set([0, 1]),
        lastAction: '',
        audioShift: 0,
        playing: false,
        history: new EditHistory(),
        trackSession: {
            version: 4,
            tracks: [
                { id: 'audio:master', type: 'audio', sourceId: 'master', name: 'Master Mix', parentId: '' },
                { id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', name: 'Guitar L', parentId: '' },
            ],
            removedSourceIds: [], tempoGuideSourceId: '', tempoGuideLocked: false, tempoGuideMode: 'audio',
        },
    });
    return S;
}

// ── _commandLabelPure: naming a command ─────────────────────────────────────
t('override table wins: DeleteNotesCmd → "delete notes"', () => {
    assert.strictEqual(_commandLabelPure(new DeleteNotesCmd([0])), 'delete notes');
    assert.strictEqual(_commandLabelPure(new AddNoteCmd({})), 'add a note');
    assert.strictEqual(_commandLabelPure(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.1 })), 'nudge the track offset');
    assert.strictEqual(_commandLabelPure(new MoveRegionCmd({})), 'move a region');
    assert.strictEqual(_commandLabelPure(new PlaceRegionCmd({})), 'place a region');
    assert.strictEqual(_commandLabelPure(new DeleteRegionCmd({})), 'delete a region');
});

t('fallback camel-splits an unknown *Cmd class name', () => {
    assert.strictEqual(_commandLabelPure(new FooBarCmd()), 'foo bar');
});

t('an explicit `label` on the command wins over the class name', () => {
    const c = new DeleteNotesCmd([0]);
    c.label = 'delete the selected notes';
    assert.strictEqual(_commandLabelPure(c), 'delete the selected notes');
});

t('null / nameless commands yield an empty label', () => {
    assert.strictEqual(_commandLabelPure(null), '');
    assert.strictEqual(_commandLabelPure({}), '');
});

// ── EditHistory records the label after a committed edit ────────────────────
t('exec records the last-action label on S.lastAction', () => {
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.1 }));
    assert.strictEqual(S.lastAction, 'nudge the track offset');
    assert.strictEqual(S.history.undo.length, 1);
});

t('the label tracks the MOST RECENT command, not the first', () => {
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.1 }));
    S.history.exec(new MoveRegionCmd({}));
    assert.strictEqual(S.lastAction, 'move a region', 'label advances with each commit');
});

t('a coalesced merge still advances the label (the newest nudge names it)', () => {
    seed();
    const a = new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.001 });
    a.coalesce = true;
    const b = new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0.001, newSec: 0.002 });
    b.coalesce = true;
    S.history.exec(a);
    S.history.exec(b);
    assert.strictEqual(S.history.undo.length, 1, 'the two nudges coalesced');
    assert.strictEqual(S.lastAction, 'nudge the track offset', 'merge keeps the same label');
});

t('redo restores the label of the redone command', () => {
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.1 }));
    S.history.exec(new MoveRegionCmd({}));
    S.history.doUndo();
    assert.strictEqual(S.lastAction, 'nudge the track offset', 'undo names the NEXT action');
    S.history.doRedo();
    assert.strictEqual(S.lastAction, 'move a region', 'redo names what was redone');
});

// ── Clearing the label ───────────────────────────────────────────────────────
t('reset() clears the label', () => {
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.1 }));
    assert.strictEqual(S.lastAction, 'nudge the track offset');
    S.history.reset();
    assert.strictEqual(S.lastAction, '', 'reset() clears the label');
});

t('undoing the last entry leaves the label at the previous action', () => {
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.1 }));
    S.history.exec(new MoveRegionCmd({}));
    S.history.doUndo();
    assert.strictEqual(S.lastAction, 'nudge the track offset', 'label rolls back with the stack');
    S.history.doUndo();
    assert.strictEqual(S.lastAction, '', 'empty stack = empty label');
});

// ── editorRevertLastAction: the verb ─────────────────────────────────────────
t('Revert undoes the top entry and names what it reverted', () => {
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.1 }));
    window.editorRevertLastAction();
    assert.strictEqual(S.history.undo.length, 0, 'one Revert = one undo');
    assert.strictEqual(statusEl.textContent, 'Reverted nudge the track offset.');
});

t('Revert with an empty stack says so and does nothing', () => {
    seed();
    window.editorRevertLastAction();
    assert.strictEqual(S.history.undo.length, 0);
    assert.strictEqual(statusEl.textContent, 'Nothing to revert.');
});

t('Revert names the fallback when the command had no label', () => {
    seed();
    const c = new FooBarCmd();
    c.exec = () => { S.sel.add(0); };
    c.rollback = () => { S.sel.delete(0); };
    S.history.exec(c);
    window.editorRevertLastAction();
    assert.strictEqual(statusEl.textContent, 'Reverted foo bar.');
});

t('Revert after a refused undo reports the refusal and keeps the stack', () => {
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.1 }));
    // Refuse the undo by making the arrangement guard fail.
    setHostHooks({ draw: () => {}, updateStatus: () => {}, ensureArr: () => false });
    window.editorRevertLastAction();
    assert.strictEqual(S.history.undo.length, 1, 'the refused command stays on the stack');
    assert.strictEqual(statusEl.textContent, 'Could not revert nudge the track offset — undo refused.');
    setHostHooks({ draw: () => {}, updateStatus: () => {}, ensureArr: () => true });
});

// ── Round-trip: exec → rollback → redo ───────────────────────────────────────
t('round-trip: exec → rollback (deep-equal) → redo', () => {
    seed();
    const row = S.trackSession.tracks.find(x => x.id === 'audio:Guitar_L');
    const snapshot = JSON.parse(JSON.stringify(row));
    const cmd = new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.123 });
    S.history.exec(cmd);
    assert.ok(near(row.offsetSec, 0.123), 'exec applied');
    cmd.rollback();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(row)), snapshot, 'rollback restores the row exactly');
    cmd.exec();
    assert.ok(near(row.offsetSec, 0.123), 'redo re-applies');
});

console.log(`\nundo_last_action: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
