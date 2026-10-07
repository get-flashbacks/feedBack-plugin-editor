/*
 * Per-track offset extends the timeline bound (issue #48 follow-up to #41).
 *
 * The two duration sites used to read the global `audioShift` alone:
 *   - src/loop.js:_editorClampScrollX            (scroll bound so the tail is reachable)
 *   - src/audio.js:_audioTimelineDuration         (playback cursor clamp + loop restart)
 *
 * Proven here:
 *   1. _audioTrackEndsPure — the max-over-audio-rows walk that reuses
 *      _trackPlacementPure: master + stems, per-track offsetSec, source offset,
 *      negative placements do NOT shrink the bound, non-audio rows are skipped,
 *      un-decoded sources contribute 0, adversarial values stay finite.
 *   2. The live wiring — a nudged MASTER track (always decoded → bounded
 *      immediately) grows BOTH _audioTimelineDuration() and the clamp, and
 *      reverting the offset restores the exact original bound (no shadow state).
 *
 * Run: node tests/track_placement_end.test.mjs
 */
import assert from 'node:assert';

globalThis.localStorage = globalThis.localStorage || {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
};
globalThis.document = globalThis.document || { getElementById: () => null };

const { _audioTimelineDuration } = await import('../src/audio.js');
const { _editorClampScrollX } = await import('../src/loop.js');
const { S } = await import('../src/state.js');
const { resetStemAudioCache } = await import('../src/audio.js');
const { _audioTrackEndsPure } = await import('../src/region.js');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

// ── 1. _audioTrackEndsPure ────────────────────────────────────────────────────
const songs = [
    { id: 'master', url: '/a.ogg', offset: 0 },
    { id: 'Guitar_L', url: '/l.ogg', offset: 0 },
    { id: 'Bass_DI', url: '/b.ogg', offset: 0.25 },
];
const trackRows = (o) => [
    { id: 'audio:master', type: 'audio', sourceId: 'master', offsetSec: o.master },
    { id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', offsetSec: o.guitarL },
    { id: 'audio:Bass_DI', type: 'audio', sourceId: 'Bass_DI', offsetSec: o.bass },
    { id: 'folder:1', type: 'folder', name: 'Gtrs', offsetSec: 999 },            // never audio
    { id: 'notes:Gtr', type: 'transcription', targetId: 'Gtr', offsetSec: 999 }, // never audio
];
const durations = { master: 10, Guitar_L: 30, Bass_DI: 12 };

t('_audioTrackEndsPure: the master row alone matches the legacy single-buffer bound', () => {
    // Same math the old _audioTimelineDurationPure did: dur + max(0, shift).
    const rows = [{ id: 'audio:master', type: 'audio', sourceId: 'master' }];
    assert.strictEqual(_audioTrackEndsPure(2, rows, [{ id: 'master', offset: 0 }], { master: 10 }),
        12, 'master tail = dur + max(0, global shift)');
    assert.strictEqual(_audioTrackEndsPure(-3, rows, [{ id: 'master', offset: 0 }], { master: 10 }),
        10, 'negative shift never shrinks the master bound');
});

t('_audioTrackEndsPure: the furthest track wins (the MAX over rows)', () => {
    // Bass (12s, +5 → 17) vs Guitar_L (30s, +0 → 30): 30 wins.
    assert.strictEqual(_audioTrackEndsPure(0, trackRows({ master: 0, guitarL: 0, bass: 5 }), songs, durations),
        30, 'the longest track bounds, not the most-shifted');
});

t('_audioTrackEndsPure: a stem nudged past the master end bounds the timeline', () => {
    // Master 10s (tail 10); Guitar_L 30s, offset +5 → tail 35.
    assert.strictEqual(_audioTrackEndsPure(0, trackRows({ master: 0, guitarL: 5, bass: 0 }), songs, durations),
        35, 'a nudged stem pushes the bound past the master');
});

t('_audioTrackEndsPure: source offsets and track offsets BOTH compose into the placement', () => {
    // Bass: source offset 0.25 + track offset 2.5 = placement 2.75; dur 12 → 14.75.
    const rows = [{ id: 'audio:Bass_DI', type: 'audio', sourceId: 'Bass_DI', offsetSec: 2.5 }];
    assert.strictEqual(_audioTrackEndsPure(0, rows, songs, durations), 14.75);
});

t('_audioTrackEndsPure: a negative placement does NOT shrink (crops front, not chart)', () => {
    // Guitar_L offset -10 on a 30s buffer: tail = 30 + max(0,-10) = 30, not 20.
    const rows = [{ id: 'audio:Guitar_L', type: 'audio', sourceId: 'Guitar_L', offsetSec: -10 }];
    assert.strictEqual(_audioTrackEndsPure(0, rows, songs, durations), 30,
        'negative offset holds the source length');
});

t('_audioTrackEndsPure: non-audio rows are skipped (folders, transcriptions)', () => {
    const rows = [
        { id: 'folder:1', type: 'folder', offsetSec: 100 },
        { id: 'notes:Gtr', type: 'transcription', offsetSec: 100 },
    ];
    assert.strictEqual(_audioTrackEndsPure(99, rows, songs, durations), 0,
        'only audio rows bound the timeline');
});

t('_audioTrackEndsPure: an un-decoded source (no duration) contributes nothing', () => {
    // Guitar_L decoded (30, offset +5 → 35); Bass not in the map → skipped.
    assert.strictEqual(_audioTrackEndsPure(0,
        trackRows({ master: 0, guitarL: 5, bass: 5 }),
        songs, { master: 10, Guitar_L: 30 }), 35);
});

t('_audioTrackEndsPure: empty / absent inputs degrade to 0 (node-safe)', () => {
    assert.strictEqual(_audioTrackEndsPure(0, null, null, null), 0);
    assert.strictEqual(_audioTrackEndsPure(0, [], [], {}), 0);
    assert.strictEqual(_audioTrackEndsPure(0, [{ type: 'audio' }], [], {}), 0,
        'an audio row with no source and no duration is skipped');
});

t('_audioTrackEndsPure: NaN / Infinity placement or duration terms never escape', () => {
    // _trackPlacementPure finite-checks placement; the duration is finite-checked
    // here too. Garbage in → 0 contribution, never NaN/Infinity out.
    const rows = [{ id: 'audio:master', type: 'audio', sourceId: 'master', offsetSec: NaN }];
    assert.strictEqual(_audioTrackEndsPure(Infinity, rows,
        [{ id: 'master', offset: 'abc' }], { master: Infinity }), 0);
    // And a sane placement with a sane duration still returns its tail.
    assert.strictEqual(_audioTrackEndsPure(3, rows, [{ id: 'master', offset: 0 }], { master: 10 }), 13);
});

// ── 2. The live wiring ────────────────────────────────────────────────────────
// The master is always decoded (S.audioBuffer), so a nudged MASTER track is
// bounded immediately by _audioTimelineDuration() / _editorClampScrollX().
function seedMasterOffset(offset) {
    resetStemAudioCache();
    Object.assign(S, {
        sessionId: 'sess-48', filename: '',
        duration: 0, audioShift: 0,
        audioBuffer: { duration: 10, sampleRate: 44100, getChannelData: () => new Float32Array(1) },
        masterAudioDuration: 10,
        audioUrl: '/a.ogg', masterAudioUrl: '/a.ogg',
        activeAudioSourceId: 'master', activeAudioSourceOffset: 0,
        stems: [], playing: false, zoom: 100,
        beats: [], arrangements: [], currentArr: 0,
        drumTab: null, drumEditMode: false, partsViewMode: false,
        partMix: {}, scrollX: 0,
        trackSession: {
            version: 4, removedSourceIds: [],
            tempoGuideSourceId: '', tempoGuideLocked: false, tempoGuideMode: 'audio',
            tracks: [{ id: 'audio:master', type: 'audio', sourceId: 'master',
                name: 'Master Mix', parentId: '', offsetSec: offset }],
        },
    });
}

t('live: _audioTimelineDuration() extends past the master tail when the master track is nudged', () => {
    seedMasterOffset(0);
    assert.strictEqual(_audioTimelineDuration(), 10, 'un-nudged: master tail is the bound');
    seedMasterOffset(8);
    assert.strictEqual(_audioTimelineDuration(), 18, 'master nudged +8 on a 10s buffer → tail at 18');
    seedMasterOffset(-5);
    assert.strictEqual(_audioTimelineDuration(), 10, 'master nudged -5 → bound holds at 10 (no shrink)');
});

t('live: _editorClampScrollX lets you scroll to the nudged tail (was pinned before #48)', () => {
    // Without the per-track term the clamp read audioShift alone → bound 10, tail at 10 unreachable.
    // Now a large requested scrollX clamps to the 18s bound's maxScroll, strictly higher.
    seedMasterOffset(0);
    const clampedBefore = _editorClampScrollX(10000);
    seedMasterOffset(8);
    const clampedAfter = _editorClampScrollX(10000);
    assert.ok(clampedAfter > clampedBefore,
        `nudged tail must extend the scroll bound (before=${clampedBefore}, after=${clampedAfter})`);
    assert.ok(Number.isFinite(clampedAfter), 'bound is finite');
    assert.strictEqual(_editorClampScrollX(0), 0, 'start of song stays at 0');
});

t('live: reverting the offset restores the exact original bound (no shadow state)', () => {
    seedMasterOffset(0);
    const restored = _audioTimelineDuration();
    seedMasterOffset(8);
    assert.ok(_audioTimelineDuration() === 18, 'offset applied grows the bound');
    seedMasterOffset(0);
    assert.strictEqual(_audioTimelineDuration(), restored,
        'reverting the offset restores the exact original bound — derived, not cached');
    // The clamp follows the same restoration: back to the pre-nudge maxScroll.
    seedMasterOffset(8);
    const withOffset = _editorClampScrollX(10000);
    seedMasterOffset(0);
    const reverted = _editorClampScrollX(10000);
    assert.ok(reverted < withOffset,
        `clamp restores the shorter bound after revert (with=${withOffset}, without=${reverted})`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
