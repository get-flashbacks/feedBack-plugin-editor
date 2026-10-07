/*
 * Sync Tempo dialog keyboard routing — fresh-open focus, Escape closes +
 * restores, and the trap wraps across the dialog's SIBLING children.
 *
 * The dialog has no wrapping panel: the title, the content block (holding
 * the BPM input) and the Apply/Cancel row are siblings, so the helper's
 * `inner` must be the dialog itself — bound to firstElementChild (the
 * title) it finds nothing to wrap and Tab falls through to the page.
 *
 * Run: node tests/sync_dialog_keyboard.test.mjs
 */
import assert from 'node:assert';

// ── DOM stub ────────────────────────────────────────────────────────
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
    const el = {
        id, className: opts.className || '', tagName: (opts.tag || 'DIV').toUpperCase(),
        textContent: '', value: '', disabled: false, files: [],
        style: {}, classList, children, parentNode: null,
        tabIndex: 0, isConnected: true,
        _attrs: {},
        setAttribute(k, v) { this._attrs[k] = v; },
        getAttribute(k) { return this._attrs[k]; },
        appendChild(c) { children.push(c); c.parentNode = this; return c; },
        addEventListener(type, fn) {
            if (!listeners.has(id)) listeners.set(id, []);
            listeners.get(id).push({ type, fn });
        },
        removeEventListener(type, fn) {
            const arr = listeners.get(id) || [];
            const i = arr.findIndex((x) => x.type === type && x.fn === fn);
            if (i >= 0) arr.splice(i, 1);
        },
        focus() { activeEl = this; },
        blur() { activeEl = null; },
        remove() {
            if (this.parentNode) {
                const i = this.parentNode.children.indexOf(this);
                if (i >= 0) this.parentNode.children.splice(i, 1);
            }
        },
        contains(n) { return n === this || children.some((c) => c.contains && c.contains(n)); },
        querySelectorAll(sel) {
            const all = this._all();
            const want = [];
            if (sel.includes('button')) want.push('BUTTON');
            if (sel.includes('input')) want.push('INPUT');
            if (sel.includes('select')) want.push('SELECT');
            if (sel.includes('textarea')) want.push('TEXTAREA');
            return all.filter((e) => want.includes(e.tagName));
        },
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        get firstElementChild() { return children[0] || null; },
        _all() {
            let out = [...children];
            for (const c of children) out = out.concat(c._all ? c._all() : []);
            return out;
        },
        get innerHTML() { return ''; },
        set innerHTML(v) { this.children = []; },
    };
    return el;
}

const registry = new Map();
function reg(id, el) { registry.set(id, el); return el; }
// Auto-create on first lookup: the show path writes textContent into a
// handful of readout spans the keyboard tests don't otherwise care about.
function byId(id) {
    if (!registry.has(id)) registry.set(id, mkEl(id));
    return registry.get(id);
}

function reset() {
    activeEl = null;
}

// The shipped markup: title, content (BPM input) and the button row are
// SIBLINGS of #editor-sync-dialog — not nested under the title.
const dlg = reg('editor-sync-dialog', mkEl('editor-sync-dialog', { className: 'absolute z-50' }));
const title = mkEl('sync-title');
const content = mkEl('sync-content');
const bpm = reg('sync-manual-bpm', mkEl('sync-manual-bpm', { tag: 'input' }));
const row = mkEl('sync-buttons');
const apply = mkEl('sync-apply', { tag: 'button' });
const cancel = mkEl('sync-cancel', { tag: 'button' });
dlg.appendChild(title);
dlg.appendChild(content); content.appendChild(bpm);
dlg.appendChild(row); row.appendChild(apply); row.appendChild(cancel);

const openerBtn = reg('editor-sync-btn', mkEl('editor-sync-btn'));
openerBtn.getBoundingClientRect = () => ({ left: 0, bottom: 0 });
reg('editor-status', mkEl('editor-status'));

function dispatchKey(el, key, opts = {}) {
    const evt = {
        key, code: '', ctrlKey: false, metaKey: false, shiftKey: !!opts.shift, altKey: false,
        target: el, preventDefault() {}, stopPropagation() {},
    };
    const arr = listeners.get(el.id) || [];
    for (const { type, fn } of arr) {
        if (type === 'keydown') fn(evt);
    }
}

globalThis.document = {
    getElementById: byId,
    createElement: (t) => mkEl(t),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: { appendChild() {} },
    get activeElement() { return activeEl; },
};
globalThis.window = globalThis.window || globalThis;
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };

const { S } = await import('../src/state.js');
const { setHostHooks } = await import('../src/host.js');
setHostHooks({ draw: () => {}, updateStatus: () => {}, ensureArr: () => true });

// Minimal chart + silence so editorSyncTempo reaches the dialog block:
// two downbeats for getTabBPM, a short buffer for detectAudioBPM.
Object.assign(S, {
    beats: [
        { time: 0, measure: 1, den: 4 },
        { time: 0.5, measure: -1, den: 4 },
        { time: 1, measure: 2, den: 4 },
    ],
    audioBuffer: { sampleRate: 44100, duration: 0.05, getChannelData: () => new Float32Array(2205) },
    audioShift: 0,
    activeAudioSourceOffset: 0,
});

let pass = 0, fail = 0;
async function t(name, fn) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

const show = async () => {
    const { editorSyncTempo } = await import('../src/sync-tempo.js');
    editorSyncTempo();
};

// ── Tests ───────────────────────────────────────────────────────────
await t('opening Sync Tempo moves focus to the manual BPM input', async () => {
    reset();
    await show();
    assert.ok(!dlg.classList.contains('hidden'), 'dialog visible');
    assert.strictEqual(activeEl, bpm, 'focus sits on the BPM input');
});

await t('Escape closes the dialog and restores focus to the opener', async () => {
    reset();
    const opener = mkEl('opener');
    opener.focus();

    await show();
    dispatchKey(dlg, 'Escape');
    assert.ok(dlg.classList.contains('hidden'), 'dialog hidden after Escape');
    assert.strictEqual(activeEl, opener, 'focus restored to opener');
});

await t('Tab from Cancel wraps to the BPM input', async () => {
    reset();
    await show();
    cancel.focus();
    assert.strictEqual(activeEl, cancel);

    dispatchKey(dlg, 'Tab');
    assert.strictEqual(activeEl, bpm, 'Tab from last wraps to first');
});

await t('Shift+Tab from the BPM input wraps to Cancel', async () => {
    reset();
    await show();
    bpm.focus();
    assert.strictEqual(activeEl, bpm);

    dispatchKey(dlg, 'Tab', { shift: true });
    assert.strictEqual(activeEl, cancel, 'Shift+Tab from first wraps to last');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
