import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OutlineHeading } from "./outline";
import OutlinePanel from "./OutlinePanel";

const leaf = (
  id: string,
  text: string,
  level: OutlineHeading["level"],
): OutlineHeading => ({
  id,
  text,
  level,
  from: 0,
  textFrom: 2,
  children: [],
});

const tree: ReadonlyArray<OutlineHeading> = [
  {
    ...leaf("alpha", "Alpha", 1),
    children: [
      {
        ...leaf("child", "Child", 2),
        children: [leaf("grandchild", "Grandchild", 3)],
      },
      leaf("second", "Second", 2),
    ],
  },
  leaf("omega", "Omega", 1),
];

const renderPanel = (
  overrides: Partial<React.ComponentProps<typeof OutlinePanel>> = {},
) => {
  const props = {
    headings: tree,
    collapsedIds: new Set<string>(),
    onToggle: vi.fn(),
    onCollapseAll: vi.fn(),
    onExpandAll: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<OutlinePanel {...props} />) };
};

describe("OutlinePanel", () => {
  it("shows loading and empty states", () => {
    const loading = renderPanel({ headings: null });
    expect(screen.getByText("正在生成大纲…")).toBeVisible();
    loading.unmount();

    renderPanel({ headings: [] });
    expect(screen.getByText("当前文档没有标题")).toBeVisible();
  });

  it("renders an accessible nested document tree", () => {
    renderPanel();

    const outline = screen.getByRole("tree", { name: "文档大纲" });
    expect(within(outline).getAllByRole("treeitem")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "收起 Alpha" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "收起 Child" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("treeitem", { name: "Alpha" })).toHaveAttribute(
      "aria-level",
      "1",
    );
    expect(screen.getByRole("treeitem", { name: "Grandchild" })).toHaveAttribute(
      "aria-level",
      "3",
    );
  });

  it("keeps disclosure and navigation actions separate", async () => {
    const user = userEvent.setup();
    const { props } = renderPanel();

    await user.click(screen.getByRole("button", { name: "收起 Alpha" }));
    expect(props.onToggle).toHaveBeenCalledWith("alpha");
    expect(props.onNavigate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("treeitem", { name: "Alpha" }));
    expect(props.onNavigate).toHaveBeenCalledWith(tree[0]);
    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it("hides descendants for collapsed branches", () => {
    renderPanel({ collapsedIds: new Set(["alpha"]) });

    expect(screen.getByRole("button", { name: "展开 Alpha" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("treeitem", { name: "Child" })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "Omega" })).toBeVisible();
  });

  it("toggles between collapsing and expanding every parent", async () => {
    const user = userEvent.setup();
    const first = renderPanel();
    const collapseAll = screen.getByRole("button", { name: "全部折叠" });
    expect(collapseAll).toBeEnabled();
    expect(collapseAll).toHaveAttribute("aria-pressed", "false");
    await user.click(collapseAll);
    expect(first.props.onCollapseAll).toHaveBeenCalledOnce();
    expect(first.props.onExpandAll).not.toHaveBeenCalled();
    first.unmount();

    const second = renderPanel({ collapsedIds: new Set(["alpha", "child"]) });
    const expandAll = screen.getByRole("button", { name: "全部展开" });
    expect(expandAll).toBeEnabled();
    expect(expandAll).toHaveAttribute("aria-pressed", "true");
    await user.click(expandAll);
    expect(second.props.onExpandAll).toHaveBeenCalledOnce();
    expect(second.props.onCollapseAll).not.toHaveBeenCalled();
  });

  it("disables the toggle-all action when there are no parent headings", () => {
    renderPanel({ headings: [leaf("only", "Only", 1)] });

    expect(screen.getByRole("button", { name: "全部折叠" })).toBeDisabled();
  });
});
