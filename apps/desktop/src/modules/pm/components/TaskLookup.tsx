"use client";

import type { TaskRow } from "@helios/pm-ui";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface TaskLookupProps {
  tasks: ReadonlyArray<TaskRow>;
  excludeIds: ReadonlySet<string>;
  onSelect: (taskId: string) => void;
  placeholder?: string;
}

// Typeahead that filters existing tasks by title and emits the picked task id.
// Used to author dependencies (prerequisite / dependent) by name.
export function TaskLookup({
  tasks,
  excludeIds,
  onSelect,
  placeholder = "Add by title…",
}: TaskLookupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks
      .filter((t) => !excludeIds.has(t.id))
      .filter((t) => (q ? t.title.toLowerCase().includes(q) : true))
      .slice(0, 8);
  }, [tasks, excludeIds, query]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(id: string) {
    onSelect(id);
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-1.5 rounded border border-helios-line bg-helios-base px-2 py-1.5 focus-within:border-asu-gold">
        <IconSearch size={13} strokeWidth={1.5} className="shrink-0 text-helios-dim" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full bg-transparent text-xs text-helios-text placeholder:text-helios-dim focus:outline-none"
        />
      </div>

      {open && matches.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-helios-line bg-helios-panel shadow-lg">
          <ul className="max-h-56 overflow-y-auto py-1">
            {matches.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => pick(t.id)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-helios-text hover:bg-helios-base"
                >
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: t.subteam.color ?? "#6B7280" }}
                  />
                  <span className="flex-1 truncate">{t.title}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-widest text-helios-dim">
                    {t.subteam.code}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
