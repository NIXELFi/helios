export const MAX_BREADCRUMBS = 50;

export type BreadcrumbCategory = "nav" | "action" | "console" | "error";
export interface Breadcrumb {
  t: string;
  category: BreadcrumbCategory;
  message: string;
  data?: unknown;
}
export interface LastError {
  label?: string;
  message: string;
  componentStack?: string;
  t: string;
}

const buffer: Breadcrumb[] = [];
let lastError: LastError | null = null;

/** Best-effort, never throws. `data` is shallow-stringified + truncated so a
 *  huge or circular object can't bloat the row or crash the recorder. */
export function recordBreadcrumb(category: BreadcrumbCategory, message: string, data?: unknown): void {
  try {
    const entry: Breadcrumb = {
      t: new Date().toISOString(),
      category,
      message: String(message).slice(0, 300),
    };
    if (data !== undefined) entry.data = safeData(data);
    buffer.push(entry);
    while (buffer.length > MAX_BREADCRUMBS) buffer.shift();
  } catch {
    /* recording must never break app code */
  }
}

export function getBreadcrumbs(): Breadcrumb[] {
  return buffer.slice();
}

export function clearBreadcrumbs(): void {
  buffer.length = 0;
  lastError = null;
}

export function recordLastError(e: { label?: string; message: string; componentStack?: string }): void {
  try {
    lastError = { ...e, message: String(e.message).slice(0, 500), t: new Date().toISOString() };
  } catch {
    /* ignore */
  }
}

export function getLastError(): LastError | null {
  return lastError;
}

function safeData(data: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(data, replacer()));
  } catch {
    return String(data).slice(0, 300);
  }
}

function replacer() {
  const seen = new WeakSet<object>();
  return (_k: string, v: unknown) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
    }
    if (typeof v === "string") return v.slice(0, 300);
    return v;
  };
}

let installed = false;
/** Install passive global error/console capture exactly once. Safe to call
 *  multiple times. Each wrapper ALWAYS delegates to the original. */
export function installGlobalCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) =>
    recordBreadcrumb("error", `window.error: ${e.message}`, { filename: e.filename, lineno: e.lineno }),
  );
  window.addEventListener("unhandledrejection", (e) =>
    recordBreadcrumb("error", `unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`),
  );
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      recordBreadcrumb(
        "console",
        `console.${level}: ${args
          .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : ""))
          .join(" ")
          .slice(0, 300)}`,
      );
      orig(...args);
    };
  }
}
