/*
 * Per-section sync alignment engine (#24) — sub-issue 3/5 of per-section
 * syncing (#8).
 *
 * The engine is PURE ANALYSIS: it reads the chart grid and the audio onset
 * strip and returns one independent proposal per section. These tests pin the
 * three acceptance criteria from the issue and the independence guarantee:
 *
 *   1. On a song whose audio tempo changes at a section boundary, the
 *      per-section factors differ, and each section's fitted map is closer to
 *      the true recording than a single global fit. METRIC = mean absolute
 *      error (MAE) in SECONDS between the fitted map's predicted audio time and
 *      the true audio time over the section's chart onsets; "global" is the
 *      least-squares affine fit over the whole song (the BEST single line, so
 *      beating it is a strong result).
 *   2. A deliberately mismatched section reads as low confidence, and its
 *      presence does not change the good sections' proposals.
 *   3. A single-section song reduces to the uniform model's convention:
 *      factor = onset-vote BPM / grid BPM, the same numbers the shipped dialog
 *      compares against.
 *
 * ── The fixture, and why it is synthetic ────────────────────────────────────
 * No binary fixtures are committed in this repo, and a synthetic click track is
 * strictly better for a deterministic engine test: the chart grid, the two
 * audio tempos and the section boundary are all known exactly, so a failure
 * points at the engine and not the recording. The clicks are read through the
 * SHIPPED onset path (src/onsets.js banded spectral flux), exactly as the
 * uniform suite reads them — never a hand-written onset array.
 *
 * Run: node tests/section_sync.test.mjs
 */
import assert from 'node:assert';

// section-sync's import graph (onsets, sync-tempo) is DOM-free; the env stub
// is installed first for precedent with the other suites.
import './_history_env.mjs';
import { _spectralFluxOnsetsPure } from '../src/onsets.js';
import { _detectTempoFromOnsetsPure } from '../src/sync-tempo.js';
import {
    _sectionRegionsPure, _localBpmFromBeatsPure, _dtwAlignPure,
    _slopeFromPairsPure, _fitAffinePure, _chartDomainPure,
    _collectSourceOnsetsPure, _alignSectionPure, _alignSectionsPure,
} from '../src/section-sync.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

const SAMPLE_RATE = 44100;
const CHART_BPM = 120;              // the chart is authored uniformly at 120
const VERSE_AUDIO_BPM = 132;        // the recording's verse runs fast
const SOLO_AUDIO_BPM = 108;         // ... and its solo runs slow
const VERSE_BARS = 12, SOLO_BARS = 12;
const LEAD_BEATS = 4;               // count-in, so the boundary is not at t=0

/** Chart grid: `leadBeats` count-in (measure 0), then uniform 4/4 bars, then a
 *  trailing downbeat — the shape an import leaves behind. */
function buildGrid(leadBeats, bars, bpm) {
    const beats = [];
    let time = 0, measure = 1;
    const spb = 60 / bpm;
    for (let i = 0; i < leadBeats; i++) { beats.push({ time, measure: 0, den: 4 }); time += spb; }
    for (let bar = 0; bar < bars; bar++) {
        for (let i = 0; i < 4; i++) { beats.push({ time, measure: i === 0 ? measure++ : -1, den: 4 }); time += spb; }
    }
    beats.push({ time, measure, den: 4 });
    return beats;
}

/** One 12 ms decaying click per requested time — the synthetic "recording". */
function clickTrackAt(times) {
    const n = Math.ceil((times[times.length - 1] + 0.5) * SAMPLE_RATE);
    const data = new Float32Array(n);
    const len = Math.round(0.012 * SAMPLE_RATE);
    for (const tt of times) {
        const at = Math.round(tt * SAMPLE_RATE);
        for (let i = 0; i < len && at + i < n; i++) data[at + i] += Math.exp(-i / (len * 0.3)) * 0.9;
    }
    return data;
}

// ── The tempo-varying fixture ──────────────────────────────────────────────
const BEATS = buildGrid(LEAD_BEATS, VERSE_BARS + SOLO_BARS, CHART_BPM);
const BEAT_T = BEATS.map((b) => b.time);
const VERSE_I = LEAD_BEATS;                                  // first verse bar
const SOLO_I = LEAD_BEATS + VERSE_BARS * 4;                  // first solo bar
const VERSE_START = BEAT_T[VERSE_I];
const SOLO_START = BEAT_T[SOLO_I];
const END_T = BEAT_T[BEAT_T.length - 1];
const RV = CHART_BPM / VERSE_AUDIO_BPM;   // verse seconds-out / seconds-in
const RS = CHART_BPM / SOLO_AUDIO_BPM;    // solo  seconds-out / seconds-in

/** The recording is ONE continuous take whose tempo kinks at the section
 *  boundary: everything before it is stretched by RV, everything after by RS.
 *  This is exactly a piecewise-linear time map, which no single factor fits. */
function audioTime(x) {
    const y0 = SOLO_START * RV;
    return x < SOLO_START - 1e-9 ? x * RV : y0 + (x - SOLO_START) * RS;
}
const AUDIO_T = BEAT_T.map(audioTime);
const TRUTH = new Map();
for (let i = 0; i < BEAT_T.length; i++) TRUTH.set(BEAT_T[i], AUDIO_T[i]);

const SECTIONS = [
    { name: 'Verse', number: 1, start_time: VERSE_START },
    { name: 'Solo', number: 2, start_time: SOLO_START },
];

// A prior that just centres each region's audio window; it is NOT the answer.
const UNIT_PRIOR = { slope: 1, intercept: 0, factor: 1, tabBpm: CHART_BPM, audioBpm: CHART_BPM, confidence: 1 };

function analyze({ sections = SECTIONS, audioOnsets, prior = UNIT_PRIOR, sourceOnsets = BEAT_T } = {}) {
    return _alignSectionsPure({
        sections,
        beats: BEATS,
        audioOnsets: audioOnsets || _spectralFluxOnsetsPure(clickTrackAt(AUDIO_T), SAMPLE_RATE),
        sourceOnsets,
        prior,
    });
}

function byName(res, name) { return res.proposals.find((p) => p.name === name); }

/** Mean absolute error (s) of a proposal's fitted map over its chart onsets. */
function sectionMae(prop) {
    const xs = BEAT_T.filter((x) => x >= prop.start - 1e-6
        && (x < prop.end - 1e-6 || (prop.end >= END_T - 1e-6 && x <= prop.end + 1e-6)));
    let sum = 0;
    for (const x of xs) sum += Math.abs(prop.slope * x + prop.intercept - TRUTH.get(x));
    return sum / xs.length;
}

/** The best possible single affine fit over the WHOLE song (least squares). */
function globalFit() {
    const n = BEAT_T.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += BEAT_T[i]; sy += AUDIO_T[i]; sxx += BEAT_T[i] * BEAT_T[i]; sxy += BEAT_T[i] * AUDIO_T[i]; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { slope, intercept: (sy - slope * sx) / n };
}

function globalMae(g, prop) {
    const xs = BEAT_T.filter((x) => x >= prop.start - 1e-6
        && (x < prop.end - 1e-6 || (prop.end >= END_T - 1e-6 && x <= prop.end + 1e-6)));
    let sum = 0;
    for (const x of xs) sum += Math.abs(g.slope * x + g.intercept - TRUTH.get(x));
    return sum / xs.length;
}

// ── 1. Pure pieces ─────────────────────────────────────────────────────────
t('regions: half-open intervals, an explicit leading region and a final endpoint', () => {
    const domain = { start: 0, end: 50 };
    const regions = _sectionRegionsPure(
        [{ name: 'Verse', number: 1, start_time: 2 }, { name: 'Solo', number: 2, start_time: 26 }], domain);
    assert.strictEqual(regions.length, 3, 'leading + Verse + Solo');
    assert.deepStrictEqual(regions.map((r) => [r.start, r.end]), [[0, 2], [2, 26], [26, 50]]);
    assert.strictEqual(regions[0].leading, true, 'the gap before the first marker is explicit');
    assert.strictEqual(regions[2].final, true, 'the last region owns the chart endpoint');
    assert.strictEqual(regions[0].name, '', 'the leading region is unnamed');

    // A marker at (or before) the domain start is the baseline, not a boundary,
    // and a marker at/after the end is not a boundary either.
    const one = _sectionRegionsPure(
        [{ name: 'A', number: 1, start_time: 0 }, { name: 'B', number: 2, start_time: 99 }], domain);
    assert.strictEqual(one.length, 1, 'single full-domain region');
    assert.deepStrictEqual([one[0].start, one[0].end], [0, 50]);
    assert.strictEqual(one[0].final, true);

    // Duplicate marker starts collapse to one boundary.
    const dup = _sectionRegionsPure(
        [{ name: 'A', number: 1, start_time: 10 }, { name: 'A2', number: 2, start_time: 10 }], domain);
    assert.strictEqual(dup.length, 2, 'leading + one shared-start region');
});

t('local tempo: a region reads its own grid BPM, a full span matches the song', () => {
    const bpm = _localBpmFromBeatsPure(BEATS, 0, END_T, true);
    assert.ok(Math.abs(bpm - CHART_BPM) < 1e-6, `full span reads ${bpm}`);
    const verse = _localBpmFromBeatsPure(BEATS, VERSE_START, SOLO_START, false);
    assert.ok(Math.abs(verse - CHART_BPM) < 1e-6, `verse reads ${verse}`);
});

t('dtw + affine: two proportional sequences recover the stretch exactly', () => {
    const src = [0, 1, 2, 3, 4];
    const dst = src.map((x) => 2 * x + 1);   // slope 2, intercept 1
    const { pairs, coverage } = _dtwAlignPure(src, dst);
    assert.strictEqual(coverage, 1, 'every source event matched');
    const fit = _fitAffinePure(pairs);
    assert.ok(Math.abs(fit.slope - 2) < 1e-6, `slope ${fit.slope}`);
    assert.ok(Math.abs(fit.intercept - 1) < 1e-6, `intercept ${fit.intercept}`);
    assert.ok(fit.mad < 1e-9, `residual ${fit.mad}`);
});

t('slope: Theil-Sen shrugs off a mis-matched correspondence', () => {
    const pairs = [[0, 0], [1, 1.5], [2, 3], [3, 4.5], [4, 99]];  // last is garbage
    assert.ok(Math.abs(_slopeFromPairsPure(pairs) - 1.5) < 1e-6, `slope ${_slopeFromPairsPure(pairs)}`);
});

t('domain: a degenerate grid is refused, not analysed', () => {
    assert.deepStrictEqual(_chartDomainPure([{ time: 5 }]), { start: 0, end: 0 });
    const res = _alignSectionsPure({ sections: SECTIONS, beats: [{ time: 5 }], audioOnsets: [] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'degenerate-grid');
    assert.deepStrictEqual(res.proposals, []);
});

t('source onsets: notes, chords, anchors, phrases and drum hits all count', () => {
    const onsets = _collectSourceOnsetsPure({
        arrangements: [{
            notes: [{ time: 0 }, { time: 0.5 }],
            chords: [{ time: 1, notes: [{ time: 1 }] }],
            anchors: [{ time: 1.5 }], anchors_user: [{ time: 2 }],
            phrases: [{ start_time: 2.5 }],
        }],
        drumTab: { hits: [{ t: 3 }, { t: 3.0005 }] },  // sub-ms dupe collapses
    });
    assert.deepStrictEqual(onsets, [0, 0.5, 1, 1.5, 2, 2.5, 3]);
});

t('one region: a region with too few onsets fails cleanly, never guesses', () => {
    const region = { index: 0, name: 'X', number: 1, start: 0, end: 50, leading: true, final: true };
    const prop = _alignSectionPure({
        region, sourceTimes: [0, 1], beats: BEATS,
        audioOnsets: _spectralFluxOnsetsPure(clickTrackAt(AUDIO_T), SAMPLE_RATE), prior: UNIT_PRIOR,
    });
    assert.strictEqual(prop.ok, false);
    assert.strictEqual(prop.reason, 'too-few-notes');
    assert.strictEqual(prop.confidence, 0);
    assert.strictEqual(prop.factor, 1, 'a failure proposes no factor');
});

// ── 2. Acceptance: per-section factors beat the single global fit ───────────
t('regions differ: each section reads its own audio tempo, not the global one', () => {
    const res = analyze();
    const verse = byName(res, 'Verse'), solo = byName(res, 'Solo');
    assert.ok(verse.ok && solo.ok, 'both sections aligned');
    assert.ok(Math.abs(verse.factor - VERSE_AUDIO_BPM / CHART_BPM) < 0.02,
        `verse factor ${verse.factor} ~ ${VERSE_AUDIO_BPM / CHART_BPM}`);
    assert.ok(Math.abs(solo.factor - SOLO_AUDIO_BPM / CHART_BPM) < 0.02,
        `solo factor ${solo.factor} ~ ${SOLO_AUDIO_BPM / CHART_BPM}`);
    assert.ok(Math.abs(verse.factor - solo.factor) > 0.1,
        `the two sections really differ (${verse.factor} vs ${solo.factor})`);
    // The factor is the BPM ratio; the affine slope is its reciprocal.
    assert.ok(Math.abs(verse.slope - 1 / verse.factor) < 1e-3, 'slope is seconds-in per second-out');
});

t('regions beat global: per-section MAE < the best single affine fit, on both', () => {
    const res = analyze();
    const g = globalFit();
    const verse = byName(res, 'Verse'), solo = byName(res, 'Solo');
    const mv = sectionMae(verse), ms = sectionMae(solo), gv = globalMae(g, verse), gs = globalMae(g, solo);
    assert.ok(mv < gv, `verse MAE ${(mv * 1000).toFixed(1)} ms beats global ${(gv * 1000).toFixed(1)} ms`);
    assert.ok(ms < gs, `solo MAE ${(ms * 1000).toFixed(1)} ms beats global ${(gs * 1000).toFixed(1)} ms`);
    // And the win is material, not a rounding artifact.
    assert.ok(mv < 0.05 && ms < 0.05, `per-section fits are tight (verse ${(mv * 1000).toFixed(1)} ms, solo ${(ms * 1000).toFixed(1)} ms)`);
    assert.ok(gv > 0.1 && gs > 0.1, `no single line can fit a kinked map (global ${(gv * 1000).toFixed(0)}/${(gs * 1000).toFixed(0)} ms)`);
});

// ── 3. Acceptance: a mismatched section is low-confidence and isolated ──────
const BREAK_START = END_T + 0.5;      // next beat after the song's last downbeat
const BREAK_END = BREAK_START + 24 * 60 / CHART_BPM;   // 6 bars of chart
const BREAK_BEATS = [];
for (let time = BREAK_START; time <= BREAK_END + 1e-9; time += 60 / CHART_BPM) {
    BREAK_BEATS.push({ time, measure: 0, den: 4 });
}
const OUTRO_END = BREAK_END + 24 * 60 / CHART_BPM;    // 6 more bars of chart
const OUTRO_BEATS = [];
for (let time = BREAK_END; time <= OUTRO_END + 1e-9; time += 60 / CHART_BPM) {
    OUTRO_BEATS.push({ time, measure: 0, den: 4 });
}
const SONG_BEATS = BEATS.concat(BREAK_BEATS, OUTRO_BEATS);
const BREAK_AUDIO_LO = audioTime(BREAK_START);
const BREAK_AUDIO_HI = audioTime(BREAK_END);

/** Clicks at pseudo-random, non-periodic times — the "wrong take" case. */
function lcgClickTimes(start, end) {
    const out = [];
    let x = start + 0.13, seed = 12345;
    while (x < end - 0.05) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        out.push(x);
        x += 0.18 + ((seed >>> 8) % 700) / 1000;   // 0.18 .. 0.88 s
    }
    return out;
}

/** The song's audio, with the Break either matching (good) or a wrong take.
 *  The Outro take stays on-tempo at Solo's tempo either way, so any change to
 *  the Outro proposal between runs is Break's fault, on the engine's head. */
function breakAudio(mismatched) {
    const pre = AUDIO_T.filter((t) => t < BREAK_AUDIO_LO - 1e-9);          // the song so far
    const mid = BREAK_BEATS.map((b) => audioTime(b.time));                 // break on-tempo
    const outro = OUTRO_BEATS.map((b) => audioTime(b.time));               // outro on-tempo
    const break_ = mismatched ? lcgClickTimes(BREAK_AUDIO_LO, BREAK_AUDIO_HI) : mid;
    return _spectralFluxOnsetsPure(clickTrackAt(pre.concat(break_, outro).sort((a, b) => a - b)), SAMPLE_RATE);
}

const BREAK_SECTIONS = [...SECTIONS,
    { name: 'Break', number: 3, start_time: BREAK_START },
    { name: 'Outro', number: 4, start_time: BREAK_END },
];
function analyzeBreak(mismatched) {
    return _alignSectionsPure({
        sections: BREAK_SECTIONS, beats: SONG_BEATS, audioOnsets: breakAudio(mismatched), prior: UNIT_PRIOR,
    });
}

t('mismatch: a wrong-take section reads low confidence', () => {
    const good = analyzeBreak(false), bad = analyzeBreak(true);
    const gb = byName(good, 'Break'), bb = byName(bad, 'Break');
    assert.ok(gb.ok && gb.confidence >= 0.5, `the matching Break is trusted (${gb.confidence})`);
    assert.ok(bb && bb.ok === true, 'the wrong-take Break is analysed, not skipped');
    assert.strictEqual(bb.reason, 'low-confidence', 'a wrong take reads low-confidence, not a hard failure');
    assert.ok(bb.confidence < 0.5, `the wrong-take Break reads ${bb.confidence}, below the floor`);
});

t('mismatch: the bad section does not touch the good sections', () => {
    const good = analyzeBreak(false), bad = analyzeBreak(true);
    // Verse and Solo precede the Break; Outro FOLLOWS it — the hard case, where
    // a failed Break could have dragged the map before it since the chain is
    // forward-propagating. Both directions must stay byte-for-byte unchanged.
    for (const name of ['Verse', 'Solo', 'Outro']) {
        assert.deepStrictEqual(byName(bad, name), byName(good, name),
            `${name} is byte-for-byte the same whether Break matches or not`);
    }
    // ... and the Break itself is the only proposal that changed.
    assert.notDeepStrictEqual(byName(bad, 'Break'), byName(good, 'Break'), 'Break is where the difference lands');
});

// ── 4. Acceptance: a single section reduces to the uniform model ────────────
t('single section: one region reproduces the uniform factor', () => {
    const res = _alignSectionsPure({
        sections: [], beats: BEATS, audioOnsets: _spectralFluxOnsetsPure(clickTrackAt(AUDIO_T), SAMPLE_RATE),
        sourceOnsets: BEAT_T, prior: UNIT_PRIOR,
    });
    assert.strictEqual(res.proposals.length, 1, 'one whole-song region');
    const prop = res.proposals[0];
    assert.ok(prop.ok, 'the whole song aligns');
    // The uniform convention the shipped dialog uses: onset-vote BPM / grid BPM.
    const onsets = _spectralFluxOnsetsPure(clickTrackAt(AUDIO_T), SAMPLE_RATE);
    const vote = _detectTempoFromOnsetsPure(onsets);
    const tabBpm = _localBpmFromBeatsPure(BEATS, 0, END_T, true);
    assert.ok(Math.abs(prop.factor - vote.bpm / tabBpm) < 1e-3,
        `factor ${prop.factor} == vote ${vote.bpm} / grid ${tabBpm.toFixed(2)}`);
});

t('uniform reduction: a same-tempo song gives every section the same factor', () => {
    // Both halves at the SAME audio tempo: per-section must agree with global.
    const audio = BEAT_T.map((x) => x * RV);
    const onsets = _spectralFluxOnsetsPure(clickTrackAt(audio), SAMPLE_RATE);
    const res = _alignSectionsPure({ sections: SECTIONS, beats: BEATS, audioOnsets: onsets, sourceOnsets: BEAT_T, prior: UNIT_PRIOR });
    const verse = byName(res, 'Verse'), solo = byName(res, 'Solo');
    assert.ok(Math.abs(verse.factor - solo.factor) < 0.02, `both halves read the same factor (${verse.factor} vs ${solo.factor})`);
    assert.ok(Math.abs(verse.factor - VERSE_AUDIO_BPM / CHART_BPM) < 0.02, 'and it is the true one');
});

t('a section whose first note is not on its marker keeps the marker place', () => {
    // 120 BPM grid 0..20 s, recording = identity (audio time == chart time), but
    // the ONLY notes run 5..19.5 — the section marker (2) is 3 s before the
    // first note. The window must anchor on the first REAL onset, not the
    // boundary, or the whole map silently shifts by a beat count.
    const gBeats = buildGrid(0, 10, CHART_BPM);
    const notes = [];
    for (let t = 5; t <= 19.5 + 1e-9; t += 0.5) notes.push(t);
    const onsets = _spectralFluxOnsetsPure(clickTrackAt(notes.slice()), SAMPLE_RATE);
    const res = _alignSectionsPure({
        sections: [{ name: 'Section', number: 1, start_time: 2 }],
        beats: gBeats, audioOnsets: onsets, sourceOnsets: notes, prior: UNIT_PRIOR,
    });
    const prop = byName(res, 'Section');
    assert.ok(prop && prop.ok, `the section aligns (${prop && (prop.reason || 'ok')})`);
    // Sub-BPM vote jitter moves slope a hair off 1; the map must still land the
    // first note on ITS OWN audio, not on the (2,2) place a boundary anchor
    // would have given (intercept ≈ -3).
    const atFirstNote = prop.slope * 5 + prop.intercept;
    assert.ok(Math.abs(atFirstNote - 5) < 0.1, `map(5) ≈ 5, got ${atFirstNote.toFixed(3)} (intercept ${prop.intercept})`);
    assert.ok(Math.abs(prop.intercept) < 0.2, `the map keeps the marker's place (intercept ${prop.intercept})`);
    assert.ok(Math.abs(prop.slope - 1) < 0.01, `slope ${prop.slope.toFixed(4)} ≈ 1`);
    const first = prop.anchors[0];
    assert.ok(first && Math.abs(first.source - 5) < 1e-9 && Math.abs(first.audio - 5) < 0.1,
        `first anchor lands on the first note (5,5), got ${JSON.stringify(first)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
