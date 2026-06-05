export interface GamesModuleProps {
  /** True while another module is the active tab — games must halt their
   *  loops so a hidden game doesn't burn CPU or rack up time-based score. */
  paused: boolean;
}

export function GamesModule({ paused }: GamesModuleProps) {
  return (
    <div className="flex h-full items-center justify-center bg-helios-base text-helios-dim">
      Games module — coming up. {paused ? "(paused)" : ""}
    </div>
  );
}
