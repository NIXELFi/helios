import { useMemo } from "react";
import {
  IconClock,
  IconDiamond,
  IconFileText,
  IconFolders,
  IconListDetails,
  IconPhoto,
} from "@tabler/icons-react";
import type { KbNote, KbVault } from "../types";
import { BarChart, type BarDatum } from "./Charts";

export function Dashboard({
  vault,
  onNavigate,
}: {
  vault: KbVault;
  onNavigate: (id: string) => void;
}) {
  const stats = useMemo(() => {
    const cars = new Set<string>();
    const subteams = new Set<string>();
    for (const n of vault.notes) {
      const car = n.frontmatter.car;
      const sub = n.frontmatter.subteam;
      if (typeof car === "string") cars.add(car);
      if (typeof sub === "string") subteams.add(sub);
    }
    return {
      notes: vault.notes.length,
      figures: vault.attachments.size,
      cars: cars.size,
      subteams: subteams.size,
    };
  }, [vault]);

  const bySubteam = useMemo<BarDatum[]>(() => {
    const m = new Map<string, { notes: number; figs: number }>();
    for (const n of vault.notes) {
      // Only notes that declare a subteam — meetings / reference / meta are
      // intentionally excluded so this reflects the design record.
      if (typeof n.frontmatter.subteam !== "string") continue;
      const st = n.frontmatter.subteam;
      const e = m.get(st) ?? { notes: 0, figs: 0 };
      e.notes++;
      e.figs += n.body.match(/!\[\[/g)?.length ?? 0;
      m.set(st, e);
    }
    return [...m.entries()]
      .sort((a, b) => b[1].notes + b[1].figs - (a[1].notes + a[1].figs))
      .slice(0, 14)
      .map(([label, v]) => ({ label, value: v.notes, secondary: v.figs }));
  }, [vault.notes]);

  const byType = useMemo<BarDatum[]>(() => {
    const m = new Map<string, number>();
    for (const n of vault.notes) {
      const t = typeof n.frontmatter.type === "string" ? n.frontmatter.type : "note";
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  }, [vault.notes]);

  const recent = useMemo(
    () =>
      [...vault.notes]
        .filter((n) => n.mtimeMs > 0)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 8),
    [vault.notes],
  );

  const quick = useMemo(() => {
    const pick = (frag: string) =>
      vault.notes.find((n) => n.id.toLowerCase() === frag.toLowerCase()) ??
      vault.notes.find((n) => n.basename.toLowerCase() === frag.split("/").pop()!.toLowerCase());
    return [
      { label: "Home", note: pick("Home") },
      { label: "Competition Results", note: pick("Reference/Competition Results") },
      { label: "Decisions Log", note: pick("Reference/Decisions Log") },
      { label: "Lessons Learned", note: pick("Reference/Lessons Learned") },
      { label: "Glossary", note: pick("Reference/Glossary") },
    ].filter((q): q is { label: string; note: KbNote } => !!q.note);
  }, [vault.notes]);

  return (
    <div className="kb-scroll h-full overflow-y-auto">
      <div className="kb-view-in mx-auto max-w-3xl px-8 py-10">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-asu-gold/15 p-2.5 text-asu-gold">
            <IconDiamond size={26} strokeWidth={1.6} />
          </div>
          <div>
            <h1 className="font-display text-2xl text-helios-text">Amethyst</h1>
            <p className="text-sm text-helios-dim">Everything the team has documented — searchable, linked, live.</p>
          </div>
        </div>

        <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={<IconFileText size={16} />} value={stats.notes} label="notes" />
          <Stat icon={<IconPhoto size={16} />} value={stats.figures} label="figures" />
          <Stat icon={<IconFolders size={16} />} value={stats.cars} label="cars" />
          <Stat icon={<IconListDetails size={16} />} value={stats.subteams} label="subteams" />
        </div>

        <section className="mt-9 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-helios-line bg-helios-panel/40 p-5">
            <SectionTitle>Design record by subteam</SectionTitle>
            <div className="mt-4">
              <BarChart data={bySubteam} primaryLabel="notes" secondaryLabel="figures" />
            </div>
          </div>
          <div className="rounded-xl border border-helios-line bg-helios-panel/40 p-5">
            <SectionTitle>Notes by type</SectionTitle>
            <div className="mt-4">
              <BarChart data={byType} />
            </div>
          </div>
        </section>

        {quick.length > 0 && (
          <section className="mt-9">
            <SectionTitle>Jump in</SectionTitle>
            <div className="mt-2 flex flex-wrap gap-2">
              {quick.map((q) => (
                <button
                  key={q.note.id}
                  onClick={() => onNavigate(q.note.id)}
                  className="rounded-lg border border-helios-line bg-helios-panel px-3.5 py-2 text-sm text-helios-text transition-colors hover:border-asu-gold/50 hover:text-asu-gold"
                >
                  {q.label}
                </button>
              ))}
            </div>
          </section>
        )}

        {recent.length > 0 && (
          <section className="mt-9">
            <SectionTitle>
              <IconClock size={13} className="mr-1 inline text-asu-gold/70" />
              Recently updated
            </SectionTitle>
            <div className="mt-2 divide-y divide-helios-line/60 overflow-hidden rounded-lg border border-helios-line">
              {recent.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onNavigate(n.id)}
                  className="flex w-full items-center justify-between gap-3 bg-helios-panel/40 px-4 py-2.5 text-left hover:bg-helios-panel"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-helios-text">{n.title}</span>
                    {n.dir && <span className="block truncate text-[11px] text-helios-dim">{n.dir}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-helios-dim">
                    {new Date(n.mtimeMs).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <p className="mt-10 text-center text-xs text-helios-dim/70">
          Press <kbd className="rounded border border-helios-line px-1">Ctrl</kbd>
          <span className="mx-0.5">+</span>
          <kbd className="rounded border border-helios-line px-1">O</kbd> to jump to any note.
        </p>
      </div>
    </div>
  );
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="rounded-xl border border-helios-line bg-helios-panel px-4 py-3">
      <div className="mb-1 text-asu-gold/70">{icon}</div>
      <div className="text-2xl font-bold text-helios-text">{value}</div>
      <div className="text-xs text-helios-dim">{label}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[11px] font-semibold uppercase tracking-wider text-helios-dim">{children}</h2>;
}
