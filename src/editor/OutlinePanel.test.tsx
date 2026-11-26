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

const rowOf = (name: string): HTMLElement => {
  const row = screen
    .getByText(name, { selector: ".outline-heading-button" })
    .closest<HTMLElement>(".outline-tree-row");
  if (!row) throw new Error(`no outline row for ${name}`);
  return row;
};

const rect = (top: number, bottom: number): DOMRect => ({
  x: 0,
  y: top,
  width: 0,
  height: bottom - top,
  top,
  bottom,
  left: 0,
  right: 0,
  toJSON: () => ({}),
});

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

  it("marks only the active heading as the current location", () => {
    renderPanel({ activeId: "child" });

    const active = screen.getByRole("treeitem", { name: "Child" });
    expect(active).toHaveAttribute("aria-current", "location");
    expect(active.closest(".outline-heading-active")).not.toBeNull();
    expect(document.querySelectorAll(".outline-heading-active")).toHaveLength(1);
    expect(screen.getByRole("treeitem", { name: "Alpha" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("treeitem", { name: "Grandchild" })).not
      .toHaveAttribute("aria-current");
  });

  it("leaves highlighting off when no active heading is supplied", () => {
    renderPanel();

    expect(document.querySelector(".outline-heading-active")).toBeNull();
    for (const item of screen.getAllByRole("treeitem")) {
      expect(item).not.toHaveAttribute("aria-current");
    }
  });

  it("ignores an active id that is not part of the outline", () => {
    renderPanel({ activeId: "stale-heading" });

    expect(document.querySelector(".outline-heading-active")).toBeNull();
    expect(document.querySelector("[data-current-ancestor]")).toBeNull();
  });

  it("marks the visible collapsed ancestor instead of expanding the tree", () => {
    const first = renderPanel({
      activeId: "grandchild",
      collapsedIds: new Set(["child"]),
    });

    // The current row is hidden and no branch expanded on its own.
    expect(screen.getByRole("button", { name: "展开 Child" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("treeitem", { name: "Grandchild" })).not
      .toBeInTheDocument();
    const ancestor = screen.getByRole("treeitem", {
      name: "Child，包含当前标题",
    });
    expect(ancestor).not.toHaveAttribute("aria-current");
    expect(document.querySelectorAll('[aria-current="location"]')).toHaveLength(0);
    expect(rowOf("Child")).toHaveAttribute("data-current-ancestor", "true");
    expect(rowOf("Child")).not.toHaveClass("outline-heading-active");
    // Expanded ancestors of the collapsed branch stay unmarked.
    expect(rowOf("Alpha")).not.toHaveAttribute("data-current-ancestor");
    expect(screen.getByRole("treeitem", { name: "Alpha" })).not.toHaveAttribute(
      "aria-label",
    );
    first.unmount();

    // Only the outermost visible collapsed ancestor is marked; branches
    // hidden beneath it stay hidden.
    renderPanel({
      activeId: "grandchild",
      collapsedIds: new Set(["alpha", "child"]),
    });
    expect(rowOf("Alpha")).toHaveAttribute("data-current-ancestor", "true");
    expect(screen.getByRole("treeitem", { name: "Alpha，包含当前标题" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "Child" })).not
      .toBeInTheDocument();
  });

  it("reveals an off-screen active heading with a minimal scroll", () => {
    const { props, rerender } = renderPanel();
    const content = document.querySelector<HTMLElement>(".outline-content")!;
    Object.defineProperty(content, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    content.style.paddingTop = "8px";
    content.style.paddingBottom = "8px";
    content.getBoundingClientRect = () => rect(0, 200);

    rowOf("Second").getBoundingClientRect = () => rect(260, 290);
    rerender(<OutlinePanel {...props} activeId="second" />);
    expect(content.scrollTop).toBe(98);

    // The panel never yanks itself back after the reader scrolls elsewhere.
    content.scrollTop = 0;
    rerender(
      <OutlinePanel {...props} activeId="second" headings={[...tree]} />,
    );
    expect(content.scrollTop).toBe(0);

    // Above the viewport, the first row lands on scrollTop 0: the 8px top
    // padding stays visible instead of being consumed by the scroll.
    rowOf("Omega").getBoundingClientRect = () => rect(-42, -12);
    content.scrollTop = 50;
    rerender(<OutlinePanel {...props} activeId="omega" />);
    expect(content.scrollTop).toBe(0);
  });

  it("does not scroll when the active heading is already visible", () => {
    const { props, rerender } = renderPanel();
    const content = document.querySelector<HTMLElement>(".outline-content")!;
    Object.defineProperty(content, "scrollTop", {
      configurable: true,
      writable: true,
      value: 24,
    });
    content.style.paddingTop = "8px";
    content.style.paddingBottom = "8px";
    content.getBoundingClientRect = () => rect(0, 200);
    rowOf("Child").getBoundingClientRect = () => rect(16, 46);

    rerender(<OutlinePanel {...props} activeId="child" />);
    expect(content.scrollTop).toBe(24);
  });

  it("reveals the marked collapsed ancestor when the current heading is hidden", () => {
    const { props, rerender } = renderPanel();
    const content = document.querySelector<HTMLElement>(".outline-content")!;
    Object.defineProperty(content, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    content.style.paddingTop = "8px";
    content.style.paddingBottom = "8px";
    content.getBoundingClientRect = () => rect(0, 200);
    rowOf("Alpha").getBoundingClientRect = () => rect(300, 330);

    rerender(
      <OutlinePanel
        {...props}
        activeId="grandchild"
        collapsedIds={new Set(["alpha"])}
      />,
    );

    // The tree stays collapsed, the ancestor is marked and revealed with
    // the padded visible band (200 - 8 = 192).
    expect(content.scrollTop).toBe(138);
    expect(rowOf("Alpha")).toHaveAttribute("data-current-ancestor", "true");
    expect(screen.getByRole("treeitem", { name: "Alpha，包含当前标题" })).not
      .toHaveAttribute("aria-current");
    expect(screen.queryByRole("treeitem", { name: "Grandchild" })).not
      .toBeInTheDocument();

    // A marked ancestor that is already visible is left alone.
    rowOf("Alpha").getBoundingClientRect = () => rect(16, 46);
    content.scrollTop = 50;
    rerender(
      <OutlinePanel
        {...props}
        activeId="second"
        collapsedIds={new Set(["alpha"])}
      />,
    );
    expect(content.scrollTop).toBe(50);
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
