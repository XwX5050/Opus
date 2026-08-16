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

  it("sends every translatable segment in its own call regardless of size", async () => {
    const paras = Array.from({ length: 5 }, () => paragraph(700));
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
    // "x"*5000 hard-splits into 1500/1500/1500/500 chunks, the last one
    // keeping the trailing newline; the short paragraph stays one request.
    expect(port.translateSegments).toHaveBeenCalledTimes(5);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [
      "x".repeat(1500),
    ]);
    expect(port.translateSegments).toHaveBeenNthCalledWith(2, settings, [
      "x".repeat(1500),
    ]);
    expect(port.translateSegments).toHaveBeenNthCalledWith(3, settings, [
      "x".repeat(1500),
    ]);
    expect(port.translateSegments).toHaveBeenNthCalledWith(4, settings, [
      "x".repeat(500) + "\n",
    ]);
    expect(port.translateSegments).toHaveBeenNthCalledWith(5, settings, [
      small,
    ]);
  });

  it("subdivides an over-long multi-line paragraph at line boundaries", async () => {
    const line = "l".repeat(300) + "\n"; // 301 chars
    const big = line.repeat(6); // 1806 chars -> chunks of 4 and 2 lines
    const doc = big + "\n" + paragraph(100);
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(3);
    expect(port.translateSegments).toHaveBeenNthCalledWith(1, settings, [
      line.repeat(4),
    ]);
    expect(port.translateSegments).toHaveBeenNthCalledWith(2, settings, [
      line.repeat(2),
    ]);
    expect(port.translateSegments).toHaveBeenNthCalledWith(3, settings, [
      paragraph(100),
    ]);
  });

  it("keeps at most ten translateSegments calls in flight by default", async () => {
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

    // Drain the pool; a new call only starts as a slot frees up.
    while (pending.length > 0) {
      const entry = pending.shift()!;
      entry.resolve(entry.segments.map((segment) => segment.toUpperCase()));
      await Promise.resolve();
    }
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(peak).toBe(10);
    expect(port.translateSegments).toHaveBeenCalledTimes(12);
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
      const entry = pending.shift()!;
      entry.resolve(entry.segments.map((segment) => segment.toUpperCase()));
      await Promise.resolve();
    }
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(peak).toBe(2);
    expect(port.translateSegments).toHaveBeenCalledTimes(6);
  });

  it("reassembles results in document order when segments finish out of order", async () => {
    const paras = Array.from({ length: 4 }, () => paragraph(700));
    const doc = paras.join("\n");
    const partials: string[] = [];
    const { port, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial.text),
    });
    expect(pending).toHaveLength(4);

    // The later segments land first: they translate while the earlier
    // segments still show the original text.
    pending[2].resolve([pending[2].segments[0].toUpperCase()]);
    await flushMicrotasks();
    pending[3].resolve([pending[3].segments[0].toUpperCase()]);
    await flushMicrotasks();
    expect(partials).toHaveLength(2);
    expect(partials[1]).toBe(
      paras[0] +
        "\n" +
        paras[1] +
        "\n" +
        paras[2].toUpperCase() +
        "\n" +
        paras[3].toUpperCase(),
    );

    pending[0].resolve([pending[0].segments[0].toUpperCase()]);
    await flushMicrotasks();
    pending[1].resolve([pending[1].segments[0].toUpperCase()]);
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(partials).toHaveLength(4);
    expect(partials[3]).toBe(doc.toUpperCase());
  });

  it("reports every completed segment through onPartial with progress counts", async () => {
    const paras = Array.from({ length: 6 }, () => paragraph(700));
    const doc = paras.join("\n");
    const partials: TranslationPartial[] = [];
    const port = echoPort();
    await translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial),
    });
    expect(partials).toHaveLength(6);
    expect(partials.map((partial) => partial.completedBatches)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(partials[0].totalBatches).toBe(6);
    expect(partials[0].text).toBe(
      [paras[0].toUpperCase()].concat(paras.slice(1)).join("\n"),
    );
    expect(partials[5].text).toBe(doc.toUpperCase());
  });

  it("reports a multi-chunk segment once, after all its chunks land", async () => {
    const big = paragraph(2500); // 2501 chars -> 1500 + 1001 char chunks
    const small = paragraph(100);
    const doc = big + "\n" + small;
    const partials: TranslationPartial[] = [];
    const { port, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      onPartial: (partial) => partials.push(partial),
    });
    // The big paragraph subdivides into two chunk requests plus the small one.
    expect(pending).toHaveLength(3);

    // Only the first chunk of the big paragraph lands: the segment is still
    // incomplete, so no partial is emitted yet.
    pending[0].resolve([pending[0].segments[0].toUpperCase()]);
    await Promise.resolve();
    expect(partials).toHaveLength(0);

    pending[1].resolve([pending[1].segments[0].toUpperCase()]);
    pending[2].resolve([pending[2].segments[0].toUpperCase()]);
    await Promise.resolve();
    await expect(running).resolves.toBe(doc.toUpperCase());
    expect(partials).toHaveLength(2);
    expect(partials[0]).toMatchObject({
      completedBatches: 1,
      totalBatches: 2,
    });
    // The big paragraph is fully translated; the small one is still original.
    expect(partials[0].text).toBe(big.toUpperCase() + "\n" + small);
    expect(partials[1]).toMatchObject({ completedBatches: 2, totalBatches: 2 });
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

  it("rejects with an AbortError and starts no new segments once aborted", async () => {
    const paras = Array.from({ length: 5 }, () => paragraph(700));
    const doc = paras.join("\n");
    const controller = new AbortController();
    const { port, started, pending } = deferredPort();
    const running = translateDocument(port, settings, doc, {
      signal: controller.signal,
    });
    // The pool fills immediately (all five segments here); the abort only
    // stops segments that have not started yet.
    expect(started).toHaveLength(5);

    controller.abort();
    for (const entry of pending) entry.resolve([]);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toHaveLength(5);
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
});