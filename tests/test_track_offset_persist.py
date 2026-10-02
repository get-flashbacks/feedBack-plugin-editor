"""Backend persistence for the per-track ``offsetSec`` (issue #41, step 1).

``_coerce_track_session`` rebuilds every track field-by-field, so an unknown
field is stripped on the save->build round-trip: without backend support the
offset the editor just saved would silently vanish. These pin that:

* an audio row's ``offsetSec`` is PRESERVED, coerced the same way the frontend
  ``src/region.js`` coerces it (finite seconds), and stamped v4;
* a ZERO offset is OMITTED rather than stored, so untouched packs stay
  byte-identical;
* an ``offsetSec`` on a non-audio row (folder / transcription) is DROPPED —
  only an audio row has a seconds-based placement;
* NaN / Infinity / garbage can never reach manifest.yaml as ``.nan`` / ``.inf``.
"""

import math

import pytest
import yaml

from routes import (
    _coerce_track_offset,
    _coerce_track_session,
)


def test_offset_is_a_finite_float_or_none():
    assert _coerce_track_offset(0.25) == 0.25
    assert _coerce_track_offset(-2) == -2.0
    assert _coerce_track_offset("0.5") == 0.5, "numeric strings coerce"
    assert _coerce_track_offset(0) == 0.0, "an explicit zero is a real zero, not garbage"
    # None is returned (not 0.0) so the caller leaves the key out entirely.
    # bool is in the garbage list because JSON `true` is reachable from the
    # wire and `float(True)` is a cheerful 1.0 — a silent one-second nudge.
    for garbage in (None, "", "abc", {}, [], True, False, float("nan"), float("inf"), -float("inf")):
        assert _coerce_track_offset(garbage) is None, garbage


def test_offset_is_rounded_to_the_microsecond():
    # Keeps manifest.yaml stable: 1.2345678 must not write a differing literal
    # on every save.
    assert _coerce_track_offset(1.2345678) == 1.234568
    assert _coerce_track_offset(-0.0000004) == 0.0


def test_offset_overflowing_float_is_dropped():
    # `float("1e400")` is inf, not an OverflowError, and isfinite is the only
    # thing standing between it and manifest.yaml.
    assert _coerce_track_offset(1e400) is None
    assert _coerce_track_offset(-1e400) is None
    assert _coerce_track_offset("1e400") is None
    assert _coerce_track_offset(float("nan")) is None


def test_offset_tolerates_surrounding_whitespace():
    assert _coerce_track_offset(" 0.5 ") == 0.5
    assert _coerce_track_offset("\t-1.25\n") == -1.25


def test_session_preserves_an_audio_offset_and_bumps_version():
    session = _coerce_track_session({
        "tracks": [
            {"id": "audio:master", "type": "audio", "sourceId": "master", "offsetSec": -0.25},
            {"id": "audio:Gtr", "type": "audio", "sourceId": "Gtr"},
        ],
    })
    assert session["version"] == 4
    master, gtr = session["tracks"]
    assert master["offsetSec"] == -0.25, "a per-track offset survives the round-trip"
    assert "offsetSec" not in gtr, "an unshifted track leaves no residue"


def test_session_drops_an_offset_of_magnitude_nan_or_inf():
    for bad in (float("nan"), float("inf"), -float("inf")):
        session = _coerce_track_session({
            "tracks": [{"id": "audio:master", "type": "audio", "sourceId": "master",
                        "offsetSec": bad}],
        })
        assert "offsetSec" not in session["tracks"][0], bad


def test_an_oversized_offset_that_still_loads_cannot_produce_an_infinite_placement():
    # A value finite enough to persist but large enough that three of them would
    # overflow: the CLIENT sum (src/region.js `_trackPlacementPure`) is what must
    # stay finite, and it finite-checks the sum, not just each term.
    big = 1e308
    assert _coerce_track_offset(big) == big          # persists
    assert not math.isfinite(big + big)               # …and would overflow a naive sum


def test_zero_offset_is_omitted_so_untouched_packs_stay_byte_identical():
    session = _coerce_track_session({
        "tracks": [
            {"id": "audio:master", "type": "audio", "sourceId": "master", "offsetSec": 0},
            {"id": "audio:Gtr", "type": "audio", "sourceId": "Gtr", "offsetSec": "0"},
            {"id": "audio:Bass", "type": "audio", "sourceId": "Bass", "offsetSec": -0.0},
        ],
    })
    assert all("offsetSec" not in track for track in session["tracks"]), \
        "zero is the implicit default and must not be written"


def test_non_audio_rows_never_carry_an_offset():
    # A folder has no timeline of its own; a transcription row places its content
    # through `regions[]`. Persisting an offset there would store a value no
    # placement site reads — a silently ignored field that reads back as lost.
    session = _coerce_track_session({
        "tracks": [
            {"id": "folder:1", "type": "folder", "offsetSec": 5},
            {"id": "notes:Gtr", "type": "transcription", "targetId": "Gtr", "offsetSec": 5},
        ],
    })
    assert all("offsetSec" not in track for track in session["tracks"])


@pytest.mark.parametrize("garbage", ["NaN", "Infinity", "-Infinity", "abc", None, {}])
def test_non_finite_offsets_never_reach_the_manifest(garbage):
    # `float("nan")` and `float("inf")` both succeed AND are truthy, so a plain
    # `value or 0` guard would let them through into YAML as `.nan` / `.inf` and
    # poison every placement derived from the stored tree. This is the boundary
    # test for that.
    session = _coerce_track_session({
        "tracks": [{"id": "audio:master", "type": "audio", "sourceId": "master",
                    "offsetSec": garbage}],
    })
    assert "offsetSec" not in session["tracks"][0], garbage


def test_audio_offset_round_trips_through_manifest_yaml():
    session = _coerce_track_session({
        "tracks": [
            {"id": "audio:master", "type": "audio", "sourceId": "master", "offsetSec": -0.125,
             "regions": [{"id": "r1", "startBeat": 8, "lenBeat": 8}]},
            {"id": "audio:Gtr", "type": "audio", "sourceId": "Gtr", "offsetSec": 0.25},
        ],
    })
    dumped = yaml.safe_dump(session, sort_keys=False, allow_unicode=True)
    assert ".nan" not in dumped and ".inf" not in dumped

    loaded = yaml.safe_load(dumped)
    again = _coerce_track_session(loaded)
    assert again == session, "coerce -> YAML -> coerce is a fixed point"
    assert [t.get("offsetSec") for t in again["tracks"]] == [-0.125, 0.25]


def test_offset_and_regions_coexist_on_one_row():
    # The two per-track placement fields are independent axes: `regions` says
    # WHICH window of media plays where, `offsetSec` slides the whole track. Both
    # must survive together, each unchanged.
    session = _coerce_track_session({
        "tracks": [{"id": "audio:master", "type": "audio", "sourceId": "master",
                    "offsetSec": 0.5,
                    "regions": [{"id": "r1", "startBeat": 8, "lenBeat": 8, "name": "Chorus"}]}],
    })
    [track] = session["tracks"]
    assert track["offsetSec"] == 0.5
    assert track["regions"] == [{"id": "r1", "startBeat": 8.0, "lenBeat": 8.0, "name": "Chorus"}]


def test_offset_does_not_disturb_the_track_offset_coercion_contract():
    # Sanity: a stored offset survives its own isfinite guard (the bug this
    # guards against is the opposite direction — a value that PASSES the coerce
    # here and then cannot be re-read).
    for value in (-1.5, -0.001, 0.001, 12.75):
        assert math.isfinite(_coerce_track_offset(value))
        assert _coerce_track_offset(value) == value