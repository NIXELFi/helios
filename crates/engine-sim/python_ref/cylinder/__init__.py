"""Cylinder and gas-phase physics for V2 — ported from V1 with source headers.

All gas property evaluations are @njit free functions so they can be called
from both the Python-level cylinder integrator and from @njit BC kernels
(the valve ghost-cell fill in particular hits γ(T, xb) and R(xb) every step).

No OO wrappers around gas-property calls in the hot path.
"""
