//! HLLC Riemann solver with Einfeldt-Batten wave-speed estimate.
//! Direct port of `solver/hllc.py`.
//!
//! Reference: Toro, "Riemann Solvers and Numerical Methods for Fluid
//! Dynamics", 3rd ed., 2009, Chapter 10.

#[inline]
pub fn prim_to_cons(rho: f64, u: f64, p: f64, y: f64, gamma: f64) -> (f64, f64, f64, f64) {
    let gm1 = gamma - 1.0;
    let big_e = p / gm1 + 0.5 * rho * u * u;
    (rho, rho * u, big_e, rho * y)
}

#[inline]
pub fn cons_to_prim(rho: f64, rho_u: f64, big_e: f64, rho_y: f64, gamma: f64)
    -> (f64, f64, f64, f64)
{
    let gm1 = gamma - 1.0;
    let u = rho_u / rho;
    let p = gm1 * (big_e - 0.5 * rho_u * rho_u / rho);
    let y = rho_y / rho;
    (rho, u, p, y)
}

#[inline]
pub fn euler_flux(rho: f64, u: f64, p: f64, y: f64, gamma: f64) -> (f64, f64, f64, f64) {
    let gm1 = gamma - 1.0;
    let big_e = p / gm1 + 0.5 * rho * u * u;
    (
        rho * u,
        rho * u * u + p,
        (big_e + p) * u,
        rho * u * y,
    )
}

/// HLLC numerical flux from L/R primitive states.
#[allow(clippy::too_many_arguments)]
pub fn hllc_flux(
    rho_l: f64, u_l: f64, p_l: f64, y_l: f64,
    rho_r: f64, u_r: f64, p_r: f64, y_r: f64,
    gamma: f64,
) -> (f64, f64, f64, f64) {
    let gm1 = gamma - 1.0;

    let a_l = (gamma * p_l / rho_l).sqrt();
    let a_r = (gamma * p_r / rho_r).sqrt();

    let h_l = gamma * p_l / (gm1 * rho_l) + 0.5 * u_l * u_l;
    let h_r = gamma * p_r / (gm1 * rho_r) + 0.5 * u_r * u_r;
    let sqrt_l = rho_l.sqrt();
    let sqrt_r = rho_r.sqrt();
    let denom = sqrt_l + sqrt_r;
    let u_roe = (sqrt_l * u_l + sqrt_r * u_r) / denom;
    let h_roe = (sqrt_l * h_l + sqrt_r * h_r) / denom;
    let mut a_roe_sq = gm1 * (h_roe - 0.5 * u_roe * u_roe);
    if a_roe_sq < 0.0 {
        a_roe_sq = 0.0;
    }
    let a_roe = a_roe_sq.sqrt();

    let s_l = (u_l - a_l).min(u_roe - a_roe);
    let s_r = (u_r + a_r).max(u_roe + a_roe);

    let big_e_l = p_l / gm1 + 0.5 * rho_l * u_l * u_l;
    let big_e_r = p_r / gm1 + 0.5 * rho_r * u_r * u_r;
    let fl0 = rho_l * u_l;
    let fl1 = rho_l * u_l * u_l + p_l;
    let fl2 = (big_e_l + p_l) * u_l;
    let fl3 = rho_l * u_l * y_l;
    let fr0 = rho_r * u_r;
    let fr1 = rho_r * u_r * u_r + p_r;
    let fr2 = (big_e_r + p_r) * u_r;
    let fr3 = rho_r * u_r * y_r;

    if s_l >= 0.0 {
        return (fl0, fl1, fl2, fl3);
    }
    if s_r <= 0.0 {
        return (fr0, fr1, fr2, fr3);
    }

    let s_star_num = p_r - p_l + rho_l * u_l * (s_l - u_l) - rho_r * u_r * (s_r - u_r);
    let s_star_den = rho_l * (s_l - u_l) - rho_r * (s_r - u_r);
    let s_star = s_star_num / s_star_den;

    if s_star >= 0.0 {
        let coef = rho_l * (s_l - u_l) / (s_l - s_star);
        let u_star_0 = coef;
        let u_star_1 = coef * s_star;
        let u_star_2 = coef * (big_e_l / rho_l
            + (s_star - u_l) * (s_star + p_l / (rho_l * (s_l - u_l))));
        let u_star_3 = coef * y_l;
        let ul0 = rho_l;
        let ul1 = rho_l * u_l;
        let ul2 = big_e_l;
        let ul3 = rho_l * y_l;
        (
            fl0 + s_l * (u_star_0 - ul0),
            fl1 + s_l * (u_star_1 - ul1),
            fl2 + s_l * (u_star_2 - ul2),
            fl3 + s_l * (u_star_3 - ul3),
        )
    } else {
        let coef = rho_r * (s_r - u_r) / (s_r - s_star);
        let u_star_0 = coef;
        let u_star_1 = coef * s_star;
        let u_star_2 = coef * (big_e_r / rho_r
            + (s_star - u_r) * (s_star + p_r / (rho_r * (s_r - u_r))));
        let u_star_3 = coef * y_r;
        let ur0 = rho_r;
        let ur1 = rho_r * u_r;
        let ur2 = big_e_r;
        let ur3 = rho_r * y_r;
        (
            fr0 + s_r * (u_star_0 - ur0),
            fr1 + s_r * (u_star_1 - ur1),
            fr2 + s_r * (u_star_2 - ur2),
            fr3 + s_r * (u_star_3 - ur3),
        )
    }
}
