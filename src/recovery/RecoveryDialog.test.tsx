import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RecoveryDraftInfo } from "../document/types";
import RecoveryDialog from "./RecoveryDialog";

const draft = (overrides: Partial<RecoveryDraftInfo> = {}): RecoveryDraftInfo => ({
  draftId: "draft-document-1",
  originalPath: "/notes/a.md",
  title: "a.md",
  savedTextHash: "hash",
  savedVersion: "v1",
  updatedUnixMs: 1,
  ...overrides,
});

const renderDialog = (
  drafts: ReadonlyArray<RecoveryDraftInfo>,
  overrides: Partial<Parameters<typeof RecoveryDialog>[0]> = {},
) => {
  const props = {
    drafts,
    onRestore: vi.fn(),
    onDiscard: vi.fn(),
    readSource: vi.fn(async (draftId: string) => `source of ${draftId}`),
    ...overrides,
  };
  render(<RecoveryDialog {...props} />);
  return props;
};

describe("RecoveryDialog", () => {
  it("lists every leftover draft with its three actions", () => {
    renderDialog([
      draft(),
      draft({ draftId: "draft-document-2", originalPath: null, title: "Untitled" }),
    ]);

    const dialog = screen.getByRole("dialog", { name: "恢复未保存的更改" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const items = within(dialog).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("a.md")).toBeVisible();
    expect(within(items[0]).getByText(/\/notes\/a\.md/)).toBeVisible();
    expect(within(items[1]).getByText("Untitled")).toBeVisible();
    for (const item of items) {
      expect(within(item).getByRole("button", { name: "恢复" })).toBeVisible();
      expect(within(item).getByRole("button", { name: "查看源码" })).toBeVisible();
      expect(within(item).getByRole("button", { name: "丢弃" })).toBeVisible();
    }
  });

  it("restores a draft only through an explicit click", async () => {
    const user = userEvent.setup();
    const props = renderDialog([draft()]);

    expect(props.onRestore).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "恢复" }));
    expect(props.onRestore).toHaveBeenCalledWith(draft());
  });

  it("discards a draft only through an explicit click", async () => {
    const user = userEvent.setup();
    const props = renderDialog([draft()]);

    expect(props.onDiscard).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "丢弃" }));
    expect(props.onDiscard).toHaveBeenCalledWith(draft());
  });

  it("shows the draft source on demand without restoring or discarding", async () => {
    const user = userEvent.setup();
    const props = renderDialog([draft()]);

    const toggle = screen.getByRole("button", { name: "查看源码" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    expect(await screen.findByText("source of draft-document-1")).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(props.readSource).toHaveBeenCalledWith("draft-document-1");
    expect(props.onRestore).not.toHaveBeenCalled();
    expect(props.onDiscard).not.toHaveBeenCalled();

    await user.click(toggle);
    expect(screen.queryByText("source of draft-document-1")).not.toBeInTheDocument();
  });

  it("never shows a stale source under a different draft", async () => {
    const user = userEvent.setup();
    const resolvers = new Map<string, (text: string) => void>();
    const readSource = vi.fn(
      (draftId: string) =>
        new Promise<string>((resolve) => resolvers.set(draftId, resolve)),
    );
    renderDialog(
      [draft(), draft({ draftId: "draft-document-2", title: "b.md" })],
      { readSource },
    );

    const dialog = screen.getByRole("dialog", { name: "恢复未保存的更改" });
    const toggles = within(dialog).getAllByRole("button", { name: "查看源码" });
    await user.click(toggles[0]);
    await user.click(toggles[1]);

    // A's late resolve must not appear under the expanded B.
    resolvers.get("draft-document-1")!("source of A");
    await act(async () => {});
    expect(screen.queryByText("source of A")).not.toBeInTheDocument();

    resolvers.get("draft-document-2")!("source of B");
    expect(await screen.findByText("source of B")).toBeVisible();
  });

  it("keeps the expanded draft's source when a slower read resolves late", async () => {
    const user = userEvent.setup();
    const resolvers = new Map<string, (text: string) => void>();
    const readSource = vi.fn(
      (draftId: string) =>
        new Promise<string>((resolve) => resolvers.set(draftId, resolve)),
    );
    renderDialog(
      [draft(), draft({ draftId: "draft-document-2", title: "b.md" })],
      { readSource },
    );

    const dialog = screen.getByRole("dialog", { name: "恢复未保存的更改" });
    const toggles = within(dialog).getAllByRole("button", { name: "查看源码" });
    // Expand A (its read stays pending), then expand B and let B's read
    // land first: B is now showing its own source.
    await user.click(toggles[0]);
    await user.click(toggles[1]);
    resolvers.get("draft-document-2")!("source of B");
    expect(await screen.findByText("source of B")).toBeVisible();

    // A's slow read then lands; it must not overwrite B's displayed source
    // (which would flip B back to "载入中…").
    resolvers.get("draft-document-1")!("source of A");
    await act(async () => {});
    expect(screen.queryByText("source of A")).not.toBeInTheDocument();
    expect(screen.getByText("source of B")).toBeVisible();
  });

  it("does not dismiss on Escape: every draft needs an explicit decision", async () => {
    const user = userEvent.setup();
    const props = renderDialog([draft()]);

    await user.keyboard("{Escape}");

    expect(screen.getByRole("dialog", { name: "恢复未保存的更改" })).toBeVisible();
    expect(props.onRestore).not.toHaveBeenCalled();
    expect(props.onDiscard).not.toHaveBeenCalled();
  });
});
