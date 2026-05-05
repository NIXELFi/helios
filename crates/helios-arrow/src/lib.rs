use arrow::record_batch::RecordBatch;
use arrow_ipc::reader::StreamReader;
use arrow_ipc::writer::StreamWriter;
use helios_core::RateGroup;
use std::io::Cursor;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ArrowIpcError {
    #[error("arrow error: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
}

/// Serialize a RateGroup's RecordBatch to Arrow IPC stream bytes (zero-copy on the read side).
pub fn batch_to_ipc(batch: &RecordBatch) -> Result<Vec<u8>, ArrowIpcError> {
    let mut buf = Vec::new();
    {
        let mut w = StreamWriter::try_new(&mut buf, &batch.schema())?;
        w.write(batch)?;
        w.finish()?;
    }
    Ok(buf)
}

/// Deserialize Arrow IPC stream bytes back into a single RecordBatch.
pub fn batch_from_ipc(bytes: &[u8]) -> Result<RecordBatch, ArrowIpcError> {
    let mut r = StreamReader::try_new(Cursor::new(bytes), None)?;
    let batch = r.next().expect("expected exactly one batch")?;
    Ok(batch)
}

pub fn rate_group_to_ipc(rg: &RateGroup) -> Result<Vec<u8>, ArrowIpcError> {
    batch_to_ipc(rg.batch())
}

#[cfg(test)]
mod tests {
    use super::*;
    use helios_core::{ChannelMeta, DataType};

    fn meta(id: &str) -> ChannelMeta {
        ChannelMeta {
            id: id.into(), display_name: id.into(), units: "".into(),
            group: "t".into(), color: "#fff".into(), decimals: 2,
            data_type: DataType::F64, source: "t".into(),
            sample_rate_hz: 100.0, min: None, max: None, warn: None, alarm: None,
        }
    }

    #[test]
    fn ipc_roundtrip() {
        let rg = RateGroup::build(
            "100hz", 100.0,
            vec![0, 10_000, 20_000],
            vec![(meta("a"), vec![1.0, 2.0, 3.0])],
        ).unwrap();
        let bytes = rate_group_to_ipc(&rg).unwrap();
        let back = batch_from_ipc(&bytes).unwrap();
        assert_eq!(back.num_rows(), 3);
        assert_eq!(back.num_columns(), 2);
        assert_eq!(back.schema().field(1).name(), "a");
    }
}
