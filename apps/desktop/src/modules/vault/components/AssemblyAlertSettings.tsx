import { useEffect, useMemo, useState } from "react";
import type { Vault, VaultFile } from "../data/types";
import { useAssemblyAlert } from "../data/useAssemblyAlert";
import { useVaultFiles } from "../data/vault-files-context";
import { useFolders } from "../data/useFolders";
import { folderPath } from "../data/folder-paths";
import { SpotlightPicker } from "./SpotlightPicker";

/** Folders are only fetched while the picker is open. */
function AssemblyFilePicker({
  vaultId,
  currentId,
  onPick,
  onClose,
}: {
  vaultId: string;
  currentId: string | null;
  onPick: (file: VaultFile) => void;
  onClose: () => void;
}) {
  const { data: files } = useVaultFiles();
  const { data: folders } = useFolders(vaultId);
  const fileList = useMemo(() => files ?? [], [files]);
  const pathOf = useMemo(() => {
    const folderList = folders ?? [];
    return (f: VaultFile) => folderPath(f.folder_id, folderList);
  }, [folders]);

  return (
    <SpotlightPicker
      title="Choose assembly"
      allowClear={false}
      files={fileList}
      pathOf={pathOf}
      currentId={currentId}
      saving={false}
      onPick={(id) => {
        const file = fileList.find((f) => f.id === id);
        if (file) onPick(file);
      }}
      onClose={onClose}
    />
  );
}

/** Vault Settings section: post to Slack when someone checks out this car's
 *  master assembly. Key it by vault id so the form resets on a vault switch. */
export function AssemblyAlertSettings({ vault }: { vault: Vault }) {
  const { data, loadError, saving, saveError, save } = useAssemblyAlert(vault.id);
  const { data: files } = useVaultFiles();
  const [enabled, setEnabled] = useState(false);
  const [fileId, setFileId] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [picking, setPicking] = useState(false);
  const [saved, setSaved] = useState(false);

  // A car with no alert saved yet starts on its spotlight file, which is the
  // master assembly on every SDM vault.
  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setFileId(data.file_id ?? vault.spotlight_file_id ?? null);
  }, [data, vault.spotlight_file_id]);

  const fileName =
    (fileId && fileId === data?.file_id ? data.file_name : null) ??
    files?.find((f) => f.id === fileId)?.name ??
    null;

  function edited<T>(setter: (value: T) => void) {
    return (value: T) => {
      setSaved(false);
      setter(value);
    };
  }

  async function handleSave() {
    setSaved(false);
    const ok = await save({ enabled, fileId, webhookUrl });
    if (ok) {
      setWebhookUrl("");
      setSaved(true);
    }
  }

  return (
    <section className="mb-8 max-w-xl space-y-3">
      <h2 className="text-sm uppercase tracking-wider text-helios-dim">
        Assembly Slack alert for {vault.name}
      </h2>
      <p className="text-xs text-helios-dim">
        Posts <span className="text-helios-text">&quot;Name is ON the assembly!&quot;</span> to a
        Slack channel when someone checks out this file. Applies to everyone on this vault.
      </p>
      <div className="space-y-3 rounded border border-helios-line bg-helios-base p-4 text-sm">
        {loadError ? (
          <p className="text-xs text-[#EF5350]" role="alert">{loadError.message}</p>
        ) : !data ? (
          <p className="text-xs text-helios-dim">Loading...</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-xs text-helios-text">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => edited(setEnabled)(e.target.checked)}
                className="accent-asu-gold"
              />
              Send alerts for this car
            </label>

            <div>
              <div className="mb-1 text-xs text-helios-dim">Assembly</div>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-mono-num text-xs text-helios-text" title={fileName ?? undefined}>
                  {fileName ?? "(no file selected)"}
                </span>
                <button
                  type="button"
                  onClick={() => setPicking(true)}
                  className="shrink-0 rounded border border-helios-line px-3 py-1 text-xs text-helios-text hover:bg-helios-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
                >
                  Change
                </button>
              </div>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-helios-dim">Slack webhook URL</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={webhookUrl}
                onChange={(e) => edited(setWebhookUrl)(e.target.value)}
                placeholder={data.has_webhook ? "Saved. Paste a new URL to replace it." : "https://hooks.slack.com/..."}
                className="w-full rounded border border-helios-line bg-helios-panel px-2 py-1.5 font-mono-num text-xs text-helios-text placeholder-helios-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
              />
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="rounded bg-asu-gold px-3 py-1.5 text-xs text-helios-on-gold hover:bg-asu-gold/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              {saved && !saveError && <span className="text-xs text-helios-dim">Saved.</span>}
            </div>
            {saveError && <p className="text-xs text-[#EF5350]" role="alert">{saveError.message}</p>}
          </>
        )}
      </div>
      {picking && (
        <AssemblyFilePicker
          vaultId={vault.id}
          currentId={fileId}
          onPick={(file) => {
            edited(setFileId)(file.id);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}
