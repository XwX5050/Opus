# Opus GitHub Publication Design

## Goal

Prepare the current `master` branch for a safe first push to the private GitHub repository `XwX5050/Opus`. The published repository must explain the project clearly, provide contributor instructions, state reuse terms, and contain no credentials or unintended machine-specific data.

## Documentation

- Refresh `AGENTS.md` as a 200–400 word contributor guide covering the current React/TypeScript, CodeMirror, Tauri/Rust, test, release, and security workflows.
- Add `README.md` with a concise product overview, current features, technology stack, local development commands, testing, macOS build instructions, and project status.
- Add the standard MIT License using `Copyright (c) 2026 XwX5050`.

Documentation must use commands that exist in `package.json` or repository scripts. Local release instructions must distinguish ad-hoc development signing from distributable Developer ID releases.

## Sensitive Information Audit

Audit both the current tracked tree and all reachable Git history before pushing. Search for common credential formats, private keys, tokens, passwords, absolute home-directory paths, generated application bundles, environment files, and other machine-specific artifacts. Inspect tracked screenshots for visible private information.

If a credential is found, do not push. Report the affected path and require credential rotation before publication. If only non-secret local paths are found in historical planning documents, remove them from the publishable state where practical and report any historical residue rather than rewriting history without explicit approval.

## GitHub Publication

After documentation and validation pass:

1. Commit the publication files with a focused Conventional Commit message.
2. Create a private GitHub repository named `XwX5050/Opus`.
3. Add it as the `origin` remote and push `master`.
4. Verify the remote default branch, visibility, latest commit, and clean local worktree.

The existing local history remains intact. No force-push, history rewrite, release upload, or public visibility change is included.
