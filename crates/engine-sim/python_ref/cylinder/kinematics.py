"""Crank-angle kinematics utilities.

Source: 1d/engine_simulator/engine/kinematics.py  (read-only V1 file)
Copy date: 2026-04-13

Changes vs V1: none of substance — ported as plain functions; no @njit
required because these are called once per RPM setup, not per step.
"""

from __future__ import annotations

from typing import Dict, List

import numpy as np


def omega_from_rpm(rpm: float) -> float:
    """Angular speed in rad/s."""
    return 2.0 * np.pi * rpm / 60.0


def cylinder_phase_offsets(
    n_cyl: int, firing_order: List[int], firing_interval: float,
) -> Dict[int, float]:
    """Map cylinder number (1-indexed per the firing order) to crank offset
    in degrees. Cylinder 1 has offset 0; subsequent cylinders in the firing
    order are offset by firing_interval · (position in order)."""
    offsets: Dict[int, float] = {}
    for i, cyl_num in enumerate(firing_order):
        offsets[int(cyl_num)] = i * firing_interval
    if n_cyl != len(firing_order):
        # Tolerate inconsistency by defaulting missing cylinders to 0
        for c in range(1, n_cyl + 1):
            offsets.setdefault(c, 0.0)
    return offsets
