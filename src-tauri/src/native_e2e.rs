//! Native end-to-end test support, compiled only with the `native-e2e`
//! Cargo feature.
//!
//! The Node orchestrator (`scripts/native-e2e.mjs`) builds this feature into
//! an isolated test application and launches it with a scenario name and
//! two output paths. Everything here is deliberately one-way:
//!
//! - Configuration comes from process environment only. The webview cannot
//!   name a scenario or an output path; it can only ask for the current
//!   context, write a phase marker, or submit a report body.
//! - The identifier must carry the dedicated `.native-e2e` suffix and must
//!   never be the production bundle identifier, so session and recovery
//!   data written by a test run can never land in a user installation.
//! - Marker and report writes use the sibling-temporary-file + fsync +
//!   rename discipline of document saves, so a concurrently polling
//!   orchestrator never observes a partially written JSON document.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Production bundle identifier, which the test build must never reuse:
/// both identifiers resolve their own session and recovery directories.
pub const PRODUCTION_IDENTIFIER: &str = "com.xiongweini.markdown-edit";
/// Dedicated native-test identifier configured in
/// `src-tauri/tauri.native-e2e.conf.json`.
pub const IDENTIFIER: &str = "com.xiongweini.markdown-edit.native-e2e";
/// Every accepted test identifier ends with this suffix.
pub const IDENTIFIER_SUFFIX: &str = ".native-e2e";

pub const ENV_SCENARIO: &str = "OPUS_NATIVE_E2E_SCENARIO";
pub const ENV_MARKER: &str = "OPUS_NATIVE_E2E_MARKER";
pub const ENV_REPORT: &str = "OPUS_NATIVE_E2E_REPORT";

/// Upper bound for a submitted report body. Reports carry fixture-sized
/// document text, never bulk data; the cap keeps a runaway runner from
/// filling the orchestrator's diagnostic directory.
pub const MAX_REPORT_BYTES: usize = 1024 * 1024;

const MAX_PHASE_LENGTH: usize = 64;

const SCENARIOS: [&str; 4] = ["smoke", "edit-save", "external-change", "recovery"];

pub enum NativeE2eError {
    MissingEnv {
        name: &'static str,
    },
    EmptyEnv {
        name: &'static str,
    },
    InvalidScenario {
        scenario: String,
    },
    RelativePath {
        name: &'static str,
        path: PathBuf,
    },
    SamePaths {
        marker: PathBuf,
        report: PathBuf,
    },
    PathIsDirectory {
        name: &'static str,
        path: PathBuf,
    },
    ProductionIdentifier {
        identifier: String,
    },
    InvalidIdentifier {
        identifier: String,
    },
    InvalidPhase {
        phase: String,
    },
    ReportNotObject,
    ReportTooLarge {
        bytes: usize,
    },
    Encode {
        message: String,
    },
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl fmt::Debug for NativeE2eError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

// `std::io::Error` is neither `Clone` nor `PartialEq`; compare I/O failures by
// path, kind, and message so tests can still assert exact error values.
impl PartialEq for NativeE2eError {
    fn eq(&self, other: &Self) -> bool {
        use NativeE2eError::*;
        match (self, other) {
            (MissingEnv { name: left }, MissingEnv { name: right })
            | (EmptyEnv { name: left }, EmptyEnv { name: right }) => left == right,
            (InvalidScenario { scenario: left }, InvalidScenario { scenario: right })
            | (
                ProductionIdentifier { identifier: left },
                ProductionIdentifier { identifier: right },
            )
            | (InvalidIdentifier { identifier: left }, InvalidIdentifier { identifier: right })
            | (InvalidPhase { phase: left }, InvalidPhase { phase: right }) => left == right,
            (
                RelativePath {
                    name: left_name,
                    path: left_path,
                },
                RelativePath {
                    name: right_name,
                    path: right_path,
                },
            )
            | (
                PathIsDirectory {
                    name: left_name,
                    path: left_path,
                },
                PathIsDirectory {
                    name: right_name,
                    path: right_path,
                },
            ) => left_name == right_name && left_path == right_path,
            (
                SamePaths {
                    marker: left_marker,
                    report: left_report,
                },
                SamePaths {
                    marker: right_marker,
                    report: right_report,
                },
            ) => left_marker == right_marker && left_report == right_report,
            (ReportNotObject, ReportNotObject) => true,
            (ReportTooLarge { bytes: left }, ReportTooLarge { bytes: right }) => left == right,
            (Encode { message: left }, Encode { message: right }) => left == right,
            (
                Io {
                    path: left_path,
                    source: left_source,
                },
                Io {
                    path: right_path,
                    source: right_source,
                },
            ) => {
                left_path == right_path
                    && left_source.kind() == right_source.kind()
                    && left_source.to_string() == right_source.to_string()
            }
            _ => false,
        }
    }
}

impl Eq for NativeE2eError {}

impl fmt::Display for NativeE2eError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingEnv { name } => write!(formatter, "native E2E environment variable {name} is not set"),
            Self::EmptyEnv { name } => write!(formatter, "native E2E environment variable {name} is empty"),
            Self::InvalidScenario { scenario } => write!(
                formatter,
                "unsupported native E2E scenario {scenario:?} (expected one of {})",
                SCENARIOS.join(", ")
            ),
            Self::RelativePath { name, path } => write!(
                formatter,
                "native E2E {name} must be an absolute path, got {}",
                path.display()
            ),
            Self::SamePaths { marker, report } => write!(
                formatter,
                "native E2E marker and report paths must differ, got {} and {}",
                marker.display(),
                report.display()
            ),
            Self::PathIsDirectory { name, path } => write!(
                formatter,
                "native E2E {name} points at a directory: {}",
                path.display()
            ),
            Self::ProductionIdentifier { identifier } => write!(
                formatter,
                "native E2E must not run under the production identifier {identifier}"
            ),
            Self::InvalidIdentifier { identifier } => write!(
                formatter,
                "native E2E identifier {identifier:?} must end with {IDENTIFIER_SUFFIX:?}"
            ),
            Self::InvalidPhase { phase } => write!(
                formatter,
                "invalid native E2E marker phase {phase:?} (1-{MAX_PHASE_LENGTH} ASCII letters, digits, '-' or '_')"
            ),
            Self::ReportNotObject => write!(formatter, "native E2E report must be a JSON object"),
            Self::ReportTooLarge { bytes } => write!(
                formatter,
                "native E2E report is {bytes} bytes, above the {MAX_REPORT_BYTES}-byte limit"
            ),
            Self::Encode { message } => write!(formatter, "cannot encode native E2E JSON: {message}"),
            Self::Io { path, source } => {
                write!(formatter, "native E2E I/O error for {}: {source}", path.display())
            }
        }
    }
}

impl std::error::Error for NativeE2eError {}

impl NativeE2eError {
    fn io(path: &Path, source: std::io::Error) -> Self {
        Self::Io {
            path: path.to_path_buf(),
            source,
        }
    }
}

/// Environment-derived test configuration. Paths never leave the Rust side:
/// the frontend only receives [`NativeE2eContext`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeE2eConfig {
    pub scenario: String,
    pub marker_path: PathBuf,
    pub report_path: PathBuf,
}

impl NativeE2eConfig {
    /// Reads the scenario and both output paths from the supplied lookup
    /// (process environment in production, a map in tests). A missing,
    /// empty, relative, or colliding path is rejected before anything is
    /// written.
    pub fn from_env<F>(mut lookup: F) -> Result<Self, NativeE2eError>
    where
        F: FnMut(&str) -> Option<OsString>,
    {
        let scenario = required_value(&mut lookup, ENV_SCENARIO)?;
        let scenario = scenario
            .into_string()
            .map_err(|_| NativeE2eError::InvalidScenario {
                scenario: "<non-UTF-8>".into(),
            })?;
        let scenario = scenario.trim().to_owned();
        if scenario.is_empty() {
            return Err(NativeE2eError::EmptyEnv { name: ENV_SCENARIO });
        }
        if !SCENARIOS.contains(&scenario.as_str()) {
            return Err(NativeE2eError::InvalidScenario { scenario });
        }

        let marker_path = output_path(&mut lookup, ENV_MARKER)?;
        let report_path = output_path(&mut lookup, ENV_REPORT)?;
        if marker_path == report_path {
            return Err(NativeE2eError::SamePaths {
                marker: marker_path,
                report: report_path,
            });
        }

        Ok(Self {
            scenario,
            marker_path,
            report_path,
        })
    }
}

fn required_value<F>(lookup: &mut F, name: &'static str) -> Result<OsString, NativeE2eError>
where
    F: FnMut(&str) -> Option<OsString>,
{
    match lookup(name) {
        None => Err(NativeE2eError::MissingEnv { name }),
        Some(value) if value.is_empty() => Err(NativeE2eError::EmptyEnv { name }),
        Some(value) => Ok(value),
    }
}

fn output_path<F>(lookup: &mut F, name: &'static str) -> Result<PathBuf, NativeE2eError>
where
    F: FnMut(&str) -> Option<OsString>,
{
    let raw = required_value(lookup, name)?;
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(NativeE2eError::RelativePath { name, path });
    }
    if path.is_dir() {
        return Err(NativeE2eError::PathIsDirectory { name, path });
    }
    Ok(path)
}

/// The path-free view of one test run handed to the webview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NativeE2eContext {
    pub scenario: String,
    pub identifier: String,
}

impl NativeE2eContext {
    pub fn from_config(config: &NativeE2eConfig, identifier: &str) -> Self {
        Self {
            scenario: config.scenario.clone(),
            identifier: identifier.to_owned(),
        }
    }
}

/// Marker contract consumed by the orchestrator: `scenario`, `phase`,
/// `identifier` — nothing else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeE2eMarker {
    pub scenario: String,
    pub phase: String,
    pub identifier: String,
}

/// A test identifier is acceptable only when it is not the production one
/// and carries the dedicated suffix.
pub fn validate_identifier(identifier: &str) -> Result<(), NativeE2eError> {
    if identifier == PRODUCTION_IDENTIFIER {
        return Err(NativeE2eError::ProductionIdentifier {
            identifier: identifier.to_owned(),
        });
    }
    if identifier.len() <= IDENTIFIER_SUFFIX.len() || !identifier.ends_with(IDENTIFIER_SUFFIX) {
        return Err(NativeE2eError::InvalidIdentifier {
            identifier: identifier.to_owned(),
        });
    }
    Ok(())
}

fn validate_phase(phase: &str) -> Result<(), NativeE2eError> {
    let valid = !phase.is_empty()
        && phase.len() <= MAX_PHASE_LENGTH
        && phase
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(NativeE2eError::InvalidPhase {
            phase: phase.to_owned(),
        })
    }
}

/// Writes `{scenario, phase, identifier}` atomically and returns it.
pub fn write_marker(
    config: &NativeE2eConfig,
    identifier: &str,
    phase: &str,
) -> Result<NativeE2eMarker, NativeE2eError> {
    validate_identifier(identifier)?;
    validate_phase(phase)?;
    let marker = NativeE2eMarker {
        scenario: config.scenario.clone(),
        phase: phase.to_owned(),
        identifier: identifier.to_owned(),
    };
    let value = serde_json::to_value(&marker).map_err(|error| NativeE2eError::Encode {
        message: error.to_string(),
    })?;
    write_json_atomic(&config.marker_path, &value)?;
    Ok(marker)
}

/// Validates a webview-supplied report body, stamps the server-owned
/// scenario and identifier, then writes it atomically. Returns the written
/// value so the caller can confirm what was persisted.
pub fn write_report(
    config: &NativeE2eConfig,
    identifier: &str,
    report: Value,
) -> Result<Value, NativeE2eError> {
    validate_identifier(identifier)?;
    let Value::Object(mut object) = report else {
        return Err(NativeE2eError::ReportNotObject);
    };
    // Server-owned fields always win: the webview cannot spoof which
    // scenario or identifier a report belongs to.
    object.insert("scenario".into(), Value::String(config.scenario.clone()));
    object.insert("identifier".into(), Value::String(identifier.to_owned()));
    let value = Value::Object(object);
    let bytes = serde_json::to_vec_pretty(&value).map_err(|error| NativeE2eError::Encode {
        message: error.to_string(),
    })?;
    if bytes.len() > MAX_REPORT_BYTES {
        return Err(NativeE2eError::ReportTooLarge { bytes: bytes.len() });
    }
    write_bytes_atomic(&config.report_path, &bytes)?;
    Ok(value)
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), NativeE2eError> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| NativeE2eError::Encode {
        message: error.to_string(),
    })?;
    bytes.push(b'\n');
    write_bytes_atomic(path, &bytes)
}

/// Sibling temporary file + fsync + rename, then sync the parent directory on
/// Unix — the same durability discipline document saves and recovery drafts
/// use. The orchestrator may poll the marker at any time and must never see
/// a partially written document.
fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), NativeE2eError> {
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    fs::create_dir_all(parent).map_err(|error| NativeE2eError::io(parent, error))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| NativeE2eError::io(parent, error))?;
    temporary
        .write_all(bytes)
        .map_err(|error| NativeE2eError::io(path, error))?;
    temporary
        .flush()
        .map_err(|error| NativeE2eError::io(path, error))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| NativeE2eError::io(path, error))?;
    temporary
        .persist(path)
        .map_err(|error| NativeE2eError::io(path, error.error))?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| NativeE2eError::io(parent, error))?;
    Ok(())
}

fn config_and_identifier(
    app: &tauri::AppHandle,
) -> Result<(NativeE2eConfig, String), NativeE2eError> {
    let identifier = app.config().identifier.clone();
    validate_identifier(&identifier)?;
    let config = NativeE2eConfig::from_env(|name| std::env::var_os(name))?;
    Ok((config, identifier))
}

/// Validates the dedicated test build at startup, before the webview loads.
///
/// `cargo test`/`clippy --features native-e2e` link the binary with the
/// *base* Tauri config (the CLI's `--config` override only applies to
/// `tauri build`), producing an executable with the production identifier
/// and no orchestrator environment. Such a binary must fail fast instead of
/// starting a window whose runner can never write a marker.
pub fn validate_startup(app: &tauri::AppHandle) -> Result<(), NativeE2eError> {
    config_and_identifier(app).map(|_| ())
}

/// Returns the scenario and identifier for this test run. The webview never
/// receives the marker or report paths.
#[tauri::command]
pub fn native_e2e_context(app: tauri::AppHandle) -> Result<NativeE2eContext, String> {
    let (config, identifier) = config_and_identifier(&app).map_err(|error| error.to_string())?;
    Ok(NativeE2eContext::from_config(&config, &identifier))
}

/// Writes a phase marker for the orchestrator. The phase is the only
/// webview-supplied input; paths and scenario stay server-side.
#[tauri::command]
pub fn native_e2e_marker(app: tauri::AppHandle, phase: String) -> Result<NativeE2eMarker, String> {
    let (config, identifier) = config_and_identifier(&app).map_err(|error| error.to_string())?;
    write_marker(&config, &identifier, &phase).map_err(|error| error.to_string())
}

/// Atomically writes a scenario report. The report body is arbitrary JSON
/// but must be an object; scenario and identifier are stamped server-side.
#[tauri::command]
pub fn native_e2e_report(app: tauri::AppHandle, report: Value) -> Result<Value, String> {
    let (config, identifier) = config_and_identifier(&app).map_err(|error| error.to_string())?;
    write_report(&config, &identifier, report).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::ffi::OsString;

    fn lookup(pairs: Vec<(&'static str, OsString)>) -> impl FnMut(&str) -> Option<OsString> {
        let map: HashMap<&'static str, OsString> = pairs.into_iter().collect();
        move |name| map.get(name).cloned()
    }

    fn path_env(name: &'static str, path: &Path) -> (&'static str, OsString) {
        (name, path.as_os_str().to_os_string())
    }

    fn test_config(dir: &tempfile::TempDir) -> NativeE2eConfig {
        NativeE2eConfig {
            scenario: "recovery".into(),
            marker_path: dir.path().join("native-e2e-marker.json"),
            report_path: dir.path().join("native-e2e-report.json"),
        }
    }

    fn dir_entries(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn config_comes_from_the_environment_and_context_hides_paths() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker.json");
        let report = dir.path().join("report.json");
        let config = NativeE2eConfig::from_env(lookup(vec![
            (ENV_SCENARIO, OsString::from("edit-save")),
            path_env(ENV_MARKER, &marker),
            path_env(ENV_REPORT, &report),
        ]))
        .unwrap();

        assert_eq!(config.scenario, "edit-save");
        assert_eq!(config.marker_path, marker);
        assert_eq!(config.report_path, report);

        let context = NativeE2eContext::from_config(&config, IDENTIFIER);
        assert_eq!(context.scenario, "edit-save");
        assert_eq!(context.identifier, IDENTIFIER);
        assert_eq!(
            serde_json::to_value(&context).unwrap(),
            json!({ "scenario": "edit-save", "identifier": IDENTIFIER })
        );
    }

    #[test]
    fn config_rejects_missing_empty_and_unknown_scenario_values() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker.json");
        let report = dir.path().join("report.json");

        let missing = NativeE2eConfig::from_env(lookup(vec![
            path_env(ENV_MARKER, &marker),
            path_env(ENV_REPORT, &report),
        ]))
        .unwrap_err();
        assert_eq!(missing, NativeE2eError::MissingEnv { name: ENV_SCENARIO });

        let empty = NativeE2eConfig::from_env(lookup(vec![
            (ENV_SCENARIO, OsString::from("   ")),
            path_env(ENV_MARKER, &marker),
            path_env(ENV_REPORT, &report),
        ]))
        .unwrap_err();
        assert_eq!(empty, NativeE2eError::EmptyEnv { name: ENV_SCENARIO });

        let unknown = NativeE2eConfig::from_env(lookup(vec![
            (ENV_SCENARIO, OsString::from("delete-everything")),
            path_env(ENV_MARKER, &marker),
            path_env(ENV_REPORT, &report),
        ]))
        .unwrap_err();
        assert_eq!(
            unknown,
            NativeE2eError::InvalidScenario {
                scenario: "delete-everything".into()
            }
        );

        let non_utf8 = NativeE2eConfig::from_env(lookup(vec![
            (ENV_SCENARIO, OsString::from("edit-save")),
            path_env(ENV_MARKER, &marker),
            (ENV_REPORT, OsString::from("report.json")),
        ]))
        .unwrap_err();
        assert_eq!(
            non_utf8,
            NativeE2eError::RelativePath {
                name: ENV_REPORT,
                path: PathBuf::from("report.json")
            }
        );
    }

    #[test]
    fn config_rejects_relative_and_colliding_paths() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("shared.json");

        let relative = NativeE2eConfig::from_env(lookup(vec![
            (ENV_SCENARIO, OsString::from("smoke")),
            (ENV_MARKER, OsString::from("marker.json")),
            path_env(ENV_REPORT, &dir.path().join("report.json")),
        ]))
        .unwrap_err();
        assert_eq!(
            relative,
            NativeE2eError::RelativePath {
                name: ENV_MARKER,
                path: PathBuf::from("marker.json")
            }
        );

        let same = NativeE2eConfig::from_env(lookup(vec![
            (ENV_SCENARIO, OsString::from("smoke")),
            path_env(ENV_MARKER, &marker),
            path_env(ENV_REPORT, &marker),
        ]))
        .unwrap_err();
        assert_eq!(
            same,
            NativeE2eError::SamePaths {
                marker: marker.clone(),
                report: marker
            }
        );
    }

    #[test]
    fn config_rejects_output_paths_that_are_directories() {
        let dir = tempfile::tempdir().unwrap();
        let existing_dir = dir.path().join("output");
        fs::create_dir(&existing_dir).unwrap();

        let error = NativeE2eConfig::from_env(lookup(vec![
            (ENV_SCENARIO, OsString::from("smoke")),
            path_env(ENV_MARKER, &existing_dir),
            path_env(ENV_REPORT, &dir.path().join("report.json")),
        ]))
        .unwrap_err();
        assert_eq!(
            error,
            NativeE2eError::PathIsDirectory {
                name: ENV_MARKER,
                path: existing_dir
            }
        );
    }

    #[test]
    fn identifier_validation_rejects_production_and_unprefixed_values() {
        assert!(validate_identifier(IDENTIFIER).is_ok());
        assert!(validate_identifier("com.example.opus.native-e2e").is_ok());

        assert_eq!(
            validate_identifier(PRODUCTION_IDENTIFIER).unwrap_err(),
            NativeE2eError::ProductionIdentifier {
                identifier: PRODUCTION_IDENTIFIER.into()
            }
        );
        assert_eq!(
            validate_identifier("com.xiongweini.markdown-edit.debug").unwrap_err(),
            NativeE2eError::InvalidIdentifier {
                identifier: "com.xiongweini.markdown-edit.debug".into()
            }
        );
        assert_eq!(
            validate_identifier(".native-e2e").unwrap_err(),
            NativeE2eError::InvalidIdentifier {
                identifier: ".native-e2e".into()
            }
        );
    }

    #[test]
    fn marker_writes_the_exact_contract_without_temp_files_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_config(&dir);

        let marker = write_marker(&config, IDENTIFIER, "draft-ready").unwrap();
        assert_eq!(
            marker,
            NativeE2eMarker {
                scenario: "recovery".into(),
                phase: "draft-ready".into(),
                identifier: IDENTIFIER.into(),
            }
        );
        let on_disk: Value =
            serde_json::from_slice(&fs::read(&config.marker_path).unwrap()).unwrap();
        assert_eq!(
            on_disk,
            json!({
                "scenario": "recovery",
                "phase": "draft-ready",
                "identifier": IDENTIFIER,
            })
        );
        assert_eq!(dir_entries(dir.path()), vec!["native-e2e-marker.json"]);

        write_marker(&config, IDENTIFIER, "restored").unwrap();
        let on_disk: Value =
            serde_json::from_slice(&fs::read(&config.marker_path).unwrap()).unwrap();
        assert_eq!(on_disk["phase"], "restored");
        assert_eq!(dir_entries(dir.path()), vec!["native-e2e-marker.json"]);
    }

    #[test]
    fn marker_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = test_config(&dir);
        config.marker_path = dir.path().join("nested").join("deeper").join("marker.json");

        write_marker(&config, IDENTIFIER, "clean-ready").unwrap();
        assert!(config.marker_path.is_file());
    }

    #[test]
    fn marker_rejects_invalid_phases_and_identifiers() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_config(&dir);

        for phase in [
            "",
            "has space",
            "../escape",
            &"x".repeat(MAX_PHASE_LENGTH + 1),
        ] {
            let error = write_marker(&config, IDENTIFIER, phase).unwrap_err();
            assert_eq!(
                error,
                NativeE2eError::InvalidPhase {
                    phase: phase.into()
                },
                "phase {phase:?} must be rejected"
            );
        }
        assert!(!config.marker_path.exists());

        let error = write_marker(&config, PRODUCTION_IDENTIFIER, "done").unwrap_err();
        assert_eq!(
            error,
            NativeE2eError::ProductionIdentifier {
                identifier: PRODUCTION_IDENTIFIER.into()
            }
        );
        assert!(!config.marker_path.exists());
    }

    #[test]
    fn report_is_stamped_with_the_server_owned_scenario_and_identifier() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_config(&dir);

        let written = write_report(
            &config,
            IDENTIFIER,
            json!({
                "status": "passed",
                "scenario": "spoofed",
                "identifier": "spoofed",
                "path": "/tmp/note.md",
                "text": "# Hello",
            }),
        )
        .unwrap();
        assert_eq!(written["scenario"], "recovery");
        assert_eq!(written["identifier"], IDENTIFIER);
        assert_eq!(written["status"], "passed");
        assert_eq!(written["path"], "/tmp/note.md");

        let on_disk: Value =
            serde_json::from_slice(&fs::read(&config.report_path).unwrap()).unwrap();
        assert_eq!(on_disk, written);
        assert_eq!(dir_entries(dir.path()), vec!["native-e2e-report.json"]);
    }

    #[test]
    fn report_rejects_non_objects_and_oversized_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_config(&dir);

        let error = write_report(&config, IDENTIFIER, json!(["passed"])).unwrap_err();
        assert_eq!(error, NativeE2eError::ReportNotObject);
        assert!(!config.report_path.exists());

        let oversized = json!({ "text": "x".repeat(MAX_REPORT_BYTES) });
        let error = write_report(&config, IDENTIFIER, oversized).unwrap_err();
        assert!(
            matches!(error, NativeE2eError::ReportTooLarge { .. }),
            "expected ReportTooLarge, got {error:?}"
        );
        assert!(!config.report_path.exists());
    }

    #[test]
    fn report_replaces_an_existing_file_without_leaving_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_config(&dir);
        fs::write(&config.report_path, "old").unwrap();

        write_report(&config, IDENTIFIER, json!({ "status": "passed" })).unwrap();
        let on_disk: Value =
            serde_json::from_slice(&fs::read(&config.report_path).unwrap()).unwrap();
        assert_eq!(on_disk["status"], "passed");
        assert_eq!(dir_entries(dir.path()), vec!["native-e2e-report.json"]);
    }
}
