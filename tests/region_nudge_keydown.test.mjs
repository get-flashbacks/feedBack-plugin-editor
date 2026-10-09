/*
 * The region-move nudge chord, driven through the REAL onKeyDown (issue #42).
 *
 * tests/region_nudge.test.mjs pins what the verb DOES (steps, coalescing,
 * clamp, rollback); this suite pins the GATING of the keyboard chord:
 *
 *   1. Plain ←/→ nudges the selected region in the Tracks overview; Shift makes
 *      it one bar. The chord claims the key (preventDefault).
 *   2. Overview-only — note view falls through to the ordinary dispatch.
 *   3. No selected region → fall through, no undo entry.
 *   4. Modified arrows (Alt / Ctrl / Cmd) fall through: those belong to the
 *      track-offset chord and the note/anchor shortcuts, not the region nudge.
 *   5. An editable target keeps the key (no nudge while typing).
 *   6. A held key still coalesces to ONE undo step through the keydown path.
 *
 * Run: node --test tests/region_nudge_keydown.test.mjs
 */
import assert from 'node:assert';

const screen = { classList: { contains: v => v === 'active' } };
const statusEl = { textContent: '' };
globalThis.document = {
    getElementById(id) {
        if (id === 'plugin-editor') return screen;
        if (id === 'editor-status') return statusEl;
        return null;
    },
    addEventListener: () => {}, activeElement: null,
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { onKeyDown } = await import('../src/input.js');
const { S } = await import('../src/state.js');
const { setHostHooks } = await import('../src/host.js');
const { EditHistory } = await import('../src/history.js');
const { _partsViewRegionNudge } = await import('../src/parts-view.js');
setHostHooks({
    draw: () => {}, updateStatus: () => {}, ensureArr: () => true,
    partsViewRegionNudge: (...a) => _partsViewRegionNudge(...a),
});

const target = kind => ({
    matches: selector => (kind === 'input' ? selector.includes('input') : false),
});
const event = (over = {}) => ({
    key: 'ArrowRight', code: 'ArrowRight',
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    target: target('canvas'), defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
    ...over,
});
// Constant 120 BPM (0.5 s/beat), 4 beats/bar.
const beats = [];
for (let i = 0; i < 13; i++) beats.push({ time: i * 0.5, measure: i % 4 === 0 ? i / 4 + 1 : 0 });

// Fresh state per case: overview live, one transcription row carrying a bounded
// region B ([4,8)) whose two notes are at beats 4 and 5.
function seed() {
    Object.assign(S, {
        arrangements: [{ name: 'Lead', notes: [{ time: 2.0, sustain: 0, string: 0, fret: 0, techniques: {} },
            { time: 2.5, sustain: 0, string: 0, fret: 0, techniques: {} }] }],
        currentArr: 0,
        sel: new Set(),
        beats,
        barSel: null,
        partsViewMode: true,
        tempoMapMode: false,
        drumEditMode: false,
        selectedTrackId: 'transcription:Lead',
        selectedRegionId: 'B',
        audioShift: 0,
        audioUrl: '', stems: [], stemLinks: {},
        playing: false,
        history: new EditHistory(),
        trackSession: {
            version: 3,
            tracks: [{ id: 'transcription:Lead', type: 'transcription', targetId: 'Lead', regions: [{ id: 'B', startBeat: 4, lenBeat: 4 }] }],
            removedSourceIds: [], tempoGuideSourceId: '', tempoGuideLocked: false, tempoGuideMode: 'audio',
        },
    });
    return S;
}
const times = () => S.arrangements[0].notes.map(n => n.time);
const regionStart = () => S.trackSession.tracks[0].regions[0].startBeat;

// ── Plain ←/→ = one beat; Shift = one bar ────────────────────────────────────
seed();
const fine = event();
onKeyDown(fine);
assert.ok(fine.defaultPrevented, 'the chord claims a plain arrow in the overview');
assert.deepStrictEqual(times(), [2.5, 3.0], 'plain → = +1 beat');
assert.strictEqual(regionStart(), 5, 'the bounded window rode +1 beat');
assert.strictEqual(S.history.undo.length, 1, 'one press = one undo entry');

seed();
const coarse = event({ shiftKey: true });
onKeyDown(coarse);
assert.ok(coarse.defaultPrevented);
assert.deepStrictEqual(times(), [4.0, 4.5], 'Shift → = +one 4/4 bar (4 beats)');

// ── Modified arrows fall through (they belong to other chords) ───────────────
for (const mods of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true, shiftKey: true }]) {
    seed();
    const ev = event(mods);
    onKeyDown(ev);
    assert.strictEqual(S.history.undo.length, 0, `region nudge ignores ${JSON.stringify(mods)}`);
    assert.deepStrictEqual(times(), [2.0, 2.5], 'no content moved');
}

// ── Overview-only + selection gate ───────────────────────────────────────────
seed();
S.partsViewMode = false;
const noteView = event();
onKeyDown(noteView);
assert.strictEqual(S.history.undo.length, 0, 'the chord is local to the Tracks overview');

seed();
S.selectedRegionId = '';
const noRegion = event();
onKeyDown(noRegion);
assert.strictEqual(S.history.undo.length, 0, 'no region selected = no nudge');

// ── Editable targets keep the key ────────────────────────────────────────────
seed();
const typed = event({ target: target('input') });
onKeyDown(typed);
assert.ok(!typed.defaultPrevented, 'a text field keeps the key');
assert.strictEqual(S.history.undo.length, 0);

// ── A held key coalesces to ONE step through keydown ─────────────────────────
seed();
onKeyDown(event());
onKeyDown(event());
onKeyDown(event());
assert.deepStrictEqual(times(), [3.5, 4.0], 'all three beats applied');
assert.strictEqual(S.history.undo.length, 1, 'a held key is ONE undo step, not three');
S.history.doUndo();
assert.deepStrictEqual(times(), [2.0, 2.5], 'one undo rolls the whole hold back');
assert.strictEqual(regionStart(), 4, 'and restores the window origin');

console.log('region-nudge keydown gating passed');
