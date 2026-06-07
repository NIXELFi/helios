-- PR #7 (PM v4) adds three manufacturing task types. Code literals
-- (packages/pm-ui/src/types.ts taskType z.enum) are snake_case:
-- mfg_laser / mfg_machine / mfg_weld — the "MFG-LZR / MFG-MCH / MFG-WELD"
-- strings in the PR description are display labels only.
--
-- Additive + backward-compatible: a client that never offers these values
-- (e.g. the deployed v4.1.1 app) is unaffected, so this is safe to apply ahead
-- of the v4.2.0 release. NOT cleanly reversible (Postgres can't drop an enum
-- value) — prefer roll-forward.
ALTER TYPE pm.task_type ADD VALUE IF NOT EXISTS 'mfg_laser';
ALTER TYPE pm.task_type ADD VALUE IF NOT EXISTS 'mfg_machine';
ALTER TYPE pm.task_type ADD VALUE IF NOT EXISTS 'mfg_weld';
