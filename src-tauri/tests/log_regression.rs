//! Regression tests against REAL tectonic-generated .log files
//! (fixtures compiled with the bundled tectonic 0.15 binary).

use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

#[test]
fn real_log_undefined_control_sequence() {
    let log = fixture("broken-undefined-ctrl.log");
    let issues = texbutler_lib::core::log_parser::parse_log(&log);
    assert!(!issues.is_empty(), "should parse at least one issue");

    let first = &issues[0];
    assert_eq!(
        first.severity,
        texbutler_lib::core::Severity::Error,
        "undefined control sequence must be an error"
    );
    assert!(first.message.contains("未定义的控制序列"));
    // tectonic's `l.4` marker — the real source line
    assert_eq!(first.line, Some(4));
    // raw block must be preserved for the AI layer
    let raw = first.raw.as_deref().unwrap_or("");
    assert!(raw.contains("Undefined control sequence"));
    assert!(raw.contains("\\undefinedcmd"));
}

#[test]
fn real_log_has_no_garbage_lines() {
    let log = fixture("broken-undefined-ctrl.log");
    let issues = texbutler_lib::core::log_parser::parse_log(&log);
    for i in &issues {
        assert!(!i.message.contains("l."), "message must be humanized: {}", i.message);
        assert!(!i.message.contains("0000000"), "no float garbage in messages");
    }
}
