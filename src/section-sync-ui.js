// Per-section sync results UI (#26) — sub-issue 5/5 of per-section syncing (#8).
//
// Presents the #24 analysis one section at a time: a row with the section name,
// its confidence badge, and whether the section will be applied or skipped.
// Low-confidence sections default to SKIP and are never applied unless the user
// explicitly selects them; failed sections are not selectable at all. "Apply all
// high-confidence" re-selects just the trusted sections; "Apply" bakes the
// current selection through the same `applyPerSectionSync` path as #25, so a
// preview and the committed edit are one map. A single-section song collapses to
// the uniform model — one full-domain row.
//
// Pure decisions live in `section-sync.js` (`_sectionSyncPlanPure`); this module
// only gathers onsets, renders, and hands the plan to the apply path. The
// window.editor* entry points are attached by main.js (the repo convention).

import { S } from './state.js';
import { _ensureOnsetsShifted } from './audio.js';
import { applyPerSectionSync } from './tempo.js';
import {
    _alignSectionsPure, _sectionSyncHighConfidenceDisabledPure, _sectionSyncPlanPure,
} from './section-sync.js';
import { _editorEscHtml, _installModalKeyboard, setStatus } from './ui.js';
import { host } from './host.js';

let _analysis = null;
let _decisions = null;   // section index -> boolean (true = apply, false = skip)
let _prevFocus = null;
let _kbInstalled = false;

const MODAL_ID = 'editor-section-sync-modal';

function _modal() {
    return typeof document === 'undefined' ? null : document.getElementById(MODAL_ID);
}

// Focus a live control in the modal. A disabled button refuses focus, so fall
// back through the primary action, any enabled control, then the modal root
// (which is `tabIndex = -1` and inside range of the keydown trap).
function _focusModal() {
    if (typeof document === 'undefined') return;
    const modal = _modal();
    if (!modal) return;
    const apply = document.getElementById('editor-section-sync-apply');
    if (apply && !apply.disabled && apply.focus) { apply.focus(); return; }
    if (typeof modal.querySelector === 'function') {
        const first = modal.querySelector('button:not([disabled])');
        if (first && first.focus) { first.focus(); return; }
    }
    if (modal.focus) modal.focus();
}

export function editorShowSectionSync() {
    if (typeof document === 'undefined') return;
    if (S.beats.length < 2) { setStatus('Need at least two beats to sync.'); return; }
    if (!S.audioBuffer && !S.waveformPeaks) {
        setStatus('Load audio before per-section sync.');
        return;
    }
    const onsets = _ensureOnsetsShifted() || [];
    if (!onsets.length) {
        setStatus('No audio onsets detected yet — cannot per-section sync.');
        return;
    }
    const analysis = _alignSectionsPure({
        sections: S.sections || [],
        beats: S.beats,
        source: { arrangements: S.arrangements, drumTab: S.drumTab },
        audioOnsets: onsets,
    });
    if (!analysis.ok) {
        setStatus(`Per-section sync unavailable (${analysis.reason}).`);
        return;
    }
    _analysis = analysis;
    _decisions = new Map();
    const modal = _modal();
    if (!modal) return;
    _renderSectionSync();
    _prevFocus = document.activeElement;
    modal.classList.remove('hidden');
    if (!_kbInstalled) {
        _kbInstalled = true;
        // The panel (firstElementChild) owns the focusables; the overlay root
        // only needs to stay focusable so a backdrop click can be redirected in.
        _installModalKeyboard(modal, modal.firstElementChild, editorHideSectionSync);
    }
    _focusModal();
    setStatus('Review per-section sync results.');
}

export function editorHideSectionSync() {
    const modal = _modal();
    if (modal) modal.classList.add('hidden');
    const prev = _prevFocus;
    _prevFocus = null;
    if (prev && prev.isConnected && prev.focus) prev.focus();
}

export function editorToggleSectionSync(index) {
    if (!_analysis || !_decisions) return;
    const row = _sectionSyncPlanPure(_analysis, _decisions)
        .rows.find((r) => r.index === index);
    if (!row) return;
    if (!row.forceable) {
        setStatus('That section has no usable alignment to apply.');
        return;
    }
    // Flip relative to the DECISION intent, not the conflict-demoted acceptance:
    // an explicitly-skipped section that a conflict would otherwise hide must
    // still toggle back on, and a demoted run must not become toggle-stuck.
    _decisions.set(index, !row.wanted);
    _renderSectionSync();
    // The re-render replaced the rows container, so the clicked button is gone
    // and focus fell to <body> — which would let global shortcuts through the
    // overlay. Put focus back on this row's toggle (or a safe fallback).
    _focusSectionToggle(index);
}

// Restore focus to a row's toggle after a re-render, falling back inside the
// modal. `document.querySelector` is absent in some DOM stubs; the fallback
// covers that.
function _focusSectionToggle(index) {
    if (typeof document === 'undefined') return;
    const btn = typeof document.querySelector === 'function'
        ? document.querySelector(`[data-section-ss="${index}"]`) : null;
    if (btn && btn.focus) { btn.focus(); return; }
    _focusModal();
}

export function editorApplySectionSync(allHighConfidence) {
    if (!_analysis) return;
    // "All high-confidence" is the default decision set: the confidence floor
    // alone decides, i.e. low-confidence sections are skipped.
    const decisions = allHighConfidence ? new Map() : _decisions;
    const plan = _sectionSyncPlanPure(_analysis, decisions);
    if (!plan.ok) { setStatus('Per-section sync analysis is unavailable.'); return; }
    if (plan.conflicts.length) {
        setStatus('Cannot apply: a section conflicts with the fit. Skip it and try again.');
        return;
    }
    if (!plan.summary.applied) { setStatus('No sections selected to apply.'); return; }
    const res = applyPerSectionSync({
        proposals: plan.proposals,
        confidenceFloor: plan.confidenceFloor,
        domain: plan.domain,
    });
    if (!res || !res.applied) {
        setStatus(`Per-section sync refused (${(res && res.reason) || 'unknown'}).`);
        return;
    }
    const n = plan.summary.applied;
    editorHideSectionSync();
    host.draw();
    setStatus(`Applied per-section sync to ${n} section${n === 1 ? '' : 's'}.`);
}

// ── Rendering ──────────────────────────────────────────────────────────────

function _tierBadge(row) {
    const cls = row.tier === 'high'
        ? 'bg-emerald-500/20 text-emerald-300'
        : row.tier === 'low'
            ? 'bg-amber-500/20 text-amber-300'
            : 'bg-red-500/20 text-red-300';
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}">`
        + `${row.confidencePct}%</span>`;
}

function _rowDetail(row) {
    if (row.conflict) return 'conflict';
    if (!row.accepted) {
        return row.tier === 'high' ? 'skipped'
            : row.tier === 'low' ? 'below threshold' : 'no match';
    }
    const shift = row.shift >= 0 ? `+${row.shift.toFixed(2)}` : row.shift.toFixed(2);
    return `×${row.factor.toFixed(3)} · ${shift}s`;
}

function _sectionRowHtml(row) {
    const toggle = row.forceable
        ? `<button type="button" data-section-ss="${row.index}"`
            + ` onclick="editorToggleSectionSync(${row.index})"`
            + ` aria-pressed="${row.wanted}" class="w-16 px-2 py-1 rounded text-[11px] `
            + `${row.wanted ? 'bg-accent hover:bg-accent-light' : 'bg-dark-600 hover:bg-dark-500'}">`
            + `${row.wanted ? 'Apply' : 'Skip'}</button>`
        : '<span class="w-16 px-2 py-1 rounded text-[11px] text-center text-gray-600">—</span>';
    return '<div class="flex items-center gap-2 py-1 border-b border-dark-600/60">'
        + '<span class="flex-1 truncate text-xs text-gray-300">'
        + `${_editorEscHtml(row.label)}</span>`
        + `${_tierBadge(row)}`
        + `<span class="w-28 text-right text-[10px] font-mono text-gray-500">${_rowDetail(row)}</span>`
        + `${toggle}</div>`;
}

function _summaryText(plan) {
    const s = plan.summary;
    if (!s.sections) return 'No sections to sync.';
    const parts = [`${s.applied}/${s.sections} selected`];
    // Count only low-confidence sections that are NOT being applied — a section
    // the user explicitly selected must not read as "skipped".
    const lowSkipped = plan.rows.filter((r) => r.tier === 'low' && !r.accepted).length;
    if (lowSkipped) parts.push(`${lowSkipped} low-confidence skipped`);
    if (s.failed) parts.push(`${s.failed} unmatched`);
    if (plan.conflicts.length) parts.push(`${plan.conflicts.length} conflict`);
    return parts.join(' · ');
}

function _renderSectionSync() {
    if (typeof document === 'undefined') return;
    const plan = _sectionSyncPlanPure(_analysis, _decisions);
    const rowsEl = document.getElementById('editor-section-sync-rows');
    if (rowsEl) {
        const scroll = rowsEl.scrollTop || 0;
        rowsEl.innerHTML = plan.rows.map(_sectionRowHtml).join('');
        rowsEl.scrollTop = scroll;
    }
    const summaryEl = document.getElementById('editor-section-sync-summary');
    if (summaryEl) summaryEl.textContent = _summaryText(plan);
    const applyBtn = document.getElementById('editor-section-sync-apply');
    if (applyBtn) {
        const n = plan.summary.applied;
        applyBtn.disabled = n === 0;
        applyBtn.textContent = n > 0
            ? `Apply ${n} section${n === 1 ? '' : 's'}`
            : 'Apply selected';
    }
    const highBtn = document.getElementById('editor-section-sync-apply-high');
    if (highBtn) highBtn.disabled = _sectionSyncHighConfidenceDisabledPure(_analysis);
}
