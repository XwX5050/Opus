import { render, screen, waitFor, within } from "@testing-library/react";
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
});
