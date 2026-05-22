//! MCP tool handlers and their JSON Schemas.
//!
//! Each tool has:
//!   - a `name` (string, used in `tools/call`)
//!   - a `description` (string, shown to the agent in `tools/list`)
//!   - an `inputSchema` (JSON Schema, validated by the agent client)
//!   - a `dispatch` function that takes the parsed `arguments` and
//!     returns a `Result<Value>`.
//!
//! The six tools mirror helios-bench subcommands plus two
//! `physics_findings/` read helpers.

use crate::library_api;
use anyhow::{Context, Result};
use serde_json::{json, Value};

/// One tool descriptor as it appears in a `tools/list` response.
pub fn tools_list() -> Vec<Value> {
    vec![
        json!({
            "name": "run_sim",
            "description": "Run one or more single-RPM simulations from a study.toml. Writes NDJSON to out_path; returns summary {out_path, commit_hash, seed, n_trials, rpms}.",
            "inputSchema": {
                "type": "object",
                "required": ["study_path", "out_path"],
                "properties": {
                    "study_path": {"type": "string", "description": "Path to study.toml"},
                    "out_path":   {"type": "string", "description": "Output NDJSON path"},
                    "commit":     {"type": "string", "description": "Override commit hash (default = `git rev-parse HEAD`)"},
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "submit_sweep",
            "description": "Run a DOE parameter sweep from a study.toml with a [sweep] section. Writes NDJSON to out_path; returns {trials, rpms, sampler, parameters, out_path, commit_hash, seed}.",
            "inputSchema": {
                "type": "object",
                "required": ["study_path", "out_path"],
                "properties": {
                    "study_path": {"type": "string"},
                    "out_path":   {"type": "string"},
                    "commit":     {"type": "string"},
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "validate_results",
            "description": "Run physics-invariant checks (mass/energy/momentum/positivity/monotonicity) on a recorded NDJSON file. Returns {pass, n_trials, failures, skipped_checks}. Does NOT throw on invariant violations — pass=false signals failure.",
            "inputSchema": {
                "type": "object",
                "required": ["ndjson_path"],
                "properties": {
                    "ndjson_path": {"type": "string"},
                    "checks": {
                        "type": "string",
                        "description": "Comma-separated subset of mass,energy,momentum,positivity,monotonicity. Default = all."
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "read_finding",
            "description": "Read a physics finding by numeric id. Returns the parsed YAML frontmatter object and the markdown body separately.",
            "inputSchema": {
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {"type": "integer", "minimum": 0}
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "list_findings",
            "description": "List physics findings under physics_findings/. Returns {findings:[{id, slug, status, topic, path}]}. Optional filter_status (case-insensitive exact match).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filter_status": {"type": "string"}
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "query_literature",
            "description": "Case-insensitive substring search over physics_findings/references/literature/*.md. Returns {citations:[{path, filename, matches:[{line_number, context}]}]}. Optional max_results (default 20).",
            "inputSchema": {
                "type": "object",
                "required": ["topic"],
                "properties": {
                    "topic": {"type": "string"},
                    "max_results": {"type": "integer", "minimum": 1}
                },
                "additionalProperties": false
            }
        }),
    ]
}

/// Dispatch one tool call. Returns the JSON content that goes into the
/// `tools/call` response (wrapped in the MCP `content` envelope by the
/// server).
pub fn dispatch(name: &str, args: &Value) -> Result<Value> {
    match name {
        "run_sim" => {
            let study_path = require_string(args, "study_path")?;
            let out_path = require_string(args, "out_path")?;
            let commit = args
                .get("commit")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            library_api::run_sim(&study_path, &out_path, commit.as_deref())
        }
        "submit_sweep" => {
            let study_path = require_string(args, "study_path")?;
            let out_path = require_string(args, "out_path")?;
            let commit = args
                .get("commit")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            library_api::submit_sweep(&study_path, &out_path, commit.as_deref())
        }
        "validate_results" => {
            let ndjson = require_string(args, "ndjson_path")?;
            let checks = args
                .get("checks")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            library_api::validate_results(&ndjson, checks.as_deref())
        }
        "read_finding" => {
            let id = args
                .get("id")
                .and_then(Value::as_u64)
                .context("missing or non-integer 'id'")? as u32;
            library_api::read_finding(id)
        }
        "list_findings" => {
            let filter = args
                .get("filter_status")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            library_api::list_findings(filter.as_deref())
        }
        "query_literature" => {
            let topic = require_string(args, "topic")?;
            let max = args.get("max_results").and_then(Value::as_u64).map(|n| n as u32);
            library_api::query_literature(&topic, max)
        }
        other => anyhow::bail!("unknown tool: {other}"),
    }
}

fn require_string(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow::anyhow!("missing or non-string '{key}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_list_has_six_tools() {
        let tools = tools_list();
        assert_eq!(tools.len(), 6);
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"run_sim"));
        assert!(names.contains(&"submit_sweep"));
        assert!(names.contains(&"validate_results"));
        assert!(names.contains(&"read_finding"));
        assert!(names.contains(&"list_findings"));
        assert!(names.contains(&"query_literature"));
    }

    #[test]
    fn dispatch_rejects_unknown_tool() {
        let err = dispatch("nope", &json!({})).unwrap_err();
        assert!(err.to_string().contains("unknown tool"));
    }
}
