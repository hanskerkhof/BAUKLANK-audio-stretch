# ============================================================
# time_pitch_mapping.py  (BAUKLANK)
#
# Purpose
# -------
# Single Source Of Truth (SSOT) for BAUKLANK Time Pitch topology.
#
# This map defines which encoder fixture talks to which controller fixture
# (and which channel A/B).
#
# Used by:
#   - server-multi.py: enriches controllerStatus with encoder fixture names
#   - generate_time_pitch_mapping_header.py: writes TimePitchMapping.h for
#     the TIME_PITCH_ENCODER firmware.
#
# Edit this file only.
# ============================================================

from __future__ import annotations

from typing import Dict, Iterable, List, Literal, Tuple, TypedDict


Channel = Literal["A", "B"]
ControllerId = str
EncoderId = str


class ControllerChannelMap(TypedDict, total=False):
    """Mapping: channel -> encoder fixture name.

    total=False so controllers can define only A or only B.
    """

    A: EncoderId
    B: EncoderId


# SSOT: controller -> {channel -> encoder}
TimePitchTopology = Dict[ControllerId, ControllerChannelMap]


TIME_PITCH_TOPOLOGY: TimePitchTopology = {
    "BKTP_CTL_01": {"A": "BKTP_ENC_01", "B": "BKTP_ENC_02"},
    "BKTP_CTL_02": {"A": "BKTP_ENC_03", "B": "BKTP_ENC_04"},
    "BKTP_CTL_03": {"A": "BKTP_ENC_05"},
    # Extend freely:
    # "BKTP_CTL_03": {"A": "BKTP_ENC_05", "B": "BKTP_ENC_06"},
}


def iter_encoder_map_entries(topology: TimePitchTopology = TIME_PITCH_TOPOLOGY) -> Iterable[Tuple[EncoderId, ControllerId, Channel]]:
    """Yield flat entries (enc, ctl, channel) suitable for C++ generation."""

    for ctl, channels in topology.items():
        for ch, enc in channels.items():
            # mypy: ch is str at runtime; we validate
            if ch not in ("A", "B"):
                raise ValueError(f"Invalid channel '{ch}' for controller '{ctl}'")
            yield (enc, ctl, ch)  # type: ignore[return-value]


def build_encoder_map_entries_sorted(topology: TimePitchTopology = TIME_PITCH_TOPOLOGY) -> List[Tuple[EncoderId, ControllerId, Channel]]:
    """Deterministic ordering: encoder name, then controller, then channel."""

    entries = list(iter_encoder_map_entries(topology))
    entries.sort(key=lambda t: (t[0], t[1], t[2]))
    return entries


def validate_topology(topology: TimePitchTopology = TIME_PITCH_TOPOLOGY) -> None:
    """Sanity checks to catch mistakes early (run on import)."""

    seen_encoders: set[str] = set()
    for enc, ctl, ch in iter_encoder_map_entries(topology):
        if enc in seen_encoders:
            raise ValueError(f"Encoder '{enc}' appears multiple times in topology")
        seen_encoders.add(enc)
        if not ctl or not enc:
            raise ValueError("Empty controllerId/encoderId in topology")
        if ch not in ("A", "B"):
            raise ValueError(f"Invalid channel '{ch}'")


# Validate at import time so both server and tooling fail fast.
validate_topology(TIME_PITCH_TOPOLOGY)
