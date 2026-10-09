/*
 * Region MOVE by keyboard nudge + exact beat prompt (issue #42, the region half
 * of the per-track offset work).
 *
 * #42's headline ask: "holding or repeating a nudge does NOT produce dozens of
 * undo entries." The track half (PR #59, tests/track_nudge.test.mjs) pinned the
 * coalescing rule for TrackOffsetCmd; this suite pins it for the REGION move,
 * which had the keyboard/numeric surfaces deferred until now.
 *
 * Pinned here:
 *   1. The step sizes — fine is ONE BEAT, coarse is ONE BAR read from the grid's
 *      own downbeats (so a waltz follows 3, not a hard-coded 4).
 *   2. The beat-0 clamp (`regionMinContainedBeat`): a leftward step is clamped to
 *      where the region's earliest contained onset sits, and refused at the floor.
 *   3. MoveRegionCmd.merge folds a consecutive nudge of the SAME region into the
 *      previous undo entry WITHOUT re-snapshotting, so undo restores the run's
 *      true origin. Different region/track breaks the run.
 *   4. `_partsViewRegionNudge` drives the real command through S.history: one
 *      entry for a held run, and it rides a BOUNDED window as well as content.
 *   5. Gates: only the Tracks overview with a selected transcription region.
 *
 * Run: node tests/region_nudge.test.mjs
 */
import assert from 'node:assert';

import { seedState, trackHooks, lastStatus } from './_history_env.mjs';
import { _regionNudgeStepBeatsPure } from '../src/region.js';
import { MoveRegionCmd, regionMinContainedBeat } from '../src/region-commands.js';
import { EditHistory } from '../src/history.js';
import { S } from '../src/state.js';

let pass = 0; let fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// Constant 120 BPM (0.5 s/beat), 4 beats/bar.
function constGrid() {
    const b = [];
    for (let i = 0; i < 13; i++) b.push({ time: i * 0.5, measure: i % 4 === 0 ? i / 4 + 1 : 0 });
    return b;
}
// 3/4 waltz: bars at beats 0, 3, 6, 9.
function waltzGrid() {
    const b = [];
    for (let i = 0; i < 10; i++) b.push({ time: i * 0.5, measure: i % 3 === 0 ? i / 3 + 1 : 0 });
    return b;
}
const note = (time, sustain = 0, string = 0, fret = 0) => ({ time, sustain, string, fret, techniques: {} });

const { _partsViewRegionNudge, _partsViewRegionPromptMove } = await import('../src/parts-view.js');

function seedNotation({ beats = constGrid(), notes, regions } = {}) {
    const arr = { name: 'Lead', notes };
    const trackSession = {
        version: 3, tracks: [
            { id: 'transcription:Lead', type: 'transcription', targetId: 'Lead', ...(regions ? { regions } : {}) },
        ], removedSourceIds: [], tempoGuideSourceId: '', tempoGuideLocked: false, tempoGuideMode: 'audio',
    };
    seedState({ arrangements: [arr], currentArr: 0, beats, drumTab: null, trackSession,
        audioUrl: '', stems: [], stemLinks: {}, partsViewMode: true,
        selectedTrackId: 'transcription:Lead', selectedRegionId: '' });
    S.history = new EditHistory();
    trackHooks();
    return arr;
}
const track = (id) => S.trackSession.tracks.find(x => x.id === id);

// ── Step sizes ───────────────────────────────────────────────────────────────
t('_regionNudgeStepBeatsPure: fine is one beat; coarse reads the grid bar', () => {
    assert.strictEqual(_regionNudgeStepBeatsPure(constGrid(), false), 1, 'fine = 1 beat');
    assert.strictEqual(_regionNudgeStepBeatsPure(constGrid(), true), 4, 'coarse = the 4/4 bar');
    assert.strictEqual(_regionNudgeStepBeatsPure(waltzGrid(), true), 3, 'coarse follows a 3/4 waltz');
    assert.strictEqual(_regionNudgeStepBeatsPure([], true), 4, 'no grid → 4-beat fallback');
    assert.strictEqual(_regionNudgeStepBeatsPure([{ time: 0, measure: 1 }], true), 4, 'one downbeat → fallback');
});

// ── Beat-0 clamp helper ──────────────────────────────────────────────────────
t('regionMinContainedBeat: earliest owned onset, window-scoped; null on empty', () => {
    const regions = [{ id: 'A', startBeat: 0, lenBeat: 4 }, { id: 'B', startBeat: 4, lenBeat: 4 }];
    seedNotation({ notes: [note(0.5), note(2.0), note(2.5)], regions });   // beats 1, 4, 5
    assert.strictEqual(regionMinContainedBeat('notation', 0, { id: 'A', startBeat: 0, lenBeat: 4 }), 1);
    assert.strictEqual(regionMinContainedBeat('notation', 0, { id: 'B', startBeat: 4, lenBeat: 4 }), 4);
    assert.strictEqual(regionMinContainedBeat('notation', 0, { id: 'region:1', startBeat: 0, lenBeat: null }), 1, 'default sees all');
    assert.strictEqual(regionMinContainedBeat('notation', 0, { id: 'Z', startBeat: 100, lenBeat: 4 }), null, 'empty window → null');
});

// ── MoveRegionCmd.merge (the coalescing core) ────────────────────────────────
t('MoveRegionCmd.merge: same region folds the delta; rollback restores the ORIGIN', () => {
    const arr = seedNotation({ notes: [note(0.5), note(1.0)], regions: [{ id: 'A', startBeat: 0, lenBeat: 4 }] });
    const a = new MoveRegionCmd({ kind: 'notation', arrIdx: 0, trackId: 'transcription:Lead',
        region: { id: 'A', startBeat: 0, lenBeat: 4 }, dBeat: 1 });
    a.coalesce = true;
    a.exec();
    assert.deepStrictEqual(arr.notes.map(n => n.time), [1.0, 1.5], 'first nudge +1 beat');
    const next = new MoveRegionCmd({ kind: 'notation', arrIdx: 0, trackId: 'transcription:Lead',
        region: { id: 'A', startBeat: 1, lenBeat: 4 }, dBeat: 1 });
    assert.strictEqual(a.merge(next), true, 'same region merges');
    assert.strictEqual(a.dBeat, 2, 'delta accumulated');
    assert.deepStrictEqual(arr.notes.map(n => n.time), [1.5, 2.0], 're-applied from the origin at +2 beats');
    assert.strictEqual(track('transcription:Lead').regions[0].startBeat, 2, 'window rode the merged delta');
    a.rollback();
    assert.deepStrictEqual(arr.notes.map(n => n.time), [0.5, 1.0], 'rollback restores the run ORIGIN, not the prior keystroke');
    assert.strictEqual(track('transcription:Lead').regions[0].startBeat, 0, 'window restored to origin');
});

t('MoveRegionCmd.merge: different region or track refuses; unexecuted command refuses', () => {
    seedNotation({ notes: [note(0.5)], regions: [{ id: 'A', startBeat: 0, lenBeat: 4 }, { id: 'B', startBeat: 4, lenBeat: 4 }] });
    const a = new MoveRegionCmd({ kind: 'notation', arrIdx: 0, trackId: 'transcription:Lead', region: { id: 'A', startBeat: 0, lenBeat: 4 }, dBeat: 1 });
    a.coalesce = true; a.exec();
    assert.strictEqual(a.merge(new MoveRegionCmd({ kind: 'notation', arrIdx: 0, trackId: 'transcription:Lead', region: { id: 'B', startBeat: 4, lenBeat: 4 }, dBeat: 1 })), false, 'different region');
    assert.strictEqual(a.merge(new MoveRegionCmd({ kind: 'notation', arrIdx: 0, trackId: 'transcription:Other', region: { id: 'A', startBeat: 0, lenBeat: 4 }, dBeat: 1 })), false, 'different track');
    assert.strictEqual(a.merge(new MoveRegionCmd({ kind: 'notation', arrIdx: 0, trackId: 'transcription:Lead', region: { id: 'A', startBeat: 0, lenBeat: 4 }, dBeat: 0 })), false, 'zero delta');
    const fresh = new MoveRegionCmd({ kind: 'notation', arrIdx: 0, trackId: 'transcription:Lead', region: { id: 'A', startBeat: 0, lenBeat: 4 }, dBeat: 1 });
    fresh.coalesce = true;
    assert.strictEqual(fresh.merge(new MoveRegionCmd({ kind: 'notation', arrIdx: 0, trackId: 'transcription:Lead', region: { id: 'A', startBeat: 0, lenBeat: 4 }, dBeat: 1 })), false, 'never exec’d → no snapshot');
});

// ── _partsViewRegionNudge: the verb ──────────────────────────────────────────
t('nudge fine (+1 beat) moves content; a held run is ONE undo step that restores the origin', () => {
    const arr = seedNotation({ notes: [note(1.0), note(1.5)] });   // beats 2, 3, default region
    S.selectedRegionId = 'region:1';
    assert.strictEqual(_partsViewRegionNudge(+1, false), true);
    assert.deepStrictEqual(arr.notes.map(n => n.time), [1.5, 2.0], '+1 beat');
    assert.strictEqual(S.history.undo.length, 1);
    assert.strictEqual(_partsViewRegionNudge(+1, false), true);
    assert.strictEqual(_partsViewRegionNudge(+1, false), true);
    assert.strictEqual(S.history.undo.length, 1, 'three presses coalesce into ONE entry');
    assert.deepStrictEqual(arr.notes.map(n => n.time), [2.5, 3.0], 'all three beats applied');
    S.history.doUndo();
    assert.deepStrictEqual(arr.notes.map(n => n.time), [1.0, 1.5], 'one undo restores the whole run');
    S.history.doRedo();
    assert.deepStrictEqual(arr.notes.map(n => n.time), [2.5, 3.0], 'redo re-applies the merged delta');
});

t('nudge coarse shifts by one BAR and rides a BOUNDED window', () => {
    const arr = seedNotation({ notes: [note(2.0), note(2.5)], regions: [{ id: 'B', startBeat: 4, lenBeat: 4 }] });   // beats 4, 5
    S.selectedRegionId = 'B';
    assert.strictEqual(_partsViewRegionNudge(+1, true), true);
    assert.deepStrictEqual(arr.notes.map(n => n.time), [4.0, 4.5], 'content +4 beats (one 4/4 bar)');
    assert.strictEqual(track('transcription:Lead').regions[0].startBeat, 8, 'window rode +4 beats');
    S.history.doUndo();
    assert.deepStrictEqual(arr.notes.map(n => n.time), [2.0, 2.5], 'undo restores content');
    assert.strictEqual(track('transcription:Lead').regions[0].startBeat, 4, 'and window');
});

t('a leftward step is clamped to beat 0 and refused at the floor', () => {
    // Region at startBeat 4, earliest onset at beat 4: a coarse (-4) step lands
    // the region exactly on beat 0.
    const arr = seedNotation({ notes: [note(2.0)], regions: [{ id: 'B', startBeat: 4, lenBeat: 4 }] });
    S.selectedRegionId = 'B';
    assert.strictEqual(_partsViewRegionNudge(-1, true), true, 'clamped, not refused');
    assert.deepStrictEqual(arr.notes.map(n => n.time), [0.0], 'content clamped to beat 0');
    assert.strictEqual(track('transcription:Lead').regions[0].startBeat, 0, 'window at beat 0');
    // Now already at the floor → refuse and consume nothing.
    const undoLen = S.history.undo.length;
    assert.strictEqual(_partsViewRegionNudge(-1, false), false, 'no room → falls through');
    assert.strictEqual(S.history.undo.length, undoLen, 'a refused nudge writes no undo step');
});

t('nudge gates: only the Tracks overview with a live transcription region', () => {
    const arr = seedNotation({ notes: [note(0.5)] });
    S.selectedRegionId = 'region:1';
    S.partsViewMode = false;
    assert.strictEqual(_partsViewRegionNudge(+1, false), false, 'not in the overview');
    S.partsViewMode = true;
    S.selectedRegionId = '';
    assert.strictEqual(_partsViewRegionNudge(+1, false), false, 'no region selected');
    S.selectedRegionId = 'region:404';
    assert.strictEqual(_partsViewRegionNudge(+1, false), false, 'stale id');
    assert.strictEqual(S.history.undo.length, 0, 'every refusal wrote nothing');
    assert.strictEqual(arr.notes.length, 1);
});

t('nudge refuses an audio row (regions are transcription-only)', () => {
    seedState({ arrangements: [{ name: 'Gtr', notes: [] }], currentArr: 0, beats: constGrid(), drumTab: null,
        trackSession: { version: 4, tracks: [
            { id: 'audio:master', type: 'audio', sourceId: 'master', name: 'Master' },
        ], removedSourceIds: [], tempoGuideSourceId: '', tempoGuideLocked: false, tempoGuideMode: 'audio' },
        audioUrl: '', stems: [], stemLinks: {}, partsViewMode: true,
        selectedTrackId: 'audio:master', selectedRegionId: 'region:1' });
    S.history = new EditHistory();
    trackHooks();
    assert.strictEqual(_partsViewRegionNudge(+1, false), false, 'audio row falls through');
    assert.strictEqual(S.history.undo.length, 0);
});

t('nudge on a drum part moves ITS own hits', () => {
    const tab = { version: 1, name: 'Drums', kit: [], hits: [{ t: 0.5, p: 36 }, { t: 1.0, p: 38 }] };
    seedState({ arrangements: [{ name: 'Drums', type: 'drums', drumTab: tab, notes: [] }], currentArr: 0,
        beats: constGrid(), drumTab: tab,
        trackSession: { version: 3, tracks: [{ id: 'transcription:Drums', type: 'transcription', targetId: 'Drums', regions: [{ id: 'D', startBeat: 0, lenBeat: 4 }] }],
            removedSourceIds: [], tempoGuideSourceId: '', tempoGuideLocked: false, tempoGuideMode: 'audio' },
        audioUrl: '', stems: [], stemLinks: {}, partsViewMode: true,
        selectedTrackId: 'transcription:Drums', selectedRegionId: 'D' });
    S.history = new EditHistory();
    trackHooks();
    assert.strictEqual(_partsViewRegionNudge(+1, false), true);
    assert.deepStrictEqual(tab.hits.map(h => h.t), [1.0, 1.5], 'the part’s own hits +1 beat');
    S.history.doUndo();
    assert.deepStrictEqual(tab.hits.map(h => h.t), [0.5, 1.0], 'undo restores');
});

// ── Numeric prompt gates (the modal itself is DOM) ───────────────────────────
t('prompt refuses without a selected region (status, no command)', async () => {
    seedNotation({ notes: [note(0.5)] });
    S.selectedRegionId = '';
    assert.strictEqual(await _partsViewRegionPromptMove(), false, 'no region → false');
    assert.ok(/Select a region/.test(lastStatus()), 'and it says why');
    assert.strictEqual(S.history.undo.length, 0);
});

for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
