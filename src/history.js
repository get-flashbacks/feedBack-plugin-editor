// ════════════════════════════════════════════════════════════════════
// Undo / redo stack.
//
// The 47 command classes still live in src/main.js — they are interleaved with
// the feature code that constructs them, and each reaches deep into it. Only
// the stack itself lifts cleanly. Every command is duck-typed: `exec()`,
// `rollback()`, the three edit-lock opt-outs (`songScope`, `pitchPreserving`,
// `suggestResolved`), and `sessionNeutral` for undoable editor preferences.
//
// Browser surface: `document.getElementById` in _ui(), for the toolbar's
// undo/redo buttons.
//
// main.js coupling is three symbols — `_historyEnsureArr`, `draw`,
// `updateStatus` — and importing them would close a cycle (main.js imports this
// module). They arrive through the shared `host` object in src/host.js.
// ════════════════════════════════════════════════════════════════════
import { host } from './host.js';
import { S, bumpEditGen, markSessionDirty } from './state.js';
import { isKeysMode, updatePianoRange, _rollReadOnly, _rollLockNotice } from './keys.js';

// The last committed edit, as a human label — "what just happened", so a user
// who didn't watch the status line can still tell what the Revert button would
// undo. Derived here from the command's own class name (every command in this
// codebase is a `*Cmd`), so it needs no per-command `label` field and can't drift
// out of sync with the class that does the work. A command may carry its own
// `label` (a more specific name than its class — e.g. a tempo-map command that
// does several things); when it does, that wins. Never serialized: it is UI
// state, not pack data, and it is cleared by reset() and by the load path.
/* @pure:last-action:start */
const _COMMAND_LABEL_OVERRIDES = Object.freeze({
    AudioShiftCmd: 'shift the recording',
    TempoOffsetCmd: 'nudge the audio offset',
    TempoGridCmd: 'rebuild the beat grid',
    TempoMapCmd: 'edit the tempo map',
    TempoLockCmd: 'lock barlines',
    RenameArrangementCmd: 'rename the track',
    SetArrangementTypeCmd: 'set the track type',
    ReplaceArrangementChartCmd: 'replace the chart',
    TrackOffsetCmd: 'nudge the track offset',
    MoveRegionCmd: 'move a region',
    PlaceRegionCmd: 'place a region',
    DeleteRegionCmd: 'delete a region',
    TrimRegionCmd: 'trim a region',
    AddDrumHitCmd: 'add a drum hit',
    DeleteDrumHitsCmd: 'delete drum hits',
    MoveDrumHitsCmd: 'move drum hits',
    ToggleDrumArticulationCmd: 'toggle a drum articulation',
    SetDrumVelocityCmd: 'set drum velocity',
    AddNoteCmd: 'add a note',
    MoveNoteCmd: 'move a note',
    DeleteNotesCmd: 'delete notes',
    SplitNotesCmd: 'split notes',
    ResizeSustainCmd: 'resize a sustain',
    ResizeSustainGroupCmd: 'resize sustains',
    ChangeFretCmd: 'change a fret',
    ChangeFretGroupCmd: 'change frets',
    ToggleTechniqueCmd: 'toggle a technique',
    SetTechScalarPerNoteCmd: 'set a technique value',
    SetTechScalarCmd: 'set a technique value',
    SetBendShapeCmd: 'set a bend shape',
    SetBendIntentCmd: 'set a bend intent',
    SetTeachingMarkCmd: 'set a teaching mark',
    SetTeachingMarksCmd: 'set teaching marks',
    SetPitchedSlideTargetsCmd: 'set slide targets',
    EditChordFnCmd: 'edit a chord',
    AcceptPositionsCmd: 'accept note positions',
    MoveToStringCmd: 'move notes to a string',
    AddStringCmd: 'add a string',
    RemoveStringCmd: 'remove a string',
    RemoveStringWithNotesCmd: 'remove a string and its notes',
});
// "DeleteNotesCmd" → "delete notes" — drop the trailing Cmd, split the camel
// boundary, and lower-case the result. Kept in a function (not an inline map)
// so the fallback is one tested expression rather than 40 hand-maintained rows.
export function _commandLabelPure(cmd) {
    if (!cmd) return '';
    if (typeof cmd.label === 'string' && cmd.label) return cmd.label;
    const name = typeof cmd.constructor?.name === 'string' ? cmd.constructor.name : '';
    // A plain object literal (or a command with no class behind it) carries the
    // generic name 'Object' — that is not a label, it is an unlabeled command.
    if (!name || name === 'Object') return '';
    if (Object.prototype.hasOwnProperty.call(_COMMAND_LABEL_OVERRIDES, name)) {
        return _COMMAND_LABEL_OVERRIDES[name];
    }
    return name.replace(/Cmd$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}
/* @pure:last-action:end */

// Cap the undo stack so a marathon session can't grow memory without bound —
// the stack held every command since the last save/load. Oldest entries drop
// first; 500 comfortably exceeds any realistic between-saves editing run.
export const MAX_UNDO = 500;

// A NOTE-scope command is refused while a fretted part is shown in the
// read-only piano roll (V4). Three carve-outs pass:
//   songScope        — edits song-level data (drum tab, tempo grid), not the
//                      fretted chart, so an unrelated part being in the roll
//                      must not freeze tempo/drum editing.
//   pitchPreserving  — the VA.5 position cycle and sustain resize can never
//                      change what a note SOUNDS like, only which string/fret
//                      plays it (or for how long), so the "no silent pitch
//                      writes" contract the lock protects is unbreakable here
//                      by construction.
//   suggestResolved  — the VA.3 suggest-position writer (resolved adds +
//                      Accept) IS the sanctioned string/fret write path the
//                      lock was holding the door for. It marks, never guesses.
//   metadataScope    — arrangement metadata (its `type`), never a single note.
//                      The lock guards silent string/fret WRITES; a type set
//                      touches no note, and the type control is the escape
//                      hatch a fretted part shown read-only in the roll needs
//                      most (re-type it out of keys). Unlike songScope it keeps
//                      _arrIdx, so undo still switches to the retyped part.
// Nothing else opts out. Returns true when the command must not run.
function _locked(cmd) {
    if (cmd.songScope === true || cmd.pitchPreserving === true || cmd.suggestResolved === true || cmd.metadataScope === true) return false;
    if (!_rollReadOnly()) return false;
    _rollLockNotice();
    return true;
}

export class EditHistory {
    constructor() { this.undo = []; this.redo = []; }

    exec(cmd) {
        if (_locked(cmd)) return;
        // Coalesce live repeats of the same nudge (holding an arrow key, repeating
        // a nudge hot-step) into the previous undo entry instead of one step per
        // keystroke. The contract is opt-in and conservative: a command opts in by
        // setting `coalesce` AND supplying a `merge(next)` that folds `next` into
        // itself; exec() only calls merge when the previous entry is a live,
        // un-cleared nudge of the same kind. Two run-breakers, so ANY undo/redo
        // ends the run: the `!this.redo.length` guard stops the next nudge the
        // moment an undo parks a command on the redo stack, and doUndo clears
        // that command's `coalesce`, so an undo→redo round trip (redo stack
        // empty again) cannot re-open it either — the next nudge starts a
        // FRESH step and Ctrl+Z never lands mid-merge or skips past the state
        // a redo just restored. Commands with no `merge` (every non-nudge
        // today) fall straight through to the normal exec/push path unchanged.
        if (this.undo.length && !this.redo.length && cmd.coalesce && typeof cmd.merge === 'function') {
            const prev = this.undo[this.undo.length - 1];
            if (prev && prev.coalesce && prev.merge(cmd)) {
                this._afterEdit(cmd);
                this._ui();
                return;
            }
        }
        // Tag each command with the arrangement it was executed against: most
        // commands resolve their target through the notes()/chords() accessors
        // at rollback time, so an undo issued after switching arrangements
        // would silently mutate the WRONG arrangement's notes.
        cmd._arrIdx = (cmd.songScope === true) ? -1 : (S.currentArr ?? -1);
        cmd.exec();
        this.undo.push(cmd);
        if (this.undo.length > MAX_UNDO) this.undo.shift();
        this.redo = [];
        this._afterEdit(cmd);
        this._ui();
    }

    doUndo() {
        if (!this.undo.length) return;
        const c = this.undo[this.undo.length - 1];
        // Peek-then-pop: if the command belongs to another arrangement,
        // ensureArr switches to it (or refuses when it's gone) BEFORE the
        // command leaves the stack, so a refused undo loses nothing.
        if (!host.ensureArr(c)) return;
        // Rolling a NOTE-scope command back would write the fretted chart shown
        // read-only in the roll, bypassing the exec/drag lock. Refuse — peek
        // only, so the command stays on the stack. ensureArr above has already
        // switched to the command's arrangement, so this evaluates against the
        // part the rollback would actually touch.
        if (_locked(c)) return;
        this.undo.pop(); c.rollback(); this.redo.push(c);
        // Break any coalescing run this command was part of. The redo stack
        // being non-empty already stops the next nudge from merging; clearing
        // the flag keeps it stopped after a redo puts the command back (the
        // redo stack is only ever populated here), so undo→redo→nudge starts a
        // fresh step instead of re-opening the pre-undo run — one Ctrl+Z then
        // lands on the state the redo restored, never past it.
        c.coalesce = false;
        this._afterEdit(c); this._ui(); host.draw(); host.updateStatus();
    }

    doRedo() {
        if (!this.redo.length) return;
        const c = this.redo[this.redo.length - 1];
        if (!host.ensureArr(c)) return;
        // Re-exec of a NOTE-scope command writes the read-only chart: same lock.
        if (_locked(c)) return;
        this.redo.pop(); c.exec(); this.undo.push(c);
        // Re-apply the MAX_UNDO cap: a redo pushes back onto the undo stack, so
        // without this a redo-heavy session could grow it past the bound that
        // exec()/doUndo already enforce. Oldest drops first, mirroring exec().
        if (this.undo.length > MAX_UNDO) this.undo.shift();
        this._afterEdit(c); this._ui(); host.draw(); host.updateStatus();
    }

    // #18: drop the whole stack when the model is rebuilt under us (the save /
    // build flatten+reconstructChords round-trip renumbers arr.notes, so every
    // index-based command would now roll back into the wrong note). Reuse the
    // live instance + its _ui() wiring rather than reassigning S.history.
    // Not _afterEdit() — that nudges the piano viewport, which a clear shouldn't.
    reset() { this.undo = []; this.redo = []; S.lastAction = ''; this._ui(); }

    // Stamp the top-of-undo command as a named checkpoint: "the state as of
    // this call is worth returning to". undoToCheckpoint() rewinds every
    // command ABOVE the stamp and stops with the stamped command still
    // applied — landing exactly on the state at the moment of this call, never
    // one edit earlier. No-op on an empty stack: there is no command to stamp
    // (and no state to return to), so the moment simply isn't recorded.
    // The stamp rides the command object, so it survives redo.
    checkpoint(label) {
        if (this.undo.length) this.undo[this.undo.length - 1]._checkpoint = label || 'checkpoint';
    }

    // Undo repeatedly until a checkpoint-stamped command is on TOP of the undo
    // stack (the stamped command itself stays applied — you land on the state
    // as of the checkpoint() call, not one edit before it). Returns
    // { undone, label, foundCheckpoint } so the caller can name the result.
    // Pressing while ALREADY at a checkpoint targets the previous one, so
    // repeated Ctrl+Alt+Z walks back boundary by boundary instead of going
    // inert. Two graceful degradations:
    //   • No (reachable) checkpoint in the stack ⇒ a single plain undo, never
    //     a silent rewind of the whole session (a checkpoint can be shifted
    //     off by MAX_UNDO or dropped by reset()).
    //   • No-progress guard: doUndo() can REFUSE without popping (ensureArr
    //     switch-away, or the read-only-roll lock). Stop the instant the stack
    //     stops shrinking, so a refusal can never spin.
    undoToCheckpoint() {
        if (!this.undo.length) return { undone: 0, label: null, foundCheckpoint: false };
        const last = this.undo.length - 1;
        // Already sitting on a checkpoint: undoing to it would be a no-op, so
        // the top stamp doesn't count as a target — rewind to the previous one.
        const atCheckpoint = !!this.undo[last]._checkpoint;
        if (!this.undo.some((c, i) => c._checkpoint && !(atCheckpoint && i === last))) {
            const before = this.undo.length;
            this.doUndo();
            return { undone: before - this.undo.length, label: null, foundCheckpoint: false };
        }
        let undone = 0;
        let label = null;
        while (this.undo.length) {
            const top = this.undo[this.undo.length - 1];
            if (top._checkpoint && !(atCheckpoint && undone === 0)) { label = top._checkpoint; break; }
            const before = this.undo.length;
            this.doUndo();
            if (this.undo.length >= before) break;   // refused — no progress
            undone++;
        }
        return { undone, label, foundCheckpoint: true };
    }

    _afterEdit(cmd = null) {
        // Bump the shared edit generation: the section-coverage, chord-display
        // and drum-lint memos all key on it. An in-place note-time move keeps
        // the notes array's identity and length, so their cheap cache keys
        // can't see it — this bump is what forces a recompute.
        bumpEditGen();
        // Editor-only preference commands (for example tempo anchor locks)
        // belong in Undo but are not serialized into the pack. They still
        // invalidate proposal caches, but must not create a false Save prompt.
        if (!(cmd && cmd.sessionNeutral)) markSessionDirty();
        // Record what just happened, so the Revert button and the last-action
        // readout can name it. The label names the TOP OF THE UNDO STACK — the
        // action a Revert would undo — not the command that just ran: after a
        // doUndo that command is on the redo stack and is no longer a Revert
        // target, so naming it would advertise a button that would only redo.
        // A zero-delta no-op (exec() returned early) never reaches here, so a
        // stale label can't survive a no-op call.
        S.lastAction = this.undo.length
            ? _commandLabelPure(this.undo[this.undo.length - 1])
            : '';
        // Keep the keys viewport in sync with the current note range so
        // multi-octave authoring works without manual range control.
        // expandOnly=true so adding a note outside the current viewport
        // extends it instead of collapsing to the latest note's octave.
        if (isKeysMode()) updatePianoRange(true);
    }

    _ui() {
        const u = document.getElementById('editor-undo');
        const r = document.getElementById('editor-redo');
        if (u) u.disabled = !this.undo.length;
        if (r) r.disabled = !this.redo.length;
        // The Revert button and the last-action readout: enabled exactly when
        // there is an undoable action to name, and labelled from S.lastAction
        // (set by _afterEdit). A cleared stack (load, reset) blanks both.
        const rev = document.getElementById('editor-revert');
        const lab = document.getElementById('editor-last-action');
        const have = !!this.undo.length;
        if (rev) {
            rev.disabled = !have;
            rev.title = have
                ? `Revert the last action (${S.lastAction || 'this edit'}) — undo without guessing which key`
                : 'Nothing to revert';
        }
        if (lab) lab.textContent = have ? (S.lastAction || '') : '';
    }
}
