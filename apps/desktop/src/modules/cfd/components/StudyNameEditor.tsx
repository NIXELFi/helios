// Inline click-to-edit study name, shared by the Studies list and every
// results header so rename behavior can't drift between screens.
//
// Accessibility contract:
// - The idle state is a real <button> (keyboard reachable, Enter/Space opens
//   the editor) labeled "Rename <name>".
// - The editing state is a labeled <input>; Enter commits, Escape cancels,
//   blur commits (standard inline-rename semantics). Focus moves into the
//   input on open and back to the button on close, so keyboard users never
//   lose their place.
// - Committing blank clears the custom name (falls back to the config name).

import { useEffect, useRef, useState } from "react";

interface Props {
  /** Current display name (custom name or config-basename fallback). */
  display: string;
  /** The custom name only (undefined → currently on the fallback). Seeds the
   *  editor so editing a fallback-named study starts from an empty field. */
  customName: string | undefined;
  onRename: (name: string | null) => void;
  className?: string;
}

export function StudyNameEditor({ display, customName, onRename, className }: Props) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const close = (commit: boolean) => {
    if (commit && inputRef.current) {
      const v = inputRef.current.value.trim();
      onRename(v.length > 0 ? v : null);
    }
    setEditing(false);
    // Hand focus back so keyboard users don't drop to <body>.
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label="Study name"
        defaultValue={customName ?? ""}
        placeholder={display}
        onKeyDown={(e) => {
          if (e.key === "Enter") close(true);
          else if (e.key === "Escape") close(false);
        }}
        onBlur={() => close(true)}
        className={
          "min-w-0 rounded-sm border border-[#FFC627] bg-[#0B0B0D] px-1 py-0 font-mono text-inherit text-[#D8DCE2] focus:outline-none " +
          (className ?? "")
        }
      />
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`Rename ${display}`}
      title="Click to rename"
      onClick={() => setEditing(true)}
      className={
        "min-w-0 cursor-text truncate rounded-sm text-left text-inherit hover:bg-[#16171B] focus:outline-none focus-visible:ring-1 focus-visible:ring-[#FFC627]/60 " +
        (className ?? "")
      }
    >
      {display}
      <span aria-hidden className="ml-1 select-none text-[9px] text-[#5A5F66] opacity-0 transition-opacity group-hover:opacity-100">
        ✎
      </span>
    </button>
  );
}
