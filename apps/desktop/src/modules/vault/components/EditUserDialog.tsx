import { useEffect, useMemo, useRef, useState } from "react";
import type { Subteam, VaultUser } from "../data/types";

/** Admin dialog for editing a user's profile (display name + subteam). Role is
 *  managed inline in the row; email is the login identity and not editable here.
 *  Mirrors the app's modal a11y convention (role=dialog + Escape-to-close +
 *  focus-on-open + focus-restore). */
export function EditUserDialog({
  user,
  subteams,
  saving,
  onSave,
  onClose,
}: {
  user: VaultUser;
  subteams: Subteam[];
  saving: boolean;
  onSave: (name: string | null, subteam: string | null) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(user.display_name ?? "");
  const [subteam, setSubteam] = useState(user.subteam ?? "");
  const dialogRef = useRef<HTMLFormElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreTo?.focus?.();
    };
  }, [onClose]);

  // Subteam options = managed subteams ∪ the user's current value (so a value
  // for a since-removed subteam isn't silently dropped).
  const options = useMemo(() => {
    const names = new Set<string>();
    for (const s of subteams) names.add(s.name);
    if (user.subteam) names.add(user.subteam);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [subteams, user.subteam]);

  const dirty = name !== (user.display_name ?? "") || subteam !== (user.subteam ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave(name.trim() === "" ? null : name.trim(), subteam === "" ? null : subteam);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${user.email ?? "user"}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-80 space-y-3 rounded-sm border border-helios-line bg-helios-panel p-4 shadow-xl"
      >
        <div>
          <h3 className="text-sm font-semibold text-helios-text">Edit user</h3>
          <p className="mt-0.5 truncate text-[11px] text-helios-dim" title={user.email ?? undefined}>
            {user.email ?? user.user_id}
          </p>
        </div>

        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-helios-dim">Display name</span>
          <input
            ref={firstRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="(no name)"
            className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-sm text-helios-text placeholder-helios-dim outline-none focus:border-asu-gold"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-helios-dim">Subteam</span>
          <select
            value={subteam}
            onChange={(e) => setSubteam(e.target.value)}
            className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-sm text-helios-text outline-none focus:border-asu-gold"
          >
            <option value="">— none —</option>
            {options.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-sm px-3 py-1 text-xs text-helios-dim hover:bg-helios-line disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !dirty}
            className="rounded-sm bg-asu-gold px-3 py-1 text-xs font-semibold text-helios-base hover:bg-asu-gold/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
