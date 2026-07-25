import { describe, expect, it } from "vitest";
import {
  effectiveMode,
  FULL_MODE_MAX_BYTES,
  FULL_MODE_MAX_LINES,
  measureText,
  modeFor,
  modeForText,
} from "./performanceMode";

describe("modeFor thresholds", () => {
  it("keeps regular documents in full mode", () => {
    expect(modeFor({ bytes: 1_048_576, lines: 20_000 })).toBe("full");
  });

  it("degrades documents just over 2 MiB to light mode", () => {
    expect(modeFor({ bytes: 2_097_153, lines: 10 })).toBe("light");
  });

  it("degrades documents just over 50,000 lines to light mode", () => {
    expect(modeFor({ bytes: 10, lines: 50_001 })).toBe("light");
  });

  it("keeps documents exactly at both thresholds in full mode", () => {
    expect(
      modeFor({ bytes: FULL_MODE_MAX_BYTES, lines: FULL_MODE_MAX_LINES }),
    ).toBe("full");
  });

  it("degrades when only the byte threshold is exceeded", () => {
    expect(modeFor({ bytes: FULL_MODE_MAX_BYTES + 1, lines: 1 })).toBe("light");
  });

  it("degrades when only the line threshold is exceeded", () => {
    expect(modeFor({ bytes: 1, lines: FULL_MODE_MAX_LINES + 1 })).toBe("light");
  });
});

describe("effectiveMode", () => {
  const large = { bytes: 2_097_153, lines: 10 };

  it("lets the user temporarily force full mode for a large document", () => {
    expect(effectiveMode(large, true)).toBe("full");
  });

  it("returns to automatic light mode when no override is active (reopen)", () => {
    expect(effectiveMode(large, false)).toBe("light");
  });

  it("never degrades small documents even without an override", () => {
    expect(effectiveMode({ bytes: 100, lines: 3 }, false)).toBe("full");
  });
});

describe("measureText", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // 6 CJK characters = 6 code units but 18 UTF-8 bytes.
    expect(measureText("你好世界你好").bytes).toBe(18);
  });

  it("counts lines like the editor (newline separators plus one)", () => {
    expect(measureText("a\nb\nc").lines).toBe(3);
    expect(measureText("").lines).toBe(1);
  });

  it("classifies a real large string through the thresholds", () => {
    const text = `${"x".repeat(99)}\n`.repeat(50_000) + "x";
    const size = measureText(text);
    expect(size.lines).toBe(50_001);
    expect(modeFor(size)).toBe("light");
  });
});

describe("modeForText", () => {
  it("takes the cheap path once UTF-16 length alone exceeds the byte threshold", () => {
    expect(modeForText("x".repeat(FULL_MODE_MAX_BYTES + 1))).toBe("light");
  });

  it("still measures CJK text by UTF-8 bytes below the length threshold", () => {
    // 800k CJK characters = 800k UTF-16 units but 2.4M UTF-8 bytes.
    expect(modeForText("好".repeat(800_000))).toBe("light");
  });

  it("degrades documents past the line threshold", () => {
    expect(modeForText("x\n".repeat(50_000))).toBe("light");
  });

  it("keeps ordinary text in full mode", () => {
    expect(modeForText("# hello\n\nworld\n")).toBe("full");
  });
});
