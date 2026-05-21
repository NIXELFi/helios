// Phase 2 ConfigScreen — full editor. Wraps the entire screen in
// <EditorProvider> so every field reads from + writes to the editor's
// draft. Header gains Save / Save As / Discard / Diff / New buttons
// and a dirty asterisk on the path.

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { useCfd } from "../state/CfdContext";
import { useEditor } from "../editor/state/editor-context";
import { NumberField } from "../editor/fields/NumberField";
import { TextField } from "../editor/fields/TextField";
import { SelectField } from "../editor/fields/SelectField";
import { CdTableField, type CdRow } from "../editor/fields/CdTableField";
import { PipeArrayField, type PipeRow as PipeRowData } from "../editor/fields/PipeArrayField";
import { FiringOrderField } from "../editor/fields/FiringOrderField";
import { ConfigDiffModal } from "../editor/diff/ConfigDiffModal";
import { TemplatePickerModal } from "../editor/templates/TemplatePickerModal";
import {
  SDM26_GROUPS,
  SDM26_SCHEMA,
  VALVE_FIELDS,
  deriveTopology,
  type FieldMeta,
  type Topology,
} from "../lib/sdm26Schema";
import { getAt } from "../editor/lib/path-helpers";
import { FullPathLabel } from "../components/PathLabel";
import type { ExampleConfig } from "../state/types";

export function ConfigScreen() {
  // EditorProvider is hoisted to CfdHome so edits survive nav switches.
  return <ConfigScreenBody />;
}

function ConfigScreenBody() {
  const { state: cfdState, bridge, setLoadedConfig } = useCfd();
  const editor = useEditor();
  const [examples, setExamples] = useState<ExampleConfig[]>([]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    bridge.listExamples().then(setExamples).catch(() => setExamples([]));
  }, [bridge]);

  async function loadFromPath(path: string) {
    setLoadError(null);
    setLoading(true);
    try {
      const loaded = await bridge.loadConfig(path);
      setLoadedConfig(loaded);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleOpen() {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Engine config", extensions: ["json"] }],
    });
    if (typeof picked === "string") {
      await loadFromPath(picked);
    }
  }

  const { state, dispatch, isDirty, canSave } = editor;
  const loaded = cfdState.loadedConfig;
  const hasConfig = loaded != null && Object.keys(state.draft).length > 0;

  return (
    <div className="flex h-full flex-col bg-[#0B0B0D] text-[#D8DCE2]">
      {/* Header */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wider text-[#FFC627]">
            Engine config
          </div>
          {hasConfig ? (
            <div className="flex items-center gap-1 text-[10px] text-[#5A5F66]">
              <FullPathLabel
                path={state.savedPath ?? "(unsaved)"}
                maxLen={140}
              />
              {isDirty && <span className="text-[#FFC627]">*</span>}
              {state.isExample && <span className="text-[#FFC627]">(example: Save will become Save As)</span>}
            </div>
          ) : (
            <p className="text-[10px] text-[#5A5F66]">No config loaded.</p>
          )}
        </div>

        <HeaderButton onClick={() => dispatch({ type: "openTemplatePicker" })}>New…</HeaderButton>
        <HeaderButton onClick={handleOpen} disabled={loading}>Open…</HeaderButton>
        <div className="relative">
          <HeaderButton
            disabled={loading || examples.length === 0}
            onClick={() => setExamplesOpen((v) => !v)}
            aria-expanded={examplesOpen}
            aria-haspopup="menu"
          >
            Examples ▾
          </HeaderButton>
          {examplesOpen && examples.length > 0 && (
            <div role="menu" className="absolute right-0 z-10 mt-1 w-80 rounded-sm border border-[#2A2C32] bg-[#0E0E10] shadow-lg">
              {examples.map((ex) => (
                <button
                  key={ex.id}
                  type="button"
                  role="menuitem"
                  className="block w-full border-b border-[#16171B] px-3 py-2 text-left last:border-b-0 hover:bg-[#16171B]"
                  onClick={() => {
                    setExamplesOpen(false);
                    void loadFromPath(ex.path);
                  }}
                >
                  <div className="text-[11px] text-[#D8DCE2]">{ex.name}</div>
                  <div className="mt-0.5 text-[10px] text-[#5A5F66]">{ex.description}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        {hasConfig && (
          <HeaderButton onClick={() => dispatch({ type: "openDiff" })}>Diff…</HeaderButton>
        )}
        {isDirty && (
          <HeaderButton onClick={() => editor.discard()}>Discard</HeaderButton>
        )}
        <HeaderButton
          onClick={() => editor.save()}
          disabled={!canSave}
          variant="gold"
        >
          Save
        </HeaderButton>
        <HeaderButton
          onClick={() => editor.saveAs()}
          disabled={!isDirty}
        >
          Save As…
        </HeaderButton>
      </header>

      {loadError && (
        <div className="flex-shrink-0 border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-200" role="alert">
          {loadError}
        </div>
      )}
      {state.globalError && (
        <div className="flex-shrink-0 border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-200" role="alert">
          {state.globalError}
        </div>
      )}
      {editor.hasFieldErrors && (
        <div className="flex-shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200" role="status">
          {Object.keys(state.fieldErrors).length} field issue{Object.keys(state.fieldErrors).length === 1 ? "" : "s"} — fix highlighted fields before saving.
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {!hasConfig ? (
          <EmptyState onOpen={handleOpen} onNew={() => dispatch({ type: "openTemplatePicker" })} />
        ) : (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {SDM26_GROUPS.map((g) => (
              <GroupSection key={g} title={g} />
            ))}
            <ValveCard
              title="Intake valve"
              path="intake_valve"
              cdTablePath="intake_valve.cd_table"
            />
            <ValveCard
              title="Exhaust valve"
              path="exhaust_valve"
              cdTablePath="exhaust_valve.cd_table"
            />
            <PipesCard title="Intake runners" pipesKey="intake_pipes" minRows={1} />
            <PipesCard title="Exhaust primaries" pipesKey="exhaust_primaries" minRows={1} />
            {deriveTopology(state.draft) === "4-2-1" && (
              <PipesCard title="Exhaust secondaries" pipesKey="exhaust_secondaries" minRows={2} />
            )}
          </div>
        )}
      </div>

      {state.diffOpen && <ConfigDiffModal onClose={() => dispatch({ type: "closeDiff" })} />}
      {state.templatePickerOpen && (
        <TemplatePickerModal
          onClose={() => dispatch({ type: "closeTemplatePicker" })}
        />
      )}
    </div>
  );
}

function HeaderButton({
  children,
  onClick,
  disabled,
  variant = "default",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "gold" }) {
  const cls =
    variant === "gold"
      ? "rounded-sm bg-[#FFC627] px-2 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300 disabled:opacity-40"
      : "rounded-sm border border-[#2A2C32] bg-[#16171B] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627] disabled:opacity-40";
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}

function EmptyState({ onOpen, onNew }: { onOpen: () => void; onNew: () => void }) {
  return (
    <div className="mx-auto mt-12 max-w-lg rounded-sm border border-[#2A2C32] bg-[#0E0E10] p-8 text-center">
      <div className="text-[11px] uppercase tracking-wider text-[#FFC627]">
        Open a config to get started
      </div>
      <p className="mt-3 text-[11px] text-[#9097A0]">
        Phase 2 supports the V1 SDM JSON schema as an editable form. Open
        an existing file, pick a bundled example, or start from a template.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <button
          type="button"
          className="rounded-sm border border-[#2A2C32] bg-[#16171B] px-3 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
          onClick={onNew}
        >
          New from template…
        </button>
        <button
          type="button"
          className="rounded-sm bg-[#FFC627] px-3 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300"
          onClick={onOpen}
        >
          Open…
        </button>
      </div>
    </div>
  );
}

function GroupSection({ title }: { title: string }) {
  const editor = useEditor();
  const { state } = editor;
  const fields = SDM26_SCHEMA.filter((f) => f.group === title);

  return (
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="border-b border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0]">
        {title}
      </div>
      <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 p-2">
        {fields.map((meta) => (
          <FieldRow key={meta.key} meta={meta} draft={state.draft} fieldErrors={state.fieldErrors} />
        ))}
      </div>
    </section>
  );
}

function FieldRow({
  meta, draft, fieldErrors,
}: {
  meta: FieldMeta;
  draft: Record<string, unknown>;
  fieldErrors: Record<string, string>;
}) {
  const editor = useEditor();
  // Synthetic __topology — handled by SelectField special-cased below.
  if (meta.key === "__topology") {
    const topology = deriveTopology(draft);
    return (
      <>
        <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">{meta.label}</span>
        <SelectField
          meta={meta}
          value={topology}
          onChange={(v) => editor.dispatch({ type: "changeTopology", topology: v as Topology })}
        />
      </>
    );
  }
  // firing_order has its own widget; rendered specially in the Engine group.
  if (meta.key === "firing_order") {
    const nCyl = Number(getAt(draft, "n_cylinders") ?? 0);
    const value = (getAt(draft, "firing_order") as number[]) ?? [];
    return (
      <>
        <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">{meta.label}</span>
        <FiringOrderField
          value={value}
          nCylinders={nCyl}
          onChange={(next) => editor.dispatch({ type: "setField", path: "firing_order", value: next })}
        />
      </>
    );
  }
  const value = getAt(draft, meta.key);
  const error = fieldErrors[meta.key] ?? null;
  const onChange = (next: unknown) => editor.dispatch({ type: "setField", path: meta.key, value: next });
  return (
    <>
      <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">{meta.label}</span>
      <FieldByType meta={meta} value={value} error={error} onChange={onChange} />
    </>
  );
}

function FieldByType({
  meta, value, error, onChange,
}: {
  meta: FieldMeta;
  value: unknown;
  error: string | null;
  onChange: (next: unknown) => void;
}) {
  switch (meta.type) {
    case "number":
    case "integer":
      return <NumberField meta={meta} value={value} error={error} onChange={onChange} />;
    case "text":
      return <TextField meta={meta} value={value} error={error} onChange={onChange} />;
    case "select":
      return <SelectField meta={meta} value={value} error={error} onChange={onChange} />;
    case "boolean":
      return <span className="text-[11px] text-[#5A5F66]">(unsupported in Phase 2)</span>;
  }
}

function ValveCard({
  title, path, cdTablePath,
}: {
  title: string;
  path: "intake_valve" | "exhaust_valve";
  cdTablePath: string;
}) {
  const editor = useEditor();
  const { state } = editor;
  const valveDraft = (getAt(state.draft, path) as Record<string, unknown>) ?? {};
  const cdTable = (getAt(state.draft, cdTablePath) as CdRow[]) ?? [];

  return (
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10] lg:col-span-2">
      <div className="border-b border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0]">
        {title}
      </div>
      <div className="grid grid-cols-1 gap-2 p-2 md:grid-cols-2">
        <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1">
          {VALVE_FIELDS.map((m) => {
            // Per-valve subschema uses keys like "diameter". Rebase to path.diameter.
            const fullPath = `${path}.${m.key}`;
            const error = state.fieldErrors[fullPath] ?? null;
            return (
              <FieldRow
                key={fullPath}
                meta={{ ...m, key: fullPath }}
                draft={state.draft}
                fieldErrors={state.fieldErrors}
              />
            );
          })}
        </div>
        <CdTableField
          value={cdTable}
          onChange={(next) =>
            editor.dispatch({ type: "setCdTable", valveKey: path, table: next })
          }
        />
      </div>
      {/* valveDraft visible to silence the unused-binding warning in dev */}
      <div className="hidden">{Object.keys(valveDraft).length}</div>
    </section>
  );
}

function PipesCard({
  title, pipesKey, minRows,
}: {
  title: string;
  pipesKey: "intake_pipes" | "exhaust_primaries" | "exhaust_secondaries";
  minRows: number;
}) {
  const editor = useEditor();
  const rows = (editor.state.draft[pipesKey] as PipeRowData[] | undefined) ?? [];
  return (
    <div className="lg:col-span-2">
      <PipeArrayField
        title={title}
        rows={rows}
        minRows={minRows}
        onChange={(next) => {
          // Bulk row commit: dispatch setPipeRow per changed index. The
          // PipeArrayField commits one row at a time so onChange always
          // arrives with exactly one row changed — but be defensive and
          // dispatch the whole new array via setField.
          editor.dispatch({ type: "setField", path: pipesKey, value: next });
        }}
        onAdd={() => editor.dispatch({ type: "addPipeRow", pipesKey })}
        onDuplicate={(i) => editor.dispatch({ type: "duplicatePipeRow", pipesKey, index: i })}
        onRemove={(i) => editor.dispatch({ type: "removePipeRow", pipesKey, index: i })}
      />
    </div>
  );
}
