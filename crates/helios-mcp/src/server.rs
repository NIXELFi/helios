//! MCP server dispatch. Stateless — `handle_request` takes a `Request`
//! and returns either `Some(Response)` (for requests with an id) or
//! `None` (for notifications, which by JSON-RPC 2.0 receive no reply).
//!
//! Kept synchronous and pure to make tests trivial: the tokio stdio
//! loop in `main.rs` calls this function for each parsed line.

use crate::handlers;
use crate::protocol::{
    Request, Response, INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND,
};
use serde_json::{json, Value};

/// Server-side state. Currently just the protocol-version constant.
/// Hold this in case future tools need shared resources (a db handle,
/// a cache, etc.).
pub struct Server {
    /// MCP protocol version we advertise in `initialize`. We use the
    /// well-known `2024-11-05` value — matches the spec snapshot we
    /// captured in cached knowledge.
    pub protocol_version: String,
}

impl Default for Server {
    fn default() -> Self {
        Self {
            protocol_version: "2024-11-05".to_string(),
        }
    }
}

impl Server {
    pub fn new() -> Self {
        Self::default()
    }

    /// Handle one parsed JSON-RPC request. Returns `None` if the request
    /// was a notification (no id field) — by JSON-RPC 2.0 those get no
    /// response.
    pub fn handle_request(&self, req: Request) -> Option<Response> {
        // Notifications: no id, no response.
        let Some(id) = req.id.clone() else {
            // Notifications we know about (just log; nothing to do).
            return None;
        };

        if req.jsonrpc != "2.0" {
            return Some(Response::error(
                id,
                INVALID_REQUEST,
                format!("expected jsonrpc='2.0', got '{}'", req.jsonrpc),
            ));
        }

        match req.method.as_str() {
            "initialize" => Some(Response::success(
                id,
                json!({
                    "protocolVersion": self.protocol_version,
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "helios-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )),
            "tools/list" => Some(Response::success(
                id,
                json!({"tools": handlers::tools_list()}),
            )),
            "tools/call" => Some(self.handle_tools_call(id, req.params.unwrap_or(Value::Null))),
            // Ping handler (some MCP clients send these as health-checks).
            "ping" => Some(Response::success(id, json!({}))),
            other => Some(Response::error(
                id,
                METHOD_NOT_FOUND,
                format!("method not found: {other}"),
            )),
        }
    }

    fn handle_tools_call(&self, id: Value, params: Value) -> Response {
        let name = match params.get("name").and_then(Value::as_str) {
            Some(s) => s.to_string(),
            None => {
                return Response::error(id, INVALID_PARAMS, "missing 'name' in tools/call params");
            }
        };
        let args = params.get("arguments").cloned().unwrap_or(Value::Null);
        match handlers::dispatch(&name, &args) {
            Ok(payload) => {
                // MCP `tools/call` response envelope: `{content: [{type:"text", text:"..."}]}`.
                // We embed the structured JSON as a text node — this is the
                // standard "tools that emit JSON" pattern in the protocol
                // (clients re-parse the text). We also include the parsed
                // payload as `structuredContent` so newer clients can skip
                // the re-parse step (MCP draft 2025).
                let text = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
                Response::success(
                    id,
                    json!({
                        "content": [{"type": "text", "text": text}],
                        "structuredContent": payload,
                        "isError": false,
                    }),
                )
            }
            Err(e) => {
                let err_text = format!("{e:#}");
                // Surface tool errors via the MCP `isError` flag rather
                // than as a JSON-RPC error — the protocol prefers
                // tool-level failures stay inside `tools/call` results so
                // the agent can read the error message.
                Response::success(
                    id,
                    json!({
                        "content": [{"type": "text", "text": err_text}],
                        "isError": true,
                    }),
                )
            }
        }
    }
}

/// Build a JSON-RPC error response for a parse failure (no id available).
pub fn parse_error_response(message: impl Into<String>) -> Response {
    Response {
        jsonrpc: "2.0".into(),
        id: Value::Null,
        result: None,
        error: Some(crate::protocol::ErrorObject {
            code: crate::protocol::PARSE_ERROR,
            message: message.into(),
            data: None,
        }),
    }
}

/// Wrap any tool-dispatch path that needs to convert a generic error to a
/// JSON-RPC error response.
#[allow(dead_code)]
pub fn internal_error_response(id: Value, e: anyhow::Error) -> Response {
    Response::error(id, INTERNAL_ERROR, format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, params: Value, id: i64) -> Request {
        Request {
            jsonrpc: "2.0".into(),
            id: Some(Value::from(id)),
            method: method.into(),
            params: Some(params),
        }
    }

    #[test]
    fn initialize_returns_protocol_version_and_capabilities() {
        let s = Server::new();
        let r = s.handle_request(req("initialize", json!({}), 1)).unwrap();
        let result = r.result.unwrap();
        assert_eq!(result["protocolVersion"], "2024-11-05");
        assert!(result["capabilities"]["tools"].is_object());
        assert_eq!(result["serverInfo"]["name"], "helios-mcp");
    }

    #[test]
    fn tools_list_returns_six_tools() {
        let s = Server::new();
        let r = s.handle_request(req("tools/list", json!({}), 2)).unwrap();
        let tools = r.result.unwrap()["tools"].as_array().unwrap().clone();
        assert_eq!(tools.len(), 6);
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let s = Server::new();
        let r = s
            .handle_request(req("does_not_exist", json!({}), 3))
            .unwrap();
        assert_eq!(r.error.unwrap().code, METHOD_NOT_FOUND);
    }

    #[test]
    fn notification_returns_none() {
        let s = Server::new();
        let r = s.handle_request(Request {
            jsonrpc: "2.0".into(),
            id: None,
            method: "notifications/initialized".into(),
            params: None,
        });
        assert!(r.is_none());
    }

    #[test]
    fn tools_call_unknown_tool_returns_iserror_true() {
        let s = Server::new();
        let r = s
            .handle_request(req(
                "tools/call",
                json!({"name": "bogus", "arguments": {}}),
                4,
            ))
            .unwrap();
        let result = r.result.unwrap();
        assert_eq!(result["isError"], true);
    }
}
