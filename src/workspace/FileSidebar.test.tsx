import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentPortError } from "../document/DocumentPort";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile } from "../document/types";
import FileSidebar from "./FileSidebar";

const root = { path: "/notes", title: "notes" };

const file = (path: string): OpenedFile => ({
  path,
  text: "",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: `version:${path}`,
});

const makePort = () =>
  new MemoryDocumentPort(
    new Map([
      ["/notes/alpha.md", file("/notes/alpha.md")],
      ["/notes/Beta.markdown", file("/notes/Beta.markdown")],
      ["/notes/drafts/gamma.md", file("/notes/drafts/gamma.md")],
    ]),
    { workspace: root, directories: ["/notes/archive"] },
  );

const renderSidebar = (port = makePort(), onOpenFile = vi.fn()) => {
  const view = render(
    <FileSidebar
      root={root}
      port={port}
      onOpenFile={onOpenFile}
      onCloseWorkspace={vi.fn()}
    />,
  );
  return { port, onOpenFile, ...view };
};

const rows = () => screen.getAllByRole("treeitem");
const rowNames = () => rows().map((row) => row.getAttribute("aria-label"));

// The disk-event reload path — event -> invalidation -> listing request ->
// render — spans several React commits plus an async listing per event. CI
// runners under parallel load exceed the 1s default find*/waitFor budget, so
// assertions that wait on that path get an explicit budget with margin.
const DISK_EVENT_TIMEOUT_MS = 3000;

describe("FileSidebar", () => {
  it("loads the top-level listing once with directories before files", async () => {
    const { port } = renderSidebar();

    await screen.findByRole("treeitem", { name: "alpha.md" });

    expect(screen.getByRole("tree", { name: "工作区文件" })).toBeInTheDocument();
    expect(rowNames()).toEqual(["archive", "drafts", "alpha.md", "Beta.markdown"]);
    expect(port.listCalls).toEqual([{ root: "/notes", relative: "" }]);
    expect(screen.getByRole("treeitem", { name: "drafts" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("treeitem", { name: "alpha.md" })).not.toHaveAttribute(
      "aria-expanded",
    );
  });

  it("expanding one directory requests only that directory and collapsing keeps the cache", async () => {
    const user = userEvent.setup();
    const { port } = renderSidebar();
    await screen.findByRole("treeitem", { name: "drafts" });

    await user.click(screen.getByRole("treeitem", { name: "drafts" }));
    await screen.findByRole("treeitem", { name: "gamma.md" });

    expect(port.listCalls).toEqual([
      { root: "/notes", relative: "" },
      { root: "/notes", relative: "drafts" },
    ]);
    expect(screen.getByRole("treeitem", { name: "drafts" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await user.click(screen.getByRole("treeitem", { name: "drafts" }));
    expect(screen.queryByRole("treeitem", { name: "gamma.md" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("treeitem", { name: "drafts" }));
    await screen.findByRole("treeitem", { name: "gamma.md" });
    // Re-expanding used the cached listing: no third request.
    expect(port.listCalls).toHaveLength(2);
  });

  it("narrows visible rows to filenames matching the filter", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await screen.findByRole("treeitem", { name: "alpha.md" });
    await user.click(screen.getByRole("treeitem", { name: "drafts" }));
    await screen.findByRole("treeitem", { name: "gamma.md" });

    await user.type(screen.getByRole("textbox", { name: "筛选文件" }), "GAM");

    expect(rowNames()).toEqual(["gamma.md"]);

    await user.clear(screen.getByRole("textbox", { name: "筛选文件" }));
    expect(rowNames()).toHaveLength(5);
  });

  it("opens a file through onOpenFile when clicked", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    renderSidebar(makePort(), onOpenFile);
    await screen.findByRole("treeitem", { name: "alpha.md" });

    await user.click(screen.getByRole("treeitem", { name: "alpha.md" }));

    expect(onOpenFile).toHaveBeenCalledWith("/notes/alpha.md");
  });

  it("supports tree keyboard navigation and opens files with Enter", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    renderSidebar(makePort(), onOpenFile);
    const first = await screen.findByRole("treeitem", { name: "archive" });
    first.focus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("treeitem", { name: "drafts" })).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    await screen.findByRole("treeitem", { name: "gamma.md" });
    expect(screen.getByRole("treeitem", { name: "drafts" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("treeitem", { name: "gamma.md" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("/notes/drafts/gamma.md");

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("treeitem", { name: "drafts" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("treeitem", { name: "drafts" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("moves an entry to the trash and leaves the tree unchanged when trashing fails", async () => {
    const user = userEvent.setup();
    const { port } = renderSidebar();
    await screen.findByRole("treeitem", { name: "alpha.md" });

    port.trashFailure = new DocumentPortError("io", "trash failed");
    const betaRow = screen.getByRole("treeitem", { name: "Beta.markdown" });
    await user.click(within(betaRow).getByRole("button", { name: "移到废纸篓" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("trash failed");
    expect(screen.getByRole("treeitem", { name: "Beta.markdown" })).toBeInTheDocument();

    port.trashFailure = null;
    const alphaRow = screen.getByRole("treeitem", { name: "alpha.md" });
    await user.click(within(alphaRow).getByRole("button", { name: "移到废纸篓" }));

    await waitFor(() =>
      expect(screen.queryByRole("treeitem", { name: "alpha.md" })).not.toBeInTheDocument(),
    );
    const reloaded = await port.listDirectory("/notes", "");
    expect(reloaded.map((entry) => entry.name)).not.toContain("alpha.md");
  });

  it("creates a markdown file through the inline name input", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await screen.findByRole("treeitem", { name: "alpha.md" });

    await user.click(screen.getByRole("button", { name: "新建文件" }));
    const input = screen.getByRole("textbox", { name: "文件名" });
    await user.type(input, "new-note.md{Enter}");

    await screen.findByRole("treeitem", { name: "new-note.md" });
    expect(rowNames()).toEqual([
      "archive",
      "drafts",
      "alpha.md",
      "Beta.markdown",
      "new-note.md",
    ]);
  });

  it("renames an entry through the inline name input", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const alphaRow = await screen.findByRole("treeitem", { name: "alpha.md" });

    await user.click(within(alphaRow).getByRole("button", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "文件名" });
    await user.clear(input);
    await user.type(input, "renamed.md{Enter}");

    await screen.findByRole("treeitem", { name: "renamed.md" });
    expect(screen.queryByRole("treeitem", { name: "alpha.md" })).not.toBeInTheDocument();
    expect(rowNames()).toEqual(["archive", "drafts", "Beta.markdown", "renamed.md"]);
  });

  it("closes the workspace through the header action", async () => {
    const user = userEvent.setup();
    const onCloseWorkspace = vi.fn();
    render(
      <FileSidebar
        root={root}
        port={makePort()}
        onOpenFile={vi.fn()}
        onCloseWorkspace={onCloseWorkspace}
      />,
    );

    await user.click(screen.getByRole("button", { name: "关闭文件夹" }));

    expect(onCloseWorkspace).toHaveBeenCalledOnce();
  });

  it("keeps typed rename text when a background listing update re-renders", async () => {
    const user = userEvent.setup();
    const port = makePort();
    // Hold the "drafts" listing so its loadSucceeded lands while the user is
    // typing in the rename input, simulating a background tree update.
    let releaseListing!: () => void;
    const original = port.listDirectory.bind(port);
    vi.spyOn(port, "listDirectory").mockImplementation(
      async (rootPath: string, relative: string) => {
        if (relative === "drafts") {
          await new Promise<void>((resolve) => {
            releaseListing = resolve;
          });
        }
        return original(rootPath, relative);
      },
    );
    renderSidebar(port);
    const betaRow = await screen.findByRole("treeitem", { name: "Beta.markdown" });

    await user.click(screen.getByRole("treeitem", { name: "drafts" }));
    await user.click(within(betaRow).getByRole("button", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "文件名" });
    await user.clear(input);
    await user.type(input, "draf");

    releaseListing();
    await screen.findByRole("treeitem", { name: "gamma.md" });
    expect(input).toHaveFocus();

    // userEvent.keyboard types into the focused element without clicking, so
    // a re-select on re-render would replace the typed text instead of adding.
    await user.keyboard("t");
    expect(input).toHaveValue("draft");
  });

  it("shows a retry row when a listing fails and re-requests on retry", async () => {
    const user = userEvent.setup();
    const { port } = renderSidebar();
    await screen.findByRole("treeitem", { name: "drafts" });

    port.listFailure = new DocumentPortError("io", "listing failed");
    await user.click(screen.getByRole("treeitem", { name: "drafts" }));

    expect(await screen.findByText("加载失败：drafts")).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "gamma.md" })).not.toBeInTheDocument();
    expect(port.listCalls).toEqual([
      { root: "/notes", relative: "" },
      { root: "/notes", relative: "drafts" },
    ]);

    port.listFailure = null;
    await user.click(screen.getByRole("button", { name: "重试" }));

    await screen.findByRole("treeitem", { name: "gamma.md" });
    expect(screen.queryByText(/加载失败/)).not.toBeInTheDocument();
    expect(port.listCalls).toEqual([
      { root: "/notes", relative: "" },
      { root: "/notes", relative: "drafts" },
      { root: "/notes", relative: "drafts" },
    ]);
  });

  it("shows no failure UI for a genuinely empty directory", async () => {
    const user = userEvent.setup();
    const { port } = renderSidebar();
    await screen.findByRole("treeitem", { name: "archive" });

    await user.click(screen.getByRole("treeitem", { name: "archive" }));

    await waitFor(() =>
      expect(port.listCalls).toEqual([
        { root: "/notes", relative: "" },
        { root: "/notes", relative: "archive" },
      ]),
    );
    expect(screen.getByRole("treeitem", { name: "archive" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByText(/加载失败/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("re-lists the affected parent when disk events change the workspace", async () => {
    const { port } = renderSidebar();
    await screen.findByRole("treeitem", { name: "alpha.md" });
    const initialCalls = port.listCalls.length;

    // A file created outside the app appears after a changed event.
    const created = await port.createMarkdownFile("/notes", "delta.md");
    port.emitDiskEvent({ kind: "changed", path: created.path, modifiedUnixMs: 1, version: "v1" });
    await screen.findByRole("treeitem", { name: "delta.md" }, { timeout: DISK_EVENT_TIMEOUT_MS });

    // A file deleted outside the app disappears after a missing event.
    port.removeFile("/notes/alpha.md");
    port.emitDiskEvent({ kind: "missing", path: "/notes/alpha.md" });
    await waitFor(
      () =>
        expect(screen.queryByRole("treeitem", { name: "alpha.md" })).not.toBeInTheDocument(),
      { timeout: DISK_EVENT_TIMEOUT_MS },
    );

    // A rename reported as moved updates both sides of the listing.
    const renamed = await port.renameEntry("/notes", "Beta.markdown", "renamed.md");
    port.emitDiskEvent({ kind: "moved", from: "/notes/Beta.markdown", to: renamed.path });
    await screen.findByRole(
      "treeitem",
      { name: "renamed.md" },
      { timeout: DISK_EVENT_TIMEOUT_MS },
    );
    expect(screen.queryByRole("treeitem", { name: "Beta.markdown" })).not.toBeInTheDocument();

    // Every event re-listed the affected parent directory.
    expect(port.listCalls.length).toBeGreaterThan(initialCalls);
  });

  it("keeps an expanded directory expanded when a disk event reloads it", async () => {
    const user = userEvent.setup();
    const { port } = renderSidebar();
    await user.click(await screen.findByRole("treeitem", { name: "drafts" }));
    await screen.findByRole("treeitem", { name: "gamma.md" });
    const callsBefore = port.listCalls.length;

    // A change inside the expanded directory invalidates exactly that
    // listing; the folder stays expanded and its children reload.
    await act(async () => {
      port.updateFile("/notes/drafts/gamma.md", "edited", "v2");
      port.emitDiskEvent({
        kind: "changed",
        path: "/notes/drafts/gamma.md",
        modifiedUnixMs: 2,
        version: "v2",
      });
    });

    await waitFor(() => expect(port.listCalls.length).toBeGreaterThan(callsBefore), {
      timeout: DISK_EVENT_TIMEOUT_MS,
    });
    expect(
      await screen.findByRole(
        "treeitem",
        { name: "gamma.md" },
        { timeout: DISK_EVENT_TIMEOUT_MS },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "drafts" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("ignores disk events outside the workspace root", async () => {
    const { port } = renderSidebar();
    await screen.findByRole("treeitem", { name: "alpha.md" });
    const calls = [...port.listCalls];

    // The subscription registers asynchronously after mount; only emit once
    // the handler is known to be live so the assertion checks a delivered
    // event rather than a not-yet-registered subscriber.
    await waitFor(() => expect(port.diskEventHandlerCount).toBeGreaterThan(0));
    await act(async () => {
      port.emitDiskEvent({ kind: "changed", path: "/other/x.md", modifiedUnixMs: 1, version: "v1" });
    });

    // A wrongly-scoped handler would dispatch an invalidation synchronously,
    // so the act flush above decides the outcome deterministically — no fixed
    // sleep window that a loaded CI worker could slip through.
    expect(port.listCalls).toEqual(calls);
  });

  it("rejects create names containing a path separator", async () => {
    const user = userEvent.setup();
    const { port } = renderSidebar();
    await screen.findByRole("treeitem", { name: "alpha.md" });

    await user.click(screen.getByRole("button", { name: "新建文件" }));
    const input = screen.getByRole("textbox", { name: "文件名" });
    await user.type(input, "sub/deep.md{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(/路径分隔符/);
    // Nothing landed in the tree or in the backing store.
    expect(screen.queryByRole("treeitem", { name: "sub/deep.md" })).not.toBeInTheDocument();
    const listing = await port.listDirectory("/notes", "");
    expect(listing.map((entry) => entry.name)).not.toContain("sub/deep.md");
    // The input stays open so the user can correct the name.
    expect(screen.getByRole("textbox", { name: "文件名" })).toBeInTheDocument();
  });

  it("reloads a renamed directory whose listing was in flight", async () => {
    const user = userEvent.setup();
    const port = makePort();
    // Hold the "drafts" listing so the rename lands while it is in flight.
    let releaseListing!: () => void;
    const original = port.listDirectory.bind(port);
    vi.spyOn(port, "listDirectory").mockImplementation(
      async (rootPath: string, relative: string) => {
        if (relative === "drafts") {
          await new Promise<void>((resolve) => {
            releaseListing = resolve;
          });
        }
        return original(rootPath, relative);
      },
    );
    renderSidebar(port);
    await screen.findByRole("treeitem", { name: "alpha.md" });

    await user.click(screen.getByRole("treeitem", { name: "drafts" }));
    const draftsRow = screen.getByRole("treeitem", { name: "drafts" });
    await user.click(within(draftsRow).getByRole("button", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "文件名" });
    await user.clear(input);
    await user.type(input, "published{Enter}");

    // The rename dropped the stale in-flight token, so the renamed directory
    // is re-requested immediately and its listing renders.
    await screen.findByRole("treeitem", { name: "gamma.md" }, { timeout: DISK_EVENT_TIMEOUT_MS });
    expect(screen.queryByRole("treeitem", { name: "drafts" })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "published" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // The stale listing settling later is discarded, not applied.
    releaseListing();
    await waitFor(
      () => expect(screen.getByRole("treeitem", { name: "gamma.md" })).toBeInTheDocument(),
      { timeout: DISK_EVENT_TIMEOUT_MS },
    );
  });
});
