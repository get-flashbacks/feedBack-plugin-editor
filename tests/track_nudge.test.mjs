/*
 * Per-track offset — keyboard nudge, numeric step sizes and undo coalescing
 * (issue #42 step 2 of 3).
 *
 * #41 shipped the data model + the `editorSetTrackOffset` / `editorNudgeTrackOffset`
 * verbs (see tests/track_offset.test.mjs). This suite pins the #42 layer on top:
 *
 *   1. The nudge step sizes (fine 1 ms / coarse 10 ms) and the resolver.
 *   2. The UndoHistory coalescing rule — the headline ask of #42 is "holding or
 *      repeating a nudge does NOT produce dozens of undo entries." EditHistory
 *      only merges an unbroken run of live nudges on the SAME target; an undone
 *      stack (redo non-empty), a redo-restored step (doUndo cleared its
 *      `coalesce`), an explicit set, or a nudge on another track breaks the
 *      chain. This is opt-in (TrackOffsetCmd.coalesce + merge).
 *   3. Isolation — a nudge moves only its own track and never the global shift.
 *   4. The merge path keeps THIS command's original rollback snapshot (it does
 *      NOT re-run exec(), which would corrupt rollback), so undo restores the
 *      chain's true origin instead of the post-merge value.
 *
 * Run: node tests/track_nudge.test.mjs
 */
import assert from 'node:assert';
import {
    editorSetTrackOffset, editorNudgeTrackOffset,
    _editorTrackOffsetNudgeStepSec,
    TRACK_OFFSET_NUDGE_FINE_SEC, TRACK_OFFSET_NUDGE_COARSE_SEC,
} from '../src/audio.js';
import { TrackOffsetCmd } from '../src/region-commands.js';
import { _trackPlacementPure } from '../src/region.js';
import { S } from '../src/state.js';
import { EditHistory } from '../src/history.js';
import { seedState, trackHooks, lastStatus } from './_history_env.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// Three rows: two AUDIO tracks (+ a sibling we nudge one of), one folder, one
// transcription — enough to assert a nudge is placement-only and isolated.
function seed({ audioShift = 0 } = {}) {
    trackHooks();
    seedState({
        arrangements: [{ name: 'Gtr', notes: [], chords: [] }],
        currentArr: 0,
        audioShift,
        playing: false,
        trackSession: {
            version: 4,
            tracks: [
                { id: 'audio:master', type: 'audio', sourceId: 'master', name: 'Master Mix', parentId: '' },
                { id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', name: 'Guitar L', parentId: '' },
                { id: 'folder:1', type: 'folder', name: 'Gtrs', parentId: '', collapsed: false },
                { id: 'notes:Gtr', type: 'transcription', targetId: 'Gtr', name: 'Gtr', parentId: 'folder:1' },
            ],
            removedSourceIds: [],
            tempoGuideSourceId: '',
            tempoGuideLocked: false,
            tempoGuideMode: 'audio',
        },
        history: new EditHistory(),
    });
    return S;
}
const track = (id) => S.trackSession.tracks.find(x => x.id === id);
const setTrackOffset = (id, sec) => {
    const row = track(id);
    if (sec) row.offsetSec = sec; else delete row.offsetSec;
};

// ── Step sizes ───────────────────────────────────────────────────────────────
t('nudge step sizes: fine is 1 ms, coarse is 10 ms', () => {
    assert.strictEqual(TRACK_OFFSET_NUDGE_FINE_SEC, 0.001, 'fine = 1 ms');
    assert.strictEqual(TRACK_OFFSET_NUDGE_COARSE_SEC, 0.01, 'coarse = 10 ms');
    assert.strictEqual(_editorTrackOffsetNudgeStepSec(false), 0.001);
    assert.strictEqual(_editorTrackOffsetNudgeStepSec(true), 0.01);
    assert.strictEqual(_editorTrackOffsetNudgeStepSec(), 0.001, 'defaults to fine');
});

t('editorNudgeTrackOffset applies the caller-given delta at 1 ms resolution', () => {
    seed();
    editorSetTrackOffset('audio:Guitar_L', 0.2);
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.201), 'fine +1ms');
    editorNudgeTrackOffset('audio:Guitar_L', -TRACK_OFFSET_NUDGE_COARSE_SEC);
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.191), 'coarse -10ms');
    // Nudging back to the original value removes the key — no residue.
    editorNudgeTrackOffset('audio:Guitar_L', -0.191);
    assert.ok(!('offsetSec' in track('audio:Guitar_L')), 'nudged back to 0 → key deleted');
});

// ── Coalescing rule ──────────────────────────────────────────────────────────
t('TrackOffsetCmd.merge only absorbs a same-track nudge and advances newSec', () => {
    const a = new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.001 });
    a.coalesce = true;
    const b = new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0.001, newSec: 0.002 });
    assert.strictEqual(a.merge(b), true, 'same track merges');
    assert.strictEqual(a.newSec, 0.002, 'target advanced to the newest value');
    const c = new TrackOffsetCmd({ trackId: 'audio:master', oldSec: 0, newSec: 0.001 });
    assert.strictEqual(a.merge(c), false, 'different track does not merge');
});

t('consecutive nudges on the same track coalesce into ONE undo step', () => {
    seed();
    editorSetTrackOffset('audio:Guitar_L', 0.2);              // discrete set  -> step 1 (coalesce off)
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // first nudge -> step 2
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // merge into step 2
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // merge into step 2
    assert.strictEqual(S.history.undo.length, 2, 'set + ONE merged nudge, not one-per-nudge');
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.203), 'all three deltas applied');
    S.history.doUndo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.2), 'one undo rolls back ALL nudges to 0.2');
    S.history.doRedo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.203), 'redo re-applies the merged delta');
});

t('an explicit set BREAKS a nudge run (sets are never coalesced)', () => {
    seed();
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // step 1
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // merge -> step 1
    editorSetTrackOffset('audio:Guitar_L', 0.5);  // explicit set -> fresh step
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // prev is a set -> fresh step
    assert.strictEqual(S.history.undo.length, 3, 'nudge-run, set, nudge -> 3 discrete steps');
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.501));
    S.history.doUndo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.5), 'undo lands on the explicit set');
    S.history.doUndo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.002), 'undo again lands on the merged run');
});

t('a nudge on another track BREAKS the coalescing run', () => {
    seed();
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);   // step 1 (Guitar)
    editorNudgeTrackOffset('audio:master', TRACK_OFFSET_NUDGE_FINE_SEC);     // diff track -> step 2
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);   // prev is master nudge -> step 3
    assert.strictEqual(S.history.undo.length, 3, 'per-target; no cross-track merge');
});

t('undo BETWEEN nudges breaks the run (the redo stack is the run-breaker)', () => {
    seed();
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // step 1
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // merge -> step 1
    assert.strictEqual(S.history.undo.length, 1);
    S.history.doUndo();                                                     // chain broken (redo non-empty)
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // fresh step
    assert.strictEqual(S.history.undo.length, 1, 'a nudge after undo starts a new step, not a merge');
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.001));
    assert.strictEqual(S.history.redo.length, 0, 'the fresh nudge cleared the redo stack');
});

t('undo → REDO also breaks the run — a redo-restored step is never re-opened', () => {
    seed();
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // step 1
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // merge -> step 1 (0.002)
    assert.strictEqual(S.history.undo.length, 1);
    S.history.doUndo();
    S.history.doRedo();                                                     // redo stack empty again
    assert.strictEqual(S.history.undo.length, 1);
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // must NOT re-merge
    assert.strictEqual(S.history.undo.length, 2, 'a nudge after undo→redo starts a fresh step');
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.003), 'all three deltas applied');
    S.history.doUndo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.002),
        'undo lands on the redo-restored state — never past it');
    S.history.doUndo();
    assert.ok(!('offsetSec' in track('audio:Guitar_L')), 'the pre-undo run still rolls back to its origin (no key)');
});

t('merge refuses WITHOUT mutating newSec when the target track is gone', () => {
    seed();
    const orphan = new TrackOffsetCmd({ trackId: 'audio:deleted', oldSec: 0, newSec: 0.001 });
    orphan.coalesce = true;
    const next = new TrackOffsetCmd({ trackId: 'audio:deleted', oldSec: 0.001, newSec: 0.002 });
    assert.strictEqual(orphan.merge(next), false, 'no track to write to');
    assert.strictEqual(orphan.newSec, 0.001, 'a refused merge leaves the stack entry as it was');
});

t('two explicit sets are TWO steps (coalesce stays off for the typed-value verb)', () => {
    seed();
    editorSetTrackOffset('audio:Guitar_L', 0.1);
    editorSetTrackOffset('audio:Guitar_L', 0.2);
    assert.strictEqual(S.history.undo.length, 2);
    S.history.doUndo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.1));
    S.history.doRedo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.2));
});

t('coalesce merge keeps the ORIGINAL rollback snapshot — undo restores the pre-nudge value', () => {
    seed();
    editorSetTrackOffset('audio:Guitar_L', 0.5);                                  // pre-existing offset (discrete step)
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // 0.501
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_FINE_SEC);  // 0.502 (merged)
    assert.strictEqual(S.history.undo.length, 2, 'set-pre + one merged nudge step');
    S.history.doUndo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.5), 'undo restores the ORIGINAL 0.5, not 0.501');
    S.history.doRedo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.502));
});

// ── Isolation ────────────────────────────────────────────────────────────────
t('nudging one track leaves every sibling and the global shift exactly where they were', () => {
    seed({ audioShift: 1 });
    setTrackOffset('audio:master', -0.5);
    editorNudgeTrackOffset('audio:Guitar_L', 2);  // large nudge, still one undo step
    assert.strictEqual(S.audioShift, 1, 'global shift untouched');
    assert.strictEqual(track('audio:master').offsetSec, -0.5, 'sibling track untouched');
    assert.ok(near(track('audio:Guitar_L').offsetSec, 2), 'target moved');
    const masterPlacement = _trackPlacementPure(S.audioShift, 0, track('audio:master').offsetSec);
    const gtrPlacement = _trackPlacementPure(S.audioShift, 0, track('audio:Guitar_L').offsetSec);
    assert.ok(near(gtrPlacement - masterPlacement, 2.5), 'relative slide = master(-0.5) + this track(+2)');
    assert.strictEqual(S.history.undo.length, 1);
});

t('nudge verb refuses non-audio targets and garbage deltas (no undo step)', () => {
    seed();
    for (const id of ['folder:1', 'notes:Gtr', 'nope', undefined]) {
        assert.strictEqual(editorNudgeTrackOffset(id, 0.001), false, String(id));
    }
    assert.strictEqual(editorNudgeTrackOffset('audio:Guitar_L', 'abc'), false);
    assert.strictEqual(editorNudgeTrackOffset('audio:Guitar_L', NaN), false);
    assert.strictEqual(editorNudgeTrackOffset('audio:Guitar_L', Infinity), false);
    assert.strictEqual(S.history.undo.length, 0, 'no nudge reaches the stack for bad inputs');
});

t('a zero-delta nudge is a no-op (no merge, no push, no status noise)', () => {
    seed();
    setTrackOffset('audio:Guitar_L', 0.5);
    assert.strictEqual(editorNudgeTrackOffset('audio:Guitar_L', 0), false);
    assert.strictEqual(S.history.undo.length, 0);
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.5));
});

t('a sub-millisecond delta below the 1ms boundary is a silent no-op', () => {
    seed();
    setTrackOffset('audio:Guitar_L', 0.5);
    // 0.5001 rounds to 500 ms → 0.5: no real change → no command pushed.
    assert.strictEqual(editorNudgeTrackOffset('audio:Guitar_L', 0.0001), false);
    assert.strictEqual(S.history.undo.length, 0, 'no step for a delta lost to 1ms rounding');
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.5));
});

t('a sub-millisecond delta that crosses a 1ms boundary still registers', () => {
    seed();
    setTrackOffset('audio:Guitar_L', 0.5);
    // 0.5006 rounds to 501 ms → +1ms: a real change despite the tiny delta.
    assert.strictEqual(editorNudgeTrackOffset('audio:Guitar_L', 0.0006), true);
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.501, 'rounded up to the next millisecond');
    assert.strictEqual(S.history.undo.length, 1);
});

// ── Status line ──────────────────────────────────────────────────────────────
t('a nudge reports the step in the status line', () => {
    seed();
    editorNudgeTrackOffset('audio:Guitar_L', TRACK_OFFSET_NUDGE_COARSE_SEC);
    assert.ok(/Track offset \+10ms/.test(lastStatus()));
    assert.ok(/Guitar L/.test(lastStatus()));
});

console.log(`\n${pass} passed, ${fail} failed`);
