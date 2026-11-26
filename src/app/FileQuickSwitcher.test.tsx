import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile } from "../document/types";
import FileQuickSwitcher from "./FileQuickSwitcher";

const workspace = { path: "/notes", title: "notes" };

const file = (path: string): OpenedFile => ({
  path,
  text: "",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: `version:${path}`,
});

const makePort = (count: number) =>
  new MemoryDocumentPort(
    new Map(
      Array.from({ length: count }, (_, index) => {
        const path = `/notes/note-${index + 1}.md`;
        return [path, file(path)] as const;
      }),
    ),
    { workspace },
  );

const renderSwitcher = (count = 9) =>
  render(
    <FileQuickSwitcher
      open
      port={makePort(count)}
      workspace={workspace}
      additionalPaths={[]}
      onOpenFile={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
    />,
  );

const input = () => screen.getByRole("combobox", { name: "切换或创建文件" });
const listbox = () => screen.findByRole("listbox", { name: "文件列表" });

describe("FileQuickSwitcher beyond the first six options", () => {
  it("keeps ids, aria-selected and aria-activedescendant global across 更多", async () => {
    const scrolledIds: string[] = [];
    const scrollDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value(this: Element) {
        scrolledIds.push(this.id);
      },
    });

    try {
      renderSwitcher(9);
      const list = await listbox();
      await waitFor(() =>
        expect(list.querySelectorAll('[role="option"]')).toHaveLength(9),
      );
      const box = input();
      box.focus();

      for (let step = 0; step < 6; step += 1) {
        fireEvent.keyDown(box, { key: "ArrowDown" });
      }

      const details = list.querySelector("details");
      await waitFor(() => expect(details).toHaveAttribute("open"));

      const seventh = document.getElementById(`${list.id}-6`);
      expect(seventh).not.toBeNull();
      expect(seventh).toHaveAttribute("aria-label", "notes/note-7.md");
      expect(seventh).toHaveAttribute("aria-selected", "true");
      expect(box).toHaveAttribute("aria-activedescendant", `${list.id}-6`);
      await waitFor(() => expect(scrolledIds.at(-1)).toBe(`${list.id}-6`));

      const ids = [...list.querySelectorAll<HTMLElement>('[role="option"]')].map(
        (option) => option.id,
      );
      expect(new Set(ids).size).toBe(ids.length);
      expect(list.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);

      fireEvent.keyDown(box, { key: "ArrowDown" });
      const eighth = document.getElementById(`${list.id}-7`);
      expect(eighth).not.toBeNull();
      expect(eighth).toHaveAttribute("aria-label", "notes/note-8.md");
      expect(eighth).toHaveAttribute("aria-selected", "true");
      expect(seventh).toHaveAttribute("aria-selected", "false");
      expect(box).toHaveAttribute("aria-activedescendant", `${list.id}-7`);
      await waitFor(() => expect(scrolledIds.at(-1)).toBe(`${list.id}-7`));
      expect(details).toHaveAttribute("open");
    } finally {
      if (scrollDescriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });
});
