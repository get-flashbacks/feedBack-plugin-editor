/*
 * Viewport clamping for the two popovers positioned from raw event
 * coordinates (issue #30): the canvas context menu (right-click) and the
 * add-note dialog (double-click). Both used to be placed straight at the
 * trigger point, so one near the bottom/right edge ran partly — sometimes
 * wholly — off screen.
 *
 * Part 1 drives the shared pure helper (_editorClampPopoverPure, src/ui.js).
 * Part 2 drives the REAL showContextMenu / showAddNote against a stub DOM,
 * because the call sites carry two behaviours the math alone doesn't pin:
 * the size must be measured AFTER `hidden` is removed (a display:none
 * element reports 0×0 and would clamp to nonsense), and the live
 * window.innerWidth/Height must be what feeds the helper.
 *
 * Run: node tests/popover_clamp.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

const VW = 1024, VH = 768;

// ── Part 1: the pure clamp math ─────────────────────────────────────────────

const { _editorClampPopoverPure } = await import('../src/ui.js');

t('a comfortable position passes through untouched', () => {
    assert.deepStrictEqual(
        _editorClampPopoverPure(100, 120, 200, 300, VW, VH),
        { x: 100, y: 120 });
});

t('the right edge pulls the box back inside', () => {
    const p = _editorClampPopoverPure(VW - 10, 120, 200, 300, VW, VH);
    assert.strictEqual(p.x, VW - 200, 'anchored to the edge, not the trigger');
    assert.strictEqual(p.x + 200, VW, 'the box ends exactly at the viewport edge');
});

t('the bottom edge pulls the box back inside', () => {
    const p = _editorClampPopoverPure(100, VH - 10, 200, 300, VW, VH);
    assert.strictEqual(p.y, VH - 300, 'anchored to the edge, not the trigger');
    assert.strictEqual(p.y + 300, VH, 'the box ends exactly at the viewport edge');
});

t('a trigger point outside the left/top edge clamps to 0, never negative', () => {
    assert.deepStrictEqual(
        _editorClampPopoverPure(-40, -5, 200, 300, VW, VH),
        { x: 0, y: 0 });
});

t('coordinates that exactly fit the edge are left alone', () => {
    assert.deepStrictEqual(
        _editorClampPopoverPure(VW - 200, VH - 300, 200, 300, VW, VH),
        { x: VW - 200, y: VH - 300 });
});

t('a box bigger than the viewport collapses to 0 (the only stable answer)', () => {
    assert.deepStrictEqual(
        _editorClampPopoverPure(500, 500, VW + 100, VH + 100, VW, VH),
        { x: 0, y: 0 });
});

// ── Part 2: the call sites ──────────────────────────────────────────────────

// A popover element whose offsetWidth/offsetHeight are only meaningful once
// `hidden` is gone — the getter flags a measurement taken while hidden so the
// tests can pin the un-hide-before-measure order.
function fakePopover(w, h) {
    const cls = new Set(['hidden']);
    const state = { measuredHidden: false };
    const flag = () => { if (cls.has('hidden')) state.measuredHidden = true; };
    return {
        state,
        classList: {
            add: (c) => { cls.add(c); },
            remove: (c) => { cls.delete(c); },
            contains: (c) => cls.has(c),
            toggle: () => {},
        },
        style: {},
        get offsetWidth() { flag(); return w; },
        get offsetHeight() { flag(); return h; },
        innerHTML: '',
        querySelectorAll: () => ({ forEach: () => {} }),
        appendChild() {},
        value: '0',
        focus() {},
        select() {},
    };
}

const menuEl = fakePopover(220, 340);
const dlgEl = fakePopover(240, 160);
const els = {
    'editor-context-menu': menuEl,
    'editor-add-note-dialog': dlgEl,
    'editor-add-fret-col': fakePopover(0, 0),
    'editor-add-pitch-col': fakePopover(0, 0),
    'editor-add-fret': fakePopover(0, 0),
    'editor-add-sustain': fakePopover(0, 0),
};
globalThis.document = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => ({ tag, className: '', dataset: {}, textContent: '' }),
    addEventListener: () => {},
    activeElement: null,
};
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };
globalThis.window = { innerWidth: VW, innerHeight: VH };

const { showAddNote } = await import('../src/add-note.js');
const { showContextMenu } = await import('../src/context-menu.js');
const { S } = await import('../src/state.js');

t('add-note: opened at the bottom-right corner the dialog stays fully on screen', () => {
    showAddNote(VW - 6, VH - 6, 1, 2, 3);
    assert.strictEqual(dlgEl.style.left, (VW - 240) + 'px');
    assert.strictEqual(dlgEl.style.top, (VH - 160) + 'px');
    assert.strictEqual(dlgEl.state.measuredHidden, false,
        'size must be measured after `hidden` is removed');
});

t('add-note: near the top-left the trigger point is kept as-is', () => {
    showAddNote(8, 12, 1, 2, 3);
    assert.strictEqual(dlgEl.style.left, '8px');
    assert.strictEqual(dlgEl.style.top, '12px');
});

Object.assign(S, {
    arrangements: [{
        name: 'Lead',
        notes: [{ time: 1, string: 2, fret: 3, sustain: 0, techniques: {} }],
        chords: [],
    }],
    currentArr: 0,
});

t('context menu: opened at the bottom-right corner it stays fully on screen', () => {
    showContextMenu(VW - 4, VH - 4, 0);
    assert.strictEqual(menuEl.style.left, (VW - 220) + 'px');
    assert.strictEqual(menuEl.style.top, (VH - 340) + 'px');
    assert.strictEqual(menuEl.state.measuredHidden, false,
        'size must be measured after `hidden` is removed');
});

t('context menu: a mid-screen right-click is positioned at the cursor', () => {
    showContextMenu(400, 300, 0);
    assert.strictEqual(menuEl.style.left, '400px');
    assert.strictEqual(menuEl.style.top, '300px');
});

// The section menu (right-click on the beat bar / empty grid) renders into
// the SAME #editor-context-menu element from src/input.js, so it is the same
// acceptance criterion as showContextMenu. It is module-private — extract it
// by brace-matching (the extractFn convention used across tests/) and drive it
// with the stub DOM above.
function extractFn(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} not found in source`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const inputSrc = fs.readFileSync(new URL('../src/input.js', import.meta.url), 'utf8');
const showSectionMenu = new Function(
    'document', 'window', 'S', '_sectionNearestIndexPure', '_editorClampPopoverPure',
    extractFn(inputSrc, 'showSectionMenu') + '\nreturn showSectionMenu;',
)(document, globalThis.window, S, () => -1, _editorClampPopoverPure);

t('section menu (same element): opened at the bottom-right corner it stays on screen', () => {
    showSectionMenu(VW - 4, VH - 4, 0);
    assert.strictEqual(menuEl.style.left, (VW - 220) + 'px');
    assert.strictEqual(menuEl.style.top, (VH - 340) + 'px');
    assert.strictEqual(menuEl.state.measuredHidden, false,
        'size must be measured after `hidden` is removed');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
