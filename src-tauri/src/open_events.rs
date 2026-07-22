use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct OpenPathsPayload {
    pub files: Vec<PathBuf>,
    pub directories: Vec<PathBuf>,
}

impl OpenPathsPayload {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.directories.is_empty()
    }
}

#[derive(Default)]
pub struct OpenPathQueue {
    ready: bool,
    pending: Vec<PathBuf>,
}

impl OpenPathQueue {
    pub fn enqueue<I>(&mut self, paths: I) -> Option<OpenPathsPayload>
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let paths = paths.into_iter().collect::<Vec<_>>();
        if self.ready {
            nonempty(classify(paths))
        } else {
            self.pending.extend(paths);
            None
        }
    }

    pub fn ready(&mut self) -> Option<OpenPathsPayload> {
        if self.ready {
            return None;
        }
        self.ready = true;
        nonempty(classify(std::mem::take(&mut self.pending)))
    }
}

fn nonempty(payload: OpenPathsPayload) -> Option<OpenPathsPayload> {
    (!payload.is_empty()).then_some(payload)
}

fn classify(paths: Vec<PathBuf>) -> OpenPathsPayload {
    let mut seen = HashSet::new();
    let mut payload = OpenPathsPayload::default();
    for path in paths.into_iter().filter(|path| seen.insert(path.clone())) {
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_dir() => payload.directories.push(path),
            Ok(metadata) if metadata.is_file() && is_markdown(&path) => payload.files.push(path),
            _ => {}
        }
    }
    payload
}

pub fn normalize_open_paths<I, S>(values: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| normalize_one(value.as_ref()))
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn normalize_one(value: &str) -> Option<PathBuf> {
    if value.starts_with('-') {
        return None;
    }
    let path = if value.contains("://") {
        let url = tauri::Url::parse(value).ok()?;
        if url.scheme() != "file" {
            return None;
        }
        url.to_file_path().ok()?
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute() || !is_markdown(&path) {
        return None;
    }
    Some(path)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| x.eq_ignore_ascii_case("md") || x.eq_ignore_ascii_case("markdown"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_urls_deduplicates_and_rejects_invalid_inputs() {
        let paths = normalize_open_paths([
            "file:///tmp/a%20b.md",
            "/tmp/a b.md",
            "https://x/a.md",
            "relative.md",
            "/tmp/a.txt",
            "--flag",
        ]);
        assert_eq!(paths, vec![PathBuf::from("/tmp/a b.md")]);
    }
}
