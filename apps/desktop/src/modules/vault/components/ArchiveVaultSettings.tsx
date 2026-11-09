import type { Vault } from "../data/types";
import { useSetVaultArchived } from "../data/useSetVaultArchived";

/** Vault Settings section (vault admins): mark a previous year's car archived
 *  so nobody's Helios auto-syncs it. */
export function ArchiveVaultSettings({ vault }: { vault: Vault }) {
  const { run, saving, error } = useSetVaultArchived();
  const archived = vault.archived === true;
  return (
    <section className="max-w-xl space-y-3">
      <h2 className="text-sm uppercase tracking-wider text-helios-dim">Archive {vault.name}</h2>
      <p className="text-xs text-helios-dim">
        For a previous year's car. Nobody's Helios auto-syncs an archived vault: everyone can still
        browse it and download the files or folders they need, and copies they already have stay put.
        Every teammate syncing every old car is most of the vault's download traffic.
      </p>
      <div className="rounded border border-helios-line bg-helios-base p-4 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={archived}
            disabled={saving}
            onChange={(e) => void run(vault.id, e.target.checked)}
            className="accent-asu-gold"
          />
          <span className="text-helios-text">Archived: don't auto-sync this vault</span>
        </label>
        {error && <p className="mt-2 text-xs text-[#EF5350]">{error}</p>}
      </div>
    </section>
  );
}
