import { afterEach, describe, expect, it, vi } from "vitest";
import type { DemoFetch } from "./demoPort";
import { createDemoPort } from "./demoPort";

const responseHeaders = (contentType: string | null) => ({
  get: (name: string) =>
    name.toLowerCase() === "content-type" ? contentType : null,
});

const textResponse = (
  text: string,
  contentType = "text/markdown; charset=utf-8",
): Awaited<ReturnType<DemoFetch>> => ({
  ok: true,
  headers: responseHeaders(contentType),
  text: async () => text,
});

describe("createDemoPort", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads a fixture by basename only, never by a nested path", async () => {
    const requests: string[] = [];
    const fetchFixture: DemoFetch = async (url) => {
      requests.push(url);
      return textResponse("# Fixture\n");
    };

    const port = await createDemoPort(
      new URLSearchParams("fixture=../nested/regular-1mb.md&theme=light"),
      fetchFixture,
    );

    expect(requests).toEqual(["/tests/perf/generated/regular-1mb.md"]);
    const session = await port.loadSession();
    expect(session).toMatchObject({
      openPaths: ["/demo/regular-1mb.md"],
      activePath: "/demo/regular-1mb.md",
      workspacePath: null,
      theme: "light",
      recent: [{ path: "/demo/regular-1mb.md", kind: "file" }],
    });
    const file = await port.openPath("/demo/regular-1mb.md");
    expect(file.text).toBe("# Fixture\n");
  });

  it("treats backslashes as path separators for fixture basenames", async () => {
    const requests: string[] = [];
    const fetchFixture: DemoFetch = async (url) => {
      requests.push(url);
      return textResponse("# Fixture\n");
    };

    const port = await createDemoPort(
      new URLSearchParams({ fixture: "..\\nested\\regular-1mb.md" }),
      fetchFixture,
    );

    expect(requests).toEqual(["/tests/perf/generated/regular-1mb.md"]);
    const file = await port.openPath("/demo/regular-1mb.md");
    expect(file.text).toBe("# Fixture\n");
  });

  it("encodes the fixture basename in the request URL", async () => {
    const requests: string[] = [];
    const fetchFixture: DemoFetch = async (url) => {
      requests.push(url);
      return textResponse("# Encoded\n");
    };

    const port = await createDemoPort(
      new URLSearchParams({ fixture: "nested/文件 名.md" }),
      fetchFixture,
    );

    expect(requests).toEqual([
      `/tests/perf/generated/${encodeURIComponent("文件 名.md")}`,
    ]);
    const file = await port.openPath("/demo/文件 名.md");
    expect(file.text).toBe("# Encoded\n");
  });

  it("rejects a 200 HTML SPA fallback instead of treating it as a document", async () => {
    const fetchFixture: DemoFetch = async () =>
      textResponse(
        "<!doctype html><title>Opus</title>",
        "text/html; charset=utf-8",
      );

    await expect(
      createDemoPort(new URLSearchParams("fixture=missing.md"), fetchFixture),
    ).rejects.toThrow(
      "性能测试文件请求返回了 HTML 页面：missing.md（fixture 请求被 SPA fallback 接管，请检查 preview fixture 中间件）",
    );
  });

  it.each(["..", ".", "nested/"])(
    "rejects invalid fixture basename %s before fetching",
    async (fixture) => {
      const fetchFixture = vi.fn<DemoFetch>(async () => textResponse("unused"));

      await expect(
        createDemoPort(new URLSearchParams({ fixture }), fetchFixture),
      ).rejects.toThrow(
        `性能测试文件无效：${fixture}（只接受 tests/perf/generated 下以 .md 结尾的文件名，且不能为空、"." 或 ".."）`,
      );
      expect(fetchFixture).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-Markdown fixture before fetching", async () => {
    const fetchFixture = vi.fn<DemoFetch>(async () => textResponse("unused"));

    await expect(
      createDemoPort(
        new URLSearchParams({ fixture: "notes/readme.txt" }),
        fetchFixture,
      ),
    ).rejects.toThrow(
      '性能测试文件无效：notes/readme.txt（只接受 tests/perf/generated 下以 .md 结尾的文件名，且不能为空、"." 或 ".."）',
    );
    expect(fetchFixture).not.toHaveBeenCalled();
  });

  it("rejects a missing fixture with the fixture-generation hint", async () => {
    const fetchFixture: DemoFetch = async () => ({
      ok: false,
      headers: responseHeaders("text/html; charset=utf-8"),
      text: async () => "",
    });

    await expect(
      createDemoPort(new URLSearchParams("fixture=missing.md"), fetchFixture),
    ).rejects.toThrow(
      "性能测试文件不存在：missing.md（先运行 npm run perf:fixtures）",
    );
  });

  it("seeds the demo workspace and its notes when workspace=1 is set", async () => {
    const fetchFixture = vi.fn<DemoFetch>(async () => textResponse("unused"));
    const port = await createDemoPort(
      new URLSearchParams("workspace=1&theme=system"),
      fetchFixture,
    );

    expect(fetchFixture).not.toHaveBeenCalled();
    const session = await port.loadSession();
    expect(session).toMatchObject({
      openPaths: ["/demo/欢迎.md"],
      activePath: "/demo/欢迎.md",
      workspacePath: "/demo",
      theme: "system",
    });

    const note = await port.openPath("/demo/notes/a.md");
    expect(note.text).toBe("# /demo/notes/a.md\n");
  });
});
