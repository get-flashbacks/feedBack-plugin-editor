/*
 * "Export to Library" must not double-submit (improvement plan P0.3, #29).
 *
 * The toolbar button is a bare `onclick="editorBuild()"` (screen.html) and the
 * File ▸ item calls the same global, so neither entry point disables itself —
 * a double-click, or a click plus a key repeat, used to post a second /build
 * and publish the same pack to the library twice. `editorBuild` now takes a
 * module-level in-flight flag and disables the button for the duration, and
 * releases both in a `finally` so a failed export stays retryable. The guard
 * itself landed in #6; this pins it, which it did not have.
 *
 * Run: node tests/export_double_submit.test.mjs
 */
import assert from 'node:assert';

// toolbars.js (via create.js) touches localStorage; editorBuild probes the
// create modal's art input. Stub the slices before import.
globalThis.localStorage = globalThis.localStorage || {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
};
globalThis.window = globalThis.window || globalThis;

// The export button is the one element the guard writes to, and `.disabled` is
// the only property it touches on it. Every other id keeps resolving to null,
// the DOM-less shape the rest of the suite runs under.
const buildBtn = { disabled: false };
globalThis.document = {
    getElementById: id => (id === 'editor-build-btn' ? buildBtn : null),
};

const { editorBuild } = await import('../src/create.js');
const { saveCDLC } = await import('../src/file-ops.js');
const { host } = await import('../src/host.js');
const { S } = await import('../src/state.js');

let pass = 0, fail = 0;
async function t(name, fn) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ': ' + e.message); }
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function seedCreateSession() {
    Object.assign(S, {
        sessionId: 'sess-create-1',
        createMode: true,
        format: 'sloppak',
        filename: '',
        title: 'White Wedding (Pt. 1)',
        artist: 'Billy Idol',
        arrangements: [{
            name: 'Lead', tuning: [0, 0, 0, 0, 0, 0], capo: 0,
            notes: [], chords: [], chord_templates: [],
        }],
        currentArr: 0,
        beats: [], sections: [],
        drumTab: null, drumTabDirty: false,
        sessionDirty: true,
        audioShift: 0, stemLinks: {},
    });
    buildBtn.disabled = false;
}

await t('two rapid clicks start exactly one export', async () => {
    seedCreateSession();
    const build = deferred();
    const destinations = [];
    globalThis.fetch = (url, opts) => {
        destinations.push(JSON.parse(opts.body).destination);
        return build.promise;
    };

    // The double-click: both calls land in the same tick, so only a flag set
    // synchronously at entry (not an awaited one) can separate them. Neither
    // promise is awaited until the response is released, so a missing guard
    // fails on the call count instead of parking the suite on a pending fetch.
    const first = editorBuild();
    const second = editorBuild();
    assert.deepStrictEqual(destinations, ['library'], 'only one /build reached the wire');
    assert.strictEqual(buildBtn.disabled, true, 'the button is disabled for the flight');

    build.resolve({ json: async () => ({ success: true, filename: 'export.feedpak' }) });
    assert.strictEqual(await first, true, 'the first export still completes');
    assert.strictEqual(await second, false, 'the second click is refused, not queued');
    assert.strictEqual(buildBtn.disabled, false, 'the button is live again');
});

await t('the button is usable again after a failed export', async () => {
    seedCreateSession();
    const attempts = [];
    globalThis.fetch = async (url, opts) => {
        attempts.push(JSON.parse(opts.body).destination);
        if (attempts.length === 1) {
            return { json: async () => ({ error: 'DLC folder not configured' }) };
        }
        return { json: async () => ({ success: true, filename: 'export.feedpak' }) };
    };

    assert.strictEqual(await editorBuild(), false, 'the backend error reads as a failure');
    assert.strictEqual(buildBtn.disabled, false,
        'a failed export must not strand the button disabled');
    assert.strictEqual(await editorBuild(), true, 'the retry runs and succeeds');
    assert.deepStrictEqual(attempts, ['library', 'library'],
        'the retry actually posted — the guard was released, not just the button');
});

await t('declining the gear-definition warning releases the guard too', async () => {
    seedCreateSession();
    // An authored tone slot with no gear definition makes editorBuild ask before
    // it posts anything, so the cancel path never reaches the network.
    S.arrangements[0].tones = { base: 'Crunch', changes: [], definitions: [], _editCount: 1 };
    let builds = 0;
    globalThis.fetch = async () => {
        builds++;
        return { json: async () => ({ success: true, filename: 'export.feedpak' }) };
    };

    globalThis.confirm = () => false;
    assert.strictEqual(await editorBuild(), false, 'declining cancels the export');
    assert.strictEqual(builds, 0, 'nothing was posted');
    assert.strictEqual(buildBtn.disabled, false, 'the cancel path releases the button');

    globalThis.confirm = () => true;
    assert.strictEqual(await editorBuild(), true, 'the next export runs and succeeds');
    assert.strictEqual(builds, 1);
    delete S.arrangements[0].tones;
    delete globalThis.confirm;
});

await t('a build that throws releases the guard just the same', async () => {
    seedCreateSession();
    // The closing repaint is the one build step outside editorBuild's own
    // network try/catch, so it is the realistic way the body rejects. A guard
    // reset on the success path only would leave Export dead for the session.
    const realDraw = host.draw;
    host.draw = () => { throw new Error('repaint failed'); };
    globalThis.fetch = async () => ({ json: async () => ({ success: true, filename: 'export.feedpak' }) });

    try {
        await assert.rejects(() => editorBuild(), /repaint failed/);
        assert.strictEqual(buildBtn.disabled, false, 'the throwing build re-enabled the button');
    } finally {
        host.draw = realDraw;
    }
    assert.strictEqual(await editorBuild(), true, 'the next export still runs');
});

await t("Save's own build leg rides the same guard", async () => {
    seedCreateSession();
    const build = deferred();
    const destinations = [];
    globalThis.fetch = (url, opts) => {
        destinations.push(JSON.parse(opts.body).destination);
        return build.promise;
    };

    // Create-mode Save packages through the same entry point, so Ctrl+S during
    // an in-flight export must not queue a second package behind it.
    const exporting = editorBuild();
    const saving = saveCDLC({ skipExternal: true });
    assert.deepStrictEqual(destinations, ['library'], 'Save did not post its own /build');

    build.resolve({ json: async () => ({ success: true, filename: 'export.feedpak' }) });
    assert.strictEqual(await exporting, true, 'the export ran and completed');
    assert.strictEqual(await saving, false, 'the in-flight export refused the Save');
    assert.strictEqual(buildBtn.disabled, false, 'the export released the button');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);