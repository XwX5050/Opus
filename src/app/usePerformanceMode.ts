import { useEffect, useState } from "react";
import {
  cheapModeForLength,
  modeForText,
  type PerformanceMode,
} from "../editor/performanceMode";

/**
 * How long in-band re-evaluation is deferred while the user types. The
 * mode only toggles widget rendering — never content or correctness — and
 * full rendering is the safe direction, so a sub-second delay at a
 * threshold crossing is imperceptible.
 */
export const MODE_REEVALUATION_DEBOUNCE_MS = 200;

interface BandScan {
  readonly tabId: string;
  readonly text: string;
  readonly mode: PerformanceMode;
}

/**
 * Automatic light/full mode for a tab, with a bounded keystroke hot path:
 *
 * - Out-of-band documents (see cheapModeForLength) classify in O(1) on
 *   every render — no state involved.
 * - In-band documents (50,000–2 MiB UTF-16 units, where only the O(n)
 *   encode/line scan decides) are scanned synchronously once per tab
 *   switch: the open path already paid an O(n) read, and a light document
 *   must not mount full widgets even for one frame.
 * - In-band edits on the same tab defer the re-scan until typing pauses
 *   (debounce), so a keystroke never pays O(n).
 */
export function useAutomaticPerformanceMode(
  tabId: string | null,
  text: string | null,
): PerformanceMode {
  const [scan, setScan] = useState<BandScan | null>(null);
  const cheap = text === null ? ("full" as const) : cheapModeForLength(text.length);

  // Derived state during render (React's sanctioned pattern): the update
  // re-renders immediately, before anything commits, so the returned mode
  // below is already the scanned one on this same pass.
  let synchronousMode: PerformanceMode | null = null;
  if (cheap === null && tabId !== null && text !== null && scan?.tabId !== tabId) {
    synchronousMode = modeForText(text);
    setScan({ tabId, text, mode: synchronousMode });
  }

  // The single cache slot pins the scanned tab's entire text, so drop it as
  // soon as that tab is no longer active — the last tab closed (tabId null)
  // or the active tab switched to an out-of-band document. Otherwise a closed
  // document's full text would stay referenced for the rest of the session.
  // An in-band tab switch needs no explicit reset: the synchronous scan above
  // already replaced the slot.
  if (scan !== null && (tabId === null || cheap !== null)) {
    setScan(null);
  }

  // In-band edits re-evaluate once typing pauses; each keystroke resets
  // the timer, so the scan runs at most once per debounce window.
  useEffect(() => {
    if (cheap !== null || tabId === null || text === null) return;
    if (scan?.tabId === tabId && scan.text === text) return;
    const timer = setTimeout(() => {
      setScan({ tabId, text, mode: modeForText(text) });
    }, MODE_REEVALUATION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [cheap, tabId, text, scan]);

  if (cheap !== null) return cheap;
  if (synchronousMode !== null) return synchronousMode;
  return scan?.tabId === tabId ? scan.mode : "full";
}
