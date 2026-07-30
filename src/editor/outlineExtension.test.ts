import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineHeading } from "./outline";
import { outlinePublisherExtension } from "./outlineExtension";

describe("outlinePublisherExtension", () => {
  let host: HTMLDivElement;
  let view: EditorView | null;
  let published: ReadonlyArray<ReadonlyArray<OutlineHeading>>;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    view = null;
    published = [];
  });

  afterEach(() => {
    view?.destroy();
    host.remove();
    vi.useRealTimers();
  });

  const createView = (doc: string) => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          markdown(),
          outlinePublisherExtension(
            (headings) => {
              published = [...published, headings];
            },
            { debounceMs: 120, parseSliceMs: 20 },
          ),
        ],
      }),
    });
    return view;
  };

  it("publishes the initial outline", async () => {
    createView("# One");

    await vi.runAllTimersAsync();

    expect(published).toHaveLength(1);
    expect(published[0].map((heading) => heading.text)).toEqual(["One"]);
  });

  it("coalesces rapid document changes and publishes only the latest tree", async () => {
    const editor = createView("# One");
    await vi.runAllTimersAsync();
    published = [];

    editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\n## Two" } });
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\n### Three" } });
    editor.dispatch({ changes: { from: 2, to: 5, insert: "Final" } });
    await vi.advanceTimersByTimeAsync(119);
    expect(published).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);

    expect(published).toHaveLength(1);
    expect(published[0][0].text).toBe("Final");
    expect(published[0][0].children[0].children[0].text).toBe("Three");
  });

  it("does not publish scheduled work after the editor is destroyed", async () => {
    const editor = createView("# One");
    editor.destroy();
    view = null;

    await vi.runAllTimersAsync();

    expect(published).toHaveLength(0);
  });

  it("publishes an empty outline when the last heading is removed", async () => {
    const editor = createView("# One");
    await vi.runAllTimersAsync();
    published = [];

    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: "plain text" },
    });
    await vi.runAllTimersAsync();

    expect(published).toEqual([[]]);
  });
});
