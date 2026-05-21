"""Boundary conditions for V2 — ghost-cell fillers.

All BCs in V2 write ghost cells so that the MUSCL-Hancock reconstruction
and HLLC flux at the boundary face produce the physically correct flux.
This is the unified interface. There is no distinction between
"interior" and "boundary" in the solver update — every face uses HLLC.
"""
