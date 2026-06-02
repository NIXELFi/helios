import type { ReactNode } from "react";

export function ViewHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-helios-line bg-helios-panel/40 px-6 py-4">
      <div className="max-w-full shrink-0">
        <h1 className="text-lg font-medium text-helios-text">{title}</h1>
        {description ? (
          <p className="mt-0.5 text-xs text-helios-dim">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
