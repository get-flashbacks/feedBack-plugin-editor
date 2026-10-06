/*
 * Issue #3 — the tier-simplification planner (src/tiers.js), pure module.
 *
 * The host's master-difficulty slider reads `phrases[].levels[idx].notes`, so
 * the editor must be able to MINT an easier level for a phrase. The editor
 * models the ladder as `phrases[].tiers[]` (routes.py `_repopulate_phrase_levels`
 * keeps authored lower tiers verbatim and rebuilds the top tier from the flat
 * chart's window slice on save). This suite pins the planner's contract:
 *
 *   - phrase windows mirror the backend's `[start_i, start_{i+1})` slicing,
 *     with the first/last -inf/+inf tails and boundary time belonging to the
 *     NEXT phrase;
 *   - chain members (hammer-on/pull-off) drop, lead techniques strip to the
 *     load-side defaults (routes.py `_note_tech_default`), bend curves null,
 *     micro-sustains cut only when positive;
 *   - chord simplification flips `high_density` and nothing else;
 *   - the planner refuses `floor`/`empty`/`wiped`/`noop` instead of building a
 *     junk tier, and never mutates its inputs.
 *
 * Run: node --test tests/tier_simplify.test.mjs
 */
import assert from 'node:assert';
import test from 'node:test';

import {
    CHAIN_TECHNIQUES,
    STRIP_TECHNIQUES,
    _deepEqual,
    beatSecondsAt,
    deriveSimplifiedChords,
    deriveSimplifiedNotes,
    findPhraseIndexAt,
    planTierSimplification,
    sliceByWindow,
    windowForPhrase,
} from '../src/tiers.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const chainNote = (time, over = {}) => ({
    time, string: 1, fret: 5, sustain: 0,
    techniques: { hammer_on: true }, ...over,
});
const bendNote = (time, over = {}) => ({
    time, string: 2, fret: 7, sustain: 0.5,
    techniques: {
        bend: 0.25, bend_intent: 2, slide_to: 4, slide_unpitch_to: 2, tap: true,
        bend_values: [[0, 0], [1, 0.25]],
    }, ...over,
});
const plainNote = (time, over = {}) => ({
    time, string: 0, fret: 3, sustain: 0, techniques: {}, ...over,
});
const hdChord = (time, over = {}) => ({
    time, chord_id: 0, high_density: true, fn: null,
    notes: [{ string: 0, fret: 3, sustain: 0.5, techniques: {} }], ...over,
});
const anchor = (time, over = {}) => ({ time, fret: 5, width: 4, ...over });
const handshape = (start, end, over = {}) => (
    { chord_id: 0, start_time: start, end_time: end, arp: false, ...over });

function window_() {
    return {
        notes: [
            plainNote(0.0),
            chainNote(0.5),
            bendNote(1.0),
            plainNote(1.5, { sustain: 0.01 }),
        ],
        chords: [hdChord(1.0)],
        anchors: [anchor(0.25)],
        handshapes: [handshape(0.0, 2.0)],
    };
}
const freshPhrase = (over = {}) => (
    { name: 'phrase', number: 1, start_time: 0.0, tiers: [], ...over });

// ── Contract constants ──────────────────────────────────────────────────────

test('CHAIN_TECHNIQUES is the frozen hammer-on/pull-off pair', () => {
    assert.deepStrictEqual([...CHAIN_TECHNIQUES], ['hammer_on', 'pull_off']);
    assert.ok(Object.isFrozen(CHAIN_TECHNIQUES));
});

test('STRIP_TECHNIQUES is the frozen lead-technique list', () => {
    assert.deepStrictEqual([...STRIP_TECHNIQUES],
        ['bend', 'bend_intent', 'slide_to', 'slide_unpitch_to', 'tap']);
    assert.ok(Object.isFrozen(STRIP_TECHNIQUES));
});

// ── Phrase windows ──────────────────────────────────────────────────────────

test('windowForPhrase: interior bounded by neighbours, tails infinite', () => {
    const phrases = [{ start_time: 0 }, { start_time: 10 }, { start_time: 20 }];
    assert.deepStrictEqual(windowForPhrase(phrases, 0), { t0: -Infinity, t1: 10 });
    assert.deepStrictEqual(windowForPhrase(phrases, 1), { t0: 10, t1: 20 });
    assert.deepStrictEqual(windowForPhrase(phrases, 2), { t0: 20, t1: Infinity });
});

test('windowForPhrase: missing/invalid start_time reads as 0', () => {
    const phrases = [{}, { start_time: 'junk' }, { start_time: 20 }];
    assert.deepStrictEqual(windowForPhrase(phrases, 0), { t0: -Infinity, t1: 0 });
    assert.deepStrictEqual(windowForPhrase(phrases, 1), { t0: 0, t1: 20 });
    assert.deepStrictEqual(windowForPhrase(phrases, 2), { t0: 20, t1: Infinity });
});

test('findPhraseIndexAt: empty list → -1, otherwise every time lands', () => {
    assert.strictEqual(findPhraseIndexAt([], 5), -1);
    const phrases = [{ start_time: 0 }, { start_time: 10 }, { start_time: 20 }];
    assert.strictEqual(findPhraseIndexAt(phrases, -50), 0, 'first tail');
    assert.strictEqual(findPhraseIndexAt(phrases, 999), 2, 'last tail');
});

test('findPhraseIndexAt: boundary equality belongs to the NEXT phrase', () => {
    const phrases = [{ start_time: 0 }, { start_time: 10 }, { start_time: 20 }];
    assert.strictEqual(findPhraseIndexAt(phrases, 0), 0);
    assert.strictEqual(findPhraseIndexAt(phrases, 9.999), 0);
    assert.strictEqual(findPhraseIndexAt(phrases, 10), 1);
    assert.strictEqual(findPhraseIndexAt(phrases, 20), 2);
});

// ── Window slicing ──────────────────────────────────────────────────────────

test('sliceByWindow: [t0, t1) membership, input order, references kept', () => {
    const items = [plainNote(0), plainNote(5), plainNote(10), plainNote(15)];
    const out = sliceByWindow(items, 5, 10);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0], items[1], 'same reference — no clone');
    assert.strictEqual(items.length, 4, 'input untouched');
});

test('sliceByWindow: handshapes slice on start_time; non-objects drop', () => {
    const hs = [null, 'junk', handshape(1, 2), handshape(3, 4)];
    const out = sliceByWindow(hs, 1, 3, 'start_time');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0], hs[2]);
});

// ── Note simplification ─────────────────────────────────────────────────────

test('deriveSimplifiedNotes: chain members drop and are counted', () => {
    const res = deriveSimplifiedNotes([
        plainNote(0), chainNote(0.5), plainNote(1, { techniques: { pull_off: true } }),
    ]);
    assert.strictEqual(res.droppedChain, 2);
    assert.strictEqual(res.notes.length, 1);
    assert.strictEqual(res.notes[0].time, 0);
});

test('deriveSimplifiedNotes: strip values are the exact load-side defaults', () => {
    const res = deriveSimplifiedNotes([bendNote(1.0, {
        techniques: {
            bend: 0.5, bend_intent: 3, slide_to: 4, slide_unpitch_to: 2, tap: true,
            bend_values: [[0, 0]],
            vibrato: true, tremolo: true, palm_mute: true, mute: true, accent: true,
        },
    })]);
    assert.strictEqual(res.stripped, 1);
    const techs = res.notes[0].techniques;
    assert.strictEqual(techs.bend, null);
    assert.strictEqual(techs.bend_intent, 0);
    assert.strictEqual(techs.slide_to, -1);
    assert.strictEqual(techs.slide_unpitch_to, -1);
    assert.strictEqual(techs.tap, false);
    assert.strictEqual(techs.bend_values, null);
    // Ornaments are playability texture — they ride along untouched.
    assert.strictEqual(techs.vibrato, true);
    assert.strictEqual(techs.tremolo, true);
    assert.strictEqual(techs.palm_mute, true);
    assert.strictEqual(techs.mute, true);
    assert.strictEqual(techs.accent, true);
});

test('deriveSimplifiedNotes: a present bend key forfeits bend_values even when already null', () => {
    const res = deriveSimplifiedNotes([
        plainNote(0, { techniques: { bend: null, bend_values: [[0, 0.2]] } }),
    ]);
    assert.strictEqual(res.stripped, 1);
    assert.strictEqual(res.notes[0].techniques.bend, null);
    assert.strictEqual(res.notes[0].techniques.bend_values, null);
});

test('deriveSimplifiedNotes: minSustain cuts only positive sustains below it', () => {
    const notes = [
        plainNote(0, { sustain: 0.05 }),
        plainNote(0.5, { sustain: 0.1 }),
        plainNote(1.0, { sustain: 0.15 }),
        plainNote(1.5, { sustain: 0 }),
        plainNote(2.0, { sustain: -0.5 }),
        plainNote(2.5, { sustain: null }),
        plainNote(3.0),
    ];
    const res = deriveSimplifiedNotes(notes, { minSustain: 0.1 });
    assert.strictEqual(res.droppedShort, 1, 'only 0.05 is positive and below');
    assert.strictEqual(res.notes.length, 6);
    assert.strictEqual(res.notes.some(n => n.time === 0), false);
    assert.strictEqual(res.notes.some(n => n.time === 0.5), true, 'exactly at the floor is kept');
});

test('deriveSimplifiedNotes: null/absent minSustain means no sustain drops', () => {
    const notes = [plainNote(0, { sustain: 0.001 }), plainNote(0.5)];
    for (const opts of [undefined, {}, { minSustain: null }, { minSustain: 0 }]) {
        const res = opts === undefined
            ? deriveSimplifiedNotes(notes)
            : deriveSimplifiedNotes(notes, opts);
        assert.strictEqual(res.droppedShort, 0);
        assert.strictEqual(res.notes.length, 2);
    }
});

test('deriveSimplifiedNotes: output is deep-cloned and techniques synthesized', () => {
    const src = [chainNote(0), { time: 1, string: 0, fret: 1, sustain: 0 }];
    const res = deriveSimplifiedNotes(src);
    const bare = res.notes.find(n => n.time === 1);
    assert.deepStrictEqual(bare.techniques, {}, 'synthesized techniques dict');
    assert.ok(!('techniques' in src[1]), 'input note untouched');
    bare.techniques.bend = 'junk';
    bare.string = 9;
    assert.strictEqual(src[0].techniques.hammer_on, true, 'input unchanged after result mutation');
    assert.strictEqual(src[1].string, 0);
});

// ── Chord simplification ────────────────────────────────────────────────────

test('deriveSimplifiedChords: only high_density flips; non-objects drop', () => {
    const chords = [hdChord(0), hdChord(1, { high_density: false }), hdChord(2, { high_density: undefined }), 42];
    const res = deriveSimplifiedChords(chords);
    assert.strictEqual(res.chords.length, 3);
    assert.strictEqual(res.thinned, 1);
    assert.strictEqual(res.chords[0].high_density, false);
    assert.strictEqual(res.chords[1].high_density, false);
    assert.strictEqual(res.chords[2].high_density, undefined);
    assert.deepStrictEqual(res.chords[0].notes, chords[0].notes, 'member notes verbatim');
});

test('deriveSimplifiedChords: no input mutation', () => {
    const chords = [hdChord(0)];
    const res = deriveSimplifiedChords(chords);
    res.chords[0].high_density = 'junk';
    res.chords[0].notes[0].fret = 99;
    assert.strictEqual(chords[0].high_density, true);
    assert.strictEqual(chords[0].notes[0].fret, 3);
});

// ── Beat grid → seconds ─────────────────────────────────────────────────────

const GRID = [{ time: 0.0, measure: 1 }, { time: 0.5, measure: -1 }, { time: 1.1, measure: -1 }, { time: 1.5, measure: -1 }];

const near = (a, b, msg) =>
    assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} (${a} ≉ ${b})`);

test('beatSecondsAt: the containing interior gap is the local beat', () => {
    near(beatSecondsAt(GRID, 0.8), 0.6);
    near(beatSecondsAt(GRID, 1.2), 0.4);
    near(beatSecondsAt(GRID, 0.0), 0.5);
});

test('beatSecondsAt: edges extrapolate along the first/last span', () => {
    near(beatSecondsAt(GRID, -3), 0.5, 'before the first beat');
    near(beatSecondsAt(GRID, 99), 0.4, 'after the last beat');
});

test('beatSecondsAt: a two-beat grid answers everywhere on the line', () => {
    const two = [{ time: 0, measure: 1 }, { time: 0.5, measure: -1 }];
    near(beatSecondsAt(two, -1), 0.5);
    near(beatSecondsAt(two, 0.25), 0.5);
    near(beatSecondsAt(two, 42), 0.5);
});

test('beatSecondsAt: degenerate gaps skip to a real span', () => {
    const dup = [{ time: 0, measure: 1 }, { time: 0.5, measure: -1 }, { time: 0.5, measure: -1 }, { time: 1.0, measure: 2 }];
    near(beatSecondsAt(dup, 0.5), 0.5);
    near(beatSecondsAt(dup, 0.25), 0.5);
});

test('beatSecondsAt: < 2 beats or no valid gaps → null', () => {
    assert.strictEqual(beatSecondsAt(undefined, 1), null);
    assert.strictEqual(beatSecondsAt([], 1), null);
    assert.strictEqual(beatSecondsAt([{ time: 0, measure: 1 }], 1), null);
    assert.strictEqual(beatSecondsAt([{}, {}], 1), null);
});

// ── _deepEqual ──────────────────────────────────────────────────────────────

test('_deepEqual: key order free, structure strict', () => {
    assert.strictEqual(_deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
    assert.strictEqual(_deepEqual({ a: 1 }, { a: 1, b: undefined }), false, 'key sets differ');
    assert.strictEqual(_deepEqual([1, 2], [1, 2, 3]), false);
    assert.strictEqual(_deepEqual({ a: [1] }, { a: [[1]] }), false);
    assert.strictEqual(_deepEqual(null, {}), false);
    assert.strictEqual(_deepEqual(NaN, NaN), true);
    assert.strictEqual(_deepEqual('1', 1), false);
});

// ── The planner ─────────────────────────────────────────────────────────────

test('planTierSimplification: fresh phrase → [simplified, full-window stub], maxDifficulty 1', () => {
    const phrase = freshPhrase();
    const win = window_();
    const res = planTierSimplification(phrase, win, { minSustain: 0.2 });
    assert.ok(!res.error, `unexpected refusal: ${res.error}`);
    assert.deepStrictEqual(res.tiers.map(t => t.difficulty), [0, 1]);
    assert.strictEqual(res.maxDifficulty, 1);
    assert.strictEqual(res.addedDifficulty, 0);
    assert.strictEqual(res.srcNoteCount, 4);
    assert.strictEqual(res.keptNoteCount, 2);
    assert.strictEqual(res.droppedChain, 1);
    assert.strictEqual(res.stripped, 1);
    assert.strictEqual(res.droppedShort, 1);
    assert.strictEqual(res.thinned, 1);
});

test('planTierSimplification: the fresh simplified tier carries the stripped content', () => {
    const res = planTierSimplification(freshPhrase(), window_(), { minSustain: 0.2 });
    const [tier0, tier1] = res.tiers;
    // Tier 0: chain note gone, bend note stripped to defaults, micro-sustain gone.
    assert.deepStrictEqual(tier0.notes.map(n => n.time), [0.0, 1.0]);
    const bent = tier0.notes[1];
    assert.strictEqual(bent.techniques.bend, null);
    assert.strictEqual(bent.techniques.bend_values, null);
    assert.strictEqual(bent.techniques.slide_to, -1);
    assert.strictEqual(bent.techniques.tap, false);
    assert.strictEqual(tier0.chords[0].high_density, false);
    assert.deepStrictEqual(tier0.anchors, [anchor(0.25)]);
    assert.deepStrictEqual(tier0.handshapes, [handshape(0.0, 2.0)]);
    // Tier 1 is the full chart copy — the editable flat chart.
    assert.deepStrictEqual(tier1.notes, window_().notes);
    assert.strictEqual(tier1.chords[0].high_density, true);
    assert.deepStrictEqual(tier1.anchors, [anchor(0.25)]);
    assert.deepStrictEqual(tier1.handshapes, [handshape(0.0, 2.0)]);
});

test('planTierSimplification: a DECLARED max_difficulty wins when larger', () => {
    const phrase = freshPhrase({ max_difficulty: 3 });
    const res = planTierSimplification(phrase, window_(), { minSustain: 0.2 });
    assert.strictEqual(res.maxDifficulty, 3);
    assert.strictEqual(res.tiers.length, 2);
});

test('planTierSimplification: garbage max_difficulty is ignored', () => {
    const phrase = freshPhrase({ max_difficulty: '3' });
    const res = planTierSimplification(phrase, window_(), { minSustain: 0.2 });
    assert.strictEqual(res.maxDifficulty, 1);
});

test('planTierSimplification: a LONE top tier sources the live chart, not the tier copy', () => {
    // A single rung at difficulty N is the top tier — the editable flat chart
    // copy save rebuilds on write. If the user edited the chart after load,
    // the loaded tier copy is stale: the new rung must derive from the live
    // window slice, and re-emit the top rung from it too. Handshapes are the
    // exception — save reads them off the tier, never off the chart, so the
    // re-emit preserves the tier's own list.
    const stale = bendNote(0.0);   // the chart's bent note, edited away since
    const live = plainNote(0.0);
    const phrase = freshPhrase({
        max_difficulty: 2,
        tiers: [{
            difficulty: 2,
            notes: [stale, chainNote(0.5)],
            chords: [],
            anchors: [],
            handshapes: [handshape(1.5, 2.5, { chord_id: 1 })],
        }],
    });
    const win = {
        notes: [live, chainNote(0.5)],
        chords: [],
        anchors: [anchor(0.25)],
        handshapes: [handshape(0.0, 2.0)],
    };
    const res = planTierSimplification(phrase, win, { minSustain: 0.2 });
    assert.ok(!res.error, `unexpected refusal: ${res.error}`);
    assert.deepStrictEqual(res.tiers.map(t => t.difficulty), [1, 2]);
    assert.strictEqual(res.addedDifficulty, 1, 'one below the lone top tier');
    assert.strictEqual(res.maxDifficulty, 2, 'declared max preserved');
    assert.strictEqual(res.stripped, 0, 'the LIVE source is already plain — nothing stripped');
    assert.deepStrictEqual(res.tiers[0].notes.map(n => n.time), [0.0],
        'chain member still drops out of the new rung');
    // The re-emitted top rung is the live window copy, not the stale tier:
    // no stale bend survives, and the window's anchors ride it.
    assert.deepStrictEqual(res.tiers[1].notes, win.notes);
    assert.deepStrictEqual(res.tiers[1].anchors, [anchor(0.25)]);
    // ...except handshapes: `_authored_phrase_levels` re-slices only
    // notes/chords/anchors from the chart and reads handshapes off the tier,
    // so keeping the tier's own is what leaves the next save byte-identical.
    assert.deepStrictEqual(res.tiers[1].handshapes, [handshape(1.5, 2.5, { chord_id: 1 })]);
    // The NEW rung is fresh content and takes the window's handshapes.
    assert.deepStrictEqual(res.tiers[0].handshapes, [handshape(0.0, 2.0)]);
});

test('planTierSimplification: tiers [1,3] → rung 0 derived from tier 1 itself', () => {
    const tier1 = {
        difficulty: 1,
        notes: [plainNote(0.25), chainNote(0.75)],
        chords: [],
        anchors: [anchor(0.25, { fret: 2 })],
        handshapes: [handshape(0.0, 1.0, { chord_id: 1, arp: true })],
    };
    const tier3 = {
        difficulty: 3,
        notes: [bendNote(2.0)],
        chords: [hdChord(2.0)],
        anchors: [],
        handshapes: [],
    };
    const phrase = freshPhrase({ max_difficulty: 3, tiers: [tier3, tier1] });
    const win = window_();
    const res = planTierSimplification(phrase, win, { minSustain: 0.2 });
    assert.ok(!res.error, `unexpected refusal: ${res.error}`);
    assert.deepStrictEqual(res.tiers.map(t => t.difficulty), [0, 1, 3]);
    assert.strictEqual(res.maxDifficulty, 3, 'declared max preserved');
    assert.strictEqual(res.addedDifficulty, 0);
    assert.strictEqual(res.droppedChain, 1, 'source was tier 1, not the window');
    assert.deepStrictEqual(res.tiers[0].notes.map(n => n.time), [0.25]);
    assert.deepStrictEqual(res.tiers[0].anchors, [anchor(0.25, { fret: 2 })],
        'the rung rides the source tier’s own anchors');
    assert.deepStrictEqual(res.tiers[0].handshapes, [handshape(0.0, 1.0, { chord_id: 1, arp: true })]);
    // Existing tiers survive verbatim (five-key shape, ascending).
    assert.deepStrictEqual(res.tiers[2], tier3);
});

test('planTierSimplification: tier without anchors/handshapes falls back to the window', () => {
    // A MULTI-tier ladder sources the easiest tier: the bend note keeps the
    // simplification from being a noop, so the rung actually gets built (and
    // its anchors/handshapes come from the window).
    const phrase = freshPhrase({
        tiers: [
            {
                difficulty: 1,
                notes: [plainNote(0.25), bendNote(0.5)],
                chords: [],
            },
            { difficulty: 2, notes: [plainNote(0.25)], chords: [] },
        ],
    });
    const res = planTierSimplification(phrase, window_(), { minSustain: 0.2 });
    assert.ok(!res.error, `unexpected refusal: ${res.error}`);
    assert.deepStrictEqual(res.tiers[0].anchors, [anchor(0.25)]);
    assert.deepStrictEqual(res.tiers[0].handshapes, [handshape(0.0, 2.0)]);
});

test('planTierSimplification: refuses empty when the source has no notes and no chords', () => {
    const fresh = planTierSimplification(freshPhrase(), { notes: [], chords: [], anchors: [], handshapes: [] });
    assert.strictEqual(fresh.error, 'empty');
    assert.ok(typeof fresh.message === 'string' && fresh.message.length > 0, 'human message');
    // Same guard on the authored-ladder path (the window has content — the
    // refusal proves the SOURCE pick is the tier's own empty content). A lone
    // top tier is exempt: it sources the live chart, so an empty TIER with a
    // full window plans a rung instead of refusing.
    const phrase = freshPhrase({ tiers: [{ difficulty: 2, notes: [], chords: [] }] });
    const tiered = planTierSimplification(phrase, window_(), { minSustain: 0.2 });
    assert.ok(!tiered.error, `lone top tier plans from the window: ${tiered.error}`);
    const multi = freshPhrase({
        tiers: [
            { difficulty: 1, notes: [], chords: [] },
            { difficulty: 2, notes: [], chords: [] },
        ],
    });
    assert.strictEqual(
        planTierSimplification(multi, window_(), { minSustain: 0.2 }).error, 'empty',
        'a multi-tier ladder with empty easiest tier still refuses');
});

test('planTierSimplification: refuses wiped when simplification empties the phrase', () => {
    const win = {
        notes: [plainNote(0, { sustain: 0.01 })],
        chords: [],
        anchors: [],
        handshapes: [],
    };
    const res = planTierSimplification(freshPhrase(), win, { minSustain: 0.2 });
    assert.strictEqual(res.error, 'wiped');
    assert.ok(typeof res.message === 'string' && res.message.length > 0);
});

test('planTierSimplification: a multi-tier ladder of chain notes cascades to wiped', () => {
    const phrase = freshPhrase({
        tiers: [
            { difficulty: 1, notes: [chainNote(0), chainNote(1)], chords: [] },
            { difficulty: 2, notes: [chainNote(0), chainNote(1)], chords: [] },
        ],
    });
    const res = planTierSimplification(phrase, window_(), { minSustain: 0.2 });
    assert.strictEqual(res.error, 'wiped');
});

test('planTierSimplification: refuses noop when simplification changes nothing', () => {
    // Plain content, already at the load-side defaults.
    const win = {
        notes: [plainNote(0), plainNote(0.5)],
        chords: [hdChord(0.5, { high_density: false })],
        anchors: [],
        handshapes: [],
    };
    const res = planTierSimplification(freshPhrase(), win, { minSustain: 0.2 });
    assert.strictEqual(res.error, 'noop');
    assert.ok(typeof res.message === 'string' && res.message.length > 0);
    // And an already-stripped bend note (bend null, curve absent) is a noop too.
    const win2 = {
        notes: [plainNote(0, { techniques: { bend: null } })],
        chords: [], anchors: [], handshapes: [],
    };
    assert.strictEqual(planTierSimplification(freshPhrase(), win2).error, 'noop');
});

test('planTierSimplification: floor is checked FIRST — tiers [0,2] answers floor, not noop', () => {
    const phrase = freshPhrase({
        tiers: [
            { difficulty: 0, notes: [plainNote(0)], chords: [] },
            { difficulty: 2, notes: [bendNote(1)], chords: [] },
        ],
    });
    const res = planTierSimplification(phrase, window_(), { minSustain: 0.2 });
    assert.strictEqual(res.error, 'floor');
    assert.ok(typeof res.message === 'string' && res.message.length > 0);
});

test('planTierSimplification: never mutates phrase or window', () => {
    const phrase = freshPhrase({ max_difficulty: 3 });
    const win = window_();
    const phraseSnap = JSON.stringify(phrase);
    const winSnap = JSON.stringify(win);
    const res = planTierSimplification(phrase, win, { minSustain: 0.2 });
    assert.ok(!res.error, `unexpected refusal: ${res.error}`);
    assert.strictEqual(JSON.stringify(phrase), phraseSnap);
    assert.strictEqual(JSON.stringify(win), winSnap);
    // Fresh identities everywhere — mutating a result cannot leak back.
    assert.notStrictEqual(res.tiers[0].notes[0], win.notes[0]);
    res.tiers[0].notes[0].techniques.bend = 'junk';
    assert.strictEqual(win.notes[2].techniques.bend, 0.25);
});
