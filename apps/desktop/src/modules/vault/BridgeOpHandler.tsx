import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readFile } from "@tauri-apps/plugin-fs";
import { useCheckIn } from "./data/useCheckIn";
import { useDownloadVersion } from "./data/useDownloadVersion";

/**
 * Runs the SOLIDWORKS add-in bridge's BLOB operations in the UI, where the
 * tested upload/download code already lives (the metadata ops — status /
 * versions / checkout — are served natively in Rust; only check-in / get-latest,
 * which gzip + sha256-verify + atomically write, are forwarded here).
 *
 * Rust emits `bridge://op` with a request id; we run the op via the same hooks
 * the Helios UI uses, then reply through `bridge_respond` to unblock the waiting
 * HTTP request. Mounted only when signed in (the hooks need a Supabase client).
 */
type OpPayload =
  | { id: string; op: "checkin"; fileId: string; path: string; comment: string | null }
  | { id: string; op: "getLatest"; sha: string; destPath: string };

export function BridgeOpHandler(): null {
  const checkIn = useCheckIn();
  const download = useDownloadVersion();
  // The hook returns change identity on each internal state set; keep the latest
  // run fns in refs so the listener (registered once) always calls the current one.
  const checkInRef = useRef(checkIn.run);
  checkInRef.current = checkIn.run;
  const downloadRef = useRef(download.run);
  downloadRef.current = download.run;

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void listen<OpPayload>("bridge://op", async (event) => {
      const p = event.payload;
      const respond = (result: Record<string, unknown>) =>
        void invoke("bridge_respond", { reply: { id: p.id, result } }).catch(() => {});
      try {
        if (p.op === "checkin") {
          const bytes = await readFile(p.path);
          // Pass an exact ArrayBuffer (sliced to the view) to the hook.
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const ver = await checkInRef.current(p.fileId, buf, p.comment ?? null);
          respond(ver ? { ok: true, versionNum: ver.version_num } : { ok: false, error: "check-in failed" });
        } else if (p.op === "getLatest") {
          const ok = await downloadRef.current(p.sha, p.destPath);
          respond(ok ? { ok: true } : { ok: false, error: "download failed" });
        } else {
          respond({ ok: false, error: "unknown bridge op" });
        }
      } catch (e) {
        respond({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }).then((u) => {
      if (active) unlisten = u;
      else u();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return null;
}
