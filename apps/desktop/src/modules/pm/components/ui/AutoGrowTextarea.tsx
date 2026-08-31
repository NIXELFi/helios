"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type TextareaHTMLAttributes,
} from "react";

export interface AutoGrowTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows"> {
  /** Height the empty box opens at, in lines. */
  minRows?: number;
  /** Height it stops growing at; past this the textarea scrolls internally. */
  maxRows?: number;
}

/**
 * A textarea that opens several lines tall and then grows with its content
 * instead of trapping a long description in a three-line slot (reported: "if
 * the task description was just a few lines taller it would make reading a lot
 * easier").
 *
 * Growth is driven off scrollHeight, re-measured whenever the value changes —
 * which covers programmatic changes (switching tasks in the detail sheet, a
 * form reset) as well as typing. Above `maxRows` the box stops and scrolls, so
 * one enormous description can't push the rest of a panel off-screen.
 */
export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(
  function AutoGrowTextarea({ minRows = 6, maxRows = 18, value, onChange, ...rest }, forwardedRef) {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    const resize = useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      const styles = window.getComputedStyle(el);
      const line = parseFloat(styles.lineHeight);
      // jsdom (and any engine that hasn't laid the box out yet) reports 0 for
      // scrollHeight and "normal" for lineHeight — leave the rows= height alone
      // rather than collapsing the box to nothing.
      if (!Number.isFinite(line) || line <= 0) return;
      const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
      const border = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
      el.style.height = "auto";
      const content = el.scrollHeight;
      if (content <= 0) {
        el.style.height = "";
        return;
      }
      const min = line * minRows + padding + border;
      const max = line * maxRows + padding + border;
      const next = Math.min(Math.max(content + border, min), max);
      el.style.height = `${next}px`;
      el.style.overflowY = content + border > max ? "auto" : "hidden";
    }, [minRows, maxRows]);

    useLayoutEffect(resize, [resize, value]);

    // Re-measure when the box's WIDTH changes (panel resize, window resize):
    // reflowed text can need a different number of lines. Width only — resize()
    // writes the element's height, so reacting to height here would feed the
    // observer its own output and spin forever.
    useEffect(() => {
      const el = innerRef.current;
      if (!el || typeof ResizeObserver === "undefined") return;
      let lastWidth = el.clientWidth;
      const ro = new ResizeObserver(() => {
        const width = el.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        resize();
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [resize]);

    return (
      <textarea
        ref={setRefs}
        rows={minRows}
        value={value}
        onChange={(e) => {
          onChange?.(e);
          resize();
        }}
        {...rest}
      />
    );
  },
);
