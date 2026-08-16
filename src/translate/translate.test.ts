import { describe, expect, it, vi } from "vitest";
import {
  translateDocument,
  type TranslationPartial,
} from "./translate";
import type { TranslationSettings } from "./types";

const settings: TranslationSettings = {
  endpoint: "https://example.com/v1",
  apiKey: "sk-test",
  model: "gpt-test",
  targetLanguage: "中文",
};

interface FakeTranslatePort {
  translateSegments(
    settings: TranslationSettings,
    segments: string[],
  ): Promise<string[]>;
}

interface PendingCall {
  segments: string[];
  resolve: (value: string[]) => void;
}

/** A paragraph of `length` chars (plus its trailing newline). */
const paragraph = (length: number): string => "x".repeat(length) + "\n";

const echoPort = (): FakeTranslatePort => ({
  translateSegments: vi.fn(
    async (_settings: TranslationSettings, segments: string[]) =>
      segments.map((segment) => segment.toUpperCase()),
  ),
});

/**
 * A port whose calls stay pending until resolved in test control; records
 * started calls and never resolves on its own.
 */
const deferredPort = (): {
  port: FakeTranslatePort;
  started: string[][];
  pending: PendingCall[];
} => {
  const started: string[][] = [];
  const pending: PendingCall[] = [];
  const port: FakeTranslatePort = {
    translateSegments: vi.fn(
      (_settings: TranslationSettings, segments: string[]) =>
        new Promise<string[]>((resolve) => {
          started.push(segments);
          pending.push({ segments, resolve });
        }),
    ),
  };
  return { port, started, pending };
};

describe("translateDocument", () => {
  it("returns the document unchanged when it is empty", async () => {
    const port = echoPort();
    await expect(translateDocument(port, settings, "")).resolves.toBe("");
    expect(port.translateSegments).not.toHaveBeenCalled();
  });

  it("returns the document unchanged when nothing is translatable", async () => {
    const doc = "---\ntitle: X\n---\n\n```ts\ncode\n```\n";
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(doc);
    expect(port.translateSegments).not.toHaveBeenCalled();
  });

  it("translates a short document in a single call, passing settings through", async () => {
    const doc = "hello\n\nworld\n";
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      "HELLO\n\nWORLD\n",
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
    expect(port.translateSegments).toHaveBeenCalledWith(settings, [
      "hello\n",
      "world\n",
    ]);
  });

  it("batches translatable blocks within the 1500-character budget", async () => {
    const paras = Array.from({ length: 5 }, () => paragraph(700));
    const doc = paras.join("\n");
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(3);
    expect(port.translateSegments).toHaveBeenNthCalledWith(
      1,
      settings,
      paras.slice(0, 2),
    );
    expect(port.translateSegments).toHaveBeenNthCalledWith(
      2,
      settings,
      paras.slice(2, 4),
    );
    expect(port.translateSegments).toHaveBeenNthCalledWith(3, settings, [
      paras[4],
    ]);
  });

  it("sends an over-budget single segment in its own batch", async () => {
    const big = paragraph(5000);
    const small = paragraph(100);
    const doc = big + "\n" + small;
    const port = echoPort();
    await translateDocument(port, settings, doc);
    expect(port.translateSegments).toHaveBeenCalledTimes(2);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [big]);
    expect(port.translateSegments).toHaveBeenNthCalledWith(
      2,
      settings,
      [small],
    );
  });

  it("keeps at most four translateSegments calls in flight", async () => {
    const paras = Array.from({ length: 12 }, () => paragraph(700));
    const doc = paras.join("\n");
    let inFlight = 0;
    let peak = 0;
    const pending: PendingCall[] = [];
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        (_settings: TranslationSettings, segments: string[]) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          return new Promise<string[]>((resolve) => {
            pending.push({
              segments,
              resolve: (value) => {
                inFlight -= 1;
                resolve(value);
              },
            });
          });
        },
      ),
    };
    const running = translateDocument(port, settings, doc);
    // The pool fills its four slots synchronously.
    expect(pending).toHaveLength(4);

    // Drain the pool; a new call only starts as a slot frees up.
    while (pending.length > 0) {
      const entry = pending.shift()!;
      entry.resolve(entry.segments.map((segment) => segment.toUpperCase()));
      await Promise.resolve();
    }
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(peak).toBe(4);
    expect(port.translateSegments).toHaveBeenCalledTimes(6);
  });

  it("reassembles results in document order when batches finish out of order", async () => {
    const paras = Array.from({ length: 4 }, () => paragraph(700));
    const doc = paras.join("\n");
    const partials: string[] = [];
    const { port, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial.text),
    });
    expect(pending).toHaveLength(2);

    // The second batch lands first: its paragraphs translate while the first
    // batch's paragraphs still show the original text.
    pending[1].resolve(
      pending[1].segments.map((segment) => segment.toUpperCase()),
    );
    await Promise.resolve();
    expect(partials).toHaveLength(1);
    expect(partials[0]).toBe(
      paras[0] +
        "\n" +
        paras[1] +
        "\n" +
        paras[2].toUpperCase() +
        "\n" +
        paras[3].toUpperCase(),
    );

    pending[0].resolve(
      pending[0].segments.map((segment) => segment.toUpperCase()),
    );
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(partials).toHaveLength(2);
    expect(partials[1]).toBe(doc.toUpperCase());
  });

  it("reports every completed batch through onPartial with progress counts", async () => {
    const paras = Array.from({ length: 6 }, () => paragraph(700));
    const doc = paras.join("\n");
    const partials: TranslationPartial[] = [];
    const port = echoPort();
    await translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial),
    });
    expect(partials).toHaveLength(3);
    expect(partials.map((partial) => partial.completedBatches)).toEqual([
      1, 2, 3,
    ]);
    expect(partials[0].totalBatches).toBe(3);
    expect(partials[1].text).toBe(
      paras
        .slice(0, 4)
        .map((para) => para.toUpperCase())
        .concat(paras.slice(4))
        .join("\n"),
    );
    expect(partials[2].text).toBe(doc.toUpperCase());
  });

  it("does not call onPartial when nothing is translatable", async () => {
    const doc = "---\ntitle: X\n---\n";
    const onPartial = vi.fn();
    const port = echoPort();
    await translateDocument(port, settings, doc, { onPartial });
    expect(onPartial).not.toHaveBeenCalled();
  });

  it("restores the original line breaks when the model drops them", async () => {
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        async (_settings: TranslationSettings, segments: string[]) =>
          segments.map((segment) => "译文" + segment.trim()),
      ),
    };
    await expect(
      translateDocument(port, settings, "one\n\ntwo\n"),
    ).resolves.toBe("译文one\n\n译文two\n");
  });

  it("restores CRLF line breaks", async () => {
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        async (_settings: TranslationSettings, segments: string[]) =>
          segments.map(() => "译文"),
      ),
    };
    await expect(
      translateDocument(port, settings, "one\r\n\r\ntwo\r\n"),
    ).resolves.toBe("译文\r\n\r\n译文\r\n");
  });

  it("normalizes extra leading and trailing newlines from the model", async () => {
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        async (_settings: TranslationSettings, segments: string[]) =>
          segments.map((segment) => "\n译文" + segment.trim() + "\n\n"),
      ),
    };
    await expect(
      translateDocument(port, settings, "one\n\ntwo\n"),
    ).resolves.toBe("译文one\n\n译文two\n");
  });

  it("rejects with an AbortError when aborted before the first call", async () => {
    const controller = new AbortController();
    controller.abort();
    const port = echoPort();
    await expect(
      translateDocument(port, settings, "hello\n\nworld\n", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(port.translateSegments).not.toHaveBeenCalled();
  });

  it("rejects with an AbortError and starts no new batches once aborted", async () => {
    const paras = Array.from({ length: 5 }, () => paragraph(700));
    const doc = paras.join("\n");
    const controller = new AbortController();
    const { port, started, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      signal: controller.signal,
    });
    // The pool fills immediately (three batches here); the abort only stops
    // batches that have not started yet.
    expect(started).toHaveLength(3);

    controller.abort();
    for (const entry of pending) entry.resolve([]);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toHaveLength(3);
  });

  it("propagates port errors", async () => {
    const failure = new Error("api down");
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(async () => {
        throw failure;
      }),
    };
    await expect(translateDocument(port, settings, "hello\n")).rejects.toBe(
      failure,
    );
  });
});