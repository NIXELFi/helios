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
