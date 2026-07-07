import { useMemo } from "react";
import { IconLink, IconListSearch } from "@tabler/icons-react";
import type { KbNote, KbVault } from "../types";
import { buildOutline } from "../data/parse";

export function RightRail({
  note,
  vault,
  onNavigate,
}: {
  note: KbNote;
  vault: KbVault;
  onNavigate: (id: string) => void;
}) {
  const outline = useMemo(() => buildOutline(note.body), [note.body]);
  const backlinks = useMemo(() => {
    const ids = vault.backlinks.get(note.id) ?? [];
    return ids.map((id) => vault.resolve.get(id.toLowerCase())).filter((n): n is KbNote => !!n);
  }, [note.id, vault]);

  function scrollTo(slug: string) {
    const el = document.getElementById(slug);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="kb-scroll flex h-full flex-col gap-6 overflow-y-auto p-3">
      <section>
        <Header icon={<IconListSearch size={13} />} label="Outline" count={outline.length} />
        {outline.length === 0 ? (
          <Empty>No headings</Empty>
        ) : (
          <div className="mt-1 space-y-0.5">
            {outline.map((o, i) => (
              <button
                key={i}
                onClick={() => scrollTo(o.slug)}
                className="block w-full truncate rounded px-2 py-0.5 text-left text-xs text-helios-dim hover:bg-helios-panel hover:text-helios-text"
                style={{ paddingLeft: 8 + (o.level - 1) * 10 }}
                title={o.text}
              >
                {o.text}
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <Header icon={<IconLink size={13} />} label="Backlinks" count={backlinks.length} />
        {backlinks.length === 0 ? (
          <Empty>No backlinks</Empty>
        ) : (
          <div className="mt-1 space-y-0.5">
            {backlinks.map((n) => (
              <button
                key={n.id}
                onClick={() => onNavigate(n.id)}
                className="block w-full rounded px-2 py-1 text-left hover:bg-helios-panel"
                title={n.id}
              >
                <div className="truncate text-xs text-helios-text/90">{n.title}</div>
                {n.dir && <div className="truncate text-[10px] text-helios-dim">{n.dir}</div>}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Header({ icon, label, count }: { icon: React.ReactNode; label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-helios-dim">
      <span className="text-asu-gold/70">{icon}</span>
      <span>{label}</span>
      <span className="text-helios-line">·</span>
      <span>{count}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-1 text-xs italic text-helios-dim/70">{children}</div>;
}
