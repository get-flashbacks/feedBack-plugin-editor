/*
 * Stem manager (Audio tracks) keyboard routing — fresh-open focus, Escape
 * closes + restores, and the trap SKIPS the hidden file input.
 *
 * The dialog's first focusable in DOM order is the Import file input,
 * which sits display:none inside its label: wrapping to it (or landing
 * there from the backdrop) strands focus on an element the browser will
 * not focus, so Tab can never enter the dialog. The trap filters to
 * rendered controls — the close button is first, the row controls after.
 *
 * Run: node tests/stem_modal_keyboard.test.mjs
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
function byId(id) { return registry.get(id) || null; }

function reset() {
    activeEl = null;
}

// The shipped markup: backdrop > panel > (label > hidden file input,
// close button, list). The file input is display:none, so its focus()
// is a no-op — exactly what the browser does with an unfocusable element.
const modal = reg('editor-stem-tracks-modal', mkEl('editor-stem-tracks-modal', { className: 'absolute inset-0 z-40' }));
const panel = mkEl('stem-panel');
const hiddenInput = mkEl('editor-stem-tracks-file', { tag: 'input' });
hiddenInput.getClientRects = () => [];     // display:none: not rendered
hiddenInput.focus = () => {};              // …so the browser ignores focus()
const closeBtn = mkEl('editor-stem-tracks-close', { tag: 'button' });
const list = reg('editor-stem-tracks-list', mkEl('editor-stem-tracks-list'));
// _render() writes row markup as a string; the stub doesn't parse HTML, so
// the row control it would produce is pre-attached and the setter kept inert.
Object.defineProperty(list, 'innerHTML', { get() { return ''; }, set() {} });
const rowBtn = mkEl('stem-row-rename', { tag: 'button' });
list.appendChild(rowBtn);
modal.appendChild(panel);
panel.appendChild(hiddenInput);
panel.appendChild(closeBtn);
panel.appendChild(list);
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

// A session is required — without one the toggle re-hides before focusing.
Object.assign(S, {
    sessionId: 'sess-stem-kb',
    stems: [{ id: 'Gtr Stem.wav' }],
    stemLinks: {},
    arrangements: [],
    trackSession: {},
});

let pass = 0, fail = 0;
async function t(name, fn) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

const show = async () => {
    const { editorToggleStemTracks } = await import('../src/stem-tracks.js');
    editorToggleStemTracks(true);
};

// ── Tests ───────────────────────────────────────────────────────────
await t('opening the Audio tracks dialog moves focus into it', async () => {
    reset();
    await show();
    assert.ok(!modal.classList.contains('hidden'), 'dialog visible');
    assert.strictEqual(activeEl, modal, 'focus sits on the dialog root');
});

await t('Escape closes the dialog and restores focus to the opener', async () => {
    reset();
    const opener = mkEl('opener');
    opener.focus();

    await show();
    dispatchKey(modal, 'Escape');
    assert.ok(modal.classList.contains('hidden'), 'dialog hidden after Escape');
    assert.strictEqual(activeEl, opener, 'focus restored to opener');
});

await t('Tab from the backdrop lands on the close button — the hidden file input is skipped', async () => {
    reset();
    await show();
    assert.strictEqual(activeEl, modal, 'fresh open leaves focus on the dialog root');

    dispatchKey(modal, 'Tab');
    assert.strictEqual(activeEl, closeBtn, 'Tab enters the dialog at the first rendered control');
});

await t('Shift+Tab from the close button wraps to the last rendered control', async () => {
    reset();
    await show();
    closeBtn.focus();

    dispatchKey(modal, 'Tab', { shift: true });
    assert.strictEqual(activeEl, rowBtn, 'Shift+Tab from first wraps to last');
});

await t('Tab from the last rendered control wraps to the close button', async () => {
    reset();
    await show();
    rowBtn.focus();

    dispatchKey(modal, 'Tab');
    assert.strictEqual(activeEl, closeBtn, 'Tab from last wraps to first');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
