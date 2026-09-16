import { useEffect, useRef } from "react";

/** Shared modal a11y: Escape-to-close, focus-trap, and focus-restore.
 *  Mirrors the recipe in components/ConfirmDialog.tsx. Returns a ref to
 *  attach to the dialog container so the trap knows its bounds. */
export function useModalA11y(open: boolean, onClose: () => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    // Focus-restore: remember whatever was focused when the modal opened.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    function focusable(): HTMLElement[] {
      const root = containerRef.current;
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        // stopImmediatePropagation (not just stopPropagation): both are
        // attached to `window`, so plain stopPropagation does NOT stop a
        // SIBLING window keydown listener. Immediate stop prevents one Escape
        // cascading into background handlers / a stacked dialog.
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab") {
        const els = focusable();
        const first = els[0];
        const last = els[els.length - 1];
        if (!first || !last) return;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !containerRef.current?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Focus-restore on unmount/close.
      previouslyFocused?.focus?.();
    };
  }, [open]);

  return containerRef;
}
