/*
 * Load/import paths reassign S.history instead of reset()ing it, so nothing
 * refreshes the toolbar readout on its own: `EditHistory._ui()` is the only
 * writer of `#editor-last-action` / `#editor-revert` (and of the Undo/Redo
 * enabled state), and a freshly constructed history never calls it. Without an
 * explicit refresh, right after loading a song the toolbar still names the
 * PREVIOUS session's edit with Revert looking enabled — the staleness
 * S.lastAction = '' was meant to remove, visible to the user anyway.
 *
 * Both entry points are driven end-to-end against a seeded, stale readout, so
 * each case fails if the `_ui()` refresh after the reassignment is dropped.
 *
 * Run: node --test tests/load_readout_refresh.test.mjs
 */
import assert from 'node:assert';

// The four elements the fix must refresh, as faithful stand-ins a suite can
// read back. Every OTHER id stays permissive (absorb any incidental DOM the
// load plumbing pokes at) so a headless run never trips over chrome we don't
// care about.
const observed = {};
const OBSERVED_IDS = ['editor-undo', 'editor-redo', 'editor-revert', 'editor-last-action', 'editor-status'];
const obs = (id) => (observed[id] ||= {
    id, disabled: false, textContent: '', title: '', value: '', innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    remove() {}, focus() {}, blur() {},
});
const el = new Proxy(function () {}, {
    get: (_t, k) => (k === 'classList' ? el : (k === 'value' ? '' : el)),
    apply: () => el,
    set: () => true,
});
globalThis.window = globalThis.window || globalThis;
globalThis.document = {
    getElementById: (id) => (OBSERVED_IDS.includes(id) ? obs(id) : el),
    createElement: () => el,
    querySelectorAll: () => [],
    body: el,
    addEventListener: () => {},
    removeEventListener: () => {},
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// The load endpoint returns the pack below; every other call (the outgoing
// session dispose, guide/onset probes) just has to answer.
const PACK = {
    session_id: 'load-session',
    title: 'T', artist: 'A',
    arrangements: [], beats: [], sections: [],
    duration: 0, offset: 0, format: 'sloppak',
};
globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/load') ? PACK : {}),
    blob: async () => ({}),
});

const { setHostHooks } = await import('../src/host.js');
const { S } = await import('../src/state.js');
const { EditHistory } = await import('../src/history.js');
const { loadCDLC } = await import('../src/file-ops.js');
const { editorApplyCreateResult } = await import('../src/create.js');

// Entry points the create path calls on window / through host.
window.editorHideCreateModal = () => {};
window.editorSetCreateMode = () => {};
setHostHooks({
    loadAudio: () => {},
    resetOffsetUI: () => {},
    updateArrangementSelector: () => {},
    updateStatus: () => {},
    updateTimeDisplay: () => {},
    updateBPMDisplay: () => {},
    draw: () => {},
    installCreatedTrackSession: () => {},
});

let pass = 0, fail = 0;
async function t(name, fn) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

// A committed edit, so the toolbar genuinely displays the previous session's
// action before the load wipes the stack underneath it.
class SeedCmd { exec() {} rollback() {} }
function seedStaleReadout() {
    Object.assign(S, {
        sessionId: '', lastAction: '',
        arrangements: [], beats: [], sections: [],
        history: new EditHistory(),
    });
    S.history.exec(new SeedCmd());
    assert.strictEqual(obs('editor-last-action').textContent, 'seed', 'premise: an action is displayed');
    assert.strictEqual(obs('editor-revert').disabled, false, 'premise: Revert looks enabled');
    assert.strictEqual(obs('editor-undo').disabled, false, 'premise: Undo looks enabled');
}

function assertCleared(where) {
    assert.strictEqual(obs('editor-last-action').textContent, '',
        `${where}: the label still names the previous session's edit`);
    assert.strictEqual(obs('editor-last-action').textContent, S.lastAction,
        `${where}: the readout matches the cleared S.lastAction`);
    assert.strictEqual(obs('editor-revert').disabled, true,
        `${where}: Revert is still enabled on an empty stack`);
    assert.strictEqual(obs('editor-revert').title, 'Nothing to revert',
        `${where}: Revert still offers a stale action by name`);
    assert.strictEqual(obs('editor-undo').disabled, true, `${where}: Undo still enabled`);
    assert.strictEqual(obs('editor-redo').disabled, true, `${where}: Redo still enabled`);
}

await t('loadCDLC refreshes the readout when it installs a fresh history', async () => {
    seedStaleReadout();
    const ok = await loadCDLC('fresh.sloppak', { skipGuard: true });
    assert.strictEqual(ok, true, `load failed: ${obs('editor-status').textContent}`);
    assert.strictEqual(S.history.undo.length, 0, 'premise: the new stack is empty');
    assertCleared('loadCDLC');
});

await t('editorApplyCreateResult refreshes the readout when it installs a fresh history', async () => {
    seedStaleReadout();
    await editorApplyCreateResult({
        session_id: 'import-session',
        title: 'X', artist: 'Y',
        arrangements: [{ name: 'Lead', notes: [], chords: [], tuning: [0, 0, 0, 0, 0, 0] }],
        beats: [], sections: [], duration: 0,
    });
    assert.strictEqual(S.history.undo.length, 0, 'premise: the new stack is empty');
    assertCleared('editorApplyCreateResult');
});

console.log('\nload_readout_refresh: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
