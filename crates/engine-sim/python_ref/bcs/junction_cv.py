"""0D junction control volume — conservative branching for 1D FV pipes.

Reference: Winterbone & Pearson, "Design Techniques for Engine Manifolds"
(1999), constant-pressure junction model (§ 9 "Multi-pipe junctions" in
most editions). Also the standard GT-Power / WAVE "plenum cell" treatment.

A junction CV is a tiny 0D lumped volume that sits between N incident
pipes, holds conserved quantities (M, E, M_Y — mass, total energy,
burned-species mass), and exchanges flux with each pipe through that
pipe's junction-end ghost cell. The CV's state after each step is the
stagnation state of all gas absorbed during that step; each outgoing
pipe then sees the CV's stagnation state as its ghost reservoir.

Conservation is strict by construction: the CV simply sums face fluxes
into itself each step, same as any FV cell. There is no iteration and
no characteristic-based residual; we just read the HLLC flux each pipe
actually delivered and credit/debit the CV accordingly.

Stagnation treatment (Winterbone): the CV carries no bulk velocity.
When gas with non-zero u enters, its kinetic energy is absorbed into
the CV's total energy E. Since u_CV = 0 always, p_CV = (γ-1)·E/V is
the stagnation pressure of the absorbed gas. Directional momentum is
discarded — physically correct for a branching manifold where flows
merge turbulently.

Volume sizing: V_j ≈ max_pipe_area · max_pipe_dx so the CV "looks like"
one more cell in the grid and does not introduce a stiffer CFL. We take
the max instead of the mean so V_j is never smaller than the largest
incident cell and the mass-depletion CFL stays safe.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

import numpy as np

from solver.state import PipeState, I_RHO_A, I_MOM_A, I_E_A, I_Y_A


LEFT = "left"
RIGHT = "right"


@dataclass
class JunctionCVLeg:
    pipe: PipeState
    end: str  # "left" or "right"

    @property
    def face_index(self) -> int:
        """Index of the junction face in the pipe's flux array."""
        if self.end == LEFT:
            return self.pipe.n_ghost
        return self.pipe.n_ghost + self.pipe.n_cells

    @property
    def sign_into_junction(self) -> float:
        """+1 if the pipe's face flux (rightward positive) points INTO the
        junction — i.e., the junction is to the pipe's right, so pipe's
        right-end flux goes into junction.
        -1 if the junction is to the pipe's left (pipe's left-end flux
        rightward means mass moves FROM junction INTO pipe, so into-junction
        is the negative of that).
        """
        return +1.0 if self.end == RIGHT else -1.0


@dataclass
class JunctionCV:
    """Control volume for a 1D pipe junction.

    State: M (kg), E (J), M_Y (kg of burned gas).
    All are totals for the CV, not densities.
    """
    V: float                                    # m³
    M: float                                    # kg
    E: float                                    # J
    M_Y: float                                  # kg
    gamma: float = 1.4
    R_gas: float = 287.0
    legs: List[JunctionCVLeg] = field(default_factory=list)

    # Diagnostics
    last_p: float = 101325.0
    last_T: float = 300.0

    @classmethod
    def from_legs(
        cls, legs: List[JunctionCVLeg],
        p_init: float = 101325.0, T_init: float = 300.0, Y_init: float = 0.0,
        gamma: float = 1.4, R_gas: float = 287.0, volume_factor: float = 1.0,
    ) -> "JunctionCV":
        """Construct a CV sized at V ≈ max(A_i · dx_i) · volume_factor."""
        V_j = 0.0
        for leg in legs:
            A_end = leg.pipe.area[leg.face_index]
            V_candidate = A_end * leg.pipe.dx
            if V_candidate > V_j:
                V_j = V_candidate
        V_j *= volume_factor
        rho = p_init / (R_gas * T_init)
        M = rho * V_j
        E = (p_init / (gamma - 1.0)) * V_j  # u=0 so no KE
        M_Y = rho * Y_init * V_j
        return cls(
            V=V_j, M=M, E=E, M_Y=M_Y, gamma=gamma, R_gas=R_gas, legs=legs,
            last_p=p_init, last_T=T_init,
        )

    # ---- derived properties -------------------------------------------

    def rho(self) -> float:
        return self.M / self.V

    def p(self) -> float:
        # Stagnation: u_CV = 0 so all of E/V is internal energy density.
        return (self.gamma - 1.0) * (self.E / self.V)

    def T(self) -> float:
        return self.p() / (self.R_gas * self.rho())

    def Y(self) -> float:
        return self.M_Y / self.M if self.M > 1e-20 else 0.0

    # ---- BC: fill each leg's pipe-end ghost cells with our stagnation state ----

    def fill_ghosts(self, dt: float = 0.0) -> None:
        """Called BEFORE the pipe MUSCL step. Sets each pipe's junction-end
        ghost cells to the CV's stagnation reservoir state.

        ``dt`` parameter is ignored for the stagnation-CV junction; it is
        accepted for signature compatibility with CharacteristicJunction
        so callers can swap junction types without changing their
        step-loop code.
        """
        rho = self.rho()
        p = self.p()
        Y = self.Y()
        gm1 = self.gamma - 1.0
        E_density = p / gm1  # u_ghost = 0

        self.last_p = p
        self.last_T = self.T()

        for leg in self.legs:
            pipe = leg.pipe
            ng = pipe.n_ghost
            nc = pipe.n_cells
            if leg.end == LEFT:
                indices = range(0, ng)
            else:
                indices = range(ng + nc, pipe.n_total)
            for i in indices:
                A = pipe.area[i]
                pipe.q[i, I_RHO_A] = rho * A
                pipe.q[i, I_MOM_A] = 0.0
                pipe.q[i, I_E_A]   = E_density * A
                pipe.q[i, I_Y_A]   = rho * Y * A

    # ---- absorb fluxes after pipe advance ------------------------------

    def absorb_fluxes(self, dt: float) -> None:
        """Called AFTER the pipe MUSCL step. Each leg's pipe has a `_scratch`
        attribute (set by the engine model's _ensure_scratch) containing the
        flux array computed during the MUSCL step. We sum those fluxes
        (signed) into the CV's M, E, M_Y. Momentum flux is discarded — the
        CV is stagnation and absorbs any incoming KE via the energy flux.
        """
        for leg in self.legs:
            s = leg.sign_into_junction
            j = leg.face_index
            F = leg.pipe._scratch["flux"][j]  # (F_mass, F_mom, F_energy, F_comp) with A_face baked in
            self.M   += dt * s * F[0]
            self.E   += dt * s * F[2]
            self.M_Y += dt * s * F[3]

        # Positivity clamps: if the CV is draining too fast (shouldn't happen
        # with sane V_j sizing and CFL) we prevent non-physical negatives.
        if self.M < 1e-20:
            self.M = 1e-20
        if self.M_Y < 0.0:
            self.M_Y = 0.0
        if self.M_Y > self.M:
            self.M_Y = self.M
        if self.E < 1e-20:
            self.E = 1e-20
