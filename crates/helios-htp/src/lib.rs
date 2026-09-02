//! HTP/1 (docs/telemetry-wire-protocol.md) + the `live_fast` value packing
//! (docs/superpowers/specs/2026-09-02-cellular-telemetry-fast-path.md §3.2).
//! Everything here is pure and allocation-light; no I/O.
pub mod error;
pub mod frame;
pub mod live;
pub mod types;

pub use error::HtpError;
pub use frame::{decode_frame, encode_frame, parse_header, Frame, Window, HEADER_LEN, MAGIC, VERSION};
// pub use live::{live_len, pack_live, unpack_live, LiveMessage};
pub use types::{ChannelDef, ChannelSetDef, Enc, GroupDef};
