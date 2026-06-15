import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordBreadcrumb, recordLastError } from "../lib/breadcrumbs";

interface Props {
  children: ReactNode;
  /** Short label for what failed, e.g. "Vault" or "Logs". Shown in the
   *  fallback heading so a contained module error reads "Vault hit an error"
   *  rather than a generic crash. Omit for the app-level boundary. */
  label?: string;
  /** Compact fills its parent pane (per-module use) instead of the whole
   *  viewport (app-level use). */
  compact?: boolean;
}

interface State {
  error: Error | null;
}

/** Catches render/lifecycle errors below it and shows a styled fallback with a
 *  recovery action instead of letting React unmount the whole tree to a blank
 *  white screen. The app had no error boundary, so any uncaught component throw
 *  (an unexpected bridge/Supabase response shape, a module bug, etc.) used to
 *  take the entire UI down silently — this turns that into a graceful error.
 *
 *  Used at two levels: once at the app root (main.tsx) as the last-resort net,
 *  and once per module (Shell.tsx) so one module crashing doesn't kill the
 *  others or the navigation rail. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Log for diagnosis — this is the only place these errors surface now that
    // we stop them from crashing the app.
    console.error(
      `ErrorBoundary${this.props.label ? ` [${this.props.label}]` : ""}: ` +
        "uncaught error",
      error,
      info.componentStack,
    );
    // Feed the bug-report diagnostics: a structured last_error (read directly by
    // the report) plus a breadcrumb. The console.error above is also captured by
    // the global console wrapper, so a catch yields ~2 breadcrumbs — accepted;
    // the explicit recordLastError is what guarantees last_error is populated.
    recordLastError({
      label: this.props.label,
      message: error.message || String(error),
      componentStack: info.componentStack ?? undefined,
    });
    recordBreadcrumb(
      "error",
      `ErrorBoundary${this.props.label ? ` [${this.props.label}]` : ""}: ${error.message || String(error)}`,
    );
  }

  private reset = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { label, compact } = this.props;
    const heading = label ? `${label} hit an error` : "Something went wrong";

    return (
      <div
        role="alert"
        className={
          (compact ? "absolute inset-0" : "fixed inset-0") +
          " flex flex-col items-center justify-center bg-[#0E0E10] text-[#D8DCE2] px-6"
        }
      >
        <div className="flex flex-col items-center gap-3">
          <h1 className="font-helios text-[3.5rem] md:text-[5rem] leading-none text-[#FFC627]">
            HELIOS
          </h1>
          <div className="text-[10px] md:text-xs uppercase tracking-[0.4em] text-[#9097A0]">
            {heading}
          </div>
        </div>

        <div className="mt-10 w-[520px] max-w-[80%] flex flex-col items-center gap-4">
          <div className="w-full border border-[#EF5350] bg-[#16171B] px-3 py-2 text-center text-xs text-[#EF5350]">
            {error.message || String(error)}
          </div>
          <div className="flex gap-3">
            {/* Per-module: re-render this subtree. App-level: full reload. */}
            <button
              type="button"
              onClick={compact ? this.reset : () => window.location.reload()}
              className="border border-[#FFC627] px-5 py-2 text-xs uppercase tracking-wider text-[#FFC627] transition-colors hover:bg-[#FFC627] hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFC627]"
            >
              {compact ? "Try again" : "Reload Helios"}
            </button>
            {compact && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="border border-[#2A2C32] px-5 py-2 text-xs uppercase tracking-wider text-[#9097A0] transition-colors hover:border-[#9097A0] hover:text-[#D8DCE2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9097A0]"
              >
                Reload Helios
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
