"""V2 finite-volume solver for quasi-1D compressible Euler with composition.

State vector per cell: q = (ρA, ρuA, EA, ρYA) — dimensional, SI units.
  ρ   : density [kg/m^3]
  u   : velocity [m/s]
  A   : pipe cross-sectional area at cell centre [m^2]
  E   : total energy per unit volume [J/m^3] = ρ·e + 0.5·ρ·u^2
  Y   : burned-gas mass fraction [dimensionless, 0..1]

Primitive vector: w = (ρ, u, p, Y).
"""
