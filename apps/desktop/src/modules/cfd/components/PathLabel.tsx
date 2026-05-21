import { basename, displayPath } from "../lib/cfdPath";

export function PathLabel({ path, className }: { path: string; className?: string }) {
  return (
    <span className={className} title={path} aria-label={path}>
      {basename(path)}
    </span>
  );
}

export function FullPathLabel({ path, maxLen, className }: { path: string; maxLen?: number; className?: string }) {
  return (
    <span className={className} title={path} aria-label={path}>
      {displayPath(path, maxLen)}
    </span>
  );
}
