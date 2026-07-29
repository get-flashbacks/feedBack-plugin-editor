/* Slopsmith Arrangement Editor — the render surface.
 *
 * The `<canvas>` element, its 2D context, and the device pixel ratio. Every
 * painter in the editor reads these; only `setCanvas` writes them.
 *
 * `canvas` and `ctx` are `export let`, so importers see them go from null to
 * live the moment `init()` calls `setCanvas`, and none of them can assign one —
 * ES import bindings are live and read-only. That is why this needs no container
 * (unlike lanes.js's `LC`, whose writers must stay in main.js): the sole writer
 * moved here.
 *
 * `DPR` is guarded so this module — and everything downstream of it — stays
 * importable under node, where there is no `window`.
 */

export let DPR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

export let canvas = null;
export let ctx = null;

/** Re-check devicePixelRatio whenever it changes (dragging the window to a
 * monitor with a different scale factor, or an OS/browser zoom change) and
 * call `onChange(newDPR)` — the caller is expected to re-run whatever sizes
 * the canvas off DPR (main.js's resizeCanvas) and redraw.
 *
 * `matchMedia('(resolution: Ndppx)')` only ever fires 'change' once: the
 * query stops matching the moment DPR moves away from N, but the SAME query
 * object never matches again afterward. So each firing re-subscribes a fresh
 * query pinned to the new DPR, chaining forward through however many changes
 * happen across the session. Guarded for node/tests, where there is no
 * `window` (or no `matchMedia`). */
export function _watchDpr(onChange) {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mq = window.matchMedia(`(resolution: ${DPR}dppx)`);
    const handler = () => {
        const next = window.devicePixelRatio || 1;
        if (next !== DPR) {
            DPR = next;
            if (typeof onChange === 'function') onChange(DPR);
        }
        mq = window.matchMedia(`(resolution: ${DPR}dppx)`);
        mq.addEventListener('change', handler, { once: true });
    };
    mq.addEventListener('change', handler, { once: true });
}

/** Adopt `el` as the render surface. Returns it, so a caller can bail on null.
 *
 * `getContext('2d')` is idempotent — it hands back the same context object for
 * the same element — so calling this twice for one canvas is a no-op, and
 * calling it after the host has replaced the DOM node correctly re-points `ctx`
 * at the NEW element's context (the old code re-read the element but kept the
 * stale context). */
export function setCanvas(el) {
    canvas = el || null;
    ctx = canvas ? canvas.getContext('2d') : null;
    return canvas;
}
