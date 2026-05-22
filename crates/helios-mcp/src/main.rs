//! helios-mcp — MCP stdio server.
//!
//! Reads newline-delimited JSON-RPC 2.0 requests from stdin, dispatches
//! them through `helios_mcp::Server`, and writes responses (one per line)
//! to stdout. Requests with no id are notifications and produce no
//! output.

use anyhow::Result;
use helios_mcp::protocol::Request;
use helios_mcp::server::{parse_error_response, Server};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};

#[tokio::main]
async fn main() -> Result<()> {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin).lines();
    let mut writer = BufWriter::new(stdout);
    let server = Server::new();

    while let Some(line) = reader.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(line) {
            Ok(req) => server.handle_request(req),
            Err(e) => Some(parse_error_response(format!("parse error: {e}"))),
        };
        if let Some(resp) = response {
            let body = serde_json::to_string(&resp)?;
            writer.write_all(body.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
        }
    }
    Ok(())
}
