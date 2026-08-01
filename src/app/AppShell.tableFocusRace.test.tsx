import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile } from "../document/types";

vi.mock("../editor/MarkdownEditor", async () => {
  const React = await import("react");
  return {
    default: ({
      onRequestTableEdit,
      tableFocusRequest,
      onTableFocusConsumed,
    }: {
      onRequestTableEdit?: (request: {
        tableFrom: number;
        cellIndex: number;
        clientX: number;
        clientY: number;
      }) => void;
      tableFocusRequest?: {
        sequence: number;
        tableFrom: number;
        cellIndex: number;
        clientX: number;
        clientY: number;
      } | null;
      onTableFocusConsumed?: (request: {
        sequence: number;
        tableFrom: number;
        cellIndex: number;
        clientX: number;
        clientY: number;
      }) => void;
    }) => {
      const seen = React.useRef(new Map<number, NonNullable<typeof tableFocusRequest>>());
      if (tableFocusRequest) seen.current.set(tableFocusRequest.sequence, tableFocusRequest);
      const request = (cellIndex: number) => onRequestTableEdit?.({
        tableFrom: 0,
        cellIndex,
        clientX: cellIndex * 10,
        clientY: cellIndex * 20,
      });
      return React.createElement(
        "div",
        null,
        React.createElement("button", {
          type: "button",
          onClick: () => request(1),
        }, "发布请求 A"),
        React.createElement("button", {
          type: "button",
          onClick: () => request(2),
        }, "发布请求 B"),
        ...[...seen.current.values()].map((request) =>
          React.createElement("button", {
            key: request.sequence,
            type: "button",
            onClick: () => onTableFocusConsumed?.(request),
          }, `确认请求 ${request.sequence}`)
        ),
        tableFocusRequest
          ? React.createElement(
              "output",
              { "data-testid": "pending-table-focus" },
              String(tableFocusRequest.sequence),
            )
          : null,
      );
    },
  };
});

import AppShell from "./AppShell";

const file = (path: string): OpenedFile => ({
  path,
  text: "table",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: `version:${path}`,
});

describe("AppShell table-focus acknowledgement ordering", () => {
  it("keeps and processes a newer request after an older acknowledgement arrives", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map([
      ["/notes/race.md", file("/notes/race.md")],
    ]));
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));

    await user.click(screen.getByRole("button", { name: "发布请求 A" }));
    await waitFor(() => expect(screen.getByTestId("pending-table-focus"))
      .toHaveTextContent("1"));
    await user.click(screen.getByRole("button", { name: "发布请求 B" }));
    await waitFor(() => expect(screen.getByTestId("pending-table-focus"))
      .toHaveTextContent("2"));

    await user.click(screen.getByRole("button", { name: "确认请求 1" }));
    expect(screen.getByTestId("pending-table-focus")).toHaveTextContent("2");

    await user.click(screen.getByRole("button", { name: "确认请求 2" }));
    await waitFor(() => expect(screen.queryByTestId("pending-table-focus"))
      .not.toBeInTheDocument());
    expect(port.writes).toHaveLength(0);
  });
});
