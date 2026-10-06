/*
 * The DPR refresh path (issue #30): canvas.js captured devicePixelRatio once
 * at module load, and a monitor move / OS-zoom change fires NO window
 * 'resize' — so nothing re-derived the canvas pixel size. _watchDpr() re-checks
 * it through matchMedia('(resolution: Ndppx)') and hands the new value to the
 * caller (main.js re-runs resizeCanvas, which sizes the backing store off the
 * live DPR binding and redraws).
 *
 * Two properties the implementation depends on:
 *   - a single resolution query only ever fires ONCE (it stops matching as
 *     soon as DPR moves), so each firing must re-subscribe a fresh query
 *     pinned to the NEW DPR — otherwise the chain dies after one change;
 *   - the chain must be disposable: the editor re-injects itself on a screen
 *     change, and a watcher left pending on window would keep resizing a
 *     canvas the next injection already owns.
 *
 * Each case gets its own canvas.js instance (cache-busted import) with a
 * hand-driven fake window, since `DPR` is module state that mutates.
 *
 * Run: node tests/dpr_watch.test.mjs
 */
import assert from 'node:assert';

let pass = 0, fail = 0;
async function t(name, fn) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

// A fake window whose matchMedia records every query string and the listeners
// handed to it, so the chain can be fired by hand.
function fakeWindow(dpr) {
    return {
        devicePixelRatio: dpr,
        queries: [],
        matchMedia(q) {
            const mq = {
                query: q,
                listeners: [],
                addEventListener(type, fn, opts) { this.listeners.push({ type, fn, opts }); },
                removeEventListener(type, fn) {
                    this.listeners = this.listeners.filter((l) => l.fn !== fn);
                },
            };
            this.queries.push(mq);
            return mq;
        },
    };
}

let caseNo = 0;
async function load(dpr) {
    const win = fakeWindow(dpr);
    globalThis.window = win;
    const mod = await import(`../src/canvas.js?case=${caseNo++}`);
    return { mod, win };
}

await t('subscribes one resolution query at the current DPR', async () => {
    const { mod, win } = await load(1);
    const stop = mod._watchDpr(() => {});
    assert.strictEqual(win.queries.length, 1, 'one query subscribed');
    assert.strictEqual(win.queries[0].query, '(resolution: 1dppx)', 'pinned to the current DPR');
    assert.strictEqual(win.queries[0].listeners.length, 1);
    assert.strictEqual(win.queries[0].listeners[0].type, 'change');
    assert.deepStrictEqual(win.queries[0].listeners[0].opts, { once: true });
    assert.strictEqual(typeof stop, 'function', 'a dispose handle comes back');
});

await t('a DPR change calls onChange with the new value and re-subscribes pinned to it', async () => {
    const { mod, win } = await load(1);
    const seen = [];
    const stop = mod._watchDpr((d) => seen.push(d));
    win.devicePixelRatio = 2;
    win.queries[0].listeners[0].fn();
    assert.deepStrictEqual(seen, [2], 'onChange got the new DPR once');
    assert.strictEqual(mod.DPR, 2, 'the exported live binding moved too');
    assert.strictEqual(win.queries.length, 2, 'a fresh query was created');
    assert.strictEqual(win.queries[1].query, '(resolution: 2dppx)', 'pinned to the NEW DPR');
    assert.strictEqual(win.queries[1].listeners.length, 1, 'the chain re-subscribed');
    stop();
});

await t('the chain keeps re-subscribing through several changes', async () => {
    const { mod, win } = await load(2);
    const seen = [];
    mod._watchDpr((d) => seen.push(d));
    win.devicePixelRatio = 1.5;
    win.queries[0].listeners[0].fn();
    win.devicePixelRatio = 3;
    win.queries[1].listeners[0].fn();
    assert.deepStrictEqual(seen, [1.5, 3]);
    assert.strictEqual(win.queries.length, 3);
    assert.strictEqual(win.queries[2].query, '(resolution: 3dppx)');
});

await t('a change event with no actual DPR move fires nothing but keeps the chain alive', async () => {
    const { mod, win } = await load(2);
    const seen = [];
    mod._watchDpr((d) => seen.push(d));
    win.queries[0].listeners[0].fn();   // devicePixelRatio is still 2
    assert.deepStrictEqual(seen, [], 'no onChange when the value did not move');
    assert.strictEqual(win.queries.length, 2, 're-subscribed anyway');
    assert.strictEqual(win.queries[1].query, '(resolution: 2dppx)');
});

await t('dispose unhooks the pending query and the chain stops dead', async () => {
    const { mod, win } = await load(1);
    const seen = [];
    const stop = mod._watchDpr((d) => seen.push(d));
    const pending = win.queries[0].listeners[0].fn;
    stop();
    assert.strictEqual(win.queries[0].listeners.length, 0, 'pending query unhooked');
    win.devicePixelRatio = 3;
    pending();   // an event already queued on the old handler must be inert
    assert.deepStrictEqual(seen, [], 'no onChange after dispose');
    assert.strictEqual(win.queries.length, 1, 'no re-subscription after dispose');
});

await t('a window-less build gets a no-op dispose it can always call', async () => {
    const saved = globalThis.window;
    delete globalThis.window;
    try {
        const mod = await import(`../src/canvas.js?nowin=${caseNo++}`);
        const stop = mod._watchDpr(() => { throw new Error('onChange must not fire'); });
        assert.strictEqual(typeof stop, 'function');
        assert.doesNotThrow(() => stop());
    } finally {
        globalThis.window = saved;
    }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
