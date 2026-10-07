/*
 * Create modal keyboard routing — Escape closes, focus restores, Tab traps.
 *
 * Run: node tests/create_modal_keyboard.test.mjs
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
        querySelector(sel) {
            const all = this._all();
            if (sel.startsWith('button')) return all.find((e) => e.tagName === 'BUTTON') || null;
            if (sel.startsWith('input')) return all.find((e) => e.tagName === 'INPUT') || null;
            if (sel.startsWith('select')) return all.find((e) => e.tagName === 'SELECT') || null;
            return null;
        },
        querySelectorAll(sel) {
            const all = this._all();
            if (sel.includes('button')) return all.filter((e) => e.tagName === 'BUTTON');
            return [];
        },
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

// Build ONE persistent modal + inner panel with two focusable buttons.
const modal = reg('editor-create-modal', mkEl('editor-create-modal', { className: 'fixed inset-0 z-50' }));
const inner = mkEl('editor-create-modal:inner');
modal.appendChild(inner);
const b1 = mkEl('b1', { tag: 'button' });
const b2 = mkEl('b2', { tag: 'button' });
inner.appendChild(b1);
inner.appendChild(b2);

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

const { setHostHooks } = await import('../src/host.js');
setHostHooks({ draw: () => {}, updateStatus: () => {}, ensureArr: () => true });

let pass = 0, fail = 0;
async function t(name, fn) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

// ── Tests ───────────────────────────────────────────────────────────
await t('Escape closes the Create modal and restores focus to the opener', async () => {
    reset();
    const opener = mkEl('opener');
    opener.focus();

    const { editorShowCreateModal } = await import('../src/create.js');
    editorShowCreateModal();
    assert.ok(!modal.classList.contains('hidden'), 'modal visible');
    b1.focus();

    dispatchKey(modal, 'Escape');
    assert.ok(modal.classList.contains('hidden'), 'modal hidden after Escape');
    assert.strictEqual(activeEl, opener, 'focus restored to opener');
});

await t('Tab from last focusable wraps to first inside Create modal', async () => {
    reset();
    const { editorShowCreateModal } = await import('../src/create.js');
    editorShowCreateModal();
    b2.focus();
    assert.strictEqual(activeEl, b2);

    dispatchKey(modal, 'Tab');
    assert.strictEqual(activeEl, b1, 'Tab from last wraps to first');
});

await t('Shift+Tab from first focusable wraps to last inside Create modal', async () => {
    reset();
    const { editorShowCreateModal } = await import('../src/create.js');
    editorShowCreateModal();
    b1.focus();
    assert.strictEqual(activeEl, b1);

    dispatchKey(modal, 'Tab', { shift: true });
    assert.strictEqual(activeEl, b2, 'Shift+Tab from first wraps to last');
});

await t('opening the Create modal moves focus into it (fresh-open Escape/Tab are live)', async () => {
    reset();
    const { editorShowCreateModal } = await import('../src/create.js');
    editorShowCreateModal();
    assert.ok(!modal.classList.contains('hidden'), 'modal visible');
    assert.strictEqual(activeEl, modal, 'focus sits on the dialog root');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
