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
          />
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
