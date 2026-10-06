/*
 * DPR refresh on a monitor / zoom change (improvement plan P0.5, issue #30).
 *
 * canvas.js cached `DPR` once at module load, so dragging the window to a
 * monitor with a different scale factor — or an OS/browser zoom change — left
 * the canvas rendering at the old pixel density until a reload. `_watchDpr`
 * re-reads devicePixelRatio from a matchMedia '(resolution: Ndppx)' query and
 * chains a fresh query forward on every change (the same query object only
 * ever fires once).
 *
 * This pins the subscription chain, the DPR/onChange updates, and the dispose
 * handle the screen teardown (src/main.js `window.__editorScreenTeardown`)
 * must call so a re-injection can't stack a second watcher.
 *
 * Run: node tests/dpr_watch.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';

// A matchMedia stub whose queries remember their listeners, so a test can see
// exactly which query is subscribed and fire it by hand — including the
// once-only consumption the browser does for us.
const mqs = [];
globalThis.window = {
    devicePixelRatio: 1,
    matchMedia(query) {
        const subs = [];
        const mq = {
            query,
            addEventListener(type, fn, opts) { subs.push({ type, fn, opts }); },
            removeEventListener(type, fn) {
                const i = subs.findIndex(s => s.type === type && s.fn === fn);
                if (i >= 0) subs.splice(i, 1);
            },
            fire() {
                for (const s of [...subs]) {
                    const once = s.opts && s.opts.once;
                    if (once) subs.splice(subs.indexOf(s), 1);
                    s.fn({ matches: true, media: query });
                }
            },
            subs,
        };
        mqs.push(mq);
        return mq;
    },
};

// Namespace import: `DPR` is a live binding, so reading it through the
// namespace (`canvasMod.DPR`) tracks the watcher's writes — destructuring
// (`const { DPR } = await import(...)`) would snapshot the import-time value.
const canvasMod = await import('../src/canvas.js');
const { _watchDpr } = canvasMod;

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

const changes = [];
let stop = _watchDpr((d) => changes.push(d));

t('the watcher subscribes once, at the CURRENT DPR, as a one-shot', () => {
    assert.strictEqual(mqs.length, 1);
    assert.strictEqual(mqs[0].query, '(resolution: 1dppx)');
    assert.strictEqual(mqs[0].subs.length, 1);
    assert.strictEqual(mqs[0].subs[0].type, 'change');
    assert.strictEqual(mqs[0].subs[0].opts.once, true);
});

t('a DPR change re-reads devicePixelRatio, notifies, and re-subscribes', () => {
    window.devicePixelRatio = 2;
    mqs[0].fire();
    assert.strictEqual(canvasMod.DPR, 2, 'the shared DPR binding must follow the monitor');
    assert.deepStrictEqual(changes, [2], 'onChange fires exactly once, with the new DPR');
    assert.strictEqual(mqs.length, 2, 'a fresh query chains forward');
    assert.strictEqual(mqs[1].query, '(resolution: 2dppx)');
    assert.strictEqual(mqs[1].subs.length, 1, 'the fresh query is armed');
    assert.strictEqual(mqs[0].subs.length, 0, 'the spent query is consumed');
});

t('a change event with DPR unchanged does not re-notify (but stays armed)', () => {
    mqs[1].fire();          // devicePixelRatio still 2
    assert.deepStrictEqual(changes, [2], 'no duplicate onChange for a no-op change');
    assert.strictEqual(mqs.length, 3, 'the chain still re-arms itself');
    assert.strictEqual(mqs[2].query, '(resolution: 2dppx)');
    assert.strictEqual(mqs[2].subs.length, 1);
});

t('dispose detaches the pending subscription', () => {
    stop();
    assert.strictEqual(mqs[2].subs.length, 0, 'the armed listener is gone');
});

t('after dispose a resolution change notifies nobody and arms nothing', () => {
    const before = mqs.length;
    window.devicePixelRatio = 3;
    mqs[2].fire();
    assert.deepStrictEqual(changes, [2], 'the disposed watcher stayed silent');
    assert.strictEqual(mqs.length, before, 'no replacement query was created');
    stop = null;
    window.devicePixelRatio = 1;   // restore for the guard below
});

t('no window / no matchMedia: _watchDpr arms nothing and still returns a dispose stub', () => {
    const saved = window.matchMedia;
    window.matchMedia = undefined;
    try {
        const dispose = _watchDpr(() => { throw new Error('must not fire'); });
        assert.strictEqual(typeof dispose, 'function');
        assert.doesNotThrow(() => dispose());
    } finally {
        window.matchMedia = saved;
    }
});

// ── The teardown wiring in src/main.js ─────────────────────────────
const mainSrc = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

function extractWinFn(name, globals) {
    const marker = 'window.' + name + ' = ';
    const start = mainSrc.indexOf(marker);
    assert.ok(start >= 0, `window.${name} must exist`);
    const open = mainSrc.indexOf('{', mainSrc.indexOf('=>', start));
    let depth = 0, end = -1;
    for (let i = open; i < mainSrc.length; i++) {
        if (mainSrc[i] === '{') depth++;
        else if (mainSrc[i] === '}' && --depth === 0) { end = i; break; }
    }
    assert.ok(end > 0, `unbalanced braces extracting ${name}`);
    const arrowSrc = mainSrc.slice(start + marker.length, end + 1); // "() => {...}"
    const names = Object.keys(globals);
    const fn = new Function(...names, '"use strict"; return (' + arrowSrc + ');');
    return fn(...names.map(k => globals[k]));
}

t('init hands _watchDpr a handler and keeps its dispose handle', () => {
    assert.ok(
        /_watchDprDispose = _watchDpr\(/.test(mainSrc),
        'main.js must retain _watchDpr\'s dispose handle for teardown',
    );
});

t('the screen teardown releases the DPR watcher', () => {
    const calls = { dispose: 0 };
    const obs = { disconnect() {} };
    const teardown = extractWinFn('__editorScreenTeardown', {
        dismissSessionPrompt() {},
        _globalListeners: { removeAll() {} },
        teardownAudio() {},
        teardownTabView: undefined,          // typeof-guarded optional hook
        _editorScreenObs: obs,
        _v3TopbarWatch: null,
        _v3LayoutObs: null,
        _canvasWrapObs: obs,
        _watchDprDispose: () => { calls.dispose++; },
        _bootPollInterval: null,
        teardownDrumPadStrip() {},
        _cancelPendingDraw: undefined,       // typeof-guarded optional hook
    });
    teardown();
    assert.strictEqual(calls.dispose, 1, 'teardown must call the dispose handle');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
