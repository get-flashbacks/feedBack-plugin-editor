/*
 * Per-section sync REVIEW model (#26): the pure decision layer the review UI
 * renders and applies.
 *
 * Pins the acceptance rules from PER-SECTION-SYNC-DESIGN.md L150-158 that a
 * builder test alone can't reach:
 *   • a low-confidence section is skipped by DEFAULT — the default action never
 *     applies it (design's do-no-harm rule, #22);
 *   • explicitly selecting a low-confidence section applies it; deselecting a
 *     trusted one skips it;
 *   • a section with no usable fit is never selectable;
 *   • a single-section song collapses to one full-domain row;
 *   • the review plan is the SAME map `applyPerSectionSync` commits, so a
 *     skipped section's notes keep their exact seconds while selected ones bake.
 *
 * Run: node tests/section_sync_ui.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory } from '../src/history.js';
import { seedState } from './_history_env.mjs';
import { applyPerSectionSync } from '../src/tempo.js';
import {
    SECTION_SYNC_CONFIDENCE_FLOOR, _proposalAcceptedPure, _sectionSyncPlanPure,
} from '../src/section-sync.js';

function prop(index, start, end, opts = {}) {
    const ok = opts.ok !== false;
    const confidence = opts.confidence != null ? opts.confidence : 0.9;
    return {
        ok,
        index,
        name: opts.name !== undefined ? opts.name : `Part ${index}`,
        number: opts.number !== undefined ? opts.number : index + 1,
        start,
        end,
        reason: opts.reason || (ok && confidence >= SECTION_SYNC_CONFIDENCE_FLOOR ? null : 'low-confidence'),
        confidence,
        factor: opts.factor != null ? opts.factor : 2,
        slope: opts.slope != null ? opts.slope : 0.5,
        intercept: opts.intercept != null ? opts.intercept : 0,
    };
}

function analysis(props) {
    return { ok: true, reason: null, domain: { start: 0, end: 30 }, proposals: props };
}

test('the default decision applies trusted sections and skips low-confidence ones', () => {
    const a = analysis([
        prop(0, 0, 10, { confidence: 0.9, name: 'Intro' }),
        prop(1, 10, 20, { confidence: 0.3, name: 'Solo' }),
        prop(2, 20, 30, { confidence: 0.8, name: 'Outro' }),
    ]);
    const plan = _sectionSyncPlanPure(a);
    assert.strictEqual(plan.ok, true);
    assert.strictEqual(plan.confidenceFloor, SECTION_SYNC_CONFIDENCE_FLOOR);
    const [intro, solo, outro] = plan.rows;
    assert.strictEqual(intro.tier, 'high');
    assert.strictEqual(intro.accepted, true, 'trusted section applies by default');
    assert.strictEqual(solo.tier, 'low');
    assert.strictEqual(solo.accepted, false, 'low-confidence section is skipped by default');
    assert.strictEqual(solo.selected, false);
    assert.strictEqual(solo.forceable, true, 'a low-confidence section can be forced on');
    assert.strictEqual(outro.accepted, true);
    assert.deepStrictEqual(plan.conflicts, []);
});

test('an explicit decision overrides the confidence default both ways', () => {
    const a = analysis([
        prop(0, 0, 10, { confidence: 0.9 }),
        prop(1, 10, 20, { confidence: 0.3 }),
    ]);
    // Force the low-confidence section on.
    const forced = _sectionSyncPlanPure(a, new Map([[1, true]]));
    assert.strictEqual(forced.rows[1].accepted, true, 'selected low-confidence section applies');
    assert.ok(forced.rows[1].tier === 'low', 'it stays labelled low even when forced');
    // Skip the trusted section.
    const skipped = _sectionSyncPlanPure(a, new Map([[0, false]]));
    assert.strictEqual(skipped.rows[0].accepted, false, 'deselected trusted section is skipped');
});

test('a section with no usable fit is never selectable, even when forced', () => {
    const a = analysis([
        prop(0, 0, 10, { ok: false, confidence: 0, name: 'Broken' }),
    ]);
    const plan = _sectionSyncPlanPure(a, new Map([[0, true]]));
    const row = plan.rows[0];
    assert.strictEqual(row.tier, 'failed');
    assert.strictEqual(row.forceable, false);
    assert.strictEqual(row.accepted, false, 'forcing a failed section does nothing');
    assert.strictEqual(plan.summary.applied, 0);
});

test('a single-section song collapses to one full-domain row', () => {
    const a = analysis([prop(0, 0, 30, { confidence: 0.85, name: '', number: 0 })]);
    const plan = _sectionSyncPlanPure(a);
    assert.strictEqual(plan.rows.length, 1);
    assert.strictEqual(plan.rows[0].label, 'Full song');
    assert.strictEqual(plan.rows[0].accepted, true);
    assert.strictEqual(plan.summary.applied, 1);
    // Uniform flow: the lone accepted section keeps its affine map (no pins).
    assert.strictEqual(plan.map.map(10), 5);
    assert.strictEqual(plan.map.map(20), 10);
});

test('a run pinned to identity at both ends surfaces a conflict the UI can block on', () => {
    const a = analysis([
        prop(0, 0, 10, { confidence: 0.3 }),
        prop(1, 10, 20, { confidence: 0.9, slope: 2 }),
        prop(2, 20, 30, { confidence: 0.3 }),
    ]);
    const plan = _sectionSyncPlanPure(a);
    assert.strictEqual(plan.conflicts.length, 1);
    assert.strictEqual(plan.conflicts[0].reason, 'identity-conflict');
    assert.strictEqual(plan.summary.applied, 0);
});

test('_proposalAcceptedPure honours selected overrides but never affine validity', () => {
    assert.strictEqual(_proposalAcceptedPure(prop(0, 0, 10, { confidence: 0.1 }), 0.7), false);
    assert.strictEqual(_proposalAcceptedPure({ ...prop(0, 0, 10, { confidence: 0.1 }), selected: true }, 0.7), true);
    assert.strictEqual(_proposalAcceptedPure({ ...prop(0, 0, 10), selected: false }, 0.7), false);
    // A nonpositive slope stays inapplicable even when forced.
    assert.strictEqual(_proposalAcceptedPure({ ...prop(0, 0, 10, { slope: 0 }), selected: true }, 0.7), false);
});

// ── Integration: the review plan drives the same apply path as #25 ──────────

function scenario() {
    const s = seedState();
    s.beats = [];
    for (let t = 0; t <= 30; t += 5) s.beats.push({ time: t, measure: -1, den: 4 });
    s.sections = [
        { name: 'Intro', number: 1, start_time: 0 },
        { name: 'Solo', number: 2, start_time: 10 },
    ];
    s.arrangements = [{
        notes: [
            { time: 5, sustain: 1, midi: 60 },   // Intro [0,10) — low confidence
            { time: 12, sustain: 1, midi: 62 },  // Solo [10,30) — trusted
            { time: 22, sustain: 1, midi: 64 },  // Solo [10,30) — trusted
        ],
        chords: [], anchors: [], anchors_user: [], handshapes: [], phrases: [],
    }];
    s.drumTab = null;
    s.history = new EditHistory();
    return s;
}

test('a skipped low-confidence section keeps its notes while neighbours bake', () => {
    const s = scenario();
    const a = {
        ok: true,
        domain: { start: 0, end: 30 },
        proposals: [
            prop(0, 0, 10, { confidence: 0.2, slope: 2, name: 'Intro' }),
            prop(1, 10, 30, { confidence: 0.9, slope: 2, name: 'Solo' }),
        ],
    };
    const plan = _sectionSyncPlanPure(a);
    assert.strictEqual(plan.rows[0].accepted, false, 'Intro defaults to skip');
    assert.strictEqual(plan.rows[1].accepted, true, 'Solo applies');
    assert.deepStrictEqual(plan.conflicts, []);

    const res = applyPerSectionSync({
        proposals: plan.proposals,
        confidenceFloor: plan.confidenceFloor,
        domain: plan.domain,
    });
    assert.strictEqual(res.applied, true);
    const notes = s.arrangements[0].notes;
    assert.strictEqual(notes[0].time, 5, 'skipped section note untouched');
    assert.strictEqual(notes[1].time, 14, 'trusted section note baked');
    assert.strictEqual(notes[2].time, 34, 'trusted section note baked');
});

test('selecting the low-confidence section applies it through the same plan', () => {
    const s = scenario();
    const a = {
        ok: true,
        domain: { start: 0, end: 30 },
        proposals: [
            prop(0, 0, 10, { confidence: 0.2, slope: 2, name: 'Intro' }),
            prop(1, 10, 30, { confidence: 0.9, slope: 2, name: 'Solo' }),
        ],
    };
    const plan = _sectionSyncPlanPure(a, new Map([[0, true]]));
    assert.strictEqual(plan.rows[0].accepted, true, 'selected low-confidence section applies');
    const res = applyPerSectionSync({
        proposals: plan.proposals,
        confidenceFloor: plan.confidenceFloor,
        domain: plan.domain,
    });
    assert.strictEqual(res.applied, true);
    const notes = s.arrangements[0].notes;
    assert.strictEqual(notes[0].time, 10, 'selected section note baked (2× at 0)');
    assert.strictEqual(notes[1].time, 24, 'selected run maps continuously');
});
