import { afterEach, describe, expect, it, vi } from "vitest";
import {
  translateDocument,
  TRANSLATION_BATCH_MAX_CHARS,
  TRANSLATION_BATCH_MAX_UNITS,
  type TranslationPartial,
  type TranslationPriority,
  type TranslationTextRange,
} from "./translate";
import type { TranslationSettings } from "./types";

const settings: TranslationSettings = {
  endpoint: "https://example.com/v1",
  model: "gpt-test",
  targetLanguage: "中文",
  concurrency: 10,
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

/** A distinguishable paragraph: `"p000"` repeated to 96 chars plus newline. */
const paraText = (n: number): string =>
  ("p" + String(n).padStart(3, "0")).repeat(24) + "\n";

const batchTexts = (k: number): string[] =>
  Array.from(
    { length: TRANSLATION_BATCH_MAX_UNITS },
    (_, j) => paraText(k * TRANSLATION_BATCH_MAX_UNITS + j),
  );

/**
 * Drains the pending microtask queue after deferred port calls resolve. The
 * worker crosses several await boundaries (port call -> retry helper -> work
 * loop) before emitting a partial, so a single `await Promise.resolve()` is
 * not enough to observe the side effect.
 */
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

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

/**
 * A port whose every segment is mapped through `transform` — lets tests model
 * providers that preserve, drop, or rewrite placeholders.
 */
const transformPort = (transform: (segment: string) => string): FakeTranslatePort => ({
  translateSegments: vi.fn(
    async (_settings: TranslationSettings, segments: string[]) =>
      segments.map(transform),
  ),
});

describe("translateDocument", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("translates a short document in one batched call, passing settings through", async () => {
    const doc = "hello\n\nworld\n";
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      "HELLO\n\nWORLD\n",
    );
    // Both segments fit one batch: a single call carries both chunks.
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [
      "hello\n",
      "world\n",
    ]);
  });

  it("packs every fitting segment into a single batch", async () => {
    const paras = Array.from({ length: 5 }, () => paragraph(550));
    const doc = paras.join("\n");
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
    expect(port.translateSegments).toHaveBeenNthCalledWith(
      1,
      settings,
      paras,
    );
  });

  it("groups contiguous units into batches capped at eight units", async () => {
    const paras = Array.from({ length: 9 }, () => paragraph(400));
    const doc = paras.join("\n");
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    // Eight 401-char units stay under the character cap; the ninth starts a
    // new batch of its own.
    expect(port.translateSegments).toHaveBeenCalledTimes(2);
    expect(port.translateSegments).toHaveBeenNthCalledWith(
      1,
      settings,
      paras.slice(0, TRANSLATION_BATCH_MAX_UNITS),
    );
    expect(port.translateSegments).toHaveBeenNthCalledWith(
      2,
      settings,
      paras.slice(TRANSLATION_BATCH_MAX_UNITS),
    );
  });

  it("stops a batch at the character cap before the unit cap", async () => {
    // Seven 551-char units fit (3857 chars); the eighth would push the batch
    // to 4408 chars, so it starts a batch of its own.
    const paras = Array.from({ length: 8 }, () => paragraph(550));
    const doc = paras.join("\n");
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(2);
    expect(port.translateSegments).toHaveBeenNthCalledWith(
      1,
      settings,
      paras.slice(0, 7),
    );
    expect(port.translateSegments).toHaveBeenNthCalledWith(2, settings, [
      paras[7],
    ]);
  });

  it("subdivides an over-long segment and packs the chunks into batches", async () => {
    const big = paragraph(5000); // 5001 chars: one over-limit line
    const small = paragraph(100);
    const doc = big + "\n" + small;
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    // "x"*5000 hard-splits into 600*8 + 200 chunks, the last one keeping the
    // trailing newline. Six 600-char chunks fill the first batch (3600 chars);
    // the remaining chunks plus the short paragraph form the second.
    expect(port.translateSegments).toHaveBeenCalledTimes(2);
    expect(port.translateSegments).toHaveBeenNthCalledWith(
      1,
      settings,
      Array.from({ length: 6 }, () => "x".repeat(600)),
    );
    expect(port.translateSegments).toHaveBeenNthCalledWith(2, settings, [
      "x".repeat(600),
      "x".repeat(600),
      "x".repeat(200) + "\n",
      small,
    ]);
  });

  it("subdivides an over-long multi-line paragraph at line boundaries", async () => {
    const line = "l".repeat(300) + "\n"; // 301 chars
    const big = line.repeat(6); // 1806 chars -> six single-line chunks
    const doc = big + "\n" + paragraph(100);
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [
      ...Array.from({ length: 6 }, () => line),
      paragraph(100),
    ]);
  });

  it("exposes the batch caps as shared constants", () => {
    expect(TRANSLATION_BATCH_MAX_UNITS).toBe(8);
    expect(TRANSLATION_BATCH_MAX_CHARS).toBe(4000);
  });

  it("keeps at most ten translateSegments calls in flight by default", async () => {
    // 100 short paragraphs -> 100 units -> 13 batches of up to eight.
    const paras = Array.from({ length: 100 }, () => paragraph(100));
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
    // The pool fills its ten slots synchronously.
    expect(pending).toHaveLength(10);

    // Drain the pool in batches; a new call only starts as a slot frees up.
    while (pending.length > 0) {
      const batch = pending.splice(0);
      for (const entry of batch) {
        entry.resolve(entry.segments.map((segment) => segment.toUpperCase()));
      }
      await flushMicrotasks();
    }
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(peak).toBe(10);
    expect(port.translateSegments).toHaveBeenCalledTimes(13);
  });

  it("honors an explicit concurrency cap below the default", async () => {
    // 30 short paragraphs -> 30 units -> 4 batches.
    const paras = Array.from({ length: 30 }, () => paragraph(100));
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
    const running = translateDocument(port, settings, doc, {
      concurrency: 2,
    });
    // The pool fills its two slots synchronously.
    expect(pending).toHaveLength(2);

    while (pending.length > 0) {
      const batch = pending.splice(0);
      for (const entry of batch) {
        entry.resolve(entry.segments.map((segment) => segment.toUpperCase()));
      }
      await flushMicrotasks();
    }
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(peak).toBe(2);
    expect(port.translateSegments).toHaveBeenCalledTimes(4);
  });

  it("reassembles results in document order when batches finish out of order", async () => {
    // Each 701-char paragraph subdivides into two chunks (600 + 101), so six
    // paragraphs make 12 units: a batch of eight and a batch of four.
    const paras = Array.from({ length: 6 }, () => paragraph(700));
    const doc = paras.join("\n");
    const partials: string[] = [];
    const { port, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial.text),
    });
    expect(pending).toHaveLength(2);

    // The last batch (the final two paragraphs) lands first: its chunks
    // translate while the earlier segments still show the original text.
    pending[1].resolve(pending[1].segments.map((segment) => segment.toUpperCase()));
    await flushMicrotasks();
    expect(partials).toHaveLength(4);
    expect(partials[3]).toBe(
      paras[0] +
        "\n" +
        paras[1] +
        "\n" +
        paras[2] +
        "\n" +
        paras[3] +
        "\n" +
        paras[4].toUpperCase() +
        "\n" +
        paras[5].toUpperCase(),
    );

    // The first batch lands last; the final partial is the full translation.
    pending[0].resolve(pending[0].segments.map((segment) => segment.toUpperCase()));
    await flushMicrotasks();
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(partials).toHaveLength(12);
    expect(partials[11]).toBe(doc.toUpperCase());
  });

  it("reports every completed unit through onPartial with progress counts", async () => {
    // Each 701-char paragraph subdivides into 600 + 101 chunks: 12 units.
    const paras = Array.from({ length: 6 }, () => paragraph(700));
    const doc = paras.join("\n");
    const partials: TranslationPartial[] = [];
    const port = echoPort();
    await translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial),
    });
    expect(partials).toHaveLength(12);
    expect(partials.map((partial) => partial.completedBatches)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(partials[0].totalBatches).toBe(12);
    // The first chunk of the first paragraph is translated; its second chunk
    // and every later paragraph still show the original text.
    expect(partials[0].text).toBe(
      "x".repeat(600).toUpperCase() +
        "x".repeat(100) +
        "\n\n" +
        paras.slice(1).join("\n"),
    );
    expect(partials[11].text).toBe(doc.toUpperCase());
  });

  it("surfaces each unit as soon as it lands, leaving unfinished units as the original text", async () => {
    const big = paragraph(2500); // 2501 chars -> 600*4 + 101 char chunks
    const small = paragraph(100);
    const doc = big + "\n" + small;
    const partials: TranslationPartial[] = [];
    const { port, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial),
    });
    // The six chunks fit a single batch.
    expect(pending).toHaveLength(1);
    expect(pending[0].segments).toHaveLength(6);

    pending[0].resolve(pending[0].segments.map((segment) => segment.toUpperCase()));
    await flushMicrotasks();
    // A finished batch emits one partial per unit: the first shows the first
    // chunk translated while the rest of the paragraph stays original.
    expect(partials).toHaveLength(6);
    expect(partials[0]).toMatchObject({
      completedBatches: 1,
      totalBatches: 6,
    });
    expect(partials[0].text).toBe(
      "x".repeat(600).toUpperCase() + "x".repeat(1900) + "\n\n" + small,
    );
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(partials[5]).toMatchObject({ completedBatches: 6, totalBatches: 6 });
    expect(partials[5].text).toBe(doc.toUpperCase());
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

  it("falls back to the original text when the model returns an empty result", async () => {
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        async (_settings: TranslationSettings, segments: string[]) =>
          segments.map((segment) => (segment === "one\n" ? "" : "\n  \n")),
      ),
    };
    await expect(
      translateDocument(port, settings, "one\n\ntwo\n"),
    ).resolves.toBe("one\n\ntwo\n");
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
    // Each paragraph subdivides into two chunks (600 + 101), packed into two
    // batches of five; the pool starts both right away.
    expect(started).toHaveLength(2);

    controller.abort();
    for (const entry of pending) entry.resolve([]);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toHaveLength(2);
  });

  it("propagates port errors after retries are exhausted", async () => {
    const failure = new Error(
      "response JSON is invalid: error decoding response body",
    );
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(async () => {
        throw failure;
      }),
    };
    vi.useFakeTimers();
    const running = translateDocument(port, settings, "hello\n");
    // Attach the rejection handler upfront so the (expected) failure is not
    // reported as an unhandled rejection while the backoff timers run.
    const assertion = expect(running).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(900);
    await assertion;
    expect(port.translateSegments).toHaveBeenCalledTimes(3);
  });

  it("retries a transiently failing request and succeeds", async () => {
    let calls = 0;
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        async (_settings: TranslationSettings, segments: string[]) => {
          calls += 1;
          if (calls === 1) throw new Error("connection reset");
          return segments.map((segment) => segment.toUpperCase());
        },
      ),
    };
    vi.useFakeTimers();
    const running = translateDocument(port, settings, "hello\n");
    await vi.advanceTimersByTimeAsync(300);
    await expect(running).resolves.toBe("HELLO\n");
    expect(calls).toBe(2);
  });

  it("retries a failed batch as a whole, resending the same unit array", async () => {
    // Nine 551-char paragraphs -> two batches: seven units, then two.
    const paras = Array.from({ length: 9 }, () => paragraph(550));
    const doc = paras.join("\n");
    const batchOne = paras.slice(0, 7);
    const batchTwo = paras.slice(7);
    let calls = 0;
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        async (_settings: TranslationSettings, segments: string[]) => {
          calls += 1;
          if (calls === 1) throw new Error("connection reset");
          return segments.map((segment) => segment.toUpperCase());
        },
      ),
    };
    vi.useFakeTimers();
    const running = translateDocument(port, settings, doc);
    await vi.advanceTimersByTimeAsync(300);
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(calls).toBe(3);
    // The first batch is resent in full; every other batch succeeds first try.
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, batchOne);
    expect(port.translateSegments).toHaveBeenNthCalledWith(2, settings, batchTwo);
    expect(port.translateSegments).toHaveBeenNthCalledWith(3, settings, batchOne);
  });

  it("rejects the run when a batch fails permanently and stops siblings", async () => {
    const failure = new Error("provider unavailable");
    // The ninth paragraph sits in its own batch and fails forever.
    const paras = Array.from({ length: 8 }, () => paragraph(550));
    const boom = "boom" + "x".repeat(546) + "\n";
    const doc = paras.join("\n") + "\n" + boom;
    const partials: TranslationPartial[] = [];
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        async (_settings: TranslationSettings, segments: string[]) => {
          if (segments.some((segment) => segment.includes("boom"))) {
            throw failure;
          }
          return segments.map((segment) => segment.toUpperCase());
        },
      ),
    };
    vi.useFakeTimers();
    const running = translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial),
    });
    const assertion = expect(running).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(900);
    await assertion;
    // The healthy batch ran its one call; the failing batch burned its three
    // attempts. Siblings stopped reporting after the failure.
    expect(port.translateSegments).toHaveBeenCalledTimes(4);
    expect(partials).toHaveLength(7);
    expect(partials[6]).toMatchObject({ completedBatches: 7, totalBatches: 9 });
  });

  it("backs off 300ms then 900ms between retry attempts", async () => {
    let calls = 0;
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(async () => {
        calls += 1;
        throw new Error("boom");
      }),
    };
    vi.useFakeTimers();
    const running = translateDocument(port, settings, "hello\n");
    const assertion = expect(running).rejects.toMatchObject({ name: "Error" });
    expect(calls).toBe(1);
    // Let the first failure land and the 300ms backoff be scheduled.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(299);
    expect(calls).toBe(1); // still inside the first backoff
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2); // first retry fired after 300ms
    await vi.advanceTimersByTimeAsync(899);
    expect(calls).toBe(2); // still inside the second backoff
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3); // second retry fired after 900ms
    await assertion;
  });

  it("does not retry when the port rejects with an AbortError", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(async () => {
        throw abort;
      }),
    };
    await expect(translateDocument(port, settings, "hello\n")).rejects.toBe(
      abort,
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
  });

  it("does not retry when aborted while a request is in flight", async () => {
    const controller = new AbortController();
    const { port, started, pending } = deferredPort();
    const running = translateDocument(port, settings, "hello\n", {
      signal: controller.signal,
    });
    expect(started).toHaveLength(1);
    controller.abort();
    pending[0].resolve([]);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toHaveLength(1);
  });

  it("sends the batch overlapping the visible range first and re-prioritizes mid-flight", async () => {
    // 80 paragraphs in ten distinguishable eight-unit batches. Before any
    // translation lands, unit i occupies displayed offsets
    // [i * stride, i * stride + 97).
    const doc = Array.from({ length: 80 }, (_, index) => paraText(index)).join(
      "\n",
    );
    const stride = paraText(0).length + 1; // paragraph + blank separator
    // The visible range sits inside the last paragraph (unit 79, batch 9).
    let range: TranslationTextRange | null = {
      from: 79 * stride,
      to: 79 * stride + 10,
    };
    const visibleRange = vi.fn((): TranslationTextRange | null => range);
    const priority: TranslationPriority = { visibleRange };
    const { port, started, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      concurrency: 4,
      priority,
    });
    // The four workers pick the batches nearest the visible units, closest
    // first.
    expect(started).toEqual([
      batchTexts(9),
      batchTexts(8),
      batchTexts(7),
      batchTexts(6),
    ]);
    expect(visibleRange).toHaveBeenCalledTimes(4);

    // Scroll to the top mid-flight: the freed worker picks the batch covering
    // unit 0, with the range re-read on this fresh pick.
    range = { from: 0, to: 5 };
    pending[0].resolve(pending[0].segments.map((segment) => segment.toUpperCase()));
    await flushMicrotasks();
    expect(started).toHaveLength(5);
    expect(started[4]).toEqual(batchTexts(0));
    expect(visibleRange).toHaveBeenCalledTimes(5);

    // No preference anymore: remaining picks fall back to document order.
    range = null;
    pending[4].resolve(pending[4].segments.map((segment) => segment.toUpperCase()));
    await flushMicrotasks();
    expect(started[5]).toEqual(batchTexts(1));
    for (let index = 5; index <= 9; index++) {
      pending[index].resolve(
        pending[index].segments.map((segment) => segment.toUpperCase()),
      );
      await flushMicrotasks();
    }
    expect(started).toEqual([
      batchTexts(9),
      batchTexts(8),
      batchTexts(7),
      batchTexts(6),
      batchTexts(0),
      batchTexts(1),
      batchTexts(2),
      batchTexts(3),
      batchTexts(4),
      batchTexts(5),
    ]);
    for (const index of [3, 2, 1]) {
      pending[index].resolve(
        pending[index].segments.map((segment) => segment.toUpperCase()),
      );
      await flushMicrotasks();
    }
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(port.translateSegments).toHaveBeenCalledTimes(10);
  });

  it("falls back to document order when the visible range is null", async () => {
    const paras = Array.from({ length: 9 }, () => paragraph(550));
    const doc = paras.join("\n");
    const priority: TranslationPriority = { visibleRange: () => null };
    const { port, started, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, { priority });
    expect(started).toEqual([paras.slice(0, 7), paras.slice(7)]);
    for (const entry of pending) {
      entry.resolve(entry.segments.map((segment) => segment.toUpperCase()));
    }
    await flushMicrotasks();
    await expect(running).resolves.toBe(doc.toUpperCase());
  });

  it("maps ranges in displayed offsets as completed translations change text length", async () => {
    // 24 paragraphs in three eight-unit batches; one worker keeps picks
    // strictly sequential.
    const doc = Array.from({ length: 24 }, (_, index) => paraText(index)).join(
      "\n",
    );
    const stride = paraText(0).length + 1;
    const long = "z".repeat(1000);
    // `displayed` mirrors what the user sees: the latest partial, or the
    // original document before the first one lands.
    let displayed = doc;
    let marker = paraText(0);
    const priority: TranslationPriority = {
      visibleRange: () => {
        const from = displayed.indexOf(marker);
        return { from, to: from + marker.length };
      },
    };
    const { port, started, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      concurrency: 1,
      priority,
      onPartial: (partial) => {
        displayed = partial.text;
      },
    });
    // Paragraph 0 is on screen: batch 0 goes first.
    expect(started).toEqual([batchTexts(0)]);

    // Batch 0's translation is ten times longer than the original, so every
    // later paragraph's displayed offset shifts far to the right.
    pending[0].resolve(pending[0].segments.map(() => long));
    marker = paraText(8);
    await flushMicrotasks();
    // Paragraph 8 now sits at 8 * (1000 + "\n" + separator) instead of
    // 8 * stride; a mapping in original offsets would clamp past the old
    // document end and land on the last batch instead of the visible one.
    expect(displayed.indexOf(paraText(8))).toBe(8 * (long.length + 2));
    expect(displayed.indexOf(paraText(8))).toBeGreaterThan(8 * stride);
    expect(started).toHaveLength(2);
    expect(started[1]).toEqual(batchTexts(1));

    pending[1].resolve(pending[1].segments.map((segment) => segment.toUpperCase()));
    await flushMicrotasks();
    expect(started[2]).toEqual(batchTexts(2));
    pending[2].resolve(pending[2].segments.map((segment) => segment.toUpperCase()));
    await flushMicrotasks();
    await expect(running).resolves.toBe(
      [
        ...Array.from({ length: 8 }, () => long + "\n"),
        ...Array.from({ length: 16 }, (_, index) =>
          paraText(8 + index).toUpperCase(),
        ),
      ].join("\n"),
    );
  });

  it("treats inverted, negative, and non-finite ranges as no preference", async () => {
    // Nine paragraphs in two batches: seven units, then two.
    const paras = Array.from({ length: 9 }, () => paragraph(550));
    const doc = paras.join("\n");
    const badRanges: TranslationTextRange[] = [
      { from: 4800, to: 10 }, // inverted
      { from: -5, to: 100 }, // negative
      { from: Number.NaN, to: 10 }, // non-finite
    ];
    for (const bad of badRanges) {
      const { port, started, pending } = deferredPort();
      const running = translateDocument(port, settings, doc, {
        priority: { visibleRange: () => bad },
      });
      expect(started).toEqual([paras.slice(0, 7), paras.slice(7)]);
      for (const entry of pending) {
        entry.resolve(entry.segments.map((segment) => segment.toUpperCase()));
      }
      await flushMicrotasks();
      await expect(running).resolves.toBe(doc.toUpperCase());
    }

    // Positive control: a valid range inside the second batch does reorder
    // the picks, so the invalid shapes above were not simply never read.
    {
      const stride = paragraph(550).length + 1;
      const { port, started, pending } = deferredPort();
      const running = translateDocument(port, settings, doc, {
        priority: {
          visibleRange: () => ({ from: 7 * stride, to: 7 * stride + 10 }),
        },
      });
      expect(started).toEqual([paras.slice(7), paras.slice(0, 7)]);
      for (const entry of pending) {
        entry.resolve(entry.segments.map((segment) => segment.toUpperCase()));
      }
      await flushMicrotasks();
      await expect(running).resolves.toBe(doc.toUpperCase());
    }
  });

  it("snaps ranges outside any unit to the nearest unit in displayed order", async () => {
    // Nine paragraphs (batches of seven and two units) followed by a tall
    // fenced code block.
    const paras = Array.from({ length: 9 }, () => paragraph(550));
    const fence = "```\n" + "c".repeat(3000) + "\n```\n";
    const doc = paras.join("\n") + "\n" + fence;
    // Neither range touches a unit: one sits inside the trailing code fence,
    // the other past the document end (clamped to the displayed length). Both
    // snap back to the last unit, so the second batch goes first.
    const ranges: TranslationTextRange[] = [
      { from: doc.length - fence.length + 10, to: doc.length - 5 },
      { from: doc.length + 1000, to: doc.length + 2000 },
    ];
    for (const range of ranges) {
      const { port, started, pending } = deferredPort();
      const running = translateDocument(port, settings, doc, {
        priority: { visibleRange: () => range },
      });
      expect(started).toEqual([paras.slice(7), paras.slice(0, 7)]);
      for (const entry of pending) {
        entry.resolve(entry.segments.map((segment) => segment.toUpperCase()));
      }
      await flushMicrotasks();
      // Only the paragraphs translate; the fenced block passes through.
      await expect(running).resolves.toBe(
        paras.map((para) => para.toUpperCase()).join("\n") + "\n" + fence,
      );
    }
  });

  it("skips units already written in the target language", async () => {
    const doc = "你好世界\n\nHello world\n\n中文不错\n";
    const partials: TranslationPartial[] = [];
    const port = echoPort();
    await expect(
      translateDocument(port, settings, doc, {
        onPartial: (partial) => partials.push(partial),
      }),
    ).resolves.toBe("你好世界\n\nHELLO WORLD\n\n中文不错\n");
    // Only the English chunk reaches the provider.
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [
      "Hello world\n",
    ]);
    // The skipped units complete immediately with their original text,
    // emit partials, and count toward progress.
    expect(partials).toHaveLength(3);
    expect(partials[0]).toMatchObject({ completedBatches: 1, totalBatches: 3 });
    expect(partials[0].text).toBe(doc);
    expect(partials[1]).toMatchObject({ completedBatches: 2, totalBatches: 3 });
    expect(partials[2]).toMatchObject({ completedBatches: 3, totalBatches: 3 });
    expect(partials[2].text).toBe("你好世界\n\nHELLO WORLD\n\n中文不错\n");
  });

  it("maps batch results back to their units when a skipped unit sits between them", async () => {
    // Regression for F05: the two English units share one batch even though
    // the Chinese unit between them was skipped, so results must land by
    // unit identity — never by `batch start + offset`, which would write the
    // last paragraph's translation into the Chinese paragraph's slot.
    const doc =
      "First English paragraph.\n\n" +
      "这是一段已经写好的中文内容。\n\n" +
      "Last English paragraph.\n";
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        async (_settings: TranslationSettings, texts: string[]) =>
          texts.map((text) =>
            text.includes("First") ? "第一段译文。" : "最后一段译文。",
          ),
      ),
    };
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      "第一段译文。\n\n" +
        "这是一段已经写好的中文内容。\n\n" +
        "最后一段译文。\n",
    );
    // Both English units still pack into a single batch around the skipped
    // Chinese unit.
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [
      "First English paragraph.\n",
      "Last English paragraph.\n",
    ]);
  });

  it("never calls the port when the whole document is in the target language", async () => {
    const doc = "你好世界\n\n天气很好\n";
    const partials: TranslationPartial[] = [];
    const port = echoPort();
    const result = await translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial),
    });
    expect(result).toBe(doc);
    expect(port.translateSegments).not.toHaveBeenCalled();
    expect(partials).toHaveLength(2);
    expect(partials[1]).toMatchObject({ completedBatches: 2, totalBatches: 2 });
  });

  it("does not skip anything for an unrecognized target language", async () => {
    const doc = "你好世界\n\nHello world\n";
    const port = echoPort();
    const klingon = { ...settings, targetLanguage: "Klingon" };
    await expect(translateDocument(port, klingon, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, klingon, [
      "你好世界\n",
      "Hello world\n",
    ]);
  });

  it("protects inline code and math spans through translation and restores them", async () => {
    const doc = "使用 `parse(input)` 计算 $x^2$ 的值。\n";
    const port = transformPort((segment) => "译文：" + segment);
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      "译文：使用 `parse(input)` 计算 $x^2$ 的值。\n",
    );
    // The provider only ever sees the placeholder-protected chunk.
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [
      "使用 ⟪1⟫ 计算 ⟪2⟫ 的值。\n",
    ]);
  });

  it("restores multi-backtick code spans and leaves one-line display math as text", async () => {
    const doc = "用 `` `x` `` 与 $$ E = mc^2 $$ 演示。\n";
    const port = transformPort((segment) => "译文：" + segment);
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      "译文：用 `` `x` `` 与 $$ E = mc^2 $$ 演示。\n",
    );
    // The code span is protected; the `$$` pair is display math and stays
    // literal text for the provider.
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [
      "用 ⟪1⟫ 与 $$ E = mc^2 $$ 演示。\n",
    ]);
  });

  it("restores out-of-order placeholders by index, not position", async () => {
    const doc = "`a` 与 $b$ 混合。\n";
    const port = transformPort((segment) =>
      segment.replace(
        /⟪(\d+)⟫/g,
        (token) => (token === "⟪1⟫" ? "⟪2⟫" : "⟪1⟫"),
      ),
    );
    // The provider swapped the tokens; each one restores its own original span
    // (by index) at the provider's chosen position instead of by slot.
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      "$b$ 与 `a` 混合。\n",
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
  });

  it("falls back to an un-protected translation when the model drops placeholders", async () => {
    const doc = "调用 `parse()` 继续。\n";
    let calls = 0;
    const port = transformPort((segment) => {
      calls += 1;
      // The provider drops the opaque token from the protected reply.
      return calls === 1 ? segment.replace(/⟪\d+⟫/g, "") : segment;
    });
    await expect(translateDocument(port, settings, doc)).resolves.toBe(doc);
    // One protected attempt, then one un-protected retry — no placeholder
    // leaks into the document.
    expect(port.translateSegments).toHaveBeenCalledTimes(2);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [
      "调用 ⟪1⟫ 继续。\n",
    ]);
    expect(port.translateSegments).toHaveBeenNthCalledWith(2, settings, [
      "调用 `parse()` 继续。\n",
    ]);
  });

  it("falls back to an un-protected translation when the model rewrites placeholders", async () => {
    const doc = "`code` 文本。\n";
    let calls = 0;
    const port = transformPort((segment) => {
      calls += 1;
      // A mangled fragment (digits plus garbage) is not a valid token.
      return calls === 1 ? segment.replace(/⟪(\d+)⟫/, "⟪$1x⟫") : segment;
    });
    await expect(translateDocument(port, settings, doc)).resolves.toBe(doc);
    expect(port.translateSegments).toHaveBeenCalledTimes(2);
  });

  it("falls back to the original chunk text when an empty reply follows a mangled one", async () => {
    const doc = "`code` 文本。\n";
    let calls = 0;
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        async (_settings: TranslationSettings, segments: string[]) => {
          calls += 1;
          if (calls === 1) return [segments[0].replace(/⟪\d+⟫/g, "")];
          return [];
        },
      ),
    };
    await expect(translateDocument(port, settings, doc)).resolves.toBe(doc);
    expect(port.translateSegments).toHaveBeenCalledTimes(2);
  });

  it("keeps protected spans intact across chunk boundaries", async () => {
    // 1900 characters of prose plus a code span that lands in the final
    // chunk after 600-character subdivision; the placeholder survives
    // chunking and restoration.
    const doc = "p".repeat(1900) + "`token`" + "q".repeat(300) + "\n";
    const port = transformPort((segment) => "译：" + segment);
    const result = await translateDocument(port, settings, doc);
    // The code span survives verbatim and no placeholder leaks into the
    // output; each of the four chunks in the single batch carries one
    // 2-character 译： prefix.
    expect(result).toContain("`token`");
    expect(result).not.toContain("⟪");
    expect(result).not.toContain("⟫");
    expect(result.length).toBe(doc.length + 8);
  });
});