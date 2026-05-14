import type { WidgetConfigEditorProps } from "../types";
import type { LapDeltaConfig } from "./render";

export function LapDeltaConfigEditor(_props: WidgetConfigEditorProps<LapDeltaConfig>) {
  return (
    <div className="p-2 text-xs text-[#9097A0]">
      <p>
        Δt traces lap-time differences along distance for the globally selected
        Main and Ref laps. Pick those in the Lap Panel — this widget needs no
        per-tile configuration.
      </p>
      <p className="mt-2">
        <span className="text-[#EF5350]">Red</span> = Main is slower at this point.
        {" "}<span className="text-[#66BB6A]">Green</span> = Main is faster.
        The final number in the header is the total lap-time delta.
      </p>
    </div>
  );
}
