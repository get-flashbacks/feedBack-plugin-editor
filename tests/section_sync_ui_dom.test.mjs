/*
 * Per-section sync REVIEW UI (#26) — the DOM wiring behind the pure plan.
 *
 * The pure decision layer is unit-tested in section_sync_ui.test.mjs; this
 * drives the real src/section-sync-ui.js against a DOM stub so the interaction
 * bugs a pure test can't see are pinned:
 *   • the default (all-low-confidence) plan disables Apply and still puts focus
 *     INSIDE the modal (a disabled button refuses focus — the code must fall
 *     back, or global shortcuts leak through the overlay);
 *   • toggling a row re-renders the rows container, so focus must be restored
 *     to the modal (not dropped to <body>);
 *   • the summary counts only sections that are actually skipped;
 *   • Apply bakes the selection and closes the modal; Escape closes and
 *     restores the opener.
 *
 * Run: node tests/section_sync_ui_dom.test.mjs
 */
import assert from 'node:assert';

// ── DOM stub (the sync_dialog_keyboard.test.mjs pattern) ─────────────
const listeners = new Map();
let activeEl = null;

function mkEl(id, opts = {}) {
    const children = [];
    const classList = {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
        contains(c) { return this._s.has(c); },
    };
    return {
        id, className: opts.className || '', tagName: (opts.tag || 'DIV').toUpperCase(),
        textContent: '', value: '', disabled: false, files: [],
        style: {}, classList, children, parentNode: null,
        tabIndex: 0, isConnected: true, scrollTop: 0,
        _attrs: {},
        setAttribute(k, v) { this._attrs[k] = v; },
        getAttribute(k) { return this._attrs[k]; },
        appendChild(c) { children.push(c); c.parentNode = this; return c; },
        addEventListener(type, fn) {
            if (!listeners.has(id)) listeners.set(id, []);
            listeners.get(id).push({ type, fn });
        },
        removeEventListener() {},
        focus() { activeEl = this; },
        blur() { activeEl = null; },
        contains(n) { return n === this || children.some((c) => c.contains && c.contains(n)); },
        querySelectorAll(sel) {
            const want = [];
            if (sel.includes('button')) want.push('BUTTON');
            if (sel.includes('input')) want.push('INPUT');
            if (sel.includes('select')) want.push('SELECT');
            if (sel.includes('textarea')) want.push('TEXTAREA');
            return this._all().filter((e) => want.includes(e.tagName));
        },
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        get firstElementChild() { return children[0] || null; },
        _all() {
            let out = [...children];
            for (const c of children) out = out.concat(c._all ? c._all() : []);
            return out;
        },
        get innerHTML() { return ''; },
        set innerHTML(_v) { /* rows are HTML strings; the stub drops them */ },
    };
}

const registry = new Map();
function reg(id, el) { registry.set(id, el); return el; }
function byId(id) {
    if (!registry.has(id)) registry.set(id, mkEl(id));
    return registry.get(id);
}

globalThis.document = {
    getElementById: byId,
    createElement: (t) => mkEl(t),
    querySelector: () => null,          // row toggles are innerHTML strings
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: { appendChild() {} },
    get activeElement() { return activeEl; },
};
globalThis.window = globalThis.window || globalThis;
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };

// Shipped markup shape: overlay root → panel (firstElementChild) → controls.
const modal = reg('editor-section-sync-modal', mkEl('modal', { className: 'absolute inset-0' }));
const panel = mkEl('panel');
const rowsEl = reg('editor-section-sync-rows', mkEl('rows'));
const summaryEl = reg('editor-section-sync-summary', mkEl('summary'));
const applyHigh = reg('editor-section-sync-apply-high', mkEl('apply-high', { tag: 'button' }));
const applyBtn = reg('editor-section-sync-apply', mkEl('apply', { tag: 'button' }));
const cancel = mkEl('cancel', { tag: 'button' });
modal.appendChild(panel);
panel.appendChild(rowsEl);
panel.appendChild(summaryEl);
panel.appendChild(applyHigh);
panel.appendChild(applyBtn);
panel.appendChild(cancel);
reg('editor-status', mkEl('editor-status'));

const { S } = await import('../src/state.js');
const { EditHistory } = await import('../src/history.js');
const { setHostHooks } = await import('../src/host.js');
setHostHooks({ draw: () => {}, updateStatus: () => {}, ensureArr: () => true });

// A single full-domain section reads low-confidence (periodic onsets vs an
// off-grid melody) but is `ok` — exactly the forceable-but-skipped case.
const rms = new Float32Array(60);
for (let i = 0; i < rms.length; i++) rms[i] = i % 2 === 0 ? 1 : 0;
Object.assign(S, {
    beats: Array.from({ length: 61 }, (_, k) => ({ time: k * 0.5, measure: k % 4 === 0 ? k / 4 + 1 : -1, den: 4 })),
    sections: [],
    duration: 30,
    waveformPeaks: { bins: 60, rms },
    audioBuffer: null,
    audioShift: 0,
    activeAudioSourceOffset: 0,
    activeAudioSourceId: 'master',
    trackSession: { version: 2, tracks: [], removedSourceIds: [], tempoGuideSourceId: '', tempoGuideLocked: false, tempoGuideMode: 'audio' },
    arrangements: [{
        notes: Array.from({ length: 16 }, (_, k) => ({ time: 2 + k * 1.7, sustain: 1, midi: 60 })),
        chords: [], anchors: [], anchors_user: [], handshapes: [], phrases: [],
    }],
    drumTab: null,
    history: new EditHistory(),
});

const { editorShowSectionSync, editorToggleSectionSync, editorApplySectionSync } =
    await import('../src/section-sync-ui.js');

function dispatchKey(el, key) {
    const evt = { key, target: el, preventDefault() {}, stopPropagation() {} };
    for (const { type, fn } of (listeners.get(el.id) || [])) if (type === 'keydown') fn(evt);
}

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

// ── Tests ───────────────────────────────────────────────────────────
t('opening shows the modal, disables Apply on an all-skipped plan, and focuses inside', () => {
    activeEl = null;
    editorShowSectionSync();
    assert.ok(!modal.classList.contains('hidden'), 'modal visible');
    assert.match(summaryEl.textContent, /0\/1 selected/, 'summary counts 0 applied');
    assert.match(summaryEl.textContent, /1 low-confidence skipped/, 'low section reported skipped');
    assert.strictEqual(applyBtn.disabled, true, 'Apply disabled with nothing selected');
    assert.ok(activeEl && activeEl !== document.body, 'focus moved into the modal despite disabled Apply');
    assert.strictEqual(panel.contains(activeEl) || activeEl === modal, true, 'focus is inside the modal');
});

t('toggling the low-confidence section selects it, enables Apply and keeps focus in the modal', () => {
    editorToggleSectionSync(0);
    assert.match(summaryEl.textContent, /1\/1 selected/, 'summary counts the forced section');
    assert.doesNotMatch(summaryEl.textContent, /skipped/, 'no skipped count once selected');
    assert.strictEqual(applyBtn.disabled, false, 'Apply enabled after selecting');
    assert.ok(activeEl && activeEl !== document.body, 'focus restored after the re-render');
    assert.strictEqual(panel.contains(activeEl) || activeEl === modal, true, 'focus stays inside the modal');
});

t('"Apply all high-confidence" on an all-low song does not bake', () => {
    activeEl = null;
    editorShowSectionSync();
    const before = S.arrangements[0].notes[0].time;
    editorApplySectionSync(true);
    assert.strictEqual(S.arrangements[0].notes[0].time, before, 'nothing baked');
    assert.ok(!modal.classList.contains('hidden'), 'modal stays open when nothing applies');
});

t('applying the selection bakes the notes and closes the modal', () => {
    activeEl = null;
    editorShowSectionSync();
    const before = S.arrangements[0].notes[0].time;
    editorToggleSectionSync(0);
    editorApplySectionSync(false);
    assert.notStrictEqual(S.arrangements[0].notes[0].time, before, 'selected section baked');
    assert.ok(modal.classList.contains('hidden'), 'modal closed after apply');
});

t('Escape closes the modal and restores focus to the opener', () => {
    const opener = mkEl('opener');
    opener.focus();
    editorShowSectionSync();
    dispatchKey(modal, 'Escape');
    assert.ok(modal.classList.contains('hidden'), 'modal hidden after Escape');
    assert.strictEqual(activeEl, opener, 'focus restored to the opener');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
