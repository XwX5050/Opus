import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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

  useEffect(() => {
    firstControlRef.current?.focus();
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

  const updateNumber = (
    key: "bodySizePx" | "lineHeight" | "contentWidthPx",
    raw: string,
  ) => {
    const value = Number(raw);
    // Ignore incomplete input (empty field); the controller clamps the rest.
    if (raw.trim() === "" || Number.isNaN(value)) return;
    update({ [key]: value });
  };

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
        <input
          id="settings-body-size"
          type="number"
          min={limits.bodySizePx.min}
          max={limits.bodySizePx.max}
          value={editorPreferences.bodySizePx}
          onChange={(event) => updateNumber("bodySizePx", event.target.value)}
        />

        <label htmlFor="settings-line-height">行高</label>
        <input
          id="settings-line-height"
          type="number"
          min={limits.lineHeight.min}
          max={limits.lineHeight.max}
          step={0.05}
          value={editorPreferences.lineHeight}
          onChange={(event) => updateNumber("lineHeight", event.target.value)}
        />

        <label htmlFor="settings-content-width">内容宽度</label>
        <input
          id="settings-content-width"
          type="number"
          min={limits.contentWidthPx.min}
          max={limits.contentWidthPx.max}
          step={10}
          value={editorPreferences.contentWidthPx}
          onChange={(event) =>
            updateNumber("contentWidthPx", event.target.value)
          }
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
              placeholder="已安装字体的名称"
              value={
                isPresetFont(editorPreferences.fontFamily)
                  ? ""
                  : editorPreferences.fontFamily
              }
              onChange={(event) => update({ fontFamily: event.target.value })}
            />
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
