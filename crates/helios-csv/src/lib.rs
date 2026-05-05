pub mod delimiter;
pub mod registry;
pub mod time_detect;

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
