// Render harness for the Add to Marketplace surfaces. NOT part of the app build.
// Renders the REAL components against stubbed IO so they can be screenshotted and
// looked at. Pick a view with ?view=… (wizard | review | help); add &dirty=1 for
// the fixture whose pre-flight fails. The wizard is driven by real clicks from
// the screenshot script, so what is captured is what the state machine produces.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { SubmitWizard } from "../src/modules/marketplace/publish/SubmitWizard";
import { ReviewView } from "../src/modules/marketplace/review/ReviewView";
import { HelpDrawer } from "../src/modules/marketplace/authoring/HelpDrawer";
import { MyPluginsView } from "../src/modules/marketplace/manage/MyPluginsView";
import { InstalledView } from "../src/modules/marketplace/views/InstalledView";
import { FolderBatchDialog } from "../src/modules/vault/components/FolderBatchDialog";

const noop = () => {};
const INSTALLED = [
  {
    id: "aero.downforce-calculator", name: "Downforce Calculator", subteam: "Aerodynamics",
    isRecommended: true, version: "1.2.0", manifest: {}, permissions: ["storage"],
    installedVersion: "1.3.0", publishedAt: "2026-07-14T10:00:00Z",
    isPreview: true, installedStatus: "pending", hasApprovedVersion: true,
  },
  {
    id: "chassis.coast", name: "COAST", subteam: "Chassis", isRecommended: false,
    version: "0.9.0", manifest: {}, permissions: [], installedVersion: "0.8.0",
    publishedAt: "2026-07-10T10:00:00Z", isPreview: false, installedStatus: "approved",
  },
  {
    id: "rf.aether", name: "Aether RF", subteam: "Electrical", isRecommended: false,
    version: "1.2.0", manifest: {}, permissions: [], installedVersion: "1.2.0",
    publishedAt: "2026-07-10T10:00:00Z", isPreview: false, installedStatus: "yanked",
  },
] as never;

// Folder check-out / check-in fixture: Brakes/ with a Rotors/ subfolder, a
// teammate holding two files, one checked out to "me", one local edit.
const VAULT_FOLDERS = [
  { id: "fB", vault_id: "v", parent_id: null, name: "Brakes", created_at: "x" },
  { id: "fR", vault_id: "v", parent_id: "fB", name: "Rotors", created_at: "x" },
] as never[];
const VAULT_NAMES = [
  ["fB", "caliper_body.SLDPRT"], ["fB", "caliper_assy.SLDASM"], ["fB", "pad_backing.SLDPRT"],
  ["fR", "rotor_front.SLDPRT"], ["fR", "rotor_rear.SLDPRT"], ["fR", "hub_carrier.SLDPRT"],
  ["fR", "bell_front.SLDPRT"], ["fR", "bell_rear.SLDPRT"], ["fR", "rotor_drawing.SLDDRW"],
] as const;
const VAULT_FILES = VAULT_NAMES.map(([folder_id, name], i) => ({
  id: `file${i}`, vault_id: "v", folder_id, name, latest_version_id: `ver${i}`, created_at: "x",
})) as never[];
function folderBatchCtx(checkin: boolean) {
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const lock = (i: number, user_id: string, m: number) => ({
    id: `l${i}`, file_id: `file${i}`, user_id, acquired_at: ago(m), released_at: null, force_released_by: null,
  });
  const rel = (i: number) => `${VAULT_NAMES[i]![0] === "fB" ? "Brakes" : "Brakes/Rotors"}/${VAULT_NAMES[i]![1]}`;
  const local = (i: number, sha: string, readonly: boolean) => ({
    basename: VAULT_NAMES[i]![1], relativePath: rel(i), absolutePath: `/vault/${rel(i)}`, sha256: sha, sizeBytes: 1, readonly,
  });
  return {
    files: VAULT_FILES,
    localFiles: checkin
      ? [local(0, "edited", false), local(1, "sha1", false), local(2, "edited", false), local(3, "edited", false), local(5, "sha5", true)]
      : [local(0, "sha0", true), local(4, "edited", false), local(5, "sha5", true)],
    versionsByFileId: new Map(VAULT_NAMES.map((_, i) => [`file${i}`, [{ id: `ver${i}`, file_id: `file${i}`, sha256: `sha${i}` }]])),
    vaultRoot: "/vault",
    folders: VAULT_FOLDERS,
    vaultId: "v",
    locks: checkin
      ? [lock(0, "me", 90), lock(1, "me", 90), lock(3, "alice", 30), lock(7, "me", 200), lock(8, "bob", 60 * 26)]
      : [lock(3, "alice", 30), lock(8, "bob", 60 * 26), lock(6, "me", 5)],
    currentUserId: "me",
    holderLabelById: new Map([["alice", "Alice Nguyen"], ["bob", "Bob Ramirez"]]),
  } as never;
}

const view = new URLSearchParams(location.search).get("view") ?? "wizard";

function Harness() {
  if (view === "review") {
    return (
      <div className="min-h-screen bg-helios-base">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <h1 className="mb-5 font-display text-2xl tracking-wide text-asu-gold">REVIEW</h1>
          <ReviewView
            available={[{ id: "aero.downforce-calculator", permissions: ["storage"] }] as never}
            onHelp={() => {}}
            onOpenPreview={() => {}}
          />
        </div>
      </div>
    );
  }
  if (view === "mine" || view === "installed") {
    return (
      <div className="min-h-screen bg-helios-base">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <h1 className="mb-5 font-display text-2xl tracking-wide text-asu-gold">
            {view === "mine" ? "MY PLUGINS" : "INSTALLED"}
          </h1>
          {view === "mine" ? (
            <MyPluginsView onHelp={noop} onAdd={noop} />
          ) : (
            <InstalledView
              plugins={INSTALLED}
              loading={false}
              error={null}
              busyId={null}
              onOpen={noop}
              onUpdate={noop}
              onUninstall={noop}
              onOpenDetail={noop}
            />
          )}
        </div>
      </div>
    );
  }
  if (view === "folder-checkout" || view === "folder-checkin") {
    return (
      <div className="min-h-screen bg-helios-base">
        <FolderBatchDialog
          op={view === "folder-checkout" ? "checkout" : "checkin"}
          scope={{ kind: "folder", name: "Brakes", folderId: "fB" }}
          scopeFiles={VAULT_FILES}
          ctx={folderBatchCtx(view === "folder-checkin")}
          onClose={noop}
          onDone={noop}
        />
      </div>
    );
  }
  if (view === "help") {
    return (
      <div className="min-h-screen bg-helios-base">
        <HelpDrawer open topic="network" onClose={() => {}} onTopicChange={() => {}} />
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-helios-base">
      <SubmitWizard onClose={() => {}} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
