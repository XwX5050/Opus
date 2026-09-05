import { describe, expect, it } from "vitest";
import { matchPreset, TRANSLATION_PRESETS } from "./presets";

describe("translation presets", () => {
  it("defines the three provider presets in order", () => {
    expect(TRANSLATION_PRESETS.map((preset) => preset.id)).toEqual([
      "glm",
      "hunyuan",
      "deepseek",
    ]);
  });

  it("carries verified endpoints, models and concurrency for each provider", () => {
    const [glm, hunyuan, deepseek] = TRANSLATION_PRESETS;
    expect(glm).toMatchObject({
      id: "glm",
      label: "智谱 GLM-4.7-Flash（免费）",
      endpoint: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.7-flash",
      concurrency: 2,
    });
    expect(glm.note).toContain("免费");
    expect(hunyuan).toMatchObject({
      id: "hunyuan",
      label: "腾讯混元 Hy-MT2-Lite（翻译）",
      endpoint: "https://tokenhub.tencentmaas.com/v1",
      model: "hy-mt2-lite",
      concurrency: 5,
    });
    expect(hunyuan.note).toContain("100 万 token");
    expect(deepseek).toMatchObject({
      id: "deepseek",
      label: "DeepSeek V4-Flash（低价）",
      endpoint: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      concurrency: 10,
    });
    expect(deepseek.note).toContain("上下文缓存");
  });

  it("matches a preset when endpoint and model agree", () => {
    expect(
      matchPreset({
        endpoint: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-4.7-flash",
      }),
    ).toEqual(TRANSLATION_PRESETS[0]);
    expect(
      matchPreset({
        endpoint: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
      }),
    ).toEqual(TRANSLATION_PRESETS[2]);
  });

  it("matches an endpoint carrying a trailing slash", () => {
    expect(
      matchPreset({
        endpoint: "https://tokenhub.tencentmaas.com/v1/",
        model: "hy-mt2-lite",
      }),
    ).toEqual(TRANSLATION_PRESETS[1]);
  });

  it("does not match a preset for a custom provider", () => {
    expect(
      matchPreset({
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      }),
    ).toBeUndefined();
  });

  it("does not match when endpoint or model differ in case", () => {
    expect(
      matchPreset({
        endpoint: "https://open.bigmodel.cn/API/paas/v4",
        model: "glm-4.7-flash",
      }),
    ).toBeUndefined();
    expect(
      matchPreset({
        endpoint: "https://open.bigmodel.cn/api/paas/v4",
        model: "GLM-4.7-Flash",
      }),
    ).toBeUndefined();
  });
});