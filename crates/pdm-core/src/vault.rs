use crate::ids::{FileId, FolderId, LockId, UserId, VaultId, VersionId};
use crate::sha256::Sha256;
use alloc::string::String;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vault {
    pub id: VaultId,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub created_by: UserId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub id: FolderId,
    pub vault_id: VaultId,
    pub parent_id: Option<FolderId>,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct File {
    pub id: FileId,
    pub vault_id: VaultId,
    pub folder_id: Option<FolderId>,
    pub name: String,
    pub latest_version_id: Option<VersionId>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Version {
    pub id: VersionId,
    pub file_id: FileId,
    pub version_num: u32,
    pub sha256: Sha256,
    pub size_bytes: u64,
    pub author_id: UserId,
    pub comment: Option<String>,
    pub parent_version_id: Option<VersionId>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lock {
    pub id: LockId,
    pub file_id: FileId,
    pub user_id: UserId,
    pub acquired_at: DateTime<Utc>,
    pub released_at: Option<DateTime<Utc>>,
    pub force_released_by: Option<UserId>,
}

impl Lock {
    pub fn is_active(&self) -> bool {
        self.released_at.is_none()
    }

    pub fn was_force_released(&self) -> bool {
        self.released_at.is_some() && self.force_released_by.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ref {
    pub parent_version_id: VersionId,
    pub child_path_hint: String,
    pub child_file_id: Option<FileId>,
}
