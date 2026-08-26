// The submit flow, as one state machine.
//
// Everything that can go wrong on the way from "a folder on disk" to "a version
// pending review" happens here, in one place, so the wizard's views can stay
// presentational and every failure branch is testable without rendering anything.
//
// The order matters and is not arbitrary:
//   pack (Rust)  -> pre-flight (shared scan) -> upload bytes -> publish RPC
// Bytes go to Storage BEFORE the RPC because the RPC records the sha256 as the
// storage key; publishing first would create a version row pointing at an object
// that does not exist. The reverse failure is harmless: an orphaned object in a
// content-addressed bucket is just bytes nobody references.

import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { useSupabaseClient } from "@helios/auth";
import type { PluginManifest } from "@helios/plugin-sdk";
import { preflight, type PreflightReport } from "./preflight";
import { permissionDiff, type PermissionDiff } from "./permissionDiff";
import { explainPublishError, isDuplicateObjectError, type ExplainedError } from "./publishErrors";

const SCHEMA = "marketplace";
const BUNDLE_BUCKET = "plugins";

/** Mirrors `PackedBundleInfo` in src-tauri/src/plugins/commands.rs. */
export interface PackedBundle {
  stagedPath: string;
  sha256: string;
  bytes: number;
  manifest: PluginManifest;
  entries: string[];
  texts: Record<string, string>;
  warnings: string[];
  largest: [string, number][];
}

export type PublishPhase =
  | "idle"
  | "packing"
  | "preflight"
  | "confirm"
  | "uploading"
  | "publishing"
  | "done";

export interface SubmittedVersion {
  pluginId: string;
  version: string;
  reviewStatus: string;
}

/** One row of `my_published_plugins`, as far as the submit flow cares. */
interface MyVersionRow {
  plugin_id: string;
  subteam: string | null;
  version: string;
  permissions: string[] | null;
  review_status: string;
  published_at: string;
}

export interface PublishState {
  phase: PublishPhase;
  /** The folder the author picked, so "Re-check" can re-pack it without a second
   *  trip through the picker. The staged path is inside the cache and is NOT a
   *  substitute for it. */
  sourceDir: string | null;
  packed: PackedBundle | null;
  report: PreflightReport | null;
  diff: PermissionDiff | null;
  /** The owning subteam of an EXISTING plugin — locked, not chosen. */
  lockedSubteam: string | null;
  /** True when this plugin id has never been published before. */
  isNewPlugin: boolean;
  error: ExplainedError | null;
  submitted: SubmittedVersion | null;
  busy: boolean;
}

const INITIAL: PublishState = {
  phase: "idle",
  sourceDir: null,
  packed: null,
  report: null,
  diff: null,
  lockedSubteam: null,
  isNewPlugin: true,
  error: null,
  submitted: null,
  busy: false,
};

export function usePublish() {
  const client = useSupabaseClient();
  const [state, setState] = useState<PublishState>(INITIAL);

  const reset = useCallback(() => setState(INITIAL), []);

  /** Pack a folder and pre-flight it. Shared by "choose a folder" and "re-check
   *  after I fixed something", which is the same operation from the user's side. */
  const packFolder = useCallback(
    async (dir: string) => {
      setState((s) => ({ ...s, phase: "packing", busy: true, error: null }));
      try {
        const packed = (await invoke("pack_plugin_bundle", { dir })) as PackedBundle;
        const report = preflight(packed.texts, packed.manifest);

        // What did the last APPROVED version of this plugin ask for? Absent means
        // this is a brand-new plugin and every permission is new by definition.
        let previousPermissions: string[] | null = null;
        let lockedSubteam: string | null = null;
        let isNewPlugin = true;
        const mine = await client.schema(SCHEMA).rpc("my_published_plugins");
        if (!mine.error) {
          const rows = ((mine.data ?? []) as MyVersionRow[]).filter(
            (r) => r.plugin_id === packed.manifest.id,
          );
          if (rows.length > 0) {
            isNewPlugin = false;
            lockedSubteam = rows[0].subteam;
            const approved = rows
              .filter((r) => r.review_status === "approved")
              .sort((a, b) => b.published_at.localeCompare(a.published_at))[0];
            if (approved) previousPermissions = approved.permissions ?? [];
          }
        }

        setState((s) => ({
          ...s,
          phase: "preflight",
          busy: false,
          sourceDir: dir,
          packed,
          report,
          diff: permissionDiff(previousPermissions, packed.manifest.permissions ?? []),
          lockedSubteam,
          isNewPlugin,
        }));
      } catch (e) {
        setState((s) => ({
          ...s,
          phase: "idle",
          busy: false,
          // A pack failure is already a plain-English sentence from pack.rs —
          // explainPublishError would only wrap it in a worse one.
          error: { title: "Could not pack this folder", detail: messageOf(e), retryable: true },
        }));
      }
    },
    [client],
  );

  const chooseFolder = useCallback(async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Choose your plugin folder" });
    if (typeof dir !== "string") return; // cancelled
    await packFolder(dir);
  }, [packFolder]);

  /** Re-pack the folder already chosen, after the author has fixed something and
   *  rebuilt. Falls back to the picker only if we somehow have no folder. */
  const recheck = useCallback(async () => {
    if (state.sourceDir) await packFolder(state.sourceDir);
    else await chooseFolder();
  }, [chooseFolder, packFolder, state.sourceDir]);

  const toConfirm = useCallback(() => {
    setState((s) => (s.report?.ok ? { ...s, phase: "confirm", error: null } : s));
  }, []);

  const back = useCallback(() => {
    setState((s) => ({
      ...s,
      phase: s.phase === "confirm" ? "preflight" : s.phase,
      error: null,
    }));
  }, []);

  /**
   * Upload the packed bytes and submit the version.
   *
   * @param subteamId  the claimed owning subteam for a NEW plugin. Ignored for an
   *                   existing one: `publish_plugin_version` refuses ownership
   *                   reassignment, so offering it would be a lie.
   */
  const submit = useCallback(
    async (subteamId: string | null) => {
      const packed = state.packed;
      const report = state.report;
      if (!packed || !report?.ok) return;

      setState((s) => ({ ...s, phase: "uploading", busy: true, error: null }));
      try {
        // 1. Bytes first. The object key IS the content hash, so a duplicate means
        //    these exact bytes are already stored — success, not a collision.
        const bytes = await readFile(packed.stagedPath);
        const upload = await client.storage
          .from(BUNDLE_BUCKET)
          .upload(packed.sha256, new Blob([bytes], { type: "application/zip" }), {
            upsert: false,
            contentType: "application/zip",
          });
        if (upload.error && !isDuplicateObjectError(upload.error)) throw upload.error;

        // 2. Record the version. Lands 'pending'; the server re-validates the
        //    manifest and re-checks the publish capability regardless of anything
        //    this client believes.
        setState((s) => ({ ...s, phase: "publishing" }));
        const published = await client.schema(SCHEMA).rpc("publish_plugin_version", {
          p_manifest: packed.manifest,
          p_sha256: packed.sha256,
          p_bytes: packed.bytes,
          p_subteam: state.isNewPlugin ? subteamId : state.lockedSubteam,
        });
        if (published.error) throw new Error(published.error.message);
        const row = ((published.data ?? []) as Array<{
          plugin_id: string;
          version: string;
          review_status: string;
        }>)[0];
        if (!row) throw new Error("publish_plugin_version returned no version");

        // 3. The staged copy has served its purpose. Best-effort: a leftover file
        //    is swept after a week anyway, and failing here would be a confusing
        //    error on an otherwise successful publish.
        try {
          await invoke("discard_staged_bundle", { sha256: packed.sha256 });
        } catch {
          /* ignore */
        }

        setState((s) => ({
          ...s,
          phase: "done",
          busy: false,
          submitted: {
            pluginId: row.plugin_id,
            version: row.version,
            reviewStatus: row.review_status,
          },
        }));
      } catch (e) {
        // Stay on confirm with the packed bundle intact: Retry must not re-pack.
        setState((s) => ({
          ...s,
          phase: "confirm",
          busy: false,
          error: explainPublishError(e, { version: packed.manifest.version }),
        }));
      }
    },
    [client, state.packed, state.report, state.isNewPlugin, state.lockedSubteam],
  );

  const canSubmit = useMemo(
    () => state.report?.ok === true && state.packed !== null && !state.busy,
    [state.report, state.packed, state.busy],
  );

  return { ...state, canSubmit, chooseFolder, packFolder, recheck, toConfirm, back, submit, reset };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

