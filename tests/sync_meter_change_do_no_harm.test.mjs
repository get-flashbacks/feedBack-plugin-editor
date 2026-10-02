/*
 * Do-no-harm guard for the UNIFORM sync on a meter-changing song.
 *
 * #8 (per-section syncing) is a strictly larger feature layered on the shipped
 * uniform model, so that model's guarantee is pinned FIRST: on an already-synced
 * song whose METER changes mid-song — the Pink Floyd "Money" shape, a compound
 * verse giving way to a square solo — the uniform sync must return factor ~ 1
 * and offset ~ 0 instead of inventing a damaging global correction. Without this
 * guard a change to the onset detector could start smearing every section of
 * such a song on the strength of one section's tempo.
 *
 * ── The fixture, and why it is synthetic ────────────────────────────────────
 * No real audio can be committed here: the repo ships no binary fixtures, and a
 * synthetic click track is strictly better for a REGRESSION guard — the tempo,
 * the meter change and the chart's own seconds are all known exactly, so a
 * failure points at the model and not at the recording. The clicks are read
 * through the SHIPPED onset paths (src/onsets.js banded spectral flux, and the
 * RMS-envelope strip src/audio.js hands editorSyncTempo synchronously), never a
 * hand-written onset array.
 *
 * `METER_CHANGE` is the chart: a uniform quarter-note grid at 128 BPM — the
 * tempo a chart authored at one tempo carries — preceded by a 4-beat count-in
 * (so the sync's pivot is NOT at t=0, the way a real lead-in leaves it) and
 * whose bar length changes mid-song from 7 beats (the compound verse) to 4 (the
 * solo), with one click per beat. The recording IS the chart: aligned, with no
 * offset to find. `TEMPO_CHANGE` is the same chart with the solo at 96 BPM, and
 * its clicks follow its grid — that one is the baseline test 7 reads.
 *
 * 7/8 is deliberately NOT the numerator here. The editor's beat grid is one
 * fixed unit, and a 7/8 bar on a quarter grid is 3.5 beats, so a literal 7/8
 * chart puts the grid's unit on the eighth note — which the octave-folding
 * detector (60–220 BPM) cannot agree with, whatever the meter. That is a
 * separate question from the do-no-harm guarantee, and answering it would mean
 * changing the model.
 *
 * ── Tolerances (reused by the per-section sub-issues) ───────────────────────
 *   FACTOR_TOL  0.01    the uniform factor, on both onset paths: within 1% of 1
 *                       on an already-synced song. 1% is the banded detector's
 *                       OWN measurement noise here — its sub-hop click placement
 *                       runs ~5 ms off on a 469 ms interval, which is ~1% per
 *                       interval — so an honest read always clears it, while a
 *                       real global correction misses it by an order of
 *                       magnitude (the tempo-varying baseline below is 13%, an
 *                       octave misread 100%). Both paths are checked because the
 *                       banded detector takes over the cache seconds after load.
 *   DRIFT_TOL   0.6 s   the most any authored time may MOVE once the uniform sync
 *                       is applied. This is FACTOR_TOL over the fixture's ~58 s,
 *                       stated separately (and a little tighter) so a bug that
 *                       moves times WITHOUT touching the factor — a bad re-fit, a
 *                       pivot error, an invented offset — still trips the guard.
 *   RIGID_TOL   1e-9 s  the pivot (bar 1) must not move AT ALL: the scale is
 *                       pivoted there, so it adds no time translation. Held apart
 *                       from DRIFT_TOL because it is the "offset ~ 0" half of the
 *                       guarantee and it must hold for a factor of ANY size.
 *   ONSET_TOL   0.015 s FIXTURE integrity, not a model tolerance: a detected
 *                       click may sit this far off its beat. If this trips, the
 *                       chart and the recording are no longer aligned and every
 *                       other assertion here is void.
 *
 * Run: node tests/sync_meter_change_do_no_harm.test.mjs
 */
import assert from 'node:assert';

// First import: installs the DOM stub every other module expects to find.
import { seedState, trackHooks } from './_history_env.mjs';
import { S } from '../src/state.js';
import { EditHistory } from '../src/history.js';
import { computeWaveform } from '../src/audio.js';
import { _spectralFluxOnsetsPure } from '../src/onsets.js';
import {
    _detectTempoFromOnsetsPure, editorSyncTempo, editorSyncUpdateFactor,
    editorApplySync, getTabBPM,
} from '../src/sync-tempo.js';
import { _eachTimed, _tempoMarkersPure, _tempoPivotTimePure } from '../src/tempo.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

// ── Tolerances (see the header — reused by the per-section sub-issues) ──────
const FACTOR_TOL = 0.01;     // the uniform factor, either onset path
const DRIFT_TOL = 0.6;       // seconds any authored time may move
const RIGID_TOL = 1e-9;      // seconds the pivot may move (it must not)
const ONSET_TOL = 0.015;     // fixture integrity: a click may sit off its beat
// The shipped model's limit on an already-synced, TEMPO-varying song, measured
// below and pinned so a later change to getTabBPM or the onset vote cannot
// quietly move the baseline the per-section sub-issues compare against.
const BASE_TAB_BPM = 112.9412;    // 60 / mean beat interval over 12 bars @128 + 8 @96
const BASE_FACTOR = 1.1333;       // the per-beat majority vote (128) over that

const SAMPLE_RATE = 44100;
const QUARTER_BPM = 128;                 // the tempo the verse is authored at
const SOLO_QUARTER_BPM = 96;             // the tempo the solo is authored at
const VERSE_BARS = 12, SOLO_BARS = 8;
const VERSE_NUM = 7, SOLO_NUM = 4;      // the mid-song meter change
const LEAD_IN_BEATS = 4;                // count-in, so the pivot is not at t=0

/** Bar programs: each entry lays down `bars` bars of `num` beats at `bpm`
 *  quarter-notes. The grid beat is one entry's `60/bpm`, so a program with two
 *  tempos yields a genuinely section-varying (still already-synced) chart. */
const METER_CHANGE = [
    { bars: VERSE_BARS, num: VERSE_NUM, bpm: QUARTER_BPM },
    { bars: SOLO_BARS, num: SOLO_NUM, bpm: QUARTER_BPM },
];
const TEMPO_CHANGE = [
    { bars: VERSE_BARS, num: VERSE_NUM, bpm: QUARTER_BPM },
    { bars: SOLO_BARS, num: SOLO_NUM, bpm: SOLO_QUARTER_BPM },
];

/** The chart grid: a `LEAD_IN_BEATS` count-in (measure 0, so every downbeat
 *  read skips it) then the program. A trailing downbeat closes the last bar —
 *  the shape a MIDI/GP import leaves behind, and what getTabBPM needs to read
 *  that bar. */
function buildGrid(program) {
    const beats = [];
    let time = 0, measure = 1;
    for (let i = 0; i < LEAD_IN_BEATS; i++) {
        beats.push({ time, measure: 0, den: 4 });
        time += 60 / program[0].bpm;
    }
    for (const part of program) {
        for (let bar = 0; bar < part.bars; bar++) {
            const spb = 60 / part.bpm;
            for (let i = 0; i < part.num; i++) {
                beats.push({ time, measure: i === 0 ? measure++ : -1, den: 4 });
                time += spb;
            }
        }
    }
    beats.push({ time, measure, den: 4 });
    return beats;
}

/** A click track with one 12 ms decaying click per beat — the synthetic
 *  "recording" the chart built from the same program is already aligned to. */
function clickTrack(beats) {
    const n = Math.ceil((beats[beats.length - 1].time + 0.5) * SAMPLE_RATE);
    const data = new Float32Array(n);
    const len = Math.round(0.012 * SAMPLE_RATE);
    for (const b of beats) {
        const at = Math.round(b.time * SAMPLE_RATE);
        for (let i = 0; i < len && at + i < n; i++) {
            data[at + i] += Math.exp(-i / (len * 0.3)) * 0.9;
        }
    }
    return data;
}

const BEATS = buildGrid(METER_CHANGE);
const BEAT_T = BEATS.map(b => b.time);
const SPAN = BEAT_T[BEAT_T.length - 1] - BEAT_T[0];
/** Index of bar 1 — the count-in ends here, and this beat is the pivot the
 *  uniform sync scales about. */
const PIVOT_I = BEATS.findIndex(b => b.measure > 0);

// The dialog pops itself next to its button; the shared DOM stub carries no
// geometry, so give it one before editorSyncTempo positions itself.
const syncBtn = document.getElementById('editor-sync-btn');
if (typeof syncBtn.getBoundingClientRect !== 'function') {
    syncBtn.getBoundingClientRect = () => ({ left: 0, bottom: 0 });
}
const el = id => document.getElementById(id);

/** Seed the real S with a chart AND the click track its own grid describes, so
 *  the recording and the chart are aligned by construction. Returns the clicks,
 *  because the banded detector has to read the very track the dialog will. */
function seedChart(beats) {
    trackHooks();
    const beatT = beats.map(b => b.time);
    const soloBeat = beats.findIndex(b => b.measure === VERSE_BARS + 1);   // the solo's bar 1
    assert.ok(soloBeat > PIVOT_I, 'the grid really does switch meter/tempo partway in');
    const mkArr = (name, beatIdx) => ({
        name,
        notes: beatIdx.map((i, k) => ({ string: k % 6, fret: (k % 12) + 1, time: beatT[i], sustain: 0.4 })),
        chords: [{ time: beatT[beatIdx[1]], notes: [{ string: 0, time: beatT[beatIdx[1]], sustain: 0.4 }] }],
        anchors: [{ time: beatT[beatIdx[2]], fret: 5, width: 3 }],
        anchors_user: [{ time: beatT[beatIdx[3]], fret: 7, width: 2 }],
        handshapes: [{ chord_id: 0, start_time: beatT[beatIdx[0]], end_time: beatT[beatIdx[2]] }],
        phrases: [{
            name: 'A', number: 1, start_time: beatT[beatIdx[0]],
            end_time: beatT[beatIdx[beatIdx.length - 1]], levels: [],
        }],
    });
    seedState({
        arrangements: [
            mkArr('Guitar', [PIVOT_I, PIVOT_I + 20, soloBeat, beatT.length - 2]),
            mkArr('Bass', [PIVOT_I + 2, PIVOT_I + 3, soloBeat + 2, beatT.length - 1]),
        ],
        currentArr: 0,
        sessionId: 'sess-meter-change',
        beats: beats.map(b => ({ ...b })),
        sections: [
            { name: 'Verse', number: 1, start_time: beatT[PIVOT_I] },
            { name: 'Solo', number: 2, start_time: beatT[soloBeat] },
        ],
        drumTab: {
            version: 1, name: 'kit', kit: 'std',
            hits: [{ p: 'kick', t: beatT[PIVOT_I + 1] }, { p: 'snare', t: beatT[soloBeat] }],
        },
        appliedOffset: 0,
        history: new EditHistory(),
        audioBuffer: {
            sampleRate: SAMPLE_RATE,
            duration: 0,
            getChannelData: () => clickTrack(beats),
        },
        audioShift: 0,
        activeAudioSourceOffset: 0,
    });
    const clicks = S.audioBuffer.getChannelData();
    S.audioBuffer.duration = clicks.length / SAMPLE_RATE;
    computeWaveform();
    return clicks;
}

/** Every authored time the uniform sync can move, read off the SAME walk the
 *  shipped command uses (`_eachTimed`, src/tempo.js): the grid's own beats plus
 *  each timed object's seconds — and the duration ends, since a re-fit rewrites
 *  note sustains and phrase/handshape spans from the grid too. Deriving the
 *  list from the model means this guard cannot fall behind the model. */
function authoredTimes() {
    const out = S.beats.map(b => b.time);
    _eachTimed((o, tf, endKind) => {
        assert.strictEqual(typeof o[tf], 'number', `a timed object has no ${tf} to compare`);
        out.push(o[tf]);
        if (endKind === 'sustain' && typeof o.sustain === 'number') out.push(o.sustain);
        else if (endKind === 'span' && typeof o.end_time === 'number') out.push(o.end_time);
    });
    return out;
}

/** Deep snapshot of every authored time, for the exact-restore comparison. */
function timesSnapshot() { return JSON.stringify(authoredTimes()); }

/** Largest |after − before| over every authored time, in seconds. */
function maxDrift(before) {
    const was = JSON.parse(before);
    const now = authoredTimes();
    assert.strictEqual(now.length, was.length, 'the sync must not add or drop authored times');
    let worst = 0;
    for (let i = 0; i < was.length; i++) worst = Math.max(worst, Math.abs(now[i] - was[i]));
    return worst;
}

/** What the dialog's own "factor" readout says after a detect pass. */
function detectFactor() {
    editorSyncTempo();
    return parseFloat(el('sync-factor').textContent);
}

/** Drive the dialog's manual-BPM field — the shipped way a user overrides the
 *  detected tempo — and return the factor it then computes. */
function manualFactor(bpm) {
    el('sync-manual-bpm').value = String(bpm);
    editorSyncUpdateFactor();
    return parseFloat(el('sync-factor').textContent);
}

// ── 1. The fixture is what it claims to be ─────────────────────────────────
t('fixture: a 128 BPM grid whose bar length changes mid-song, one click per beat', () => {
    const clicks = seedChart(BEATS);
    assert.ok(Math.abs(getTabBPM() - QUARTER_BPM) < 1e-9, `tab reads ${getTabBPM()}`);
    assert.strictEqual(_tempoPivotTimePure(S.beats, -1), BEAT_T[PIVOT_I],
        'the sync pivots on bar 1, not on the count-in');

    // The repo's OWN definition of a meter change agrees: a meter marker at the
    // solo's bar, and the tempo restated NOWHERE after bar 1. Nothing else in the
    // song differs from a plain 4/4 chart, so the do-no-harm assertions below are
    // testing exactly one thing — that this meter change costs the sync nothing.
    const markers = _tempoMarkersPure(BEATS, 0.01, []);
    const meter = markers.filter(m => m.kind === 'meter');
    assert.ok(meter.some(m => m.measure === 1 && m.label === `${VERSE_NUM}/4`), 'bar 1 is the meter baseline');
    assert.ok(meter.some(m => m.measure === VERSE_BARS + 1 && m.label === `${SOLO_NUM}/4`),
        'meter change at the solo bar');
    assert.deepStrictEqual(markers.filter(m => m.kind === 'tempo').map(m => m.measure), [1],
        'tempo constant across the meter change');

    // The chart is already aligned: every click lands on its beat, unshifted.
    const onsets = _spectralFluxOnsetsPure(clicks, SAMPLE_RATE);
    assert.strictEqual(onsets.length, BEATS.length - 1, 'one onset per beat after the first');
    let worst = 0;
    for (let i = 1; i < BEATS.length; i++) worst = Math.max(worst, Math.abs(onsets[i - 1].t - BEAT_T[i]));
    assert.ok(worst < ONSET_TOL, `clicks land on the beats (worst ${(worst * 1000).toFixed(1)} ms)`);
});

// ── 2. The factor, off both shipped onset paths ────────────────────────────
t('factor: the banded spectral-flux read of a meter-changing song is ~1', () => {
    const clicks = seedChart(BEATS);
    const read = _detectTempoFromOnsetsPure(_spectralFluxOnsetsPure(clicks, SAMPLE_RATE));
    assert.ok(read, 'detects');
    assert.ok(Math.abs(read.bpm / getTabBPM() - 1) <= FACTOR_TOL,
        `factor ${(read.bpm / getTabBPM()).toFixed(4)} within ${FACTOR_TOL} of 1 (read ${read.bpm} BPM)`);
});

t('factor: the shipping (RMS strip) read editorSyncTempo uses is ~1', () => {
    seedChart(BEATS);
    const factor = detectFactor();
    assert.ok(Math.abs(factor - 1) <= FACTOR_TOL, `factor ${factor} within ${FACTOR_TOL} of 1`);
    assert.ok(Math.abs(parseFloat(el('sync-tab-bpm').textContent) - QUARTER_BPM) < 1e-6,
        'the dialog shows the tab tempo it compared against');
});

// ── 3. The applied result: do no harm ──────────────────────────────────────
t('apply: the uniform sync moves nothing on an already-synced meter change', () => {
    seedChart(BEATS);
    const before = timesSnapshot();
    editorSyncTempo();
    editorApplySync();

    const drift = maxDrift(before);
    assert.ok(drift <= DRIFT_TOL,
        `largest authored-time move ${(drift * 1000).toFixed(3)} ms (tolerance ${DRIFT_TOL * 1000} ms)`);

    // offset ~ 0, twice over: the scale is pivoted on bar 1, so bar 1 itself
    // holds its time and no time translation is introduced at all — this must
    // hold for a factor of ANY size, which is why it is separate from DRIFT_TOL.
    assert.ok(Math.abs(S.beats[PIVOT_I].time - BEAT_T[PIVOT_I]) <= RIGID_TOL, 'the pivot (bar 1) did not move');
    assert.strictEqual(S.appliedOffset, 0, 'the uniform sync invented no offset');

    // Still one undoable step, and undo restores the exact pre-sync seconds.
    assert.strictEqual(S.history.undo.length, 1, 'the sync pushed exactly one undoable command');
    S.history.doUndo();
    assert.strictEqual(timesSnapshot(), before, 'undo restored every authored second exactly');
    S.history.doRedo();
    assert.ok(maxDrift(before) > 0, 'redo re-applied the (near-identity) sync');
    S.history.doUndo();
    assert.strictEqual(timesSnapshot(), before, 'undo is clean again');
});

t('apply: the banded detector\'s tempo, applied the way a user would, is ~1 too', () => {
    const clicks = seedChart(BEATS);
    const read = _detectTempoFromOnsetsPure(_spectralFluxOnsetsPure(clicks, SAMPLE_RATE));
    const before = timesSnapshot();
    detectFactor();
    assert.ok(Math.abs(manualFactor(read.bpm) - 1) <= FACTOR_TOL, 'factor ~1 from the flux read');
    editorApplySync();

    // The flux detector places its onsets a few ms off, so its tempo read is the
    // widest this fixture can honestly be: the factor may sit inside FACTOR_TOL
    // and still smear the far end of the song — but only by what that factor is
    // worth, which is the point.
    const drift = maxDrift(before);
    assert.ok(drift <= DRIFT_TOL, `largest authored-time move ${(drift * 1000).toFixed(1)} ms`);
    assert.ok(Math.abs(S.beats[PIVOT_I].time - BEAT_T[PIVOT_I]) <= RIGID_TOL, 'the pivot still did not move');
    assert.strictEqual(S.appliedOffset, 0, 'still no offset');
});

t('teeth: a real global correction through the same path blows the drift budget', () => {
    // The guard's tolerances only mean something if a correction this small
    // would fail them. Halve the tempo through the dialog's own override — the
    // smallest mistake a user can actually make — and the chart must tear.
    seedChart(BEATS);
    const before = timesSnapshot();
    detectFactor();
    const factor = manualFactor(QUARTER_BPM / 2);
    assert.ok(Math.abs(factor - 1) > FACTOR_TOL, `the correction is outside FACTOR_TOL (${factor})`);
    editorApplySync();
    const drift = maxDrift(before);
    assert.ok(drift > DRIFT_TOL,
        `largest authored-time move ${(drift * 1000).toFixed(0)} ms exceeds ${DRIFT_TOL * 1000} ms`);
});

t('teeth: the tolerances hang together and the fixture is long enough to matter', () => {
    // DRIFT_TOL is FACTOR_TOL's worth of drift at the far end of the song, given a
    // little slack — the two bounds are the same statement in different units, so
    // neither is loose enough to wave through the other.
    assert.ok(SPAN * FACTOR_TOL <= DRIFT_TOL, `FACTOR_TOL permits ${(SPAN * FACTOR_TOL).toFixed(3)} s of drift at the far end`);
    assert.ok(SPAN * FACTOR_TOL * 2 >= DRIFT_TOL, 'DRIFT_TOL is not looser than that');
    assert.ok(SPAN > 30, `the fixture is long enough for a scale error to show (${SPAN.toFixed(1)} s)`);
});

// ── 4. The case the uniform model CANNOT help (the per-section baseline) ───
t('baseline: a song that also changes TEMPO is what per-section sync has to beat', () => {
    // Same chart, but the solo runs at 96 quarter-BPM and its clicks follow — a
    // genuinely already-synced, tempo-varying recording. getTabBPM() is a per-bar
    // MEAN while the onset vote is a per-beat MAJORITY, so no single factor fits:
    // the uniform factor lands ~13% off. That IS the shipped model's limit and the
    // number the per-section sub-issues must improve on — pinned here so a future
    // change to getTabBPM or to the vote cannot quietly move the baseline they
    // compare against.
    const beatTempo = buildGrid(TEMPO_CHANGE);
    seedChart(beatTempo);
    const barBpm = new Set(_tempoMarkersPure(beatTempo, 0.01, [])
        .filter(m => m.kind === 'tempo')
        .map(m => parseFloat(m.label)));
    assert.ok(barBpm.size > 1, 'this fixture really does change tempo mid-song');

    assert.ok(Math.abs(getTabBPM() - BASE_TAB_BPM) <= 0.05, `tab reads ${getTabBPM().toFixed(2)}`);
    const factor = detectFactor();
    assert.ok(Math.abs(factor - BASE_FACTOR) <= 0.005,
        `uniform factor ${factor.toFixed(4)} is pinned near ${BASE_FACTOR} — no single factor fits a section-varying song`);
    assert.ok(Math.abs(factor - 1) > FACTOR_TOL * 5,
        `and it is a dozen times outside FACTOR_TOL — the scale of correction the guard above rejects`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);