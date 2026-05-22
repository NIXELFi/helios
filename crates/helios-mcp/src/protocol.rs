//! JSON-RPC 2.0 envelope types per the MCP spec
//! (<https://modelcontextprotocol.io/>). Newline-delimited over stdio.
//!
//! Known Issue I-5: keep this minimal and in-house. The MCP protocol is
//! JSON-RPC 2.0 with three message kinds we care about for a tools-only
//! server:
//!   - `initialize` — handshake; client sends capabilities, server returns
//!     `protocolVersion`, `serverInfo`, and its own `capabilities`.
//!   - `tools/list` — returns `tools: [{name, description, inputSchema}]`.
//!   - `tools/call` — params `{name, arguments}`, response `{content: [...]}`.
//!
//! We also accept the `notifications/initialized` notification (no
//! response). Anything else gets a `-32601 method not found`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC 2.0 request. `id` is `None` for notifications.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Request {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

/// JSON-RPC 2.0 response.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Response {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorObject>,
}

/// JSON-RPC 2.0 error object.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ErrorObject {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// JSON-RPC 2.0 notification (no id, no response expected).
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl Response {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(ErrorObject {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }

    pub fn error_with_data(id: Value, code: i32, message: impl Into<String>, data: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(ErrorObject {
                code,
                message: message.into(),
                data: Some(data),
            }),
        }
    }
}

// Standard JSON-RPC error codes.
pub const PARSE_ERROR: i32 = -32700;
pub const INVALID_REQUEST: i32 = -32600;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const INTERNAL_ERROR: i32 = -32603;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrip() {
        let raw = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        let req: Request = serde_json::from_str(raw).unwrap();
        assert_eq!(req.jsonrpc, "2.0");
        assert_eq!(req.method, "initialize");
        assert_eq!(req.id, Some(Value::from(1)));
    }

    #[test]
    fn notification_has_no_id() {
        let raw = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let req: Request = serde_json::from_str(raw).unwrap();
        assert!(req.id.is_none());
    }

    #[test]
    fn response_success_serialization() {
        let r = Response::success(Value::from(1), serde_json::json!({"ok": true}));
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"result\""));
        assert!(!s.contains("\"error\""));
    }

    #[test]
    fn response_error_serialization() {
        let r = Response::error(Value::from(2), METHOD_NOT_FOUND, "no such method");
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"error\""));
        assert!(s.contains("-32601"));
        assert!(!s.contains("\"result\""));
    }
}
