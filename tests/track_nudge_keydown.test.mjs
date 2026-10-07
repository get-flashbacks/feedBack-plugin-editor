/*
 * The #42 keyboard nudge chord, driven through the REAL onKeyDown.
 *
 * tests/track_nudge.test.mjs pins what a nudge DOES (steps, coalescing,
 * rollback, isolation); this suite pins the GATING of the chord itself:
 *
 *   1. Overview-only — it claims the key in the Tracks overview, and nowhere
 *      else (note view falls through to the ordinary dispatch).
 *   2. A live loop/bar selection (S.barSel) does NOT disable it: the loop-edge
 *      Alt+arrows handler sits BELOW the parts-view read-only guard, which
 *      returns unconditionally in the overview, so the two never meet whatever
 *      S.barSel holds — and the chord must not touch the loop region either.
 *   3. An editable target keeps the key (no nudge inside a text field).
 *   4. A non-audio selection falls through: no nudge, no undo entry.
 *   5. A held key still coalesces to ONE undo step through the keydown path.
 *
 * Run: node --test tests/track_nudge_keydown.test.mjs
 */
import assert from 'node:assert';

const screen = { classList: { contains: v => v === 'active' } };
const statusEl = { textContent: '' };
globalThis.document = {
    getElementById(id) {
        if (id === 'plugin-editor') return screen;
        if (id === 'editor-status') return statusEl;
        // Every other lookup (Tab-preview / User-guide modals, chrome buttons)
        // resolves to null = absent/closed, so the lenses at the top of
        // onKeyDown read as closed.
        return null;
    },
    addEventListener: () => {}, activeElement: null,
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { onKeyDown } = await import('../src/input.js');
const { S } = await import('../src/state.js');
const { setHostHooks } = await import('../src/host.js');
const { EditHistory } = await import('../src/history.js');
setHostHooks({ draw: () => {}, updateStatus: () => {}, ensureArr: () => true });

const target = kind => ({
    matches: selector => (kind === 'input' ? selector.includes('input') : false),
});
// Alt+Shift+→ by default — the fine nudge chord in the overview.
const event = (over = {}) => ({
    key: 'ArrowRight', code: 'ArrowRight',
    ctrlKey: false, metaKey: false, shiftKey: true, altKey: true,
    target: target('canvas'), defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
    ...over,
});
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const offsetOf = id => S.trackSession.tracks.find(t => t.id === id).offsetSec;

// Fresh state per case: overview live, one audio row + one transcription row,
// a loop region already set (the gate this suite exists to pin), and an empty
// history so entry counts are per-case.
function seed() {
    Object.assign(S, {
        arrangements: [{ name: 'Gtr', notes: [], chords: [] }],
        currentArr: 0,
        sel: new Set(),
        barSel: { startTime: 0, endTime: 4, mode: 'bar' },
        partsViewMode: true,
        tempoMapMode: false,
        drumEditMode: false,
        selectedTrackId: 'audio:Guitar_L',
        audioShift: 0,
        playing: false,
        history: new EditHistory(),
        trackSession: {
            version: 4,
            tracks: [
                { id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', name: 'Guitar L', parentId: '' },
                { id: 'notes:Gtr', type: 'transcription', targetId: 'Gtr', name: 'Gtr', parentId: '' },
            ],
            removedSourceIds: [],
            tempoGuideSourceId: '',
            tempoGuideLocked: false,
            tempoGuideMode: 'audio',
        },
    });
    return S;
}

// ── The chord fires in the overview even with a loop region live ─────────────
seed();
const live = event();
onKeyDown(live);
assert.ok(live.defaultPrevented, 'the chord claims Alt+Shift+arrow in the overview');
assert.ok(near(offsetOf('audio:Guitar_L'), 0.001), 'fine step = 1 ms');
assert.strictEqual(S.history.undo.length, 1, 'one press = one undo entry');
assert.deepStrictEqual(S.barSel, { startTime: 0, endTime: 4, mode: 'bar' },
    'a live loop region neither blocks the nudge nor gets nudged itself');

// ── Ctrl/Cmd takes the coarse step ───────────────────────────────────────────
seed();
const coarse = event({ ctrlKey: true });
onKeyDown(coarse);
assert.ok(coarse.defaultPrevented);
assert.ok(near(offsetOf('audio:Guitar_L'), 0.010), 'Ctrl = 10 ms');

seed();
const cmd = event({ metaKey: true });
onKeyDown(cmd);
assert.ok(near(offsetOf('audio:Guitar_L'), 0.010), 'Cmd = the same 10 ms step on macOS');

// ── Editable targets keep the key ────────────────────────────────────────────
seed();
const typed = event({ target: target('input') });
onKeyDown(typed);
assert.ok(!typed.defaultPrevented, 'a text field keeps the key');
assert.strictEqual(S.history.undo.length, 0, 'no nudge while typing');

// ── A non-audio selection falls through ──────────────────────────────────────
seed();
S.selectedTrackId = 'notes:Gtr';
const rows = event();
onKeyDown(rows);
assert.strictEqual(S.history.undo.length, 0, 'a transcription row is not a nudge target');
assert.strictEqual(offsetOf('audio:Guitar_L'), undefined, 'no track moved');

seed();
S.selectedTrackId = '';
const none = event();
onKeyDown(none);
assert.strictEqual(S.history.undo.length, 0, 'no selection = no nudge');

// ── Overview-only: note view falls through ───────────────────────────────────
seed();
S.partsViewMode = false;
S.barSel = null;
const noteView = event();
onKeyDown(noteView);
assert.strictEqual(S.history.undo.length, 0, 'the chord is local to the Tracks overview');
assert.strictEqual(offsetOf('audio:Guitar_L'), undefined, 'note view does not nudge');

// ── Holding the key through keydown still coalesces to ONE step ──────────────
seed();
onKeyDown(event());
onKeyDown(event());
onKeyDown(event());
assert.ok(near(offsetOf('audio:Guitar_L'), 0.003), 'all three presses applied');
assert.strictEqual(S.history.undo.length, 1, 'a held key is ONE undo step, not three');
S.history.doUndo();
assert.strictEqual(offsetOf('audio:Guitar_L'), undefined, 'one undo rolls the whole hold back');

console.log('track-nudge keydown gating passed');
