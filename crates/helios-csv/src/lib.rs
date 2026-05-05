pub mod delimiter;
pub mod load;
pub mod registry;
pub mod time_detect;

pub use load::{load_csv, load_csv_bytes, LoadResult};
pub use registry::ChannelRegistry;

#[derive(Debug, thiserror::Error)]
pub enum CsvLoadError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("csv: {0}")]
    Csv(#[from] csv::Error),
    #[error("malformed: {0}")]
    Malformed(String),
    #[error("core: {0}")]
    Core(#[from] helios_core::rate_group::RateGroupError),
}
