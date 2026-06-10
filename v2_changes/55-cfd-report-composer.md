# 55 — CFD: report composer — pick designs, print straight to PDF, redesigned doc

**Date:** 2026-06-09 · Frontend-only. Refines #54 per feedback.

- **Pickable scope:** every "Report (PDF)" button now opens a composer dialog
  listing all studies (kind chip + name + date, All/None). The report's
  sections AND its comparison cover exactly the checked designs — no more
  comparing every sweep on the machine. Screens pre-check their natural
  scope (open study on results screens, pinned set on Compare).
- **Real PDF path:** "Print → PDF" loads the report into a hidden iframe and
  invokes the native print dialog (Save as PDF) directly from the app; if the
  webview refuses, it falls back to saving the HTML. "Save HTML" stays for
  archiving.
- **Document redesign:** accent-banded cover with a metadata strip, two-column
  linked TOC, numbered section headers with accent rules, headline stat cards
  on the executive summary, dark table headers + zebra rows + highlighted
  best-design row, and charts rebuilt with gridlines, labeled ticks on both
  axes, and a boxed legend.

3 composer tests (default scope, picked-set comparison, disabled at zero);
475 CFD tests + typecheck green.
