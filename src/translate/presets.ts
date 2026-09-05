/**
 * Translation provider presets: verified OpenAI-compatible endpoints and
 * model ids offered in the settings dialog, so switching provider never
 * requires looking up a base URL. All user-facing strings are zh-CN.
 *
 * Endpoints/models verified against official docs:
 * - GLM: https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash
 * - Tencent Hy-MT2: https://cloud.tencent.com/document/product/1823/132252
 *   (TokenHub base URL) and .../130055 (pricing)
 * - DeepSeek: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */

export interface TranslationPreset {
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly model: string;
  readonly concurrency: number;
  /** Short cost/signup hint shown under the preset selector. */
  readonly note: string;
}

export const TRANSLATION_PRESETS: readonly TranslationPreset[] = [
  {
    id: "glm",
    label: "智谱 GLM-4.7-Flash（免费）",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.7-flash",
    // The free tier is rate-limited, so batch concurrency stays low.
    concurrency: 2,
    note: "永久免费，需实名认证；免费额度有限速，适合个人使用。",
  },
  {
    id: "hunyuan",
    label: "腾讯混元 Hy-MT2-Lite（翻译）",
    endpoint: "https://tokenhub.tencentmaas.com/v1",
    model: "hy-mt2-lite",
    concurrency: 5,
    note: "输入 ¥0.3/百万 tokens，极低价；新人开通送 100 万 token 体验额度。",
  },
  {
    id: "deepseek",
    label: "DeepSeek V4-Flash（低价）",
    endpoint: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    concurrency: 10,
    note: "低价 + 上下文缓存：输入 ¥1.5/百万 tokens，缓存命中低至 ¥0.05。",
  },
];

/**
 * The preset matching the given settings, or undefined when the endpoint and
 * model identify no preset (the user is on a custom provider). The endpoint
 * is compared without its trailing slash — providers accept both spellings —
 * but everything else is exact, so a preset only matches the values it
 * actually assigns.
 */
export function matchPreset(settings: {
  readonly endpoint: string;
  readonly model: string;
}): TranslationPreset | undefined {
  const normalizedEndpoint = settings.endpoint.replace(/\/+$/, "");
  return TRANSLATION_PRESETS.find(
    (preset) =>
      preset.endpoint === normalizedEndpoint && preset.model === settings.model,
  );
}