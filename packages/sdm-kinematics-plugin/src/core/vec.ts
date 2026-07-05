// Minimal 3-vector math on plain [x,y,z] tuples. The kinematics core is kept
// free of three.js so it can be unit-tested and reused (e.g. a future desktop
// module or a batch CLI) without a renderer in the dependency graph.

export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3): number => norm(sub(a, b));
export const unit = (a: V3): V3 => {
  const n = norm(a);
  return n > 0 ? scale(a, 1 / n) : [0, 0, 0];
};
export const lerp = (a: V3, b: V3, t: number): V3 => add(a, scale(sub(b, a), t));
export const clone = (a: V3): V3 => [a[0], a[1], a[2]];

/** Rotate point `p` about the axis through `origin` with unit direction `axis`
 *  by `angle` radians (Rodrigues). */
export function rotateAboutAxis(p: V3, origin: V3, axis: V3, angle: number): V3 {
  const v = sub(p, origin);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const term1 = scale(v, c);
  const term2 = scale(cross(axis, v), s);
  const term3 = scale(axis, dot(axis, v) * (1 - c));
  return add(origin, add(add(term1, term2), term3));
}

/** Rigid-body transform defined by three non-collinear points moving from a
 *  static to a displaced configuration. Maps any body-fixed point. */
export interface RigidXform {
  apply(q: V3): V3;
  /** Rotate a body-fixed direction (no translation). */
  applyDir(d: V3): V3;
}

export function rigidFromTriad(s1: V3, s2: V3, s3: V3, c1: V3, c2: V3, c3: V3): RigidXform {
  const frame = (p1: V3, p2: V3, p3: V3): [V3, V3, V3] => {
    const e1 = unit(sub(p2, p1));
    const v = sub(p3, p1);
    const e2 = unit(sub(v, scale(e1, dot(v, e1))));
    const e3 = cross(e1, e2);
    return [e1, e2, e3];
  };
  const [a1, a2, a3] = frame(s1, s2, s3);
  const [b1, b2, b3] = frame(c1, c2, c3);
  // R = B · Aᵀ, applied as: coords of (q - s1) in frame A, re-expanded in frame B.
  const apply = (q: V3): V3 => {
    const v = sub(q, s1);
    const u: V3 = [dot(v, a1), dot(v, a2), dot(v, a3)];
    return add(c1, add(add(scale(b1, u[0]), scale(b2, u[1])), scale(b3, u[2])));
  };
  const applyDir = (d: V3): V3 => {
    const u: V3 = [dot(d, a1), dot(d, a2), dot(d, a3)];
    return add(add(scale(b1, u[0]), scale(b2, u[1])), scale(b3, u[2]));
  };
  return { apply, applyDir };
}

/** Solve the dense linear system A·x = b in place (Gaussian elimination with
 *  partial pivoting). A is row-major n×n. Returns null if singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-14) return null;
    if (piv !== col) {
      [A[piv], A[col]] = [A[col], A[piv]];
      [b[piv], b[col]] = [b[col], b[piv]];
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (deg: number): number => (deg * Math.PI) / 180;
