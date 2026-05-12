use crate::channel::ChannelMeta;
use arrow::array::{ArrayRef, Float64Array, Int64Array};
use arrow::datatypes::{DataType as ArrowDataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RateGroupError {
    #[error("channel id `{0}` not found in rate group")]
    UnknownChannel(String),
    #[error("channel `{channel}` has wrong length: expected {expected}, got {got}")]
    LengthMismatch { channel: String, expected: usize, got: usize },
    #[error("arrow error: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
}

/// A group of channels that share a sample rate and time index.
/// One Arrow RecordBatch with `time_us` (Int64) plus one Float64 column per channel.
pub struct RateGroup {
    pub id: String,
    pub nominal_rate_hz: f32,
    channels: HashMap<String, usize>, // channel_id -> column index in batch
    metas: Vec<ChannelMeta>,
    batch: RecordBatch,
}

impl RateGroup {
    pub fn build(
        id: impl Into<String>,
        nominal_rate_hz: f32,
        time_us: Vec<i64>,
        channel_data: Vec<(ChannelMeta, Vec<Option<f64>>)>,
    ) -> Result<Self, RateGroupError> {
        let n = time_us.len();
        for (m, v) in &channel_data {
            if v.len() != n {
                return Err(RateGroupError::LengthMismatch {
                    channel: m.id.clone(),
                    expected: n,
                    got: v.len(),
                });
            }
        }
        let mut fields = vec![Field::new("time_us", ArrowDataType::Int64, false)];
        let mut arrays: Vec<ArrayRef> = vec![Arc::new(Int64Array::from(time_us))];
        let mut channels = HashMap::new();
        let mut metas = Vec::new();
        for (i, (meta, data)) in channel_data.into_iter().enumerate() {
            fields.push(Field::new(&meta.id, ArrowDataType::Float64, true));
            arrays.push(Arc::new(Float64Array::from(data)));
            channels.insert(meta.id.clone(), i + 1);
            metas.push(meta);
        }
        let schema = Arc::new(Schema::new(fields));
        let batch = RecordBatch::try_new(schema, arrays)?;
        Ok(Self { id: id.into(), nominal_rate_hz, channels, metas, batch })
    }

    pub fn channel_ids(&self) -> Vec<&str> {
        self.metas.iter().map(|m| m.id.as_str()).collect()
    }

    pub fn meta(&self, id: &str) -> Option<&ChannelMeta> {
        self.channels.get(id).map(|&i| &self.metas[i - 1])
    }

    pub fn batch(&self) -> &RecordBatch { &self.batch }

    pub fn time_us(&self) -> &Int64Array {
        self.batch.column(0).as_any().downcast_ref::<Int64Array>().unwrap()
    }

    pub fn channel_data(&self, id: &str) -> Result<&Float64Array, RateGroupError> {
        let &col = self.channels.get(id)
            .ok_or_else(|| RateGroupError::UnknownChannel(id.into()))?;
        Ok(self.batch.column(col).as_any().downcast_ref::<Float64Array>().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::DataType;
    use arrow::array::Array;

    fn meta(id: &str) -> ChannelMeta {
        ChannelMeta {
            id: id.into(), display_name: id.into(), units: "".into(),
            group: "test".into(), color: "#fff".into(), decimals: 2,
            data_type: DataType::F64, source: "test".into(),
            sample_rate_hz: 100.0, min: None, max: None, warn: None, alarm: None,
            source_header: None,
        }
    }

    #[test]
    fn build_and_lookup() {
        let rg = RateGroup::build(
            "100hz", 100.0,
            vec![0, 10_000, 20_000],
            vec![
                (meta("engine.rpm"), vec![Some(1000.0), Some(2000.0), Some(3000.0)]),
                (meta("engine.tps"), vec![Some(10.0), Some(20.0), Some(30.0)]),
            ],
        ).unwrap();

        assert_eq!(rg.channel_ids(), vec!["engine.rpm", "engine.tps"]);
        assert!(rg.meta("engine.rpm").is_some());
        assert_eq!(rg.time_us().value(1), 10_000);
        assert_eq!(rg.channel_data("engine.rpm").unwrap().value(2), 3000.0);
    }

    #[test]
    fn unknown_channel_errors() {
        let rg = RateGroup::build(
            "100hz", 100.0,
            vec![0, 10_000],
            vec![(meta("a"), vec![Some(1.0), Some(2.0)])],
        ).unwrap();
        assert!(matches!(
            rg.channel_data("missing"),
            Err(RateGroupError::UnknownChannel(_))
        ));
    }

    /// Mismatched column length must surface as a Result error, not a panic.
    /// (Previously this was an `assert_eq!` in a public fallible API.)
    #[test]
    fn length_mismatch_returns_error() {
        let res = RateGroup::build(
            "100hz", 100.0,
            vec![0, 10_000, 20_000],
            vec![(meta("engine.rpm"), vec![Some(1000.0), Some(2000.0)])],
        );
        assert!(matches!(
            res,
            Err(RateGroupError::LengthMismatch { ref channel, expected: 3, got: 2 })
                if channel == "engine.rpm"
        ));
    }

    /// Leading missing samples must surface as Arrow nulls, not NaN sentinels.
    #[test]
    fn leading_none_becomes_arrow_null() {
        let rg = RateGroup::build(
            "100hz", 100.0,
            vec![0, 10_000, 20_000],
            vec![(meta("engine.rpm"), vec![None, None, Some(3000.0)])],
        ).unwrap();
        let arr = rg.channel_data("engine.rpm").unwrap();
        assert!(arr.is_null(0));
        assert!(arr.is_null(1));
        assert!(!arr.is_null(2));
        assert_eq!(arr.value(2), 3000.0);
    }
}
