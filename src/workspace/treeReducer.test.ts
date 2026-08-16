import { describe, expect, it } from "vitest";
import type { DirectoryEntry, WorkspaceRoot } from "../document/DocumentPort";
import {
  initialTreeState,
  pendingLoads,
  treeReducer,
  visibleRows,
} from "./treeReducer";

const root: WorkspaceRoot = { path: "/notes", title: "notes" };

const dir = (path: string): DirectoryEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  isDirectory: true,
});

const file = (path: string): DirectoryEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  isDirectory: false,
});

const topLevel: DirectoryEntry[] = [
  dir("/notes/archive"),
  dir("/notes/drafts"),
  file("/notes/alpha.md"),
  file("/notes/Beta.markdown"),
];

const draftsChildren: DirectoryEntry[] = [
  dir("/notes/drafts/deep"),
  file("/notes/drafts/gamma.md"),
];

const opened = () => treeReducer(initialTreeState, { type: "workspaceOpened", root });
const loaded = () =>
  treeReducer(opened(), {
    type: "loadSucceeded",
    path: root.path,
    children: topLevel,
    epoch: 0,
  });

describe("treeReducer", () => {
  it("starts empty and requests the root listing after a workspace opens", () => {
    expect(initialTreeState.root).toBeNull();
    expect(pendingLoads(initialTreeState)).toEqual([]);

    const state = opened();
    expect(state.root).toEqual(root);
    expect(pendingLoads(state)).toEqual([root.path]);
  });

  it("opening another workspace drops every cached node", () => {
    const state = treeReducer(loaded(), {
      type: "workspaceOpened",
      root: { path: "/other", title: "other" },
    });
    expect(state.children).toEqual({});
    expect(pendingLoads(state)).toEqual(["/other"]);
  });

  it("expanding one directory requests only that directory", () => {
    const expanded = treeReducer(loaded(), {
      type: "directoryToggled",
      path: "/notes/drafts",
    });

    expect(expanded.expanded.has("/notes/drafts")).toBe(true);
    expect(pendingLoads(expanded)).toEqual(["/notes/drafts"]);

    const withChildren = treeReducer(expanded, {
      type: "loadSucceeded",
      path: "/notes/drafts",
      children: draftsChildren,
      epoch: 0,
    });
    expect(pendingLoads(withChildren)).toEqual([]);
  });

  it("collapsing retains cached children and re-expanding issues no new request", () => {
    let state = treeReducer(loaded(), { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, {
      type: "loadSucceeded",
      path: "/notes/drafts",
      children: draftsChildren,
      epoch: 0,
    });

    const collapsed = treeReducer(state, { type: "directoryToggled", path: "/notes/drafts" });
    expect(collapsed.expanded.has("/notes/drafts")).toBe(false);
    expect(collapsed.children["/notes/drafts"]).toEqual(draftsChildren);

    const reexpanded = treeReducer(collapsed, { type: "directoryToggled", path: "/notes/drafts" });
    expect(reexpanded.expanded.has("/notes/drafts")).toBe(true);
    expect(pendingLoads(reexpanded)).toEqual([]);
  });

  it("lists visible rows depth-first only through expanded directories", () => {
    let state = treeReducer(loaded(), { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, {
      type: "loadSucceeded",
      path: "/notes/drafts",
      children: draftsChildren,
      epoch: 0,
    });

    const rows = visibleRows(state);
    expect(rows.map((row) => [row.entry.path, row.depth] as const)).toEqual([
      ["/notes/archive", 1],
      ["/notes/drafts", 1],
      ["/notes/drafts/deep", 2],
      ["/notes/drafts/gamma.md", 2],
      ["/notes/alpha.md", 1],
      ["/notes/Beta.markdown", 1],
    ]);
    expect(rows[1].isExpanded).toBe(true);
    expect(rows[0].isExpanded).toBe(false);
  });

  it("filtering matches file and directory names case-insensitively", () => {
    let state = treeReducer(loaded(), { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, {
      type: "loadSucceeded",
      path: "/notes/drafts",
      children: draftsChildren,
      epoch: 0,
    });

    const filtered = treeReducer(state, { type: "filterChanged", filter: "GAM" });
    expect(visibleRows(filtered).map((row) => row.entry.path)).toEqual([
      "/notes/drafts/gamma.md",
    ]);

    const cleared = treeReducer(filtered, { type: "filterChanged", filter: "" });
    expect(visibleRows(cleared).length).toBe(6);
  });

  it("marks failed loads so they are not retried until the directory is toggled again", () => {
    let state = treeReducer(loaded(), { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, { type: "loadRequested", path: "/notes/drafts" });
    expect(pendingLoads(state)).toEqual([]);

    state = treeReducer(state, { type: "loadFailed", path: "/notes/drafts", epoch: 0 });
    expect(pendingLoads(state)).toEqual([]);

    state = treeReducer(state, { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, { type: "directoryToggled", path: "/notes/drafts" });
    expect(pendingLoads(state)).toEqual(["/notes/drafts"]);
  });

  it("inserts created entries into a cached listing in sorted position only", () => {
    let state = loaded();
    state = treeReducer(state, {
      type: "entryCreated",
      parentPath: "/notes",
      entry: file("/notes/zeta.md"),
    });
    state = treeReducer(state, {
      type: "entryCreated",
      parentPath: "/notes",
      entry: dir("/notes/middle"),
    });
    state = treeReducer(state, {
      type: "entryCreated",
      parentPath: "/notes/not-loaded",
      entry: file("/notes/not-loaded/x.md"),
    });

    expect(state.children["/notes"].map((entry) => entry.name)).toEqual([
      "archive",
      "drafts",
      "middle",
      "alpha.md",
      "Beta.markdown",
      "zeta.md",
    ]);
    expect(state.children["/notes/not-loaded"]).toBeUndefined();
  });

  it("renames an entry and re-keys its cached subtree", () => {
    let state = treeReducer(loaded(), { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, {
      type: "loadSucceeded",
      path: "/notes/drafts",
      children: draftsChildren,
      epoch: 0,
    });

    state = treeReducer(state, {
      type: "entryRenamed",
      parentPath: "/notes",
      from: "/notes/drafts",
      entry: dir("/notes/published"),
    });

    expect(state.children["/notes"].map((entry) => entry.name)).toEqual([
      "archive",
      "published",
      "alpha.md",
      "Beta.markdown",
    ]);
    expect(state.children["/notes/drafts"]).toBeUndefined();
    expect(state.children["/notes/published"]).toEqual([
      dir("/notes/published/deep"),
      file("/notes/published/gamma.md"),
    ]);
    expect(state.expanded.has("/notes/drafts")).toBe(false);
    expect(state.expanded.has("/notes/published")).toBe(true);
  });

  it("removes a trashed entry together with its cached subtree", () => {
    let state = treeReducer(loaded(), { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, {
      type: "loadSucceeded",
      path: "/notes/drafts",
      children: draftsChildren,
      epoch: 0,
    });

    state = treeReducer(state, {
      type: "entryRemoved",
      parentPath: "/notes",
      path: "/notes/drafts",
    });

    expect(state.children["/notes"].map((entry) => entry.name)).toEqual([
      "archive",
      "alpha.md",
      "Beta.markdown",
    ]);
    expect(state.children["/notes/drafts"]).toBeUndefined();
    expect(state.expanded.has("/notes/drafts")).toBe(false);
  });

  it("re-requests a cached listing after a disk invalidation, keeping it expanded", () => {
    let state = treeReducer(loaded(), { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, {
      type: "loadSucceeded",
      path: "/notes/drafts",
      children: draftsChildren,
      epoch: 0,
    });
    expect(pendingLoads(state)).toEqual([]);

    state = treeReducer(state, { type: "directoryInvalidated", path: "/notes/drafts" });

    expect(state.children["/notes/drafts"]).toBeUndefined();
    expect(state.expanded.has("/notes/drafts")).toBe(true);
    expect(pendingLoads(state)).toEqual(["/notes/drafts"]);
  });

  it("re-requests a previously failed directory after a disk invalidation", () => {
    let state = treeReducer(loaded(), { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, { type: "loadRequested", path: "/notes/drafts" });
    state = treeReducer(state, { type: "loadFailed", path: "/notes/drafts", epoch: 0 });
    expect(pendingLoads(state)).toEqual([]);

    state = treeReducer(state, { type: "directoryInvalidated", path: "/notes/drafts" });

    expect(state.failed.has("/notes/drafts")).toBe(false);
    expect(pendingLoads(state)).toEqual(["/notes/drafts"]);
  });

  it("discards an in-flight result superseded by a disk invalidation", () => {
    let state = treeReducer(loaded(), { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, { type: "loadRequested", path: "/notes/drafts" });
    state = treeReducer(state, { type: "directoryInvalidated", path: "/notes/drafts" });
    expect(state.loading.has("/notes/drafts")).toBe(false);

    // The stale request lands with the generation it was issued under.
    state = treeReducer(state, {
      type: "loadSucceeded",
      path: "/notes/drafts",
      children: draftsChildren,
      epoch: 0,
    });
    expect(state.children["/notes/drafts"]).toBeUndefined();
    expect(pendingLoads(state)).toEqual(["/notes/drafts"]);

    // The replacement request (current generation) applies normally.
    state = treeReducer(state, {
      type: "loadSucceeded",
      path: "/notes/drafts",
      children: draftsChildren,
      epoch: 1,
    });
    expect(state.children["/notes/drafts"]).toEqual(draftsChildren);
    expect(pendingLoads(state)).toEqual([]);
  });

  it("renaming an in-flight directory re-requests it and discards the stale result", () => {
    let state = treeReducer(loaded(), { type: "directoryToggled", path: "/notes/drafts" });
    state = treeReducer(state, { type: "loadRequested", path: "/notes/drafts" });
    expect(pendingLoads(state)).toEqual([]);

    state = treeReducer(state, {
      type: "entryRenamed",
      parentPath: "/notes",
      from: "/notes/drafts",
      entry: dir("/notes/published"),
    });

    // The in-flight mark is dropped instead of remapped, so the renamed
    // directory is requested again rather than leaving `loading` stuck.
    expect(state.loading.has("/notes/drafts")).toBe(false);
    expect(state.loading.has("/notes/published")).toBe(false);
    expect(pendingLoads(state)).toEqual(["/notes/published"]);

    // The stale result for the old path is discarded, not cached.
    state = treeReducer(state, {
      type: "loadSucceeded",
      path: "/notes/drafts",
      children: draftsChildren,
      epoch: 0,
    });
    expect(state.children["/notes/drafts"]).toBeUndefined();
    expect(pendingLoads(state)).toEqual(["/notes/published"]);

    state = treeReducer(state, {
      type: "loadSucceeded",
      path: "/notes/published",
      children: draftsChildren,
      epoch: 0,
    });
    expect(state.children["/notes/published"]).toEqual(draftsChildren);
    expect(pendingLoads(state)).toEqual([]);
  });
});