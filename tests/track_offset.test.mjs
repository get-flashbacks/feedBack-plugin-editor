/*
 * Per-track time offset — nudge ONE track in time, independently of the song.
 *
 * The data-model half of the per-track offset (issue #41 step 1 of 3). Three
 * placement terms compose by ADDITION and never replace one another:
 *
 *   global  S.audioShift    one value for the whole audio group (src/state.js)
 *   source  row.sourceOffset  per stem, baked into the manifest
 *   track   row.offsetSec     THIS offset — per audio track, per seconds
 *
 * Proven here:
 *   1. _placementSecPure / _trackPlacementPure — the one composed expression, and
 *      the adversarial-value guards that keep NaN out of a position.
 *   2. trackOffsetTarget / TrackOffsetCmd — the undoable container-only write
 *      (audio rows only; exact exec→undo→redo, zero deletes the key, no-ops).
 *   3. editorSetTrackOffset / editorNudgeTrackOffset — 1ms resolution, undoable
 *      through the real EditHistory, and ISOLATED: one track moves, the global
 *      shift and every sibling track do not.
 *   4. The persistence seam — normalize keeps a track's offsetSec, drops one
 *      written on a folder/transcription row, omits zero, and makes the tree
 *      non-default so `trackSessionSavePayload()` persists it.
 *
 * Run: node tests/track_offset.test.mjs
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { _placementSecPure, _trackPlacementPure } from '../src/region.js';
import { TrackOffsetCmd, trackOffsetTarget } from '../src/region-commands.js';
import {
    activeSourcePlacementSec, editorNudgeTrackOffset, editorSetTrackOffset, _ensureOnsetsShifted,
} from '../src/audio.js';
import { _mapHealthResults } from '../src/ruler.js';
import {
    _trackSessionNormalizePure, _trackSessionIsDefaultPure, _trackSessionRowsPure, trackSessionSavePayload,
} from '../src/track-session.js';
import { S } from '../src/state.js';
import { EditHistory } from '../src/history.js';
import { seedState, trackHooks, lastStatus } from './_history_env.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── A shared song: three rows, one of each kind ──────────────────────────────
// (declared up here because the tests below drive it directly)
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
function setTrackOffset(id, sec) {
    const row = track(id);
    if (sec) row.offsetSec = sec; else delete row.offsetSec;
}
// Fixtures for the normalize/save seam (section 4), declared up here because the
// suite runs top-to-bottom and `const` is hoisted into a TDZ.
const sources = [
    { id: 'master', name: 'Master Mix', kind: 'master', url: '/a.ogg', offset: 0.5 },
    { id: 'Guitar_L', name: 'Guitar_L', kind: 'stem', url: '/s1.ogg', offset: 0 },
];
// The seeded song's own sources, for the rebuild test (which normalizes the LIVE
// session against them).
const songSources = [
    { id: 'master', name: 'Master Mix', kind: 'master', url: '/a.ogg', offset: 0 },
    { id: 'Guitar_L', name: 'Guitar_L', kind: 'stem', url: '/s1.ogg', offset: 0 },
];
const arrangements = [{ name: 'Gtr' }];
const drumTab = null;
const empty = {
    version: 3, tracks: [], removedSourceIds: [], tempoGuideSourceId: '',
    tempoGuideLocked: false, tempoGuideMode: 'audio',
};

// ── 1. The placement pures ───────────────────────────────────────────────────
t('_placementSecPure: a finite number passes, everything else contributes 0', () => {
    assert.strictEqual(_placementSecPure(0.25), 0.25);
    assert.strictEqual(_placementSecPure(-2), -2);
    assert.strictEqual(_placementSecPure('0.5'), 0.5, 'numeric strings coerce');
    assert.strictEqual(_placementSecPure(undefined), 0);
    assert.strictEqual(_placementSecPure(null), 0);
    assert.strictEqual(_placementSecPure(''), 0);
    assert.strictEqual(_placementSecPure('abc'), 0);
    // The guard is load-bearing: NaN and ±Infinity both survive `Number()` AND
    // are truthy, so neither a `|| 0` fallback nor the truthiness test catches
    // them — only the explicit isfinite check does.
    assert.strictEqual(_placementSecPure(NaN), 0);
    assert.strictEqual(_placementSecPure(Infinity), 0);
    assert.strictEqual(_placementSecPure(-Infinity), 0);
    assert.strictEqual(_placementSecPure('NaN'), 0);
});

t('_trackPlacementPure COMPOSES the three terms — each is additive', () => {
    assert.strictEqual(_trackPlacementPure(0, 0, 0), 0);
    assert.strictEqual(_trackPlacementPure(2, 0, 0), 2, 'global alone');
    assert.strictEqual(_trackPlacementPure(0, 3, 0), 3, 'source alone');
    assert.strictEqual(_trackPlacementPure(0, 0, -4), -4, 'track alone');
    // The load-bearing assertion: all three present, summed — never one winning.
    assert.strictEqual(_trackPlacementPure(2, 3, -4), 1);
    // …and order does not matter, because it is addition.
    assert.strictEqual(_trackPlacementPure(-4, 3, 2), 1);
});

t('_trackPlacementPure: a garbage term drops out and the rest stand', () => {
    assert.strictEqual(_trackPlacementPure(NaN, 3, -4), -1, 'garbage global drops');
    assert.strictEqual(_trackPlacementPure(2, undefined, -4), -2, 'absent source drops');
    assert.strictEqual(_trackPlacementPure(2, 3, 'garbage'), 5, 'garbage track offset drops');
    assert.strictEqual(_trackPlacementPure(NaN, NaN, NaN), 0, 'all garbage → 0, not NaN');
});

t('_trackPlacementPure: the SUM is finite-checked — three finite terms can overflow', () => {
    // 1e308 is finite, so the per-term guard passes it; adding two of them does
    // not. An Infinity placement would flow straight into timeToX() and
    // node.start(when), so it must degrade to 0 like any other garbage.
    assert.ok(Number.isFinite(1e308), 'the addends themselves are finite');
    assert.strictEqual(1e308 + 1e308, Infinity, 'the raw sum overflows');
    assert.strictEqual(_trackPlacementPure(1e308, 1e308, 0), 0, '…and placement clamps it to 0');
    assert.strictEqual(_trackPlacementPure(1e308, -1e308, 0), 0, 'a cancelling pair lands on 0');
    assert.strictEqual(_trackPlacementPure(1e308, 0, 0), 1e308, 'a large but non-overflowing value still works');
});

t('adding a track offset never disturbs the global shift (the point of the feature)', () => {
    seed({ audioShift: 2.5 });
    setTrackOffset('audio:Guitar_L', 0.75);
    assert.strictEqual(S.audioShift, 2.5, 'global shift untouched');
    assert.strictEqual(_trackPlacementPure(S.audioShift, 0, 0.75), 3.25, 'only this track moved');
    assert.strictEqual(_trackPlacementPure(S.audioShift, 0, 0), 2.5, 'a sibling track is unmoved');
});

// ── 2. trackOffsetTarget / TrackOffsetCmd ────────────────────────────────────
t('trackOffsetTarget resolves AUDIO rows and refuses every other kind', () => {
    seed();
    assert.strictEqual(trackOffsetTarget('audio:Guitar_L'), track('audio:Guitar_L'), 'audio row resolves');
    assert.strictEqual(trackOffsetTarget('folder:1'), null, 'a folder has no timeline of its own');
    assert.strictEqual(trackOffsetTarget('notes:Gtr'), null,
        'a transcription row places content via its regions, not a seconds axis');
    assert.strictEqual(trackOffsetTarget('nope'), null, 'unknown id');
    assert.strictEqual(trackOffsetTarget(undefined), null);
    seed({ });
    delete S.trackSession;
    assert.strictEqual(trackOffsetTarget('audio:Guitar_L'), null, 'no session → no target');
});

t('TrackOffsetCmd exec writes offsetSec and round-trips exec→undo→redo', () => {
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.25 }));
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.25, 'exec applied');
    S.history.doUndo();
    assert.ok(!('offsetSec' in track('audio:Guitar_L')), 'undo deleted the key it never had');
    S.history.doRedo();
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.25, 'redo re-applied');
});

t('TrackOffsetCmd: undo restores the previous value verbatim, including a non-zero one', () => {
    seed();
    setTrackOffset('audio:Guitar_L', -1.5);
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: -1.5, newSec: 0.5 }));
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.5);
    S.history.doUndo();
    assert.strictEqual(track('audio:Guitar_L').offsetSec, -1.5, 'the prior offset came back exactly');
});

t('TrackOffsetCmd: a zero target REMOVES the key (no residue in the pack)', () => {
    seed();
    setTrackOffset('audio:Guitar_L', 3);
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 3, newSec: 0 }));
    assert.ok(!('offsetSec' in track('audio:Guitar_L')), 'zero removes rather than stores a 0');
    S.history.doUndo();
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 3, 'undo brings the 3s offset back');
});

t('TrackOffsetCmd writes nothing for a zero delta or an unreachable/non-audio track', () => {
    seed();
    // exec() is the whole contract: a no-op command must leave the tree byte-identical.
    new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 1, newSec: 1 }).exec();
    new TrackOffsetCmd({ trackId: 'nope', oldSec: 0, newSec: 5 }).exec();
    new TrackOffsetCmd({ trackId: 'folder:1', oldSec: 0, newSec: 5 }).exec();
    new TrackOffsetCmd({ trackId: 'notes:Gtr', oldSec: 0, newSec: 5 }).exec();
    assert.ok(!('offsetSec' in track('audio:Guitar_L')), 'the zero-delta track is untouched');
    assert.ok(!('offsetSec' in track('folder:1')), 'a folder never gains one');
    assert.ok(!('offsetSec' in track('notes:Gtr')), 'a transcription row never gains one');
    // An exec() that did nothing also rolls back harmlessly — no snapshot, no write.
    new TrackOffsetCmd({ trackId: 'nope', oldSec: 0, newSec: 5 }).rollback();
    assert.ok(!('offsetSec' in track('audio:Guitar_L')));
    // The verb (not the history) is what keeps a no-op OFF the undo stack.
    setTrackOffset('audio:Guitar_L', 1);
    editorSetTrackOffset('audio:Guitar_L', 1);
    assert.strictEqual(S.history.undo.length, 0, 'a no-op never reaches the user as an undo step');
});

t('TrackOffsetCmd coerces a NaN/Infinity argument to 0 — it can never become the stored value', () => {
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: NaN }));
    assert.ok(!('offsetSec' in track('audio:Guitar_L')), 'NaN newSec writes nothing');
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: Infinity }));
    assert.ok(!('offsetSec' in track('audio:Guitar_L')), 'Infinity newSec writes nothing');
});

t('TrackOffsetCmd declares itself placement-only (no pitch change, song scope)', () => {
    const cmd = new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 1 });
    assert.strictEqual(cmd.pitchPreserving, true);
    assert.strictEqual(cmd.songScope, true);
});

t('afterApply fires on exec AND rollback — undo/redo never bypass the audio reaction', () => {
    // Undo and redo reach the command WITHOUT passing through the verb, so a
    // reaction living only in the verb would leave playing audio at the old
    // placement while the lane showed the new one.
    seed();
    let calls = 0;
    const cmd = new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.5 });
    cmd.afterApply = () => { calls++; };
    S.history.exec(cmd);
    assert.strictEqual(calls, 1, 'exec');
    S.history.doUndo();
    assert.strictEqual(calls, 2, 'undo re-seats the source too');
    S.history.doRedo();
    assert.strictEqual(calls, 3, 'redo as well');
    // A command with no callback (the node-runnable default) must not throw.
    new TrackOffsetCmd({ trackId: 'audio:master', oldSec: 0, newSec: 1 }).exec();
});

// ── 3. The verbs ─────────────────────────────────────────────────────────────
t('editorSetTrackOffset rounds to 1ms, execs ONE command, and names the move', () => {
    seed();
    assert.strictEqual(editorSetTrackOffset('audio:Guitar_L', '0.2004'), true);
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.2, 'rounded to the millisecond');
    assert.strictEqual(S.history.undo.length, 1, 'one undoable command');
    assert.ok(/Track offset \+200ms/.test(lastStatus()), 'status names the offset');
    assert.ok(/Guitar L/.test(lastStatus()), 'status names the track');
    assert.ok(/global shift unchanged/.test(lastStatus()), 'status says what did NOT move');
    // A negative offset reads as -Nms, never "+-Nms".
    editorSetTrackOffset('audio:Guitar_L', -0.25);
    assert.ok(/Track offset -250ms/.test(lastStatus()));
});

t('editorSetTrackOffset is a no-op when the value is unchanged', () => {
    seed();
    setTrackOffset('audio:Guitar_L', 0.1);
    assert.strictEqual(editorSetTrackOffset('audio:Guitar_L', '0.1'), false);
    assert.strictEqual(S.history.undo.length, 0, 'no command pushed for a no-op');
});

t('editorSetTrackOffset refuses a non-audio track (returns false, pushes nothing)', () => {
    seed();
    for (const id of ['folder:1', 'notes:Gtr', 'nope', undefined]) {
        assert.strictEqual(editorSetTrackOffset(id, 1), false, id === undefined ? 'undefined id' : id);
    }
    assert.strictEqual(S.history.undo.length, 0);
});

t('editorSetTrackOffset refuses garbage instead of silently zeroing a real offset', () => {
    // `parseFloat(x) || 0` would turn every one of these into 0 — DELETE the
    // track's offset — and still report a move. A value that isn't a number must
    // change nothing.
    seed();
    setTrackOffset('audio:Guitar_L', 0.25);
    for (const bad of ['abc', '', null, undefined, true, false, {}, [], NaN, Infinity, 1e308]) {
        assert.strictEqual(editorSetTrackOffset('audio:Guitar_L', bad), false, JSON.stringify(bad));
        assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.25, `${JSON.stringify(bad)} left the offset intact`);
    }
    assert.strictEqual(S.history.undo.length, 0, 'no garbage ever reaches the undo stack');
    assert.strictEqual(editorNudgeTrackOffset('audio:Guitar_L', 'abc'), false, 'the nudge verb guards too');
    assert.strictEqual(editorNudgeTrackOffset('audio:Guitar_L', NaN), false);
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.25);
    // …and a good value still works afterwards.
    assert.strictEqual(editorSetTrackOffset('audio:Guitar_L', '0.3'), true);
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.3);
});

t('editorNudgeTrackOffset nudges from the current value and composes', () => {
    seed();
    editorSetTrackOffset('audio:Guitar_L', 0.1);
    editorNudgeTrackOffset('audio:Guitar_L', 0.05);
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.15), 'nudged relative, not absolute');
    editorNudgeTrackOffset('audio:Guitar_L', -0.05);
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.1));
    // A nudge back to zero removes the key — an undone move leaves no residue.
    editorNudgeTrackOffset('audio:Guitar_L', -0.1);
    assert.ok(!('offsetSec' in track('audio:Guitar_L')));
    assert.strictEqual(editorNudgeTrackOffset('folder:1', 0.1), false, 'a folder cannot be nudged');
});

t('the whole move is undoable in two steps, restoring the key-less original', () => {
    seed();
    editorSetTrackOffset('audio:Guitar_L', 0.25);
    editorNudgeTrackOffset('audio:Guitar_L', 0.25);
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.5));
    S.history.doUndo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.25));
    S.history.doUndo();
    assert.ok(!('offsetSec' in track('audio:Guitar_L')), 'back to the untouched row');
    S.history.doRedo();
    S.history.doRedo();
    assert.ok(near(track('audio:Guitar_L').offsetSec, 0.5), 'redo replays both');
});

t('moving ONE track leaves every sibling track and the global shift exactly where they were', () => {
    seed({ audioShift: 1 });
    setTrackOffset('audio:master', -0.5);
    editorSetTrackOffset('audio:Guitar_L', 2);
    assert.strictEqual(S.audioShift, 1, 'global shift unmoved');
    assert.strictEqual(track('audio:master').offsetSec, -0.5, 'the sibling track unmoved');
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 2, 'the target moved');
    // …and the composed placements agree: they differ by exactly this track's delta.
    const masterPlacement = _trackPlacementPure(S.audioShift, 0, track('audio:master').offsetSec);
    const gtrPlacement = _trackPlacementPure(S.audioShift, 0, track('audio:Guitar_L').offsetSec);
    assert.ok(near(gtrPlacement - masterPlacement, 2.5), 'relative slide = master + this track');
});

t('activeSourcePlacementSec composes global + source offset + the ACTIVE track offset', () => {
    seed({ audioShift: 0.5 });
    S.activeAudioSourceId = 'Guitar_L';
    S.activeAudioSourceOffset = 2;
    assert.strictEqual(activeSourcePlacementSec(), 2.5, 'no track offset yet');
    setTrackOffset('audio:Guitar_L', -1);
    assert.strictEqual(activeSourcePlacementSec(), 1.5, 'the active track offset joins the sum');
    // A source with no track row contributes no offset.
    S.activeAudioSourceId = 'master';
    assert.strictEqual(activeSourcePlacementSec(), 2.5);
    S.activeAudioSourceId = 'gone';
    assert.strictEqual(activeSourcePlacementSec(), 2.5, 'unknown source → no offset');
});

t('undo/redo survives the tree being REBUILT (new row objects, same ids)', () => {
    // Normalizing the session replaces every row object. A command that captured
    // a row reference would write to a detached object; one that resolves by id
    // (and whose value normalize carries across) must still round-trip.
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.25 }));
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.25);
    const before = track('audio:Guitar_L');
    S.trackSession = _trackSessionNormalizePure(S.trackSession, songSources, S.arrangements, S.drumTab);
    assert.notStrictEqual(track('audio:Guitar_L'), before, 'normalize rebuilt the row object');
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.25, 'and carried the offset across');
    S.history.doUndo();
    assert.ok(!('offsetSec' in track('audio:Guitar_L')), 'undo reverted the REBUILT row');
    S.history.doRedo();
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 0.25, 'and redo reapplied to it');
});

t('undo after the track row is deleted is a safe no-op, not a crash', () => {
    // The row is gone, so there is nothing to write; the chosen semantics are
    // "silently skip" (the stack entry is consumed either way) and they are
    // pinned here so a refactor cannot change them quietly.
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 0.25 }));
    S.trackSession.tracks = S.trackSession.tracks.filter(x => x.id !== 'audio:Guitar_L');
    assert.doesNotThrow(() => S.history.doUndo());
    assert.doesNotThrow(() => S.history.doRedo());
});

t('two moves then two undos land on the FIRST value (re-snapshot is idempotent)', () => {
    // exec() re-snapshots _before on every run, so this is only correct because
    // EditHistory.exec clears the redo stack — a second command can never land on
    // top of an un-rolled-back one. Load-bearing, and easy to break.
    seed();
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 0, newSec: 1 }));
    S.history.exec(new TrackOffsetCmd({ trackId: 'audio:Guitar_L', oldSec: 1, newSec: 2 }));
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 2);
    S.history.doUndo();
    assert.strictEqual(track('audio:Guitar_L').offsetSec, 1, 'back to the first move');
    S.history.doUndo();
    assert.ok(!('offsetSec' in track('audio:Guitar_L')), 'and back to the untouched original');
});

// ── 4. The persistence seam (track-session.js) ───────────────────────────────

t('_ensureOnsetsShifted slides chart-time onsets by the per-track offset too', () => {
    // Onsets are cached in BUFFER time and read as CHART time everywhere a
    // detected attack is compared to a beat (Suggest-fit, onset snap, Sync, Map
    // Health). Leaving the per-track term out would read a nudged track as a
    // whole-map drift equal to its own offset.
    seed({ audioShift: 0.2 });
    const bins = 400, rms = new Array(bins).fill(0.05);
    for (let i = 20; i < bins; i += 50) rms[i] = 1.0;          // a transient every 0.5 s
    Object.assign(S, {
        duration: 4, waveformPeaks: { bins, rms },
        activeAudioSourceId: 'Guitar_L', activeAudioSourceOffset: 0,
    });
    const before = _ensureOnsetsShifted().map(o => o.t);
    assert.ok(before.length > 1, 'the fixture actually produced onsets');
    setTrackOffset('audio:Guitar_L', 0.3);
    const after = _ensureOnsetsShifted().map(o => o.t);
    assert.strictEqual(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
        assert.ok(near(after[i] - before[i], 0.3), `onset ${i}: ${before[i]} → ${after[i]}`);
    }
});

t('normalize carries a track offsetSec onto the audio row and stamps v4', () => {
    const model = _trackSessionNormalizePure({
        ...empty,
        tracks: [{ id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', offsetSec: -0.25 }],
    }, sources, arrangements, drumTab);
    const row = model.tracks.find(x => x.id === 'audio:Guitar_L');
    assert.strictEqual(model.version, 4, 'schema version bumped');
    assert.strictEqual(row.offsetSec, -0.25, 'a negative offset survives');
    assert.strictEqual(row.sourceId, 'Guitar_L', 'the row still points at its source');
});

t('the view row keeps the source offset and the track offset as SEPARATE terms', () => {
    // The master source carries offset 0.5 and the track a -0.25 offset. If
    // normalize folded one into the other, moving the track would silently
    // rewrite the source's alignment for every other row using it.
    const { rows } = _trackSessionRowsPure({
        ...empty,
        tracks: [{ id: 'audio:master', type: 'audio', sourceId: 'master', offsetSec: -0.25 }],
    }, sources, arrangements, drumTab, {});
    const row = rows.find(x => x.id === 'audio:master');
    assert.strictEqual(row.sourceOffset, 0.5, "the source's own offset, untouched");
    assert.strictEqual(row.offsetSec, -0.25, "the track's offset, its own field");
    assert.strictEqual(_trackPlacementPure(row.sourceOffset, 0, row.offsetSec), 0.25,
        'and placement composes the two');
});

t('normalize OMITS a zero offset — an untouched project stays byte-identical', () => {
    for (const value of [0, -0, '0', null, undefined, NaN, Infinity, 'garbage']) {
        const model = _trackSessionNormalizePure({
            ...empty,
            tracks: [{ id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', offsetSec: value }],
        }, sources, arrangements, drumTab);
        const row = model.tracks.find(x => x.id === 'audio:Guitar_L');
        assert.ok(!('offsetSec' in row), `${String(value)} → no offsetSec key`);
    }
});

t('normalize DROPS an offsetSec written on a non-audio row', () => {
    const model = _trackSessionNormalizePure({
        ...empty,
        tracks: [
            { id: 'folder:1', type: 'folder', name: 'Gtrs', offsetSec: 5 },
            { id: 'notes:Gtr', type: 'transcription', targetId: 'Gtr', offsetSec: 5 },
        ],
    }, sources, arrangements, drumTab);
    for (const row of model.tracks) {
        assert.ok(!('offsetSec' in row), `${row.type} must not carry an offsetSec`);
    }
});

t('an offset makes the tree NON-default, so trackSessionSavePayload persists it', () => {
    assert.strictEqual(_trackSessionIsDefaultPure(empty, sources, arrangements, drumTab), true);
    const withOffset = {
        ...empty,
        tracks: [{ id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', offsetSec: 0.25 }],
    };
    assert.strictEqual(_trackSessionIsDefaultPure(withOffset, sources, arrangements, drumTab), false,
        'a shifted track must persist — otherwise the offset would be lost on save');

    // …and the payload the save request ships actually carries it.
    seed();
    S.masterAudioUrl = '/a.ogg';
    S.stems = [{ id: 'Guitar_L', name: 'Guitar_L', url: '/s1.ogg' }];
    S.trackSession = { ...empty, tracks: [
        { id: 'audio:master', type: 'audio', sourceId: 'master', name: '', parentId: '' },
        { id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', name: '', parentId: '', offsetSec: 0.25 },
    ] };
    const payload = trackSessionSavePayload();
    assert.ok(payload, 'a non-default tree is sent');
    assert.strictEqual(payload.version, 4);
    assert.strictEqual(payload.tracks.find(x => x.id === 'audio:Guitar_L').offsetSec, 0.25,
        'the offset rides the save payload to the backend');
});

t('a default tree still saves as null so untouched packs keep their bytes', () => {
    seed();
    S.masterAudioUrl = '/a.ogg';
    S.stems = [{ id: 'Guitar_L', name: 'Guitar_L', url: '/s1.ogg' }];
    S.trackSession = { ...empty, tracks: [
        { id: 'audio:master', type: 'audio', sourceId: 'master', name: '', parentId: '' },
        { id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', name: '', parentId: '' },
    ] };
    assert.strictEqual(trackSessionSavePayload(), null, 'no offset → no editor_track_session key');
});

t('an unshifted audio row keeps its exact key set (byte-identical saves)', () => {
    const model = _trackSessionNormalizePure({
        ...empty,
        tracks: [{ id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L' }],
    }, sources, arrangements, drumTab);
    const row = model.tracks.find(x => x.id === 'audio:Guitar_L');
    assert.deepStrictEqual(Object.keys(row), ['id', 'type', 'sourceId', 'name', 'parentId'],
        'a zero offset contributes NO key at all — not even a falsy one');
});

t('normalize is idempotent over offset data (the value round-trips unchanged)', () => {
    const input = {
        ...empty,
        tracks: [{ id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', offsetSec: -1.5 }],
    };
    const once = _trackSessionNormalizePure(input, sources, arrangements, drumTab);
    const twice = _trackSessionNormalizePure(once, sources, arrangements, drumTab);
    assert.deepStrictEqual(twice.tracks, once.tracks, 'normalize(normalize(x)) === normalize(x)');
});

// ── 5. The structural pin: no placement site left behind ──────────────────────
// A missed site is INVISIBLE to unit tests of the pure — every one of them can
// pass while src/parts-view.js, src/waveform.js or _startStemSources still
// hand-rolls the old two-term sum and quietly ignores the track offset. Assert
// the wiring itself: no module may compute placement by adding S.audioShift to
// something by hand; placement goes through _trackPlacementPure /
// activeSourcePlacementSec. (Source-text assertion, like
// tests/tempo_onset_snap.test.mjs.)
t('no placement site still hand-rolls the old two-term placement sum', () => {
    // Shapes that are deliberately NOT placements, blanked before the check:
    //   - src/waveform.js's typeof-guarded fallback for slice-based render
    //     harnesses (README "Testing conventions"), and
    //   - `S.audioShift + delta`, a scalar nudge of the GLOBAL shift
    //     (editorNudgeAudioShift) — not a composition of placement terms.
    // Anything else that adds S.audioShift by hand is a missed site.
    const notAPlacement = [
        /\(Number\(S\.audioShift\) \|\| 0\) \+ \(Number\(S\.activeAudioSourceOffset\) \|\| 0\)/g,
        /\(Number\(S\.audioShift\) \|\| 0\) \+ \(Number\(row\.sourceOffset\) \|\| 0\)/g,
        /\(Number\(S\.audioShift\) \|\| 0\) \+ \(Number\(row\.offsetSec\) \|\| 0\)/g,
        /\(Number\(S\.audioShift\) \|\| 0\) \+ \(Number\(delta\) \|\| 0\)/g,
    ];
    for (const file of ['src/audio.js', 'src/parts-view.js', 'src/waveform.js', 'src/ruler.js']) {
        const src = notAPlacement.reduce((s, re) => s.replace(re, ''),
            readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
        assert.ok(!/\(Number\(S\.audioShift\) \|\| 0\) \+ \(/.test(src),
            `${file} still adds S.audioShift to another term by hand — resolve placement through ` +
            '_trackPlacementPure / activeSourcePlacementSec instead');
    }
    // …and the three modules that MUST consume the per-track term actually do.
    const view = readFileSync(new URL('../src/parts-view.js', import.meta.url), 'utf8');
    assert.ok(/_trackPlacementPure\(S\.audioShift, row\.sourceOffset, row\.offsetSec\)/.test(view),
        'parts-view must compose the global, the source offset and the TRACK offset');
    const wave = readFileSync(new URL('../src/waveform.js', import.meta.url), 'utf8');
    assert.ok(/activeSourcePlacementSec/.test(wave), 'the timeline waveform/onsets use the composed placement');
    const audio = readFileSync(new URL('../src/audio.js', import.meta.url), 'utf8');
    assert.ok(/_trackPlacementPure\(S\.audioShift, source\.offset,\s*track && _placementSecPure\(track\.offsetSec\)\)/.test(audio),
        'the stem scheduler composes the per-track term too');
});

t('a per-track move alone re-keys the Map Health memo and is seen as drift', () => {
    // The lens memoizes on the placement scalar. If it keyed on S.audioShift
    // alone, moving ONE track (the whole point of this feature) would keep
    // serving a lens computed for the old placement. And because the chart-time
    // onsets move WITH the track, a track slid against an unmoved grid must read
    // as exactly its own offset of drift — not as healthy, and not as a stale
    // verdict.
    const bins = 400, rms = new Array(bins).fill(0.05);
    for (let i = 20; i < bins; i += 50) rms[i] = 1.0;
    seed();
    S.duration = 4;
    S.waveformPeaks = { bins, rms };
    S.audioShift = 0.2;
    S.activeAudioSourceId = 'Guitar_L';
    S.activeAudioSourceOffset = 0;
    const gridAt = (t0) => {
        S.beats = [];
        for (let i = 0; i < 8; i++) S.beats.push({ time: t0 + i * 0.5, measure: (i % 4 === 0 ? (i / 4) + 1 : 0) });
    };
    gridAt(0.4);                       // onsets at chart 0.40, 0.90, 1.40, … match the grid
    const a = _mapHealthResults();
    assert.ok(a.measures.every(m => m.band === 'green'), 'the unshifted fixture is healthy');

    setTrackOffset('audio:Guitar_L', 0.1);       // global shift UNCHANGED
    const b = _mapHealthResults();
    assert.notStrictEqual(b, a, 'the memo recomputed after a track-only move');
    assert.ok(b.measures.some(m => m.band !== 'green'),
        'a track slid against an unmoved grid reads as drift, not as healthy');

    gridAt(0.5);                       // move the chart with the track: healthy again
    const c = _mapHealthResults();
    assert.ok(c.measures.every(m => m.band === 'green'), 'the lens follows the placement, not a stale key');
});

console.log(`\n${pass} passed, ${fail} failed`);