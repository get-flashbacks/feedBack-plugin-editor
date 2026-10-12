/*
 * Per-section sync APPLY path (#25): baking the piecewise map into note, span,
 * drum-hit and beat seconds, with exact skip preservation and an undoable,
 * symmetric command.
 *
 * The map builder itself is unit-tested in section_sync.test.mjs; this pins the
 * apply contract from PER-SECTION-SYNC-DESIGN.md that a pure builder test can't
 * reach:
 *   • an object starting in a skipped section keeps every timing field exactly
 *     (its sustain/span endpoint included) while its neighbours are baked
 *     (design L130-136);
 *   • a both-sided identity-pinned run blocks Apply with a surfaced conflict
 *     rather than a silent demotion (design L90-98, L143-144);
 *   • exec → undo → redo is symmetric — exact rollback, reproduced redo.
 *
 * Run: node tests/per_section_apply.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory } from '../src/history.js';
import { seedState } from './_history_env.mjs';
import { _applyPerSectionSyncPure } from '../src/tempo.js';
import { _buildPiecewiseMapPure } from '../src/section-sync.js';

function accept(start, end, slope, intercept) {
    return { start, end, slope, intercept, ok: true, confidence: 0.9 };
}
function skip(start, end) {
    return { start, end, slope: 1, intercept: 0, ok: false, confidence: 0 };
}

// A 0..30 s grid and three notes spread across a skipped leading section and an
// accepted run, so skip preservation and mapping are both observable at once.
function scenario() {
    const s = seedState();
    s.beats = [];
    for (let t = 0; t <= 30; t += 5) {
        s.beats.push({ time: t, measure: t % 20 === 0 ? (t / 20) + 1 : -1, den: 4 });
    }
    s.sections = [];
    s.arrangements = [{
        notes: [
            { time: 5, sustain: 3, midi: 60 },   // skipped section — must not move
            { time: 12, sustain: 2, midi: 62 },  // accepted section
            { time: 22, sustain: 1, midi: 64 },  // accepted section
        ],
        chords: [], anchors: [], anchors_user: [], handshapes: [], phrases: [],
    }];
    s.drumTab = { hits: [{ t: 7 }] };
    s.history = new EditHistory();
    return s;
}

const times = (arr, key) => arr.map((o) => o[key]);

test('apply bakes accepted sections and leaves skipped ones bit-for-bit intact', () => {
    const s = scenario();
    const props = [skip(0, 10), accept(10, 30, 2, 0)];
    const map = _buildPiecewiseMapPure(props, { start: 0, end: 30 });
    assert.deepStrictEqual(map.conflicts, []);
    // The run abuts a skipped section, so it is pinned to identity at the seam.
    assert.strictEqual(map.map(10), 10);
    assert.strictEqual(map.map(20), 30);

    const preNote = { ...s.arrangements[0].notes[0] };
    const preHit = { ...s.drumTab.hits[0] };
    const res = _applyPerSectionSyncPure(map, props, 0.7);
    assert.strictEqual(res.applied, true);

    const notes = s.arrangements[0].notes;
    assert.strictEqual(notes[0].time, preNote.time, 'skipped note onset untouched');
    assert.strictEqual(notes[0].sustain, preNote.sustain, 'skipped note sustain untouched');
    assert.strictEqual(notes[1].time, 14, 'accepted note onset mapped');
    assert.strictEqual(notes[1].sustain, 4, 'sustain derived from the mapped endpoints');
    assert.strictEqual(notes[2].time, 34, 'later accepted note mapped');
    assert.strictEqual(s.drumTab.hits[0].t, preHit.t, 'skipped drum hit untouched');

    const bt = times(s.beats, 'time');
    assert.ok(bt.every((t, i) => i === 0 || t > bt[i - 1]), `grid strictly increasing: ${bt}`);
});

test('apply maps span endpoints and round-trips through undo then redo', () => {
    const s = scenario();
    s.arrangements[0].handshapes = [{ start_time: 15, end_time: 25 }];
    const props = [skip(0, 10), accept(10, 30, 2, 0)];
    const map = _buildPiecewiseMapPure(props, { start: 0, end: 30 });
    const before = {
        beats: times(s.beats, 'time'),
        notes: times(s.arrangements[0].notes, 'time'),
        hit: s.drumTab.hits[0].t,
    };

    assert.strictEqual(_applyPerSectionSyncPure(map, props, 0.7).applied, true);
    assert.strictEqual(s.arrangements[0].handshapes[0].start_time, 20, 'span start mapped');
    assert.strictEqual(s.arrangements[0].handshapes[0].end_time, 40, 'span end mapped');

    s.history.doUndo();
    assert.deepStrictEqual(times(s.arrangements[0].notes, 'time'), before.notes, 'undo restores note onsets');
    assert.deepStrictEqual(times(s.beats, 'time'), before.beats, 'undo restores the grid');
    assert.strictEqual(s.drumTab.hits[0].t, before.hit, 'undo restores the skipped hit');

    s.history.doRedo();
    assert.strictEqual(s.arrangements[0].notes[1].time, 14, 'redo reproduces the apply');
    assert.strictEqual(s.arrangements[0].handshapes[0].end_time, 40, 'redo reproduces the mapped span');
});

test('a both-sided identity-pinned run blocks Apply with a surfaced conflict', () => {
    const s = scenario();
    const props = [skip(0, 10), accept(10, 20, 2, 0), skip(20, 30)];
    const map = _buildPiecewiseMapPure(props, { start: 0, end: 30 });
    assert.strictEqual(map.conflicts.length, 1);
    assert.strictEqual(map.conflicts[0].reason, 'identity-conflict');

    const res = _applyPerSectionSyncPure(map, props, 0.7);
    assert.strictEqual(res.applied, false);
    assert.strictEqual(res.reason, 'conflict');
    assert.strictEqual(res.conflicts.length, 1);
    assert.strictEqual(s.arrangements[0].notes[1].time, 12, 'nothing was baked when Apply was refused');
});
