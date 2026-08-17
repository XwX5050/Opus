import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("translates a short document in one call per segment, passing settings through", async () => {
    const doc = "hello\n\nworld\n";
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      "HELLO\n\nWORLD\n",
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(2);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [
      "hello\n",
    ]);
    expect(port.translateSegments).toHaveBeenNthCalledWith(2, settings, [
      "world\n",
    ]);
  });

  it("sends every translatable segment as a single call when it fits the chunk limit", async () => {
    const paras = Array.from({ length: 5 }, () => paragraph(550));
    const doc = paras.join("\n");
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(5);
    for (let index = 0; index < paras.length; index++) {
      expect(port.translateSegments).toHaveBeenNthCalledWith(
        index + 1,
        settings,
        [paras[index]],
      );
    }
  });

  it("subdivides an over-long segment into chunk requests under the limit", async () => {
    const big = paragraph(5000); // 5001 chars: one over-limit line
    const small = paragraph(100);
    const doc = big + "\n" + small;
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    // "x"*5000 hard-splits into 600*8 + 200 chunks, the last one keeping the
    // trailing newline; the short paragraph stays one request.
    expect(port.translateSegments).toHaveBeenCalledTimes(10);
    for (let index = 0; index < 8; index++) {
      expect(port.translateSegments).toHaveBeenNthCalledWith(
        index + 1,
        settings,
        ["x".repeat(600)],
      );
    }
    expect(port.translateSegments).toHaveBeenNthCalledWith(9, settings, [
      "x".repeat(200) + "\n",
    ]);
    expect(port.translateSegments).toHaveBeenNthCalledWith(10, settings, [
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
    expect(port.translateSegments).toHaveBeenCalledTimes(7);
    for (let index = 0; index < 6; index++) {
      expect(port.translateSegments).toHaveBeenNthCalledWith(
        index + 1,
        settings,
        [line],
      );
    }
    expect(port.translateSegments).toHaveBeenNthCalledWith(7, settings, [
      paragraph(100),
    ]);
  });

  it("keeps at most ten translateSegments calls in flight by default", async () => {
    // Each 701-char paragraph subdivides into two chunk requests.
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
    // The pool fills its ten slots synchronously.
    expect(pending).toHaveLength(10);

    // Drain the pool in batches; a new call only starts as a slot frees up.
    // Flushing several microtask turns keeps the freed workers' next calls
    // ahead of the loop's pending check.
    while (pending.length > 0) {
      const batch = pending.splice(0);
      for (const entry of batch) {
        entry.resolve(entry.segments.map((segment) => segment.toUpperCase()));
      }
      await flushMicrotasks();
    }
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(peak).toBe(10);
    expect(port.translateSegments).toHaveBeenCalledTimes(24);
  });

  it("honors an explicit concurrency cap below the default", async () => {
    const paras = Array.from({ length: 6 }, () => paragraph(700));
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
    expect(port.translateSegments).toHaveBeenCalledTimes(12);
  });

  it("reassembles results in document order when chunks finish out of order", async () => {
    // Each 701-char paragraph subdivides into two chunk requests (600 + 101).
    const paras = Array.from({ length: 4 }, () => paragraph(700));
    const doc = paras.join("\n");
    const partials: string[] = [];
    const { port, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial.text),
    });
    expect(pending).toHaveLength(8);

    // The later paragraphs land first: their chunks translate while the
    // earlier segments still show the original text.
    for (const index of [4, 5, 6, 7]) {
      pending[index].resolve([pending[index].segments[0].toUpperCase()]);
      await flushMicrotasks();
    }
    expect(partials).toHaveLength(4);
    expect(partials[3]).toBe(
      paras[0] +
        "\n" +
        paras[1] +
        "\n" +
        paras[2].toUpperCase() +
        "\n" +
        paras[3].toUpperCase(),
    );

    // The remaining chunks land in order; the partials converge to the full
    // translation.
    for (const index of [0, 1, 2, 3]) {
      pending[index].resolve([pending[index].segments[0].toUpperCase()]);
      await flushMicrotasks();
    }
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(partials).toHaveLength(8);
    expect(partials[7]).toBe(doc.toUpperCase());
  });

  it("reports every completed chunk through onPartial with progress counts", async () => {
    // Each 701-char paragraph subdivides into 600 + 101 chunks.
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

  it("surfaces each chunk as soon as it lands, leaving unfinished chunks as the original text", async () => {
    const big = paragraph(2500); // 2501 chars -> 600*4 + 101 char chunks
    const small = paragraph(100);
    const doc = big + "\n" + small;
    const partials: TranslationPartial[] = [];
    const { port, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial),
    });
    // The big paragraph subdivides into five chunk requests plus the small one.
    expect(pending).toHaveLength(6);

    // The first chunk of the big paragraph lands: the partial already shows
    // it translated while the rest of the paragraph stays original.
    pending[0].resolve([pending[0].segments[0].toUpperCase()]);
    await flushMicrotasks();
    expect(partials).toHaveLength(1);
    expect(partials[0]).toMatchObject({
      completedBatches: 1,
      totalBatches: 6,
    });
    expect(partials[0].text).toBe(
      "x".repeat(600).toUpperCase() + "x".repeat(1900) + "\n\n" + small,
    );

    // The remaining chunks land one at a time; each emits its own partial.
    for (const index of [1, 2, 3, 4, 5]) {
      pending[index].resolve([pending[index].segments[0].toUpperCase()]);
      await flushMicrotasks();
    }
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(partials).toHaveLength(6);
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

  it("rejects with an AbortError and starts no new chunks once aborted", async () => {
    const paras = Array.from({ length: 5 }, () => paragraph(700));
    const doc = paras.join("\n");
    const controller = new AbortController();
    const { port, started, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      signal: controller.signal,
    });
    // Each paragraph subdivides into two chunks (600 + 101); the pool of ten
    // fills immediately, so the abort only stops chunks that have not
    // started yet (there are none beyond the ten).
    expect(started).toHaveLength(10);

    controller.abort();
    for (const entry of pending) entry.resolve([]);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toHaveLength(10);
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
    // output; each of the four chunks carries one 2-character 译： prefix.
    expect(result).toContain("`token`");
    expect(result).not.toContain("⟪");
    expect(result).not.toContain("⟫");
    expect(result.length).toBe(doc.length + 8);
  });
});