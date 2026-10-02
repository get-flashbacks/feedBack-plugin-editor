/*
 * Per-phrase difficulty tiers ride the beat-primary tempo model (issue #33).
 *
 * The editor holds a phrase's per-difficulty content in `phrases[].tiers[]`
 * (routes.py `_phrase_with_tiers`) — real note content, not metadata. So a
 * tempo flex has to reproject it exactly like the flat chart; otherwise the
 * chart moves to the new timeline while the authored tiers stay put, and the
 * next save persists those stale times into `levels[]`. Same for the
 * save-strip: `beat`/`beatEnd` are runtime caches and must never reach the wire.
 *
 *   1. tier notes/chords/chord-notes/anchors/handshapes are lifted like chart
 *      objects (beat + beatEnd bookkeeping included),
 *   2. a flex keeps their beats and moves their seconds,
 *   3. each is visited exactly once (no double-lift),
 *   4. only `tiers` is walked — the wire `levels[]` a legacy client might send
 *      is left alone,
 *   5. the save strip clears the cache at every level and never mutates live
 *      objects,
 *   6. a grid with < 2 beats degrades to seconds-primary.
 *
 * Run: node tests/phrase_tiers_tempo.test.mjs
 */
import assert from 'node:assert';
import { beatOf, timeOf } from '../src/beats.js';
import { S as realS } from '../src/state.js';
import {
    _eachTimed, _liftAllBeats, _reprojectAll,
    _stripArrangementBeats, _stripBeatsFromSaveBody,
} from '../src/tempo.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}
const near = (a, b, msg) =>
    assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} (${a} ≉ ${b})`);

// ── Fixtures ────────────────────────────────────────────────────────────────
// The same drifting grid beat_primary.test.mjs gates the flat chart against, so
// these cases prove identical math: 9 beats (0..8) spanning 0..4 s with every
// gap a different width, and a same-length flex (indexing fixed, times moved).
const DRIFT = [
    { time: 0.00, measure: 1 }, { time: 0.50, measure: -1 }, { time: 1.10, measure: -1 },
    { time: 1.50, measure: -1 }, { time: 2.30, measure: 2 }, { time: 2.70, measure: -1 },
    { time: 3.00, measure: -1 }, { time: 3.60, measure: -1 }, { time: 4.00, measure: 3 },
];
const FLEX = [0.00, 0.55, 1.05, 1.60, 2.10, 2.55, 3.05, 3.55, 4.10]
    .map((time, i) => ({ time, measure: DRIFT[i].measure }));
const driftGrid = () => DRIFT.map(b => ({ ...b }));
const flexGrid = () => FLEX.map(b => ({ ...b }));

// One arrangement, one phrase, two tiers — an authored easy tier and the top
// tier. Every timed slot a tier can hold is populated, so a missing branch in
// the walk shows up as an unmoved time.
function tier(difficulty) {
    return {
        difficulty,
        notes: [
            { time: 0.5, string: 0, fret: 0, sustain: 0.4 },
            { time: 1.5, string: 1, fret: 3, sustain: 0 },
        ],
        chords: [{ time: 1.1, chord_id: 0, notes: [{ time: 1.1, string: 0, fret: 0, sustain: 0.3 }] }],
        anchors: [{ time: 2.3, fret: 5, width: 4 }],
        handshapes: [{ chord_id: 0, start_time: 0.5, end_time: 1.5, arp: false }],
    };
}
function song() {
    return {
        beats: driftGrid(),
        drumTab: null,
        sections: [{ start_time: 0.0, name: 'A' }],
        arrangements: [{
            name: 'Lead',
            notes: [{ time: 0.5, string: 0, fret: 0, sustain: 0.4 }],
            chords: [], anchors: [], anchors_user: [], handshapes: [],
            phrases: [{
                name: 'verse', number: 1,
                start_time: 0.0, end_time: 4.0,
                tiers: [tier(0), tier(9)],
            }],
        }],
    };
}

function makeEnv(seed) {
    Object.assign(realS, seed);
    return { beatOf, timeOf, _liftAllBeats, _reprojectAll, _eachTimed,
             _stripArrangementBeats, _stripBeatsFromSaveBody };
}
// The timed objects inside one tier, for per-slot assertions.
const tierSlots = (tierObj) => ({
    note: tierObj.notes[0],
    chord: tierObj.chords[0],
    chordNote: tierObj.chords[0].notes[0],
    anchor: tierObj.anchors[0],
    handshape: tierObj.handshapes[0],
});

t('a tier note is lifted like a chart note (beat + sustain end-beat)', () => {
    const S = song();
    const env = makeEnv(S);
    env._liftAllBeats(driftGrid());
    const { note } = tierSlots(S.arrangements[0].phrases[0].tiers[0]);
    near(note.beat, env.beatOf(driftGrid(), 0.5), 'tier note beat');
    near(note.beatEnd, env.beatOf(driftGrid(), 0.9), 'tier note beatEnd (sustain)');
    // The zero-sustain note must NOT grow an end-beat.
    assert.ok(!('beatEnd' in S.arrangements[0].phrases[0].tiers[0].notes[1]),
        'zero-sustain tier note has no end beat');
});

t('a tempo flex keeps every tier beat and moves the seconds (tier by tier)', () => {
    const S = song();
    const env = makeEnv(S);
    env._liftAllBeats(driftGrid());
    const before = S.arrangements[0].phrases[0].tiers.map(tierObj => {
        const s = tierSlots(tierObj);
        return { beat: s.note.beat, time: s.note.time };
    });
    env._reprojectAll(flexGrid());
    const grid = flexGrid();
    for (const [i, tierObj] of S.arrangements[0].phrases[0].tiers.entries()) {
        const s = tierSlots(tierObj);
        near(s.note.beat, before[i].beat, `tier ${i} beat held`);
        near(s.note.time, env.timeOf(grid, s.note.beat), `tier ${i} seconds reprojected`);
        assert.ok(Math.abs(s.note.time - before[i].time) > 1e-6,
            'the flex actually moved this tier');
    }
});

t('tier chords, chord notes, anchors and handshapes ride the flex too', () => {
    const S = song();
    const env = makeEnv(S);
    env._liftAllBeats(driftGrid());
    const s = tierSlots(S.arrangements[0].phrases[0].tiers[0]);
    assert.ok(typeof s.chord.beat === 'number', 'tier chord lifted');
    assert.ok(typeof s.chordNote.beat === 'number', 'tier chord note lifted');
    assert.ok(typeof s.anchor.beat === 'number', 'tier anchor lifted');
    assert.ok(typeof s.handshape.beat === 'number', 'tier handshape lifted');
    assert.ok(typeof s.handshape.beatEnd === 'number', 'tier handshape span lifted');
    env._reprojectAll(flexGrid());
    const grid = flexGrid();
    near(s.chord.time, env.timeOf(grid, s.chord.beat), 'tier chord seconds');
    near(s.chordNote.time, env.timeOf(grid, s.chordNote.beat), 'tier chord note seconds');
    near(s.anchor.time, env.timeOf(grid, s.anchor.beat), 'tier anchor seconds');
    near(s.handshape.start_time, env.timeOf(grid, s.handshape.beat), 'tier handshape start');
    near(s.handshape.end_time, env.timeOf(grid, s.handshape.beatEnd), 'tier handshape end');
    // A reprojected sustain must scale, not stay a frozen length.
    const { note } = tierSlots(S.arrangements[0].phrases[0].tiers[0]);
    assert.ok(note.sustain > 0 && note.sustain !== 0.4,
        `sustain rescaled by the flex (got ${note.sustain})`);
});

t('each timed object is visited exactly once (a double visit would corrupt it)', () => {
    const S = song();
    const env = makeEnv(S);
    const counts = new Map();
    env._eachTimed((o) => counts.set(o, (counts.get(o) || 0) + 1));
    for (const tierObj of S.arrangements[0].phrases[0].tiers) {
        for (const slot of Object.values(tierSlots(tierObj))) {
            assert.strictEqual(counts.get(slot), 1, 'visited once');
        }
    }
    assert.strictEqual(counts.get(S.arrangements[0].phrases[0]), 1, 'the phrase itself');
    assert.strictEqual(counts.get(S.arrangements[0].notes[0]), 1, 'the flat chart');
});

t('only `tiers` is walked — a legacy wire `levels[]` is never retimed', () => {
    const S = song();
    const env = makeEnv(S);
    // A wire-shaped level rides alongside, as a client on the old contract sends.
    // Its note carries the long `time` key ON PURPOSE: that is the field the
    // walk lifts, so an over-eager walk of `levels` would leave a `beat` here
    // and fail the assertion below. (A short-key `t` note could never gain a
    // beat, so it would pass either way.)
    S.arrangements[0].phrases[0].levels =
        [{ difficulty: 0, notes: [{ time: 0.5, string: 0, fret: 0 }] }];
    env._liftAllBeats(driftGrid());
    // The authored tier beside it WAS walked — so a `beat` here proves the walk
    // ran and reached `tiers`, not that it silently skipped the phrase.
    assert.ok(typeof S.arrangements[0].phrases[0].tiers[0].notes[0].beat === 'number',
        'the authored tier was lifted');
    const wireNote = S.arrangements[0].phrases[0].levels[0].notes[0];
    assert.ok(!('beat' in wireNote), 'wire level notes are not beat-lifted');
    assert.ok(!('beatEnd' in wireNote), 'wire level notes gain no end beat');
});

t('the save strip clears beat/beatEnd at every tier level, live objects intact', () => {
    const S = song();
    const env = makeEnv(S);
    env._liftAllBeats(driftGrid());
    const arr = S.arrangements[0];
    const stripped = env._stripArrangementBeats(arr);
    const json = JSON.stringify(stripped);
    assert.ok(!/"beat"/.test(json), 'no "beat" on the wire');
    assert.ok(!/"beatEnd"/.test(json), 'no "beatEnd" on the wire');
    // times survived
    assert.strictEqual(typeof stripped.phrases[0].tiers[0].notes[0].time, 'number');
    assert.strictEqual(typeof stripped.phrases[0].tiers[1].handshapes[0].end_time, 'number');
    assert.strictEqual(stripped.phrases[0].tiers[0].difficulty, 0, 'tier content intact');
    // the LIVE objects keep their cache (the strip clones, never mutates)
    assert.strictEqual(typeof arr.phrases[0].tiers[0].notes[0].beat, 'number');
    assert.strictEqual(typeof arr.phrases[0].tiers[0].anchors[0].beat, 'number');
});

t('the save body strip reaches tiers nested under arrangements', () => {
    const S = song();
    const env = makeEnv(S);
    env._liftAllBeats(driftGrid());
    const body = env._stripBeatsFromSaveBody({ arrangements: S.arrangements });
    assert.ok(!/"beat"/.test(JSON.stringify(body)), 'no "beat" anywhere in the body');
    assert.ok(!/"beatEnd"/.test(JSON.stringify(body)), 'no "beatEnd" anywhere in the body');
    assert.strictEqual(body.arrangements[0].phrases[0].tiers.length, 2);
});

t('a grid with < 2 beats degrades to seconds-primary (tier times untouched)', () => {
    const S = song();
    S.beats = [];
    const env = makeEnv(S);
    env._liftAllBeats(S.beats);
    env._reprojectAll(S.beats);
    const { note } = tierSlots(S.arrangements[0].phrases[0].tiers[0]);
    assert.strictEqual(note.time, 0.5, 'tier note unchanged with no grid');
    assert.strictEqual(note.sustain, 0.4, 'tier sustain unchanged with no grid');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);