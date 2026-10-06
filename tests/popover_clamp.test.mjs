/*
 * Popover viewport clamping (improvement plan P0.4, issue #30).
 *
 * The context menu and the add-note dialog are positioned straight from event
 * coordinates, so a right-click / double-click near an edge ran them off
 * screen. _clampPopoverPos (src/ui.js, @pure:popover-clamp) is the shared
 * math; the second half of this suite drives the REAL showContextMenu and
 * showAddNote against a stubbed DOM to pin that both call sites apply it —
 * measured size, viewport edges and all.
 *
 * Run: node tests/popover_clamp.test.mjs
 */
import assert from 'node:assert';

const VW = 800, VH = 600;

globalThis.window = {
    innerWidth: VW,
    innerHeight: VH,
    devicePixelRatio: 1,
    addEventListener() {},
    localStorage: { getItem() { return null; }, setItem() {} },
};

// One element per id, materialized only for the properties the code under test
// writes/reads. Unknown ids stay null so a missing dependency fails loudly.
const els = new Map();
function fakeEl(id, { w = 0, h = 0 } = {}) {
    const el = {
        id,
        offsetWidth: w,
        offsetHeight: h,
        innerHTML: '',
        style: {},
        textContent: '',
        value: '',
        onclick: null,
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            toggle(c, force) {
                if (force === undefined ? !this._set.has(c) : force) this._set.add(c);
                else this._set.delete(c);
            },
            contains(c) { return this._set.has(c); },
        },
        querySelectorAll: () => [],
        focus() {},
        select() {},
    };
    els.set(id, el);
    return el;
}
globalThis.document = { getElementById: (id) => els.get(id) || null };

let pass = 0, fail = 0;
function t(name, fn) {
    try {
        fn();
        pass++;
        console.log('ok - ' + name);
    } catch (err) {
        fail++;
        console.error('not ok - ' + name);
        console.error(err && err.stack || err);
    }
}

const { _clampPopoverPos } = await import('../src/ui.js');

// ── The pure math ──────────────────────────────────────────────────
t('a popover well inside the viewport is left alone', () => {
    assert.deepStrictEqual(_clampPopoverPos(100, 100, 180, 320, VW, VH),
        { x: 100, y: 100 });
});

t('near the right/bottom edge it is pulled back inside', () => {
    assert.deepStrictEqual(_clampPopoverPos(VW - 10, VH - 10, 180, 320, VW, VH),
        { x: VW - 180, y: VH - 320 });
});

t('past the right/bottom edge it never overspans', () => {
    assert.deepStrictEqual(_clampPopoverPos(VW + 500, VH + 500, 180, 320, VW, VH),
        { x: VW - 180, y: VH - 320 });
});

t('above/left of the origin it stops at 0', () => {
    assert.deepStrictEqual(_clampPopoverPos(-40, -40, 180, 320, VW, VH),
        { x: 0, y: 0 });
});

t('a popover exactly as wide as the viewport lands at 0, not negative', () => {
    assert.deepStrictEqual(_clampPopoverPos(50, 50, VW, VH, VW, VH), { x: 0, y: 0 });
});

t('a popover BIGGER than the viewport pins at 0 (as much visible as fits)', () => {
    assert.deepStrictEqual(_clampPopoverPos(50, 50, VW + 200, VH + 200, VW, VH),
        { x: 0, y: 0 });
});

t('the exact far corner is not nudged off by rounding', () => {
    assert.deepStrictEqual(_clampPopoverPos(VW - 180, VH - 320, 180, 320, VW, VH),
        { x: VW - 180, y: VH - 320 });
});

// ── The real call sites ────────────────────────────────────────────
const { showContextMenu } = await import('../src/context-menu.js');
const { showAddNote } = await import('../src/add-note.js');
const { S } = await import('../src/state.js');

function inViewport(left, top, w, h) {
    const x = parseFloat(left), y = parseFloat(top);
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `non-numeric position ${left},${top}`);
    assert.ok(x >= 0 && x + w <= VW + 1e-9, `horizontal escape: x=${x} w=${w}`);
    assert.ok(y >= 0 && y + h <= VH + 1e-9, `vertical escape: y=${y} h=${h}`);
    return { x, y };
}

function seedFrettedChart() {
    S.arrangements = [{ name: 'Gtr 1', notes: [
        { time: 1, string: 0, fret: 3, sustain: 0.5, techniques: {} },
    ], chords: [] }];
    S.currentArr = 0;
    S.sel = new Set();
}

const MENU_W = 180, MENU_H = 320;
const DIALOG_W = 240, DIALOG_H = 140;

t('the context menu opened past the right/bottom edge stays fully on screen', () => {
    seedFrettedChart();
    fakeEl('editor-context-menu', { w: MENU_W, h: MENU_H });
    showContextMenu(VW + 40, VH + 40, 0);
    const menu = els.get('editor-context-menu');
    assert.deepStrictEqual(inViewport(menu.style.left, menu.style.top, MENU_W, MENU_H),
        { x: VW - MENU_W, y: VH - MENU_H });
});

t('the context menu opened above/left of the origin stays fully on screen', () => {
    seedFrettedChart();
    fakeEl('editor-context-menu', { w: MENU_W, h: MENU_H });
    showContextMenu(-30, -30, 0);
    const menu = els.get('editor-context-menu');
    assert.deepStrictEqual(inViewport(menu.style.left, menu.style.top, MENU_W, MENU_H),
        { x: 0, y: 0 });
});

t('a context menu in the middle of the viewport keeps its click point', () => {
    seedFrettedChart();
    fakeEl('editor-context-menu', { w: MENU_W, h: MENU_H });
    showContextMenu(300, 200, 0);
    const menu = els.get('editor-context-menu');
    assert.strictEqual(menu.style.left, '300px');
    assert.strictEqual(menu.style.top, '200px');
});

t('the add-note dialog opened past the right/bottom edge stays fully on screen', () => {
    fakeEl('editor-add-note-dialog', { w: DIALOG_W, h: DIALOG_H });
    fakeEl('editor-add-fret-col');
    fakeEl('editor-add-pitch-col');
    fakeEl('editor-add-fret');
    fakeEl('editor-add-sustain');
    showAddNote(VW + 20, VH + 20, 1, 0, 3);
    const dlg = els.get('editor-add-note-dialog');
    assert.deepStrictEqual(inViewport(dlg.style.left, dlg.style.top, DIALOG_W, DIALOG_H),
        { x: VW - DIALOG_W, y: VH - DIALOG_H });
});

t('the add-note dialog opened above/left of the origin stays fully on screen', () => {
    fakeEl('editor-add-note-dialog', { w: DIALOG_W, h: DIALOG_H });
    showAddNote(-10, -10, 1, 0, 3);
    const dlg = els.get('editor-add-note-dialog');
    assert.deepStrictEqual(inViewport(dlg.style.left, dlg.style.top, DIALOG_W, DIALOG_H),
        { x: 0, y: 0 });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
