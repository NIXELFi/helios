import { useEffect, useRef, useState, type DragEvent } from "react";
import type { SupabaseClient } from "@helios/auth";
import { RECEIPT_MAX_BYTES, RECEIPT_TYPES, deleteReceipt, openExternal, receiptUrl, type Receipt } from "../api";

/** Receipt files on a reimbursement: thumbnails for photos, a link for PDFs. */
export function ReceiptList({ client, receipts, onDelete }: { client: SupabaseClient; receipts: Receipt[]; onDelete?: (r: Receipt) => void }) {
  if (!receipts.length) return <span className="text-xs text-helios-muted">no receipt</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {receipts.map((r) => <ReceiptChip key={r.id} client={client} r={r} onDelete={onDelete} />)}
    </div>
  );
}

function ReceiptChip({ client, r, onDelete }: { client: SupabaseClient; r: Receipt; onDelete?: (r: Receipt) => void }) {
  const [thumb, setThumb] = useState<string | null>(null);
  const image = r.content_type.startsWith("image/") && !r.content_type.includes("hei");
  useEffect(() => {
    if (!image) return;
    let on = true;
    receiptUrl(client, r).then((u) => { if (on) setThumb(u); }).catch(() => {});
    return () => { on = false; };
  }, [client, r.object_path, image]);
  const open = () => void receiptUrl(client, r).then(openExternal).catch(() => {});
  return (
    <span className="group relative inline-flex items-center gap-1 rounded-md border border-helios-line bg-helios-strip text-xs">
      <button onClick={open} title={`Open ${r.file_name}`} className="flex items-center gap-1 px-1.5 py-1 hover:text-asu-gold">
        {thumb ? <img src={thumb} alt="" className="size-8 rounded object-cover" /> : <span aria-hidden className="text-[10px] font-semibold text-helios-muted">{r.content_type === "application/pdf" ? "PDF" : "FILE"}</span>}
        <span className="max-w-[120px] truncate">{r.file_name}</span>
      </button>
      {onDelete && <button className="pr-1.5 text-helios-muted hover:text-helios-danger" onClick={() => onDelete(r)} aria-label={`Remove ${r.file_name}`}>✕</button>}
    </span>
  );
}

/** Drop zone + file picker for receipts (photos or PDFs, 10 MB each). */
export function ReceiptPicker({ files, setFiles, compact }: { files: File[]; setFiles: (f: File[]) => void; compact?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  function add(list: FileList | null) {
    if (!list) return;
    const ok: File[] = [];
    const bad: string[] = [];
    for (const f of Array.from(list)) {
      if (!RECEIPT_TYPES.includes(f.type)) bad.push(`${f.name} isn't a photo or PDF`);
      else if (f.size > RECEIPT_MAX_BYTES) bad.push(`${f.name} is over 10 MB`);
      else ok.push(f);
    }
    setProblem(bad.length ? bad.join("; ") : null);
    setFiles([...files, ...ok]);
  }
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); };
  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
        onClick={() => ref.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") ref.current?.click(); }}
        className={compact
          ? `inline-block cursor-pointer rounded px-1 text-xs ${over ? "bg-asu-gold/10 text-asu-gold" : "text-helios-dim hover:text-asu-gold"}`
          : `cursor-pointer rounded-lg border border-dashed p-5 text-center text-sm ${over ? "border-asu-gold bg-asu-gold/10" : "border-helios-line hover:bg-helios-strip"}`}>
        {compact ? "+ Add receipt" : <>Drop receipts here or <span className="text-asu-gold">choose files</span><div className="text-xs text-helios-muted">Photos or PDFs, up to 10 MB each</div></>}
        <input ref={ref} type="file" multiple accept={RECEIPT_TYPES.join(",")} className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      </div>
      {problem && <div className="mt-1 text-xs text-helios-danger">{problem}</div>}
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-md border border-helios-line bg-helios-strip px-1.5 py-1 text-xs">
              <span className="max-w-[160px] truncate">{f.name}</span>
              <button className="text-helios-muted hover:text-helios-danger" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>✕</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The question to ask (with useConfirm) before removing a receipt. */
export const removeReceiptQuestion = (r: Receipt) =>
  ({ title: "Remove receipt", body: `Remove ${r.file_name}?`, confirmLabel: "Remove", danger: true });
