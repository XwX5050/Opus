import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  EDITOR_PREFERENCE_LIMITS,
  FONT_PRESETS,
  type EditorPreferences,
  type ThemePreference,
} from "../theme/preferences";

export interface SettingsDialogProps {
  readonly theme: ThemePreference;
  readonly editorPreferences: EditorPreferences;
  readonly onThemeChange: (value: ThemePreference) => void;
  readonly onEditorPreferencesChange: (value: EditorPreferences) => void;
  readonly onClose: () => void;
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const FONT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "system", label: "系统默认" },
  { value: "serif", label: "衬线" },
  { value: "monospace", label: "等宽" },
  { value: "custom", label: "自定义…" },
];

const isPresetFont = (fontFamily: string): boolean =>
  (FONT_PRESETS as ReadonlyArray<string>).includes(fontFamily);

interface NumberFieldProps {
  readonly id: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onCommit: (value: number) => void;
}

/**
 * Number input with a local string draft. Committing on every keystroke
 * would re-render the field with the clamped value mid-typing (typing "18"
 * at a 13–24 range becomes 13→138→24), so the draft commits on blur/Enter
 * instead; the controller then clamps once. Invalid drafts snap back to the
 * last committed value.
 */
function NumberField({ id, value, min, max, step, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string) => {
    setDraft(null);
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed) || parsed === value) return;
    onCommit(parsed);
  };

  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft ?? String(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(event.currentTarget.value);
        }
      }}
    />
  );
}

/**
 * Theme and editor-preferences dialog. Changes apply (and persist)
 * immediately; values are clamped by the controller. Follows the same modal
 * discipline as the other dialogs: labelled, focus-trapped, Escape closes.
 */
export default function SettingsDialog({
  theme,
  editorPreferences,
  onThemeChange,
  onEditorPreferencesChange,
  onClose,
}: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstControlRef = useRef<HTMLSelectElement>(null);
  // Whether the custom-font row is shown. Tracked locally so picking
  // "自定义…" does not round-trip through the (clamped) stored value before
  // the user has typed a name.
  const [customSelected, setCustomSelected] = useState(() =>
    !isPresetFont(editorPreferences.fontFamily),
  );
  // Installed font family names for the custom-font searchable list. Loaded
  // once per dialog open; `null` means "not available" and keeps the plain
  // text input. Outside the Tauri webview (`queryLocalFonts` is absent in
  // WKWebView) this stays `null` so the fallback input is used.
  const [installedFonts, setInstalledFonts] = useState<readonly string[] | null>(
    null,
  );

  useEffect(() => {
    firstControlRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    invoke<string[]>("list_installed_fonts")
      .then((names) => {
        if (cancelled) return;
        setInstalledFonts([...names].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {
        // Enumeration is a nicety; on failure the dialog keeps the plain
        // text input.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        "button:not(:disabled), select:not(:disabled), input:not(:disabled)",
      ),
    ];
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const update = (patch: Partial<EditorPreferences>) =>
    onEditorPreferencesChange({ ...editorPreferences, ...patch });

  const limits = EDITOR_PREFERENCE_LIMITS;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      onKeyDown={onKeyDown}
    >
      <h2 id="settings-dialog-title">设置</h2>
      <div className="settings-grid">
        <label htmlFor="settings-theme">主题</label>
        <select
          id="settings-theme"
          ref={firstControlRef}
          value={theme}
          onChange={(event) =>
            onThemeChange(event.target.value as ThemePreference)
          }
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label htmlFor="settings-body-size">正文字号</label>
        <NumberField
          id="settings-body-size"
          min={limits.bodySizePx.min}
          max={limits.bodySizePx.max}
          value={editorPreferences.bodySizePx}
          onCommit={(value) => update({ bodySizePx: value })}
        />

        <label htmlFor="settings-line-height">行高</label>
        <NumberField
          id="settings-line-height"
          min={limits.lineHeight.min}
          max={limits.lineHeight.max}
          step={0.05}
          value={editorPreferences.lineHeight}
          onCommit={(value) => update({ lineHeight: value })}
        />

        <label htmlFor="settings-content-width">内容宽度</label>
        <NumberField
          id="settings-content-width"
          min={limits.contentWidthPx.min}
          max={limits.contentWidthPx.max}
          step={10}
          value={editorPreferences.contentWidthPx}
          onCommit={(value) => update({ contentWidthPx: value })}
        />

        <label htmlFor="settings-font">字体</label>
        <select
          id="settings-font"
          value={customSelected ? "custom" : editorPreferences.fontFamily}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "custom") {
              setCustomSelected(true);
            } else {
              setCustomSelected(false);
              update({ fontFamily: value });
            }
          }}
        >
          {FONT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {customSelected && (
          <>
            <label htmlFor="settings-font-custom">自定义字体</label>
            <input
              id="settings-font-custom"
              type="text"
              list={installedFonts ? "settings-font-datalist" : undefined}
              placeholder={
                installedFonts ? "搜索已安装字体…" : "已安装字体的名称"
              }
              value={
                isPresetFont(editorPreferences.fontFamily)
                  ? ""
                  : editorPreferences.fontFamily
              }
              onChange={(event) => update({ fontFamily: event.target.value })}
            />
            {installedFonts && (
              <datalist id="settings-font-datalist">
                {installedFonts.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            )}
          </>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  );
}
