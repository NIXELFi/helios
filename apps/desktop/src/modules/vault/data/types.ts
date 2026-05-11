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
}

export interface Version {
  id: VersionId;
  file_id: FileId;
  version_num: number;
  sha256: string;
  size_bytes: number;
  author_id: UserId | null;
  comment: string | null;
  parent_version_id: VersionId | null;
  created_at: string;
}

export interface Lock {
  id: LockId;
  file_id: FileId;
  user_id: UserId;
  acquired_at: string;
  released_at: string | null;
  force_released_by: UserId | null;
}

/** Common shape returned by every data hook. */
export interface QueryResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}
