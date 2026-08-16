import { describe, expect, it, vi } from "vitest";
import { translateDocument } from "./translate";
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

/** A paragraph of `length` chars (plus its trailing newline). */
const paragraph = (length: number): string => "x".repeat(length) + "\n";

const echoPort = (): FakeTranslatePort => ({
  translateSegments: vi.fn(
    async (_settings: TranslationSettings, segments: string[]) =>
      segments.map((segment) => segment.toUpperCase()),
  ),
});

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

  it("batches translatable blocks within the 3000-character budget", async () => {
    const paras = Array.from({ length: 5 }, () => paragraph(700));
    const doc = paras.join("\n");
    const port = echoPort();
    await expect(translateDocument(port, settings, doc)).resolves.toBe(
      doc.toUpperCase(),
    );
    expect(port.translateSegments).toHaveBeenCalledTimes(2);
    expect(port.translateSegments).toHaveBeenNthCalledWith(
      1,
      settings,
      paras.slice(0, 4),
    );
    expect(port.translateSegments).toHaveBeenNthCalledWith(2, settings, [
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
      translateDocument(port, settings, "hello\n\nworld\n", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(port.translateSegments).not.toHaveBeenCalled();
  });

  it("stops between batches when aborted mid-flight", async () => {
    const paras = Array.from({ length: 5 }, () => paragraph(700));
    const doc = paras.join("\n");
    const controller = new AbortController();
    const port: FakeTranslatePort = {
      translateSegments: vi.fn(
        async (_settings: TranslationSettings, segments: string[]) => {
          controller.abort();
          return segments.map((segment) => segment.toUpperCase());
        },
      ),
    };
    await expect(
      translateDocument(port, settings, doc, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(port.translateSegments).toHaveBeenCalledTimes(1);
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
