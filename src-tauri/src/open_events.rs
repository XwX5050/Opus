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

const IMAGE_EXTENSIONS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico",
];

pub fn is_image_path(path: &Path) -> bool {
    path.extension().and_then(|x| x.to_str()).is_some_and(|x| {
        IMAGE_EXTENSIONS
            .iter()
            .any(|ext| x.eq_ignore_ascii_case(ext))
    })
}

/// Payload for the `image-files-dropped` event. `x`/`y` are the physical
/// drop coordinates reported by the native drag-drop event.
#[derive(Clone, Debug, Serialize)]
pub struct ImageDropPayload {
    pub paths: Vec<PathBuf>,
    pub x: f64,
    pub y: f64,
}

/// Splits natively dropped paths into `(images, rest)`: image *files* are
/// inserted into the editor as `![image](path)` references, everything else
/// (including image-named directories) flows through the regular
/// open-as-document pipeline.
pub fn partition_dropped_paths(paths: Vec<PathBuf>) -> (Vec<PathBuf>, Vec<PathBuf>) {
    paths.into_iter().partition(|path| {
        is_image_path(path) && std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
    })
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

    #[test]
    fn partitions_dropped_paths_into_image_files_and_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        let photo = dir.path().join("photo.PNG");
        std::fs::write(&photo, "x").unwrap();
        let note = dir.path().join("note.md");
        std::fs::write(&note, "x").unwrap();
        let webp = dir.path().join("pic.webp");
        std::fs::write(&webp, "x").unwrap();
        // An image-named *directory* must not enter the image pipeline.
        let image_named_dir = dir.path().join("folder.png");
        std::fs::create_dir(&image_named_dir).unwrap();
        // A missing path cannot be an image either, even with a matching
        // extension; it keeps the open-as-document behavior.
        let missing = dir.path().join("missing.PNG");

        let (images, rest) = partition_dropped_paths(vec![
            photo.clone(),
            note.clone(),
            webp.clone(),
            image_named_dir.clone(),
            missing.clone(),
        ]);
        assert_eq!(images, vec![photo, webp]);
        assert_eq!(rest, vec![note, image_named_dir, missing]);
    }
}
