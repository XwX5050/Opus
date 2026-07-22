use markdown_edit_lib::open_events::{OpenPathQueue, OpenPathsPayload};

#[test]
fn queues_before_ready_then_flushes_once_with_deduplication() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.md");
    std::fs::write(&file, "a").unwrap();
    let mut queue = OpenPathQueue::default();
    assert!(queue.enqueue([file.clone(), file.clone()]).is_none());
    assert_eq!(
        queue.ready(),
        Some(OpenPathsPayload {
            files: vec![file],
            directories: vec![]
        })
    );
    assert_eq!(queue.ready(), None);
}

#[test]
fn classifies_real_metadata_not_extensions() {
    let dir = tempfile::tempdir().unwrap();
    let folder_md = dir.path().join("folder.md");
    let markdown = dir.path().join("note.MARKDOWN");
    let plain = dir.path().join("note.txt");
    std::fs::create_dir(&folder_md).unwrap();
    std::fs::write(&markdown, "a").unwrap();
    std::fs::write(&plain, "a").unwrap();
    let mut queue = OpenPathQueue::default();
    queue.enqueue([folder_md.clone(), markdown.clone(), plain]);
    assert_eq!(
        queue.ready(),
        Some(OpenPathsPayload {
            files: vec![markdown],
            directories: vec![folder_md]
        })
    );
}
