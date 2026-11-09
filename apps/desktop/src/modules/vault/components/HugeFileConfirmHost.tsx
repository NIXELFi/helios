import { useSyncExternalStore } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import {
  HUGE_FILE_WARNING,
  answerHugeUpload,
  currentHugeUpload,
  formatSize,
  subscribeHugeUploads,
} from "../data/huge-file-guard";

/** Shows the "this file is huge" warning for whichever add / check-in is
 *  waiting on it (see huge-file-guard.ts). Mounted once, in the Shell. */
export function HugeFileConfirmHost() {
  const req = useSyncExternalStore(subscribeHugeUploads, currentHugeUpload, currentHugeUpload);
  if (!req) return null;
  const verb = req.action === "add" ? "add" : "check in";
  return (
    <ConfirmDialog
      key={req.key}
      title={`${req.name} is ${formatSize(req.bytes)}`}
      body={
        <div className="space-y-2">
          <p className="font-semibold text-[#EF5350]">{HUGE_FILE_WARNING}</p>
          <p>
            Every teammate's Helios downloads every file in the vault, so one file this size is
            downloaded once per person. Results, meshes and backup archives usually belong
            somewhere else.
          </p>
        </div>
      }
      confirmLabel={`${verb[0]!.toUpperCase()}${verb.slice(1)} anyway`}
      confirmTone="danger"
      cancelLabel={req.action === "add" ? "Don't add" : "Don't check in"}
      onConfirm={() => answerHugeUpload(req.key, true)}
      onClose={() => answerHugeUpload(req.key, false)}
    />
  );
}
