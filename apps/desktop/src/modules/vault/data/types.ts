export type VaultId = string;
export type FolderId = string;
export type FileId = string;
export type VersionId = string;
export type LockId = string;
export type UserId = string;

export interface Vault {
  id: VaultId;
  name: string;
  created_at: string;
  created_by: UserId;
  /** Optional flagship file for the vault (the project's master assembly),
   *  surfaced in the Insights view. DB-stored on pdm.vaults, admin-changeable.
   *  Null when no spotlight has been chosen. */
  spotlight_file_id?: FileId | null;
}

export interface Folder {
  id: FolderId;
  vault_id: VaultId;
  parent_id: FolderId | null;
  name: string;
  created_at: string;
}

export interface VaultFile {
  id: FileId;
  vault_id: VaultId;
  folder_id: FolderId | null;
  name: string;
  latest_version_id: VersionId | null;
  created_at: string;
  /** Latest version embedded directly on the file row (PostgREST
   *  `versions!files_latest_version_fk(...)`) so the file list carries the sha
   *  needed to download/check out WITHOUT a separate per-vault version fetch.
   *  Omitted by code paths / tests that don't request the embed; null when the
   *  file has no version. `properties` is excluded from the embed (the data
   *  card fetches that on demand) — see EmbeddedLatest. */
  latest?: EmbeddedLatest | null;
  /** Soft-delete metadata (pdm.files.deleted_at / deleted_by). Non-null
   *  deleted_at = the file is in the recycle bin: excluded from the normal
   *  browse list, listed by useDeletedFiles, recoverable via pdm_restore_file. */
  deleted_at?: string | null;
  deleted_by?: UserId | null;
}

/** The latest-version fields embedded on a file row — everything on Version
 *  except the (potentially large) `properties` jsonb. */
export type EmbeddedLatest = Omit<Version, "properties">;

/** PostgREST select that pulls each file plus its latest version embedded as
 *  `latest` (one to-one join over files_latest_version_fk). Used by useFiles /
 *  useAllFiles so the file list carries the download sha with no second pass.
 *  `properties` is intentionally omitted to keep the payload small at
 *  thousands-of-files scale. */
export const FILE_WITH_LATEST_SELECT =
  "*, latest:versions!files_latest_version_fk(id,file_id,version_num,sha256,size_bytes,author_id,comment,parent_version_id,revision,created_at)";

export interface Version {
  id: VersionId;
  file_id: FileId;
  version_num: number;
  sha256: string;
  size_bytes: number;
  author_id: UserId | null;
  comment: string | null;
  parent_version_id: VersionId | null;
  /** Manually-stamped numeric revision (SW-PDM "Set Revision"), or null if this
   *  version has never been given a revision. Distinct from `version_num`. */
  revision: number | null;
  /** SolidWorks custom properties parsed from the file (data card), or null if
   *  not parsed yet. */
  properties: SwProperty[] | null;
  created_at: string;
}

/** A SolidWorks custom property name/value pair (data-card field). */
export interface SwProperty {
  name: string;
  value: string;
}

export interface Lock {
  id: LockId;
  file_id: FileId;
  user_id: UserId;
  acquired_at: string;
  released_at: string | null;
  force_released_by: UserId | null;
}

/** Role tiers in pdm.user_roles. `owner` is the super-user (set only via the
 *  bootstrap script); the others are managed from the in-app Admin panel. */
export type VaultRole = "owner" | "admin" | "editor" | "viewer";

/** A selectable SDM subteam. The list is managed in pdm.subteams (not
 *  hard-coded) and every account picks one at sign-up. */
export interface Subteam {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

/** One row from the admin_list_users RPC — every auth user plus their role
 *  (null when they've signed up but not been granted access yet), display
 *  name, and chosen subteam. */
export interface VaultUser {
  user_id: UserId;
  email: string | null;
  display_name: string | null;
  subteam: string | null;
  role: VaultRole | null;
  granted_at: string | null;
  created_at: string;
}

/** Common shape returned by every data hook. */
export interface QueryResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}
