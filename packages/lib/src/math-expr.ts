/* Math-channel expression engine.
 *
 * Grammar (precedence low → high):
 *   expr     = ternary
 *   ternary  = or ('?' expr ':' expr)?
 *   or       = and ('||' and)*
 *   and      = not ('&&' not)*
 *   not      = '!' not | cmp
 *   cmp      = sum (('<'|'>'|'<='|'>='|'=='|'!=') sum)?
 *   sum      = product (('+'|'-') product)*
 *   product  = power (('*'|'/'|'%') power)*
 *   power    = unary ('^' power)?
 *   unary    = '-' unary | atom
 *   atom     = NUMBER | IDENT | '[' BRACKETED ']' | IDENT '(' args? ')' | '(' expr ')'
 *
 * Identifiers may contain dots (`engine.rpm`); bracketed identifiers `[Engine Speed]`
 * accept any non-`]` character including spaces.
 *
 * Built-in functions: abs, sqrt, sin, cos, tan, asin, acos, atan, atan2,
 * min, max, pow, exp, log, log10, ln, floor, ceil, round, sign.
 * Built-in constants: pi, e.
 */

export type Ast =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "neg"; arg: Ast }
  | { kind: "not"; arg: Ast }
  | { kind: "binop"; op: BinOp; lhs: Ast; rhs: Ast }
  | { kind: "ternary"; cond: Ast; then: Ast; else: Ast }
  | { kind: "call"; name: string; args: Ast[] };

export type BinOp =
  | "+" | "-" | "*" | "/" | "%" | "^"
  | "<" | ">" | "<=" | ">=" | "==" | "!="
  | "&&" | "||";

export interface ParseResult {
  ast?: Ast;
  error?: string;
  /** Identifier names referenced by the expression (channels needed). */
  refs: string[];
}

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  abs:    ([x]) => Math.abs(x!),
  sqrt:   ([x]) => Math.sqrt(x!),
  sin:    ([x]) => Math.sin(x!),
  cos:    ([x]) => Math.cos(x!),
  tan:    ([x]) => Math.tan(x!),
  asin:   ([x]) => Math.asin(x!),
  acos:   ([x]) => Math.acos(x!),
  atan:   ([x]) => Math.atan(x!),
  atan2:  ([y, x]) => Math.atan2(y!, x!),
  min:    (xs) => Math.min(...xs),
  max:    (xs) => Math.max(...xs),
  pow:    ([b, e]) => Math.pow(b!, e!),
  exp:    ([x]) => Math.exp(x!),
  log:    ([x]) => Math.log(x!),
  ln:     ([x]) => Math.log(x!),
  log10:  ([x]) => Math.log10(x!),
  floor:  ([x]) => Math.floor(x!),
  ceil:   ([x]) => Math.ceil(x!),
  round:  ([x]) => Math.round(x!),
  sign:   ([x]) => Math.sign(x!),
};

/** Parse an expression. On success returns `ast` and the set of identifiers
 *  it references (constants and function names excluded). On failure returns
 *  `error` describing the syntax issue. */
export function parseExpr(src: string): ParseResult {
  const tokens = tokenize(src);
  if (tokens.kind === "err") return { error: tokens.message, refs: [] };
  const p = new Parser(tokens.tokens);
  try {
    const ast = p.parseExpr();
    if (!p.atEnd()) {
      return { error: `unexpected token after expression: ${p.peek()?.text}`, refs: [] };
    }
    return { ast, refs: collectRefs(ast) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), refs: [] };
  }
}

/** Evaluate an AST with a per-name resolver. Resolver returns NaN/undefined
 *  for unknown identifiers; the evaluator coerces those to NaN so a single
 *  bad sample doesn't kill the whole channel. */
export function evalAst(ast: Ast, resolve: (name: string) => number | undefined): number {
  switch (ast.kind) {
    case "num":   return ast.value;
    case "ident": {
      const c = CONSTANTS[ast.name];
      if (c !== undefined) return c;
      const v = resolve(ast.name);
      return v === undefined ? NaN : v;
    }
    case "neg":   return -evalAst(ast.arg, resolve);
    case "not":   return evalAst(ast.arg, resolve) ? 0 : 1;
    case "binop": return evalBin(ast.op, evalAst(ast.lhs, resolve), evalAst(ast.rhs, resolve));
    case "ternary":
      return evalAst(ast.cond, resolve) ? evalAst(ast.then, resolve) : evalAst(ast.else, resolve);
    case "call": {
      const fn = FUNCTIONS[ast.name];
      if (!fn) return NaN;
      return fn(ast.args.map((a) => evalAst(a, resolve)));
    }
  }
}

function evalBin(op: BinOp, l: number, r: number): number {
  switch (op) {
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    case "/": return l / r;
    case "%": return l % r;
    case "^": return Math.pow(l, r);
    case "<": return l < r ? 1 : 0;
    case ">": return l > r ? 1 : 0;
    case "<=": return l <= r ? 1 : 0;
    case ">=": return l >= r ? 1 : 0;
    case "==": return l === r ? 1 : 0;
    case "!=": return l !== r ? 1 : 0;
    case "&&": return (l && r) ? 1 : 0;
    case "||": return (l || r) ? 1 : 0;
  }
}

/** Walk an AST and return the set of identifier names. Constants and
 *  function names are excluded. */
function collectRefs(ast: Ast, out = new Set<string>()): string[] {
  switch (ast.kind) {
    case "num": break;
    case "ident": if (CONSTANTS[ast.name] === undefined) out.add(ast.name); break;
    case "neg": collectRefs(ast.arg, out); break;
    case "not": collectRefs(ast.arg, out); break;
    case "binop": collectRefs(ast.lhs, out); collectRefs(ast.rhs, out); break;
    case "ternary": collectRefs(ast.cond, out); collectRefs(ast.then, out); collectRefs(ast.else, out); break;
    case "call": for (const a of ast.args) collectRefs(a, out); break;
  }
  return [...out];
}

// ─── tokenizer ──────────────────────────────────────────────────────────────

interface Token { kind: TokenKind; text: string; pos: number; }
type TokenKind =
  | "num" | "ident" | "lparen" | "rparen" | "comma" | "lbracket" | "rbracket"
  | "op" | "ternary_q" | "ternary_c";

type TokenizeResult =
  | { kind: "ok"; tokens: Token[] }
  | { kind: "err"; message: string };

const MULTI_OPS = ["<=", ">=", "==", "!=", "&&", "||"];
const SINGLE_OPS = "+-*/%^<>!";

function tokenize(src: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c >= "0" && c <= "9" || c === ".") {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      // Optional exponent
      if (j < src.length && (src[j] === "e" || src[j] === "E")) {
        j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      const text = src.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) return { kind: "err", message: `invalid number "${text}" at ${i}` };
      tokens.push({ kind: "num", text, pos: i });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_.]/.test(src[j]!)) j++;
      tokens.push({ kind: "ident", text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === "[") {
      const close = src.indexOf("]", i + 1);
      if (close === -1) return { kind: "err", message: `unterminated [identifier] at ${i}` };
      const name = src.slice(i + 1, close).trim();
      if (!name) return { kind: "err", message: `empty bracketed identifier at ${i}` };
      tokens.push({ kind: "ident", text: name, pos: i });
      i = close + 1;
      continue;
    }
    if (c === "(") { tokens.push({ kind: "lparen", text: "(", pos: i }); i++; continue; }
    if (c === ")") { tokens.push({ kind: "rparen", text: ")", pos: i }); i++; continue; }
    if (c === ",") { tokens.push({ kind: "comma",  text: ",", pos: i }); i++; continue; }
    if (c === "?") { tokens.push({ kind: "ternary_q", text: "?", pos: i }); i++; continue; }
    if (c === ":") { tokens.push({ kind: "ternary_c", text: ":", pos: i }); i++; continue; }
    // Multi-char operators first
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ kind: "op", text: two, pos: i });
      i += 2;
      continue;
    }
    if (SINGLE_OPS.includes(c)) {
      tokens.push({ kind: "op", text: c, pos: i });
      i++;
      continue;
    }
    return { kind: "err", message: `unexpected character "${c}" at ${i}` };
  }
  return { kind: "ok", tokens };
}

// ─── parser ─────────────────────────────────────────────────────────────────

class Parser {
  #tokens: Token[];
  #pos = 0;
  constructor(tokens: Token[]) { this.#tokens = tokens; }

  peek(): Token | undefined { return this.#tokens[this.#pos]; }
  atEnd(): boolean { return this.#pos >= this.#tokens.length; }
  advance(): Token { return this.#tokens[this.#pos++]!; }

  expect(kind: TokenKind, text?: string): Token {
    const t = this.peek();
    if (!t || t.kind !== kind || (text !== undefined && t.text !== text)) {
      throw new Error(`expected ${text ?? kind}, got ${t ? t.text : "<end>"}`);
    }
    return this.advance();
  }

  matchOp(...ops: string[]): Token | null {
    const t = this.peek();
    if (t && t.kind === "op" && ops.includes(t.text)) { this.#pos++; return t; }
    return null;
  }

  parseExpr(): Ast { return this.parseTernary(); }

  parseTernary(): Ast {
    const cond = this.parseOr();
    if (this.peek()?.kind === "ternary_q") {
      this.advance();
      const thenE = this.parseExpr();
      this.expect("ternary_c");
      const elseE = this.parseExpr();
      return { kind: "ternary", cond, then: thenE, else: elseE };
    }
    return cond;
  }

  parseOr(): Ast {
    let lhs = this.parseAnd();
    while (this.matchOp("||")) lhs = { kind: "binop", op: "||", lhs, rhs: this.parseAnd() };
    return lhs;
  }

  parseAnd(): Ast {
    let lhs = this.parseNot();
    while (this.matchOp("&&")) lhs = { kind: "binop", op: "&&", lhs, rhs: this.parseNot() };
    return lhs;
  }

  parseNot(): Ast {
    if (this.matchOp("!")) return { kind: "not", arg: this.parseNot() };
    return this.parseCmp();
  }

  parseCmp(): Ast {
    const lhs = this.parseSum();
    const t = this.matchOp("<", ">", "<=", ">=", "==", "!=");
    if (t) return { kind: "binop", op: t.text as BinOp, lhs, rhs: this.parseSum() };
    return lhs;
  }

  parseSum(): Ast {
    let lhs = this.parseProduct();
    let t;
    while ((t = this.matchOp("+", "-"))) {
      lhs = { kind: "binop", op: t.text as BinOp, lhs, rhs: this.parseProduct() };
    }
    return lhs;
  }

  parseProduct(): Ast {
    let lhs = this.parsePower();
    let t;
    while ((t = this.matchOp("*", "/", "%"))) {
      lhs = { kind: "binop", op: t.text as BinOp, lhs, rhs: this.parsePower() };
    }
    return lhs;
  }

  parsePower(): Ast {
    const lhs = this.parseUnary();
    // right-associative
    if (this.matchOp("^")) return { kind: "binop", op: "^", lhs, rhs: this.parsePower() };
    return lhs;
  }

  parseUnary(): Ast {
    if (this.matchOp("-")) return { kind: "neg", arg: this.parseUnary() };
    if (this.matchOp("+")) return this.parseUnary();
    return this.parseAtom();
  }

  parseAtom(): Ast {
    const t = this.peek();
    if (!t) throw new Error("unexpected end of expression");
    if (t.kind === "num") {
      this.advance();
      return { kind: "num", value: Number(t.text) };
    }
    if (t.kind === "ident") {
      this.advance();
      // Function call?
      if (this.peek()?.kind === "lparen") {
        this.advance();
        const args: Ast[] = [];
        if (this.peek()?.kind !== "rparen") {
          args.push(this.parseExpr());
          while (this.peek()?.kind === "comma") {
            this.advance();
            args.push(this.parseExpr());
          }
        }
        this.expect("rparen");
        return { kind: "call", name: t.text, args };
      }
      return { kind: "ident", name: t.text };
    }
    if (t.kind === "lparen") {
      this.advance();
      const e = this.parseExpr();
      this.expect("rparen");
      return e;
    }
    throw new Error(`unexpected token "${t.text}"`);
  }
}

/** All built-in symbols (constants + functions). Useful for UI hints. */
export const MATH_BUILTINS = {
  constants: Object.keys(CONSTANTS),
  functions: Object.keys(FUNCTIONS),
} as const;
