// The author help panel. Slides in over whatever the author was doing, keeps the
// topic list visible, and can be opened straight to one topic — which is what
// every pre-flight finding does, so "forbidden API" is never the end of the road.

import { useEffect, useRef, useState } from "react";
import { IconX, IconHelpCircle, IconChevronRight } from "@tabler/icons-react";
import { HELP_ARTICLES, HELP_TOPIC_ORDER, type HelpTopic } from "./helpContent";

export function HelpDrawer({
  open,
  topic,
  onClose,
  onTopicChange,
}: {
  open: boolean;
  topic: HelpTopic;
  onClose: () => void;
  onTopicChange: (t: HelpTopic) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Escape closes, and switching topic scrolls back to the top — otherwise a
  // short article opens halfway down after a long one.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    // Optional call: not every environment implements Element.scrollTo, and
    // failing to scroll is never worth throwing inside an effect over.
    bodyRef.current?.scrollTo?.({ top: 0 });
  }, [topic]);

  if (!open) return null;
  const article = HELP_ARTICLES[topic];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Plugin author help"
      className="fixed inset-0 z-[60] flex justify-end bg-black/50"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="flex h-full w-full max-w-2xl flex-col border-l border-helios-line bg-helios-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-helios-line px-4 py-3">
          <div className="flex items-center gap-2 text-asu-gold">
            <IconHelpCircle size={18} strokeWidth={1.5} />
            <h2 className="font-display text-sm tracking-wide">PLUGIN AUTHOR HELP</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close help"
            className="rounded-sm p-1 text-helios-dim transition-colors hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="w-52 shrink-0 overflow-y-auto border-r border-helios-line py-2">
            {HELP_TOPIC_ORDER.map((t) => {
              const active = t === topic;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => onTopicChange(t)}
                  aria-current={active ? "page" : undefined}
                  className={
                    "flex w-full items-center justify-between gap-1 px-3 py-2 text-left text-[11px] leading-snug transition-colors " +
                    (active
                      ? "bg-asu-gold/10 font-semibold text-asu-gold"
                      : "text-helios-dim hover:bg-helios-line/40 hover:text-helios-text")
                  }
                >
                  <span>{HELP_ARTICLES[t].title}</span>
                  {active && <IconChevronRight size={12} className="shrink-0" />}
                </button>
              );
            })}
          </nav>

          <div ref={bodyRef} className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <h3 className="font-display text-lg tracking-wide text-helios-text">{article.title}</h3>
            <p className="mt-1 text-xs text-helios-dim">{article.summary}</p>

            <div className="mt-5 space-y-5">
              {article.sections.map((section, i) => (
                <section key={i} className="space-y-2">
                  {section.heading && (
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-asu-gold">
                      {section.heading}
                    </h4>
                  )}
                  {section.body?.map((p, j) => (
                    <p key={j} className="text-xs leading-relaxed text-helios-text/90">
                      {p}
                    </p>
                  ))}
                  {section.bullets && (
                    <ul className="space-y-1.5 pl-1">
                      {section.bullets.map((b, j) => (
                        <li key={j} className="flex gap-2 text-xs leading-relaxed text-helios-text/90">
                          <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-asu-gold" />
                          <span>{b}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {section.code && (
                    // Wrap rather than scroll: these blocks are mostly instructions
                    // meant to be read and copied, and a horizontal scrollbar hides
                    // the end of the sentence exactly where it matters.
                    <pre className="whitespace-pre-wrap break-words rounded-sm border border-helios-line bg-helios-base p-3 font-mono text-[11px] leading-relaxed text-helios-text/90">
                      {section.code}
                    </pre>
                  )}
                </section>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Drawer state, so any surface can open help at a specific topic in one call. */
export function useHelpDrawer(initial: HelpTopic = "getting-started") {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState<HelpTopic>(initial);
  return {
    open,
    topic,
    setTopic,
    openHelp: (t?: HelpTopic) => {
      if (t) setTopic(t);
      setOpen(true);
    },
    closeHelp: () => setOpen(false),
  };
}
