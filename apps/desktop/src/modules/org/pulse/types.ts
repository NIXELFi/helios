// Row/document shapes returned by the pdm_admin_ops_* RPCs
// (infra/pdm-supabase/supabase/migrations/20260915000000_pdm_admin_ops_dashboard.sql).

/** One UTC day of growth + activity, from pdm.ops_daily (today is computed live). */
export interface OpsDay {
  day: string; // YYYY-MM-DD
  users_total: number;
  users_new: number;
  active_users: number;
  vault_actions: number;
  pm_actions: number;
  games_plays: number;
  notify_sent: number;
  notify_failed: number;
  files_total: number;
  versions_total: number;
  content_bytes: number;
  storage_bytes: number | null;
  db_bytes: number | null;
  vault_files: Record<string, number>;
  computed_at: string;
}

export interface OpsCronJob {
  name: string;
  schedule: string;
  active: boolean;
  last_status: string | null;
  last_start: string | null;
  last_ms: number | null;
}

export interface OpsVault {
  name: string;
  files: number;
  versions: number;
  bytes: number;
  locks: number;
  actions_7d: number;
}

export interface OpsOverview {
  as_of: string;
  today: OpsDay;
  online_now: number;
  active_7d: number;
  active_30d: number;
  users_new_7d: number;
  users_new_30d: number;
  sessions_live: number;
  locks_active: number;
  drafts_unpublished: number;
  recycle_bin: number;
  notify: { queued: number; failed_24h: number; sent_24h: number; last_sent: string | null };
  games: { bets_24h: number; scores_24h: number; players_7d: number; banned: number };
  db: {
    bytes: number;
    connections: number;
    connections_active: number;
    max_connections: number;
    cache_hit_pct: number;
    tables: Array<{ name: string; bytes: number; rows: number | null }>;
  };
  storage: { bytes: number; objects: number };
  cron: OpsCronJob[];
  vaults: OpsVault[];
}

export interface OpsPerson {
  user_id: string;
  email: string | null;
  display_name: string | null;
  subteam: string | null;
  role: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  last_active: string | null;
  online: boolean;
  vault_actions_30d: number;
  pm_actions_30d: number;
  games_30d: number;
}

export type OpsSource = "vault" | "pm" | "games";

export interface OpsHourCell {
  source: OpsSource | string;
  dow: number; // 0 = Monday ... 6 = Sunday (ISO dow - 1)
  hour: number; // 0..23 UTC
  n: number;
}
