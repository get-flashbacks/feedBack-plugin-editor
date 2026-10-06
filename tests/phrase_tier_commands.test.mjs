'use strict';
/*
 * Tests for the undoable tier-ladder write (SimplifyPhraseCmd, the
 * @pure:tier-cmds block driven through the REAL @pure:edit-history
 * EditHistory — no stub of the subject), plus an integration-style pure run:
 * window slice (src/tiers.js) → planTierSimplification → SimplifyPhraseCmd
 * exec → undo/redo on the phrase.
 *
 * Issue #3: the mastery slider reads phrases[].levels[] on disk; the editor
 * authors that ladder as phrases[].tiers[] (save repopulates lower tiers
 * verbatim, re-slices the TOP tier from the flat chart — see the README's
 * tiers invariant). The write is ref-held (the phrase object plus both
 * ladders), songScope like AddPhraseCmd (tiers are arrangement STRUCTURE,
 * never a fretted-note write), and rollback restores ABSENCE (a pre-ladder
 * phrase comes back without a tiers/max_difficulty key at all, not with an
 * undefined-valued one). These assertions fail without the @pure:tier-cmds
 * block.
 *
 * Run: node tests/phrase_tier_commands.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import { EditHistory } from '../src/history.js';
import { _rollReadOnly } from '../src/keys.js';
import { beatSecondsAt, planTierSimplification, sliceByWindow, windowForPhrase } from '../src/tiers.js';
import { seedState, trackHooks } from './_history_env.mjs';

const src = fs.readFileSync(new URL('../src/input.js', import.meta.url), 'utf8');
function extract(name) {
    const re = new RegExp(
        '/\\* @pure:' + name + ':start \\*/[\\s\\S]*?/\\* @pure:' + name + ':end \\*/');
    const m = src.match(re);
    if (!m) { console.error(`FAIL: @pure:${name} block missing`); process.exit(1); }
    return m[0];
}

// The REAL EditHistory + the REAL tier command sliced from source. The command
// operates on the phrase object it is handed, so no global state is needed
// beyond a live history.
function makeEnv() {
    const S = seedState({ sections: [], history: null });
    const api = new Function(
        'S',
        '"use strict";'
        + extract('tier-cmds') + '\n'
        + 'return { SimplifyPhraseCmd };'
    )(S);
    trackHooks();
    S.history = new EditHistory();
    return { ...api, S, history: S.history };
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

const TIER = (difficulty, notes = [], chords = [], anchors = [], handshapes = []) =>
    ({ difficulty, notes, chords, anchors, handshapes });

// ── SimplifyPhraseCmd ────────────────────────────────────────────────────────

t('simplify: exec swaps the ladder in; rollback restores the original tiers REFERENCE and removes a max_difficulty the phrase never had', () => {
    const env = makeEnv();
    const ph = {
        name: 'phrase', number: 1, start_time: 0,
        tiers: [TIER(0)],
    };
    const prevSnapshot = clone(ph);
    const prevTiers = ph.tiers;
    const nextTiers = [TIER(0), TIER(1)];
    env.S.history.exec(new env.SimplifyPhraseCmd(ph, prevTiers, nextTiers, ph.max_difficulty, 1));
    assert.strictEqual(ph.tiers, nextTiers, 'exec staged the new ladder by reference');
    assert.strictEqual(ph.max_difficulty, 1, 'exec records the new top difficulty');
    assert.ok(hasOwn(ph, 'max_difficulty'), 'harness: the key was actually written');
    env.S.history.doUndo();
    assert.strictEqual(ph.tiers, prevTiers, 'rollback restores the ORIGINAL tiers array reference, not a copy');
    assert.ok(!hasOwn(ph, 'max_difficulty'), 'a max_difficulty the phrase never had is removed again — not left undefined');
    assert.deepStrictEqual(ph, prevSnapshot, 'and the phrase is byte-identical to before');
    env.S.history.doRedo();
    assert.strictEqual(ph.tiers, nextTiers, 'redo re-installs the same ladder object');
    assert.strictEqual(ph.max_difficulty, 1);
});

t('simplify: a pre-existing max_difficulty is restored as the old number', () => {
    const env = makeEnv();
    // A pack phrase with an authored ladder and a declared top difficulty.
    const ph = {
        name: 'phrase', number: 1, start_time: 2,
        max_difficulty: 2,
        tiers: [TIER(2)],
    };
    const prevTiers = ph.tiers;
    const nextTiers = [TIER(1), TIER(2)];
    env.S.history.exec(new env.SimplifyPhraseCmd(ph, prevTiers, nextTiers, 2, 1));
    assert.strictEqual(ph.max_difficulty, 1, 'exec re-declares the ladder top for the new rung');
    env.S.history.doUndo();
    assert.strictEqual(ph.tiers, prevTiers);
    assert.strictEqual(ph.max_difficulty, 2, 'rollback restores the OLD declared number, verbatim');
    env.S.history.doRedo();
    assert.strictEqual(ph.max_difficulty, 1);
});

t('simplify: a pre-ladder phrase (no tiers key) rolls back to true absence', () => {
    const env = makeEnv();
    const ph = { name: 'phrase', number: 1, start_time: 0 };   // no `tiers` key at all
    const nextTiers = [TIER(0), TIER(1)];
    env.S.history.exec(new env.SimplifyPhraseCmd(ph, undefined, nextTiers, undefined, 1));
    assert.strictEqual(ph.tiers, nextTiers, 'exec creates the ladder');
    env.S.history.doUndo();
    assert.ok(!hasOwn(ph, 'tiers'), 'DEFENSIVE: the tiers key is deleted on rollback, not set to undefined');
    assert.ok(!hasOwn(ph, 'max_difficulty'), 'DEFENSIVE: max_difficulty absence is restored as absence too');
    env.S.history.doRedo();
    assert.strictEqual(ph.tiers, nextTiers, 'redo works across the deleted-key rollback');
});

// The read-only-roll lock refuses NOTE-scope commands while a fretted part is
// shown in the piano roll; a tier ladder arrangement-STRUCTURE write must pass
// the same songScope carve-out the phrase add takes (an unflagged command
// still gets refused — that is the control that proves the lock is live).
t('read-only roll: the tier-ladder write bypasses the lock (unflagged commands do not)', () => {
    const env = makeEnv();
    // Fretted part ("Lead") shown in the piano roll = the read-only lock is live.
    seedState({ arrangements: [{ id: 'a1', name: 'Lead', notes: [], chords: [] }],
        currentArr: 0, rollView: true });
    assert.ok(_rollReadOnly(), 'harness: the roll is read-only for a fretted part');

    // Control: an unflagged command IS refused here — proves the lock is engaged.
    let ran = 0;
    env.S.history.exec({ exec() { ran++; }, rollback() { ran--; } });
    assert.strictEqual(ran, 0, 'harness bites: an unflagged command is blocked by the live lock');

    // The tier write (songScope) goes through anyway and undoes cleanly.
    const ph = { name: 'phrase', number: 1, start_time: 0, tiers: [] };
    const prevTiers = ph.tiers;
    env.S.history.exec(new env.SimplifyPhraseCmd(
        ph, prevTiers, [TIER(0), TIER(1)], ph.max_difficulty, 1));
    assert.strictEqual(ph.tiers.length, 2, 'the ladder was installed — songScope passed the lock');
    env.S.history.doUndo();
    assert.strictEqual(ph.tiers, prevTiers, 'and it rolls back even from inside the locked roll');
});

// ── Integration: window slice → plan → commit → undo/redo ───────────────────

t('integration: window slice → plan → exec yields the two-rung ladder; undo/redo are ref-exact', () => {
    const env = makeEnv();
    // Two phrases, so phrase 1's window is finite: [0, 8).
    const phrases = [
        { name: 'phrase', number: 1, start_time: 0, tiers: [] },
        { name: 'phrase', number: 2, start_time: 8, tiers: [] },
    ];
    const notes = [
        { time: 0.0, string: 0, fret: 3, sustain: 0.5, techniques: {} },
        { time: 0.5, string: 1, fret: 5, sustain: 0.5, techniques: {} },
        // The chain: an anchor note and its hammer-on continuation. The low
        // tier drops the CONTINUATION (it replays its anchor); the anchor stays.
        { time: 1.0, string: 1, fret: 7, sustain: 0.5, techniques: { hammer_on: 1 } },
        // A lead ornament that strips: bend → null, bend curve → null.
        { time: 2.0, string: 0, fret: 9, sustain: 0.5, techniques: { bend: 2, bend_values: [0, 200] } },
        // A micro-sustain (positive, under half a local beat) that drops —
        // beside a sustain-0 (unknown-length) note that must STAY.
        { time: 3.0, string: 2, fret: 2, sustain: 0.05, techniques: {} },
        { time: 3.2, string: 2, fret: 4, sustain: 0, techniques: {} },
        // NEXT phrase's window — sliced off before planning.
        { time: 9.0, string: 0, fret: 1, sustain: 0.5, techniques: {} },
    ];
    const chords = [{ time: 0.0, high_density: true, name: 'Csus' }];
    const anchors = [{ time: 0.0, fret: 3, width: 4 }];
    const handshapes = [{ chord_id: 0, start_time: 0.0, end_time: 1.0, arp: false }];

    // Mirror the runner: one slice of each authored list, handshapes by
    // start_time.
    const { t0, t1 } = windowForPhrase(phrases, 0);
    const win = {
        notes: sliceByWindow(notes, t0, t1),
        chords: sliceByWindow(chords, t0, t1),
        anchors: sliceByWindow(anchors, t0, t1),
        handshapes: sliceByWindow(handshapes, t0, t1, 'start_time'),
    };
    assert.strictEqual(win.notes.length, 6, 'harness: the out-of-window note is sliced off');

    // Half a local beat, the runner's rule exactly (0.5 s beats → 0.25 s floor).
    const beats = [{ time: 0, measure: 1 }, { time: 0.5, measure: 1 }, { time: 1.0, measure: 2 }];
    const beatSecs = beatSecondsAt(beats, 0);
    assert.strictEqual(beatSecs, 0.5, 'harness: a real tempo map yields the local beat span');
    const plan = planTierSimplification(phrases[0], win, { minSustain: beatSecs * 0.5 });
    assert.ok(!plan.error, 'harness: the window plans a tier — ' + (plan.message || 'ok'));
    assert.strictEqual(plan.addedDifficulty, 0, 'a fresh ladder adds the difficulty-0 rung');
    assert.strictEqual(plan.maxDifficulty, 1, 'the fresh ladder tops out at 1 (no larger declared value)');
    assert.strictEqual(plan.srcNoteCount, 6);
    assert.strictEqual(plan.keptNoteCount, 4, 'chain member + micro-sustain drop; the unknown-length note stays');
    assert.strictEqual(plan.droppedChain, 1);
    assert.strictEqual(plan.droppedShort, 1);
    assert.strictEqual(plan.stripped, 1);
    assert.strictEqual(plan.thinned, 1, 'the dense chord thins to low density');
    assert.deepStrictEqual(plan.tiers.map(tr => tr.difficulty), [0, 1], 'the ladder is sorted by difficulty');

    const [tier0, tier1] = plan.tiers;
    assert.strictEqual(tier0.notes.length, 4, 'the simplified rung lost the chain member and the micro-sustain');
    assert.ok(!tier0.notes.some(n => n.techniques && n.techniques.hammer_on), 'no chain members survive into tier 0');
    assert.ok(tier0.notes.some(n => n.sustain === 0), 'a sustain-0 (unknown) note is kept, not cut with the micro-sustains');
    const bent = tier0.notes.find(n => n.techniques && hasOwn(n.techniques, 'bend'));
    assert.ok(bent, 'harness: the bent note stayed');
    assert.strictEqual(bent.techniques.bend, null, 'bend stripped to its load default');
    assert.strictEqual(bent.techniques.bend_values, null, 'and the bend curve is nulled too');
    assert.deepStrictEqual(tier0.chords, [{ time: 0.0, high_density: false, name: 'Csus' }], 'the dense chord thins to low density');
    assert.deepStrictEqual(tier0.anchors, win.anchors, 'anchor content rides into the tier verbatim (cloned)');
    assert.deepStrictEqual(tier0.handshapes, [{ chord_id: 0, start_time: 0.0, end_time: 1.0, arp: false }], 'handshapes normalize to the tier shape');
    assert.strictEqual(tier1.notes.length, 6, 'the top rung is the full window copy');
    assert.deepStrictEqual(tier1.notes, win.notes, 'tier 1 = window note content verbatim');
    assert.deepStrictEqual(tier1.chords, win.chords, 'tier 1 = window chord content verbatim (density intact)');
    assert.deepStrictEqual(tier1.anchors, win.anchors);
    assert.ok(!JSON.stringify(tier0).includes('"time":9') && !JSON.stringify(tier1).includes('"time":9'),
        'the out-of-window note is absent from BOTH rungs');

    // Commit through the REAL history: refs hold exactly across undo/redo.
    const ph = phrases[0];
    const prevTiers = ph.tiers;
    env.S.history.exec(new env.SimplifyPhraseCmd(
        ph, prevTiers, plan.tiers, ph.max_difficulty, plan.maxDifficulty));
    assert.strictEqual(ph.tiers, plan.tiers, 'exec installed the planned ladder by reference');
    assert.strictEqual(ph.max_difficulty, plan.maxDifficulty);
    env.S.history.doUndo();
    assert.strictEqual(ph.tiers, prevTiers, 'undo restores the pre-edit ladder by reference');
    assert.ok(!hasOwn(ph, 'max_difficulty'), 'undo also restores max_difficulty absence');
    env.S.history.doRedo();
    assert.strictEqual(ph.tiers, plan.tiers, 'redo re-installs the SAME ladder object');
    assert.strictEqual(ph.max_difficulty, plan.maxDifficulty);
});

// The cascade: a ladder topping out above 0 grows a rung at min-1 (each press
// re-source's the easiest tier's own content, in this arc "derive from the
// easiest existing tier"), and the descent stops at a difficulty-0 rung — the
// ladder-shape floor check answers 'floor' BEFORE content is even read.
t('cascade: an existing ladder grows a rung at minDifficulty-1; a difficulty-0 floor refuses', () => {
    const env = makeEnv();
    const ph = { name: 'phrase', number: 1, start_time: 0,
        tiers: [TIER(2, [{ time: 0.0, string: 0, fret: 3, sustain: 0.5, techniques: { bend: 1 } }])] };
    const from = windowForPhrase([ph], 0);
    const win = { notes: sliceByWindow(ph.tiers[0].notes, from.t0, from.t1), chords: [], anchors: [], handshapes: [] };

    // First press on the mid-ladder phrase: the new rung lands one below the
    // ladder floor, and the top rung stays verbatim above it.
    const plan = planTierSimplification(ph, win, { minSustain: null });
    assert.ok(!plan.error, 'harness: the mid-ladder phrase plans — ' + (plan.message || 'ok'));
    assert.strictEqual(plan.addedDifficulty, 1, 'the new rung lands one below the ladder floor');
    assert.deepStrictEqual(plan.tiers.map(tr => tr.difficulty), [1, 2], 'the existing rung stays verbatim above');
    const prevTiers = ph.tiers;
    env.S.history.exec(new env.SimplifyPhraseCmd(ph, prevTiers, plan.tiers, ph.max_difficulty, plan.maxDifficulty));
    assert.strictEqual(ph.tiers, plan.tiers);

    // And the descent stops at the difficulty-0 rung (ladder-shape refusal,
    // independent of content — a floor phrase is done, pressed-again or not).
    const floored = planTierSimplification(
        { name: 'phrase', number: 1, start_time: 0, tiers: [TIER(0)] }, win, { minSustain: null });
    assert.strictEqual(floored.error, 'floor', 'a difficulty-0 rung refuses the next press outright');
    env.S.history.doUndo();
    assert.strictEqual(ph.tiers, prevTiers, 'undo restores the single-rung ladder by reference');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
