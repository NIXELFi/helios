// Hardpoint optimizer — OptimumK-style studies, improved:
//   · any number of parameters (output channels), each with a target that is
//     either a CONSTANT or a CURVE (table of sweep-position → value, linearly
//     interpolated) and a study weight,
//   · per-point opt-in with mutation bounds: a BOX (±x/±y/±z around the seed)
//     or, for the actuation points, the ACTUATION PLANE — the plane through
//     the pushrod's non-suspended-mass attachment (NSMA_PPAttPnt), the rocker
//     pivot (CHAS_RocPiv) and the chassis shock eye (CHAS_AttPnt). Plane-
//     constrained points mutate in a ±u/±v patch inside that plane,
//   · elitist evolutionary search with tournament selection, blend crossover
//     and gaussian mutation, seeded RNG for reproducible studies, chunked so
//     the UI stays live and the run is cancellable.

import { type V3, add, sub, scale, dot, cross, unit } from "./vec";
import type { AxleGeometry, CarSetup } from "./model";
import { runSweep, channelDefs, type SweepSpec, type EvalOpts, type ChannelDef } from "./sweep";

export interface CurvePoint { x: number; y: number }

export type TargetSpec =
  | { kind: "const"; value: number }
  | { kind: "curve"; table: CurvePoint[] };

export interface OptParameter {
  channelKey: string;
  motion: SweepSpec;
  target: TargetSpec;
  weight: number;
}

export type AxleId = "front" | "rear";
export type ConstraintKind = "box" | "plane";

/** The six actuation points eligible for the actuation-plane constraint. */
export const ACTUATION_KEYS: (keyof AxleGeometry)[] = [
  "pushLower", "pushUpper", "rockerAxis1", "rockerAxis2", "shockRocker", "shockChassis",
];

export interface PointOpt {
  axle: AxleId;
  key: keyof AxleGeometry;
  enabled: boolean;
  kind: ConstraintKind;
  /** Box: ±x/±y/±z (in). Plane: ext[0]=±u, ext[1]=±v (in-plane, in). */
  ext: [number, number, number];
}

export interface OptimizerConfig {
  points: PointOpt[];
  params: OptParameter[];
  population: number;
  generations: number;
  rngSeed: number;
}

export interface OptProgress {
  generation: number;
  generations: number;
  bestObjective: number;
  seedObjective: number;
  history: number[];
  evals: number;
}

export interface ParamScore { seedErr: number; bestErr: number }

export interface OptResult {
  bestCar: CarSetup;
  bestObjective: number;
  seedObjective: number;
  perParam: ParamScore[];
  history: number[];
  config: OptimizerConfig;
  seedCar: CarSetup;
}

const PENALTY = 1e9;

/** Actuation plane for an axle, from SEED geometry (fixed during a run):
 *  origin at the pushrod NSMA attachment, spanned toward the rocker pivot
 *  and the chassis shock eye. */
export function actuationPlane(g: AxleGeometry): { origin: V3; e1: V3; e2: V3; n: V3 } {
  const a = g.pushLower; // NSMA_PPAttPnt — outboard, on the control arm
  const b = g.rockerAxis2; // CHAS_RocPiv
  const c = g.shockChassis; // CHAS_AttPnt
  const e1 = unit(sub(b, a));
  const n = unit(cross(sub(b, a), sub(c, a)));
  const e2 = cross(n, e1);
  return { origin: a, e1, e2, n };
}

export function projectToPlane(p: V3, pl: { origin: V3; n: V3 }): V3 {
  return sub(p, scale(pl.n, dot(sub(p, pl.origin), pl.n)));
}

/** Piecewise-linear interpolation, clamped at the table ends. */
export function interpCurve(table: CurvePoint[], x: number): number {
  const t = [...table].sort((a, b) => a.x - b.x);
  if (t.length === 0) return 0;
  if (x <= t[0].x) return t[0].y;
  if (x >= t[t.length - 1].x) return t[t.length - 1].y;
  for (let i = 1; i < t.length; i++) {
    if (x <= t[i].x) {
      const f = (x - t[i - 1].x) / (t[i].x - t[i - 1].x || 1e-12);
      return t[i - 1].y + f * (t[i].y - t[i - 1].y);
    }
  }
  return t[t.length - 1].y;
}

/** Deterministic RNG (mulberry32) so studies are reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Genome ⇄ CarSetup
// ---------------------------------------------------------------------------

interface Gene {
  point: PointOpt;
  /** Number of scalars: 3 for box, 2 for plane. */
  dims: number;
  bounds: number[]; // per-dim half-extent
  /** Plane frame (plane-constrained genes only). */
  plane?: { origin: V3; e1: V3; e2: V3; n: V3 };
  /** Seed position (box) or seed projected into the plane (plane). */
  seed: V3;
}

function buildGenes(seedCar: CarSetup, points: PointOpt[]): Gene[] {
  const genes: Gene[] = [];
  const planes = {
    front: actuationPlane(seedCar.front),
    rear: actuationPlane(seedCar.rear),
  };
  for (const p of points) {
    if (!p.enabled) continue;
    const seedPos = seedCar[p.axle][p.key] as V3;
    if (p.kind === "plane") {
      const pl = planes[p.axle];
      genes.push({
        point: p, dims: 2,
        bounds: [Math.abs(p.ext[0]), Math.abs(p.ext[1])],
        plane: pl,
        seed: projectToPlane(seedPos, pl),
      });
    } else {
      genes.push({
        point: p, dims: 3,
        bounds: [Math.abs(p.ext[0]), Math.abs(p.ext[1]), Math.abs(p.ext[2])],
        seed: [...seedPos] as V3,
      });
    }
  }
  return genes;
}

function genomeLength(genes: Gene[]): number {
  return genes.reduce((s, g) => s + g.dims, 0);
}

function decode(seedCar: CarSetup, genes: Gene[], genome: number[]): CarSetup {
  const car: CarSetup = {
    ...seedCar,
    front: { ...seedCar.front },
    rear: { ...seedCar.rear },
    params: { ...seedCar.params },
  };
  let i = 0;
  for (const g of genes) {
    let pos: V3;
    if (g.plane) {
      const u = genome[i], v = genome[i + 1];
      pos = add(g.seed, add(scale(g.plane.e1, u), scale(g.plane.e2, v)));
    } else {
      pos = [g.seed[0] + genome[i], g.seed[1] + genome[i + 1], g.seed[2] + genome[i + 2]];
    }
    (car[g.point.axle][g.point.key] as V3) = pos;
    i += g.dims;
  }
  return car;
}

// ---------------------------------------------------------------------------
// Objective
// ---------------------------------------------------------------------------

function needsFor(keys: string[]): EvalOpts {
  const axleKeys = /^(rc_|anti_|bump_steer|camber_gain|arb_twist_ratio|arb_mr|arb_ir)/;
  // anti_pitch weights the two axles by ride rate, so it needs wheel rates.
  const cornerKeys = /^(install_ratio|wheel_rate|total_travel|bump_travel|anti_pitch)/;
  return {
    axleProbes: keys.some((k) => axleKeys.test(k)),
    cornerProbes: keys.some((k) => cornerKeys.test(k)),
  };
}

interface MotionGroup {
  motion: SweepSpec;
  params: { p: OptParameter; def: ChannelDef; idx: number }[];
  opts: EvalOpts;
}

function groupByMotion(params: OptParameter[]): MotionGroup[] {
  const defs = channelDefs();
  const map = new Map<string, MotionGroup>();
  params.forEach((p, idx) => {
    const def = defs.find((d) => d.key === p.channelKey);
    if (!def) return;
    const k = `${p.motion.type}|${p.motion.range}|${p.motion.steps}`;
    let g = map.get(k);
    if (!g) {
      g = { motion: p.motion, params: [], opts: {} };
      map.set(k, g);
    }
    g.params.push({ p, def, idx });
  });
  for (const g of map.values()) g.opts = needsFor(g.params.map((x) => x.p.channelKey));
  return [...map.values()];
}

/** Weighted objective + per-parameter RMS errors for one candidate. */
export function evaluate(car: CarSetup, params: OptParameter[]): { objective: number; perParam: number[] } {
  const groups = groupByMotion(params);
  const perParam = new Array<number>(params.length).fill(NaN);
  let objective = 0;
  for (const grp of groups) {
    let res;
    try {
      res = runSweep(car, grp.motion, grp.opts);
    } catch {
      return { objective: PENALTY, perParam };
    }
    // A candidate whose geometry can't assemble anywhere in the motion is out.
    for (const st of res.states) {
      for (const id of ["FL", "FR", "RL", "RR"] as const) {
        if (!st.corners[id].ok) return { objective: PENALTY, perParam };
      }
    }
    for (const { p, idx } of grp.params) {
      const series = res.series.get(p.channelKey);
      if (!series) { perParam[idx] = NaN; continue; }
      let sum = 0, n = 0;
      for (let i = 0; i < res.values.length; i++) {
        const v = series[i];
        if (!Number.isFinite(v)) continue;
        const t = p.target.kind === "const" ? p.target.value : interpCurve(p.target.table, res.values[i]);
        sum += (v - t) * (v - t);
        n++;
      }
      const rms = n > 0 ? Math.sqrt(sum / n) : PENALTY;
      perParam[idx] = rms;
      objective += p.weight * rms;
    }
  }
  return { objective, perParam };
}

// ---------------------------------------------------------------------------
// Evolutionary loop
// ---------------------------------------------------------------------------

export interface RunHandle {
  cancel(): void;
  done: Promise<OptResult>;
}

export function runOptimizer(
  seedCar: CarSetup,
  config: OptimizerConfig,
  onProgress: (p: OptProgress) => void,
): RunHandle {
  const genes = buildGenes(seedCar, config.points);
  const L = genomeLength(genes);
  if (L === 0) throw new Error("no points enabled for optimization");
  if (config.params.length === 0) throw new Error("no parameters defined");

  const rng = makeRng(config.rngSeed || 1);
  const gauss = () => {
    // Box–Muller
    const u = Math.max(rng(), 1e-12), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const boundAt = (j: number): number => {
    let i = 0;
    for (const g of genes) {
      if (j < i + g.dims) return g.bounds[j - i];
      i += g.dims;
    }
    return 0;
  };
  const clamp = (genome: number[]) => {
    for (let j = 0; j < L; j++) {
      const b = boundAt(j);
      genome[j] = Math.min(b, Math.max(-b, genome[j]));
    }
    return genome;
  };

  const pop: { genome: number[]; fit: number }[] = [];
  const seedGenome = new Array<number>(L).fill(0);
  const seedEval = evaluate(seedCar, config.params);
  let evals = 1;

  pop.push({ genome: seedGenome, fit: seedEval.objective });
  for (let i = 1; i < config.population; i++) {
    const g = new Array<number>(L).fill(0).map((_, j) => (rng() * 2 - 1) * boundAt(j));
    pop.push({ genome: g, fit: NaN });
  }

  let cancelled = false;
  const history: number[] = [];

  const done = new Promise<OptResult>((resolve) => {
    let gen = 0;

    const finish = () => {
      pop.sort((a, b) => a.fit - b.fit);
      const best = pop[0];
      const bestCar = decode(seedCar, genes, best.genome);
      const bestEval = evaluate(bestCar, config.params);
      resolve({
        bestCar,
        bestObjective: best.fit,
        seedObjective: seedEval.objective,
        perParam: config.params.map((_, i) => ({
          seedErr: seedEval.perParam[i],
          bestErr: bestEval.perParam[i],
        })),
        history,
        config,
        seedCar,
      });
    };

    const step = () => {
      if (cancelled) { finish(); return; }
      // Evaluate anything stale.
      for (const ind of pop) {
        if (!Number.isFinite(ind.fit)) {
          ind.fit = evaluate(decode(seedCar, genes, ind.genome), config.params).objective;
          evals++;
        }
      }
      pop.sort((a, b) => a.fit - b.fit);
      history.push(pop[0].fit);
      onProgress({
        generation: gen,
        generations: config.generations,
        bestObjective: pop[0].fit,
        seedObjective: seedEval.objective,
        history: [...history],
        evals,
      });
      if (gen >= config.generations) { finish(); return; }
      gen++;

      // Elites survive; the rest are bred.
      const elite = Math.max(2, Math.floor(config.population * 0.2));
      const next = pop.slice(0, elite).map((e) => ({ genome: [...e.genome], fit: e.fit }));
      const tourney = () => {
        let best = pop[Math.floor(rng() * pop.length)];
        for (let k = 0; k < 2; k++) {
          const c = pop[Math.floor(rng() * pop.length)];
          if (c.fit < best.fit) best = c;
        }
        return best;
      };
      while (next.length < config.population) {
        const a = tourney().genome, b = tourney().genome;
        const child = a.map((av, j) => (rng() < 0.5 ? av : b[j]));
        for (let j = 0; j < L; j++) {
          if (rng() < 0.7) child[j] += gauss() * 0.2 * boundAt(j);
        }
        next.push({ genome: clamp(child), fit: NaN });
      }
      pop.length = 0;
      pop.push(...next);
      setTimeout(step, 0); // yield to the UI between generations
    };
    setTimeout(step, 0);
  });

  return { cancel: () => { cancelled = true; }, done };
}

/** Default point list: every hardpoint on both axles, disabled, box ±0.5",
 *  actuation points defaulting to the plane constraint (±1" in-plane). */
export function defaultPointOpts(): PointOpt[] {
  const keys: (keyof AxleGeometry)[] = [
    "lcaFront", "lcaRear", "lbj", "ucaFront", "ucaRear", "ubj",
    "tieInner", "tieOuter",
    "pushLower", "pushUpper", "rockerAxis1", "rockerAxis2", "shockRocker", "shockChassis",
    "ubarNsma", "ubarArm", "ubarPivot",
  ];
  const out: PointOpt[] = [];
  for (const axle of ["front", "rear"] as AxleId[]) {
    for (const key of keys) {
      const isAct = ACTUATION_KEYS.includes(key);
      out.push({
        axle, key, enabled: false,
        kind: isAct ? "plane" : "box",
        ext: isAct ? [1, 1, 0] : [0.5, 0.5, 0.5],
      });
    }
  }
  return out;
}
