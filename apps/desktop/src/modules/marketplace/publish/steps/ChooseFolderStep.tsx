import { IconFolderOpen, IconLoader2, IconAlertTriangle } from "@tabler/icons-react";
import type { ExplainedError } from "../publishErrors";
import type { HelpTopic } from "../../authoring/helpContent";

/** Step 1 — point Helios at the folder. The copy's whole job is to prevent the
 *  single most common mistake: picking dist/ instead of the folder above it. */
export function ChooseFolderStep({
  busy,
  error,
  onChoose,
  onHelp,
}: {
  busy: boolean;
  error: ExplainedError | null;
  onChoose: () => void;
  onHelp: (t: HelpTopic) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-helios-text">Choose your plugin folder</h3>
        <p className="mt-1 text-xs leading-relaxed text-helios-dim">
          Pick the folder that contains <span className="font-mono text-helios-text">manifest.json</span> —
          the top of your plugin project, not the <span className="font-mono text-helios-text">dist</span>{" "}
          folder inside it. Helios packs the manifest and your built output into a bundle, checks it, and
          shows you the result before anything is submitted.
        </p>
      </div>

      <div className="rounded-sm border border-helios-line bg-helios-base p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
          What it should look like
        </div>
        <pre className="mt-2 font-mono text-[11px] leading-relaxed text-helios-text/80">
{`my-plugin/          <- pick this one
  manifest.json
  dist/
    index.html
    app.js`}
        </pre>
      </div>

      <button
        type="button"
        onClick={onChoose}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-sm bg-asu-gold px-4 py-2 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? <IconLoader2 size={14} className="animate-spin" /> : <IconFolderOpen size={14} />}
        {busy ? "Packing…" : "Choose folder…"}
      </button>

      {error && (
        <div className="flex items-start gap-2 rounded-sm border border-helios-danger/40 bg-helios-danger/10 p-3">
          <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-helios-danger" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-helios-danger">{error.title}</div>
            <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-helios-text/90">
              {error.detail}
            </p>
            <button
              type="button"
              onClick={() => onHelp("bundle")}
              className="mt-2 text-[11px] font-medium text-asu-gold underline-offset-2 hover:underline"
            >
              What ships in a bundle?
            </button>
          </div>
        </div>
      )}

      <p className="text-[11px] text-helios-dim">
        Never built one before?{" "}
        <button
          type="button"
          onClick={() => onHelp("getting-started")}
          className="font-medium text-asu-gold underline-offset-2 hover:underline"
        >
          Start here
        </button>
        .
      </p>
    </div>
  );
}
