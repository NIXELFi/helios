import { useMemo, useState } from "react";
import { can } from "../../lib/api";
import { Button, Card, Empty } from "../../components/ui";
import { applyChange, saveTextFile } from "../api";
import { allEvidence } from "../compute";
import { looseEnds } from "../looseEnds";
import { buildSnapshot, planChanges, readChanges, type Planned } from "../roundtrip";
import { today } from "../../lib/dates";
import { Badge, shortDate, whereLabel, type FinanceProps } from "./shared";

/** What to type to Claude alongside the files. */
const PROMPT = "Here is a snapshot of our team's books from Agora (agora-snapshot JSON), with new order emails, invoices and notes. "
  + "Follow the instructions_for_claude inside the snapshot and send me back agora-changes.json. Add a note for anything you aren't sure about.";

/**
 * Execs: keep Agora up to date with Claude's help. Export a snapshot (with
 * instructions for Claude inside), give it to Claude with new emails and
 * invoices, and load the changes file Claude sends back. Every change is
 * shown against what Agora says now, and only ticked ones are written.
 */
export function ClaudeView({ client, fin, pur, reload, flash, me }: FinanceProps) {
  const where = whereLabel(pur);
  const evidence = useMemo(() => allEvidence(fin, pur.items, where), [fin, pur.items]);
  const resolved = useMemo(() => new Set(fin.resolutions.map((r) => r.key)), [fin.resolutions]);
  const ends = useMemo(() => looseEnds(fin.txns, evidence, resolved), [fin.txns, evidence, resolved]);

  async function exportSnapshot() {
    const snap = buildSnapshot({
      items: pur.items, projects: pur.projects, subteams: pur.subteams, carSubteams: pur.carSubteams, vendors: pur.vendors,
      accounts: fin.accounts, categories: fin.categories, txns: fin.txns, evidence: fin.evidence, reimbursements: fin.reimbursements,
      looseEnds: ends, exportedAt: new Date().toISOString(), exportedBy: me,
    });
    try {
      if (await saveTextFile(`agora-snapshot-${today()}.json`, JSON.stringify(snap, null, 1), { name: "JSON", extension: "json", mime: "application/json" })) {
        flash("Snapshot saved. Give it to Claude with the new emails and invoices.");
      }
    } catch (e) { flash(`Couldn't save the file: ${e instanceof Error ? e.message : String(e)}`, true); }
  }

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <p className="text-sm text-helios-dim">
        Claude can read order emails, invoices and receipts and work out what they mean for Agora: which parts shipped, which charge an invoice
        explains, how to split a charge. You hand it a snapshot and the documents; it hands back a list of changes; you tick the ones to make.
      </p>

      <Step n={1} title="Save a snapshot of Agora">
        <p className="text-xs text-helios-dim">
          One file with the parts list ({pur.items.length} parts), the ledger ({fin.txns.length} lines), invoices, reimbursements and the
          {" "}{ends.length} loose ends, plus instructions that tell Claude what to send back. Card and account numbers are only ever the last four
          digits, but it is the team's books: keep it private, and never put it in the Helios repository.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void exportSnapshot()}>Save snapshot</Button>
          <Button kind="ghost" onClick={() => void navigator.clipboard.writeText(PROMPT).then(() => flash("Copied. Paste it into Claude with the files."))}>
            Copy the message for Claude</Button>
        </div>
      </Step>

      <Step n={2} title="Give it to Claude">
        <ol className="ml-4 list-decimal space-y-1 text-sm text-helios-dim">
          <li>Start a new chat in Claude (claude.ai or the Claude app).</li>
          <li>Attach the snapshot and the new material: order confirmations and shipping emails (print to PDF, or paste the text), invoices and receipts, and a line on anything else that changed.</li>
          <li>Paste the message you copied, and send. Claude replies with <b className="text-helios-text">agora-changes.json</b>: download it.</li>
        </ol>
      </Step>

      <Step n={3} title="Load Claude's changes">
        <ChangesLoader {...{ client, fin, pur, reload, flash }} />
      </Step>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Card className="flex gap-4">
      <div className="grid size-7 shrink-0 place-items-center rounded-full bg-asu-gold/15 text-sm font-bold text-asu-gold">{n}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-2"><b>{title}</b>{children}</div>
    </Card>
  );
}

type Result = { ok: true } | { ok: false; error: string };

function ChangesLoader({ client, fin, pur, reload, flash }: Pick<FinanceProps, "client" | "fin" | "pur" | "reload" | "flash">) {
  const [file, setFile] = useState<{ name: string; basedOn: string; summary: string; changes: Record<string, unknown>[] } | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<Map<number, Result>>(new Map());
  const [busy, setBusy] = useState(false);
  const override = can(pur.caps, "purchasing.override");

  // re-checked against Agora every time it changes: once applied, a change shows as done
  const planned = useMemo(() => file ? planChanges(file.changes, {
    items: pur.items, projects: pur.projects, subteams: pur.subteams, vendors: pur.vendors, txns: fin.txns,
    evidence: fin.evidence, categories: fin.categories, override,
  }) : [], [file, pur, fin, override]);
  const doable = planned.filter((p) => p.action && !p.problem && !p.nothing);
  const notes = planned.filter((p) => p.note);
  const changes = planned.filter((p) => !p.note);

  async function pick(f: File) {
    try {
      const read = readChanges(await f.text());
      setFile({ name: f.name, ...read });
      setResults(new Map());
      // tick everything that can be applied
      const plan = planChanges(read.changes, {
        items: pur.items, projects: pur.projects, subteams: pur.subteams, vendors: pur.vendors, txns: fin.txns,
        evidence: fin.evidence, categories: fin.categories, override,
      });
      setTicked(new Set(plan.filter((p) => p.action && !p.problem && !p.nothing).map((p) => p.n)));
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  }

  async function apply() {
    if (!file) return;
    setBusy(true);
    const out = new Map(results);
    let done = 0, failed = 0;
    for (const p of doable) {
      if (!ticked.has(p.n) || !p.action) continue;
      try { await applyChange(client, p.action, `claude:${file.name}:${p.n}`); out.set(p.n, { ok: true }); done++; }
      catch (e) { out.set(p.n, { ok: false, error: e instanceof Error ? e.message : String(e) }); failed++; }
    }
    setResults(out);
    setTicked(new Set());
    await reload();
    setBusy(false);
    flash(failed ? `Made ${done} change${done === 1 ? "" : "s"}; ${failed} couldn't be made (see below).` : `Made ${done} change${done === 1 ? "" : "s"}.`, failed > 0);
  }

  const toggle = (n: number, on: boolean) => setTicked((s) => { const x = new Set(s); if (on) x.add(n); else x.delete(n); return x; });
  const tickedCount = doable.filter((p) => ticked.has(p.n)).length;

  return (
    <div className="flex flex-col gap-3">
      <label className="w-fit cursor-pointer rounded-md border border-helios-line px-3 py-1.5 text-sm hover:bg-helios-strip">
        {file ? `${file.name}: pick another` : "Pick agora-changes.json"}
        <input type="file" accept=".json,application/json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pick(f); }} />
      </label>

      {file && (
        <>
          {(file.summary || file.basedOn) && (
            <div className="rounded-md border border-helios-line bg-helios-strip/50 px-3 py-2 text-sm">
              {file.summary && <p>{file.summary}</p>}
              {file.basedOn && <p className="mt-1 text-xs text-helios-dim">Made from the snapshot saved {shortDate(file.basedOn)}. Every change below is
                compared with Agora as it is now, so anything already done since shows as done.</p>}
            </div>
          )}

          {notes.length > 0 && (
            <div className="rounded-md border border-asu-gold/50 bg-asu-gold/10 px-3 py-2 text-sm">
              <b>For you to check</b>
              <ul className="ml-4 mt-1 list-disc space-y-0.5">{notes.map((p) => <li key={p.n}>{p.note}</li>)}</ul>
            </div>
          )}

          {changes.length ? (
            <div className="overflow-hidden rounded-lg border border-helios-line">
              <div className="flex items-center gap-3 border-b border-helios-line bg-helios-strip px-3 py-2 text-xs text-helios-dim">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={doable.length > 0 && doable.every((p) => ticked.has(p.n))}
                    onChange={(e) => setTicked(e.target.checked ? new Set(doable.map((p) => p.n)) : new Set())} />
                  {doable.length} to make
                </label>
                <span>{changes.filter((p) => p.nothing).length} already true</span>
                {changes.some((p) => p.problem) && <span className="text-helios-danger">{changes.filter((p) => p.problem).length} can't be made</span>}
              </div>
              <div className="divide-y divide-helios-line">
                {changes.map((p) => <ChangeRow key={p.n} p={p} on={ticked.has(p.n)} toggle={toggle} result={results.get(p.n)} />)}
              </div>
            </div>
          ) : !notes.length && <Empty>That file has no changes.</Empty>}

          <div className="flex items-center gap-2">
            <Button disabled={busy || !tickedCount} onClick={() => void apply()}>{busy ? "Making changes..." : `Make ${tickedCount} change${tickedCount === 1 ? "" : "s"}`}</Button>
            <Button kind="ghost" onClick={() => { setFile(null); setResults(new Map()); }}>Close</Button>
            <span className="text-xs text-helios-dim">Each change goes through the same checks as doing it by hand, and shows in the history.</span>
          </div>
        </>
      )}
    </div>
  );
}

function ChangeRow({ p, on, toggle, result }: { p: Planned; on: boolean; toggle: (n: number, on: boolean) => void; result?: Result }) {
  const doable = !!p.action && !p.problem && !p.nothing;
  return (
    <div className={`flex gap-3 px-3 py-2.5 text-sm ${doable ? "" : "bg-helios-strip/30"}`}>
      <input type="checkbox" className="mt-1" disabled={!doable} checked={doable && on} onChange={(e) => toggle(p.n, e.target.checked)}
        aria-label={`Make change ${p.n}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`font-semibold ${doable ? "" : "text-helios-dim"}`}>{p.title || `Change ${p.n}`}</span>
          <Badge>{p.op.replace(/_/g, " ")}</Badge>
          {result?.ok && <Badge tone="good">done</Badge>}
          {result && !result.ok && <Badge tone="bad">failed</Badge>}
          {!result && p.nothing && <Badge tone="good">already true</Badge>}
          {p.problem && <Badge tone="bad">can't be made</Badge>}
        </div>
        {p.lines.length > 0 && (
          <table className="mt-1 text-xs">
            <tbody>{p.lines.map((l, k) => (
              <tr key={k}>
                <td className="whitespace-nowrap pr-3 align-top text-helios-dim">{l.field}</td>
                <td className="align-top">{l.from ? <><span className="text-helios-muted line-through decoration-helios-muted/50">{l.from}</span> <span className="text-helios-dim">to</span> </> : null}
                  <span className="font-medium">{l.to}</span></td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {p.why && <p className="mt-1 text-xs text-helios-dim"><span className="text-helios-muted">Claude's reason:</span> {p.why}</p>}
        {p.problem && <p className="mt-1 text-xs text-helios-danger">{p.problem}</p>}
        {!result?.ok && p.warnings.map((w, k) => <p key={k} className="mt-1 text-xs text-asu-gold">{w}</p>)}
        {result && !result.ok && <p className="mt-1 text-xs text-helios-danger">{result.error}</p>}
      </div>
    </div>
  );
}
