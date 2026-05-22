//! End-to-end JSON-RPC tests: spawn the actual `helios-mcp` binary,
//! pipe newline-delimited JSON-RPC messages over stdin, and verify the
//! stdout responses parse and carry the expected fields.
//!
//! Why a child process? The MCP contract is "stdio JSON-RPC", and these
//! tests are the only place we can validate the wire shape end-to-end.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;
use tempfile::tempdir;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_helios-mcp"))
}

/// Helper: drive the server with N requests; collect their responses
/// (one JSON object per line) in order.
fn drive(requests: &[Value]) -> Vec<Value> {
    drive_with_env(requests, &[])
}

fn drive_with_env(requests: &[Value], env: &[(&str, &str)]) -> Vec<Value> {
    let mut cmd = bin();
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("spawn helios-mcp");

    {
        let stdin = child.stdin.as_mut().expect("take stdin");
        for r in requests {
            let line = serde_json::to_string(r).unwrap();
            writeln!(stdin, "{}", line).expect("write request");
        }
        // Drop stdin to signal EOF.
    }
    // Re-take stdin so it actually drops here.
    drop(child.stdin.take());

    let stdout = child.stdout.take().expect("take stdout");
    let reader = BufReader::new(stdout);
    let mut responses: Vec<Value> = Vec::new();
    for line in reader.lines() {
        let line = line.expect("read stdout line");
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).expect("response line is JSON");
        responses.push(v);
    }
    // Wait for exit (bounded — the server should have closed stdin already).
    let _ = wait_with_timeout(&mut child, Duration::from_secs(30));
    responses
}

fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
) -> std::io::Result<std::process::ExitStatus> {
    let start = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            return child.wait();
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn initialize_returns_protocol_version() {
    let resps = drive(&[json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {}
    })]);
    assert_eq!(resps.len(), 1, "expected one response, got: {:?}", resps);
    let r = &resps[0];
    assert_eq!(r["jsonrpc"], "2.0");
    assert_eq!(r["id"], 1);
    assert!(r["result"]["protocolVersion"].is_string());
    assert!(r["result"]["serverInfo"]["name"].as_str().unwrap() == "helios-mcp");
}

#[test]
fn tools_list_returns_six_tools_with_schemas() {
    let resps = drive(&[
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    ]);
    assert_eq!(resps.len(), 2);
    let tools = resps[1]["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 6, "expected 6 tools, got: {:?}", tools);
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    for required in [
        "run_sim",
        "submit_sweep",
        "validate_results",
        "read_finding",
        "list_findings",
        "query_literature",
    ] {
        assert!(
            names.contains(&required),
            "tools/list missing {required}: {names:?}"
        );
    }
    // Every tool must have an inputSchema.
    for t in tools {
        assert!(
            t["inputSchema"]["type"].as_str() == Some("object"),
            "tool {} missing inputSchema.type=object: {:?}",
            t["name"],
            t
        );
    }
}

#[test]
fn tools_call_run_sim_produces_ndjson() {
    // Build a minimal study.toml that calls into the real SDM26 baseline.
    let dir = tempdir().unwrap();
    let study_path = dir.path().join("study.toml");
    let out_path = dir.path().join("results.ndjson");

    // CARGO_MANIFEST_DIR -> crates/helios-mcp; go up two to repo root.
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let cfg = manifest
        .parent()
        .unwrap()
        .join("engine-sim/python_ref/configs/sdm26.json");
    let cfg = std::fs::canonicalize(&cfg).expect("baseline config");
    let cfg_str = cfg.display().to_string().replace('\\', "/");

    let toml_text = format!(
        r#"
[run]
config = "{cfg_str}"
rpm = [6000.0]
cycles = 2
recorded = true
seed = 1
junction = "characteristic"

[environment]
target_triple = "any"
rustc_version = "any"
rayon_threads = 1
libm_source = "any"
"#
    );
    std::fs::write(&study_path, toml_text).unwrap();

    let resps = drive(&[
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
        json!({
            "jsonrpc":"2.0","id":2,"method":"tools/call",
            "params":{
                "name":"run_sim",
                "arguments":{
                    "study_path": study_path.to_str().unwrap(),
                    "out_path":   out_path.to_str().unwrap(),
                    "commit":     "jsonrpc-test"
                }
            }
        }),
    ]);
    assert_eq!(resps.len(), 2, "expected 2 responses, got: {resps:?}");
    let call = &resps[1];
    assert_eq!(call["result"]["isError"], false, "{call:?}");
    let structured = &call["result"]["structuredContent"];
    assert_eq!(structured["n_trials"], 1);
    assert_eq!(structured["commit_hash"], "jsonrpc-test");
    // And the NDJSON file actually exists with the env block + 1 trial.
    let body = std::fs::read_to_string(&out_path).expect("ndjson out");
    let lines: Vec<&str> = body.lines().collect();
    assert!(lines.len() >= 2, "expected env+trial, got: {body}");
    let env: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(env["kind"], "environment");
    let trial: Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(trial["kind"], "trial");
}

#[test]
fn tools_call_list_findings_returns_registry_under_temp_root() {
    // Make a fake physics_findings/ tree in a temp dir and point the
    // server at it via HELIOS_PHYSICS_FINDINGS_DIR.
    let dir = tempdir().unwrap();
    let root = dir.path().join("physics_findings");
    std::fs::create_dir_all(root.join("0001-cold-start-imep")).unwrap();
    std::fs::write(
        root.join("0001-cold-start-imep").join("finding.md"),
        "---\nid: 1\nslug: cold-start-imep\nstatus: INVESTIGATING\ntopic: imep cold start\n---\nbody\n",
    )
    .unwrap();
    std::fs::create_dir_all(root.join("0002-mass-drift")).unwrap();
    std::fs::write(
        root.join("0002-mass-drift").join("finding.md"),
        "---\nid: 2\nslug: mass-drift\nstatus: VALIDATED\ntopic: mass drift band\n---\n",
    )
    .unwrap();

    let resps = drive_with_env(
        &[
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
            json!({
                "jsonrpc":"2.0","id":2,"method":"tools/call",
                "params":{"name":"list_findings","arguments":{}}
            }),
            json!({
                "jsonrpc":"2.0","id":3,"method":"tools/call",
                "params":{"name":"list_findings","arguments":{"filter_status":"VALIDATED"}}
            }),
        ],
        &[("HELIOS_PHYSICS_FINDINGS_DIR", root.to_str().unwrap())],
    );
    assert_eq!(resps.len(), 3);
    let all = &resps[1]["result"]["structuredContent"]["findings"];
    assert_eq!(all.as_array().unwrap().len(), 2);
    assert_eq!(all[0]["id"], 1);
    assert_eq!(all[0]["slug"], "cold-start-imep");
    let filtered = &resps[2]["result"]["structuredContent"]["findings"];
    let arr = filtered.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["slug"], "mass-drift");
}

#[test]
fn unknown_method_returns_method_not_found() {
    let resps = drive(&[json!({
        "jsonrpc":"2.0","id":1,"method":"does/not/exist","params":{}
    })]);
    assert_eq!(resps.len(), 1);
    assert_eq!(resps[0]["error"]["code"], -32601);
}

#[test]
fn notifications_get_no_response() {
    // One notification, one normal request: we should get exactly one response.
    let resps = drive(&[
        json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
    ]);
    assert_eq!(resps.len(), 1, "got: {resps:?}");
    assert_eq!(resps[0]["id"], 1);
}
