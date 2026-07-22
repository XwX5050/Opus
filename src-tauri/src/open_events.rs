use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

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
