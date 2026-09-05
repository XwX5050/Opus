import { describe, expect, it } from "vitest";
import { isLikelyTargetLanguage } from "./languageGuess";

describe("isLikelyTargetLanguage", () => {
  describe("Chinese targets", () => {
    const targets = ["中文", "汉语", "Chinese", "CHINESE", "中文（简体）"];

    it.each(targets)("skips CJK-heavy text for %s", (target) => {
      expect(isLikelyTargetLanguage("你好世界，今天天气不错。", target)).toBe(
        true,
      );
    });

    it("skips at the exact 70% boundary and not below", () => {
      // 7 CJK letters of 10.
      expect(isLikelyTargetLanguage("你好你好你好你abc", "中文")).toBe(true);
      // 6 CJK letters of 10.
      expect(isLikelyTargetLanguage("你好你好你好abcd", "中文")).toBe(false);
    });

    it("never skips Latin text", () => {
      expect(isLikelyTargetLanguage("Hello world, this is English.", "中文")).toBe(
        false,
      );
    });

    it("does not count placeholder tokens as letters", () => {
      expect(isLikelyTargetLanguage("使用 ⟪1⟫ 与 ⟪2⟫ 处理数据。", "中文")).toBe(
        true,
      );
    });

    it("does not skip a mixed paragraph under the CJK bar", () => {
      expect(
        isLikelyTargetLanguage("这是一段中文 with English words 混合", "中文"),
      ).toBe(false);
    });

    it("does not skip a chunk whose only CJK-adjacent content is a code span", () => {
      expect(isLikelyTargetLanguage("使用 `parse()` 处理", "中文")).toBe(false);
    });
  });

  describe("Japanese targets", () => {
    const targets = ["日本語", "japanese", "Japanese", "日文"];

    it.each(targets)("skips kana-plus-kanji text for %s", (target) => {
      expect(isLikelyTargetLanguage("日本語の文章です。", target)).toBe(true);
    });

    it("skips pure kana text", () => {
      expect(isLikelyTargetLanguage("これはテストです", "日本語")).toBe(true);
    });

    it("never skips kanji-only text without kana", () => {
      expect(isLikelyTargetLanguage("日本語文章", "日本語")).toBe(false);
    });

    it("never skips Latin text", () => {
      expect(isLikelyTargetLanguage("Hello world", "日本語")).toBe(false);
    });

    it("skips at the exact 70% boundary and not below", () => {
      // 7 CJK-or-kana letters of 10, kana present.
      expect(isLikelyTargetLanguage("こんにちは世界abc", "日本語")).toBe(true);
      // 7 of 11.
      expect(isLikelyTargetLanguage("こんにちは世界abcd", "日本語")).toBe(false);
    });

    it("does not treat Chinese text as Japanese", () => {
      expect(isLikelyTargetLanguage("你好世界", "日本語")).toBe(false);
    });
  });

  describe("Korean targets", () => {
    const targets = ["한국어", "조선어", "korean", "Korean", "韩语"];

    it.each(targets)("skips hangul-heavy text for %s", (target) => {
      expect(isLikelyTargetLanguage("안녕하세요, 한국어 문서입니다.", target)).toBe(
        true,
      );
    });

    it("skips at the exact 70% boundary and not below", () => {
      // 7 hangul letters of 10.
      expect(isLikelyTargetLanguage("안녕하세요가나abc", "한국어")).toBe(true);
      // 6 hangul letters of 10.
      expect(isLikelyTargetLanguage("안녕하세요가abcd", "한국어")).toBe(false);
    });

    it("never skips Latin text", () => {
      expect(isLikelyTargetLanguage("Hello world", "korean")).toBe(false);
    });
  });

  describe("English and Latin-script European targets", () => {
    const targets = [
      "english",
      "English",
      "英语",
      "英文",
      "français",
      "Français",
      "deutsch",
      "español",
      "português",
      "italiano",
      "nederlands",
      "polski",
      "svenska",
      "czech",
      "türkçe",
      "tiếng việt",
    ];
    const latinText = "This is a test document written in plain prose.";

    it.each(targets)("skips Latin text for %s", (target) => {
      expect(isLikelyTargetLanguage(latinText, target)).toBe(true);
    });

    it("skips accented Latin text", () => {
      expect(isLikelyTargetLanguage("Café déjà vu, s'il vous plaît.", "english")).toBe(
        true,
      );
    });

    it("skips at the exact 95% boundary and not below", () => {
      // 19 Latin letters of 20.
      expect(isLikelyTargetLanguage("aaaaaaaaaaaaaaaaaaa中", "english")).toBe(
        true,
      );
      // 18 of 20.
      expect(isLikelyTargetLanguage("aaaaaaaaaaaaaaaaaa中中", "english")).toBe(
        false,
      );
    });

    it("does not skip mixed CJK paragraphs under the Latin bar", () => {
      expect(isLikelyTargetLanguage("Hello 你好 World 世界", "english")).toBe(
        false,
      );
    });

    it("does not skip Cyrillic text", () => {
      expect(isLikelyTargetLanguage("Привет мир, это тест.", "english")).toBe(
        false,
      );
    });
  });

  describe("conservative fallbacks", () => {
    it("returns false for unrecognized target languages", () => {
      expect(isLikelyTargetLanguage("This is English text.", "Klingon")).toBe(
        false,
      );
      expect(isLikelyTargetLanguage("你好世界", "Klingon")).toBe(false);
      expect(isLikelyTargetLanguage("Hello", "auto")).toBe(false);
      expect(isLikelyTargetLanguage("Hello", "")).toBe(false);
    });

    it("returns false for empty or letter-free text", () => {
      expect(isLikelyTargetLanguage("", "中文")).toBe(false);
      expect(isLikelyTargetLanguage("⟪1⟫", "中文")).toBe(false);
      expect(isLikelyTargetLanguage("12345 !!!", "english")).toBe(false);
      expect(isLikelyTargetLanguage("\n\n", "中文")).toBe(false);
    });

    it("does not confuse scripts across targets", () => {
      // Pure kana text under a Chinese target: no CJK ideographs.
      expect(isLikelyTargetLanguage("こんにちは", "中文")).toBe(false);
      // CJK text under an English target.
      expect(isLikelyTargetLanguage("你好世界", "english")).toBe(false);
      // Hangul under a Japanese target: no kana, no CJK ideographs.
      expect(isLikelyTargetLanguage("안녕하세요", "日本語")).toBe(false);
      // Japanese kana under a Korean target.
      expect(isLikelyTargetLanguage("こんにちは", "한국어")).toBe(false);
    });

    it("handles placeholders and digits mixed into long paragraphs", () => {
      // Long Chinese paragraph with a few digits and placeholders: still CJK.
      expect(
        isLikelyTargetLanguage(
          "第 1 章：使用 ⟪1⟫ 计算，结果 42 次验证无误。".repeat(2),
          "中文",
        ),
      ).toBe(true);
      // A mostly Latin paragraph with one code span for an English target.
      expect(
        isLikelyTargetLanguage("The function `parse()` returns the value.", "english"),
      ).toBe(true);
    });
  });
});