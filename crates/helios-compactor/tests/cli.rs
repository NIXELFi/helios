use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

fn run_once(status: &'static str, body: &'static str) -> Output {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "CLI did not request pending rows"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(e) => panic!("accept failed: {e}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut request = Vec::new();
        let mut buf = [0; 1024];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buf).unwrap();
            assert!(n > 0, "CLI closed connection before sending headers");
            request.extend_from_slice(&buf[..n]);
        }
        assert!(String::from_utf8_lossy(&request).starts_with("GET /rest/v1/staging_chunks?"));
        write!(stream,
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ).unwrap();
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_helios-compactor"))
        .args([
            "--url",
            &url,
            "--service-role-key",
            "test-key",
            "run",
            "--once",
        ])
        .env("NO_PROXY", "127.0.0.1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!(
                "--once did not exit: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    server.join().unwrap();
    output
}

#[test]
fn once_exits_nonzero_when_pending_fetch_fails() {
    let output = run_once("500 Internal Server Error", r#"{"message":"unavailable"}"#);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !output.status.success(),
        "failed pass exited successfully: {stderr}"
    );
    assert!(stderr.contains("fetch_pending: HTTP 500"), "{stderr}");
    assert!(
        !stderr.contains("will retry"),
        "one-shot execution cannot retry: {stderr}"
    );
}

#[test]
fn once_exits_zero_when_nothing_is_pending() {
    let output = run_once("200 OK", "[]");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
