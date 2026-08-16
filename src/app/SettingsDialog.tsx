import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { invoke } from "@tauri-apps/api/core";
import {
  EDITOR_PREFERENCE_LIMITS,
  FONT_PRESETS,
  type EditorPreferences,
  type ThemePreference,
} from "../theme/preferences";
import { type DocumentPort } from "../document/DocumentPort";
import {
  DEFAULT_TRANSLATION_SETTINGS,
  type TranslationSettings,
} from "../translate/types";
import { MOTION } from "../motion/motionConfig";
import { prefersReducedMotion } from "../motion/motionRuntime";
import type { UpdateCheckState } from "./updates";
import { version as APP_VERSION } from "../../package.json";

gsap.registerPlugin(useGSAP);

export interface SettingsDialogProps {
  readonly theme: ThemePreference;
  readonly editorPreferences: EditorPreferences;
  readonly translationSettings: TranslationSettings;
  readonly onThemeChange: (value: ThemePreference) => void;
  readonly onEditorPreferencesChange: (value: EditorPreferences) => void;
  readonly onTranslationSettingsChange: (value: TranslationSettings) => void;
  readonly onClose: () => void;
  readonly onCheckForUpdates: () => void;
  readonly updateCheckState: UpdateCheckState;
  /**
   * Backend for the model fetch and connection check. Optional so the dialog
   * stays renderable in tests and until the shell passes the app's port; the
   * translation buttons are disabled while it is absent.
   */
  readonly port?: DocumentPort;
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

/** Target languages for document translation; the display name is the value
 * passed through to the translation API. */
const TRANSLATION_LANGUAGES: ReadonlyArray<string> = [
  "中文",
  "English",
  "日本語",
  "한국어",
  "Français",
  "Deutsch",
  "Español",
  "Русский",
];

/** Inline hints next to the 检查更新 button, per manual-check state. */
const UPDATE_HINTS: Readonly<
  Record<Exclude<UpdateCheckState, "idle">, string>
> = {
  checking: "正在检查…",
  "up-to-date": "当前已是最新版本",
  error: "检查失败，请稍后重试",
  unsupported: "当前环境不支持检查更新",
};

/** Inline hints next to the 获取模型列表 button, per fetch state. */
const MODEL_LIST_HINTS = {
  loading: "正在获取模型…",
  success: (count: number) => `已加载 ${count} 个模型`,
  error: (reason: string) => `获取模型失败：${reason}`,
};

/** Inline hints next to the 测试连接 button, per check state. */
const CONNECTION_HINTS = {
  testing: "正在测试…",
  success: (count: number) => `连接成功（共 ${count} 个模型）`,
  error: (reason: string) => `连接失败：${reason}`,
};

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

interface TextFieldProps {
  readonly id: string;
  readonly value: string;
  readonly type?: "text" | "password";
  readonly placeholder?: string;
  readonly onCommit: (value: string) => void;
}

/**
 * Text counterpart of NumberField: a local draft committed on blur/Enter, so
 * typing never round-trips through the parent mid-keystroke. An emptied field
 * commits as "" (clearing the API key is a legitimate change).
 */
function TextField({
  id,
  value,
  type = "text",
  placeholder,
  onCommit,
}: TextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string) => {
    setDraft(null);
    if (raw === value) return;
    onCommit(raw);
  };

  return (
    <input
      id={id}
      type={type}
      placeholder={placeholder}
      value={draft ?? value}
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

interface SearchableFieldProps {
  readonly id: string;
  readonly value: string;
  /** Options for the drawn list; `null` keeps a plain text input. */
  readonly options: readonly string[] | null;
  /** Placeholder when there is no option list to search. */
  readonly fallbackPlaceholder: string;
  /** Placeholder once options are available. */
  readonly searchPlaceholder: string;
  /** aria-label of the drawn listbox. */
  readonly listLabel: string;
  /** Per-option inline style (fonts render in their own face); applied when
   * set, omitted otherwise. */
  readonly optionStyle?: (name: string) => CSSProperties | undefined;
  readonly onChange: (value: string) => void;
}

/**
 * Text field with a drawn, searchable option list. The native `<datalist>`
 * picker cannot be styled inside the dark WKWebView (its popup renders as an
 * unreadable black box), so the list is drawn in-app: filtered live as the
 * user types, navigable with ArrowUp/ArrowDown + Enter, closed by Escape,
 * blur or a choice. `options` is null outside the Tauri webview (or before a
 * list is loaded), where the field stays a plain text input.
 */
function SearchableField({
  id,
  value,
  options,
  fallbackPlaceholder,
  searchPlaceholder,
  listLabel,
  optionStyle,
  onChange,
}: SearchableFieldProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    if (options === null) return null;
    const query = value.trim().toLocaleLowerCase();
    return query.length === 0
      ? options
      : options.filter((name) => name.toLocaleLowerCase().includes(query));
  }, [options, value]);

  // Keep the highlighted option inside the filtered list while typing.
  useEffect(() => {
    setActiveIndex((current) =>
      filtered === null
        ? 0
        : Math.min(current, Math.max(filtered.length - 1, 0)),
    );
  }, [filtered]);

  const select = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (filtered === null) return;
    if (event.key === "Escape") {
      if (open) {
        // Close only the list; the dialog handles Escape itself.
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      if (filtered.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) =>
        Math.min(filtered.length - 1, Math.max(0, current + delta)),
      );
      return;
    }
    if (event.key === "Enter" && open && filtered.length > 0) {
      event.preventDefault();
      select(filtered[Math.min(activeIndex, filtered.length - 1)]);
    }
  };

  const listVisible = open && filtered !== null && filtered.length > 0;
  const activeOptionId = listVisible
    ? `${id}-option-${Math.min(activeIndex, filtered.length - 1)}`
    : undefined;

  return (
    <div
      className="font-search"
      onBlur={(event) => {
        // React's onBlur bubbles, so this also fires when the input inside
        // loses focus. Clicking an option never blurs the input (mousedown
        // is prevented), so any blur leaving the wrapper closes the list.
        if (
          event.relatedTarget === null ||
          !event.currentTarget.contains(event.relatedTarget as Node)
        ) {
          setOpen(false);
        }
      }}
    >
      <input
        id={id}
        type="text"
        role={options === null ? undefined : "combobox"}
        aria-expanded={options === null ? undefined : open}
        aria-controls={listVisible ? `${id}-listbox` : undefined}
        aria-activedescendant={listVisible ? activeOptionId : undefined}
        placeholder={options === null ? fallbackPlaceholder : searchPlaceholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          if (options !== null) setOpen(true);
        }}
        onMouseDown={() => {
          if (options !== null) setOpen(true);
        }}
        onFocus={() => {
          if (options !== null) {
            setOpen(true);
            setActiveIndex(0);
          }
        }}
        onKeyDown={onKeyDown}
      />
      {listVisible && (
        <ul
          id={`${id}-listbox`}
          role="listbox"
          aria-label={listLabel}
          className="font-search-list"
        >
          {filtered.map((name, index) => (
            <li
              key={name}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className="font-search-option"
              style={optionStyle?.(name)}
              onMouseDown={(event) => {
                event.preventDefault();
                select(name);
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface FontSearchFieldProps {
  readonly id: string;
  readonly value: string;
  readonly fonts: readonly string[] | null;
  readonly onChange: (value: string) => void;
}

/**
 * Custom-font name field: the searchable option list serving installed fonts.
 * See SearchableField for the drawn-list behavior behind it.
 */
function FontSearchField({ id, value, fonts, onChange }: FontSearchFieldProps) {
  return (
    <SearchableField
      id={id}
      value={value}
      options={fonts}
      fallbackPlaceholder="已安装字体的名称"
      searchPlaceholder="搜索已安装字体…"
      listLabel="已安装字体"
      optionStyle={(name) => ({ fontFamily: name })}
      onChange={onChange}
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
  // Defaults keep the dialog renderable in tests that mount it without the
  // translation props; the interface still requires them, so the AppShell
  // always passes them and the defaults never fire in production.
  translationSettings = DEFAULT_TRANSLATION_SETTINGS,
  onTranslationSettingsChange = () => {},
  onClose,
  onCheckForUpdates,
  updateCheckState,
  port,
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
  // Model names for the model field's searchable list, loaded on demand via
  // the port. `null` keeps the plain text input until a fetch succeeds; the
  // connection test shares the same request but only reports the outcome.
  const [translationModels, setTranslationModels] = useState<
    readonly string[] | null
  >(null);
  const [modelsHint, setModelsHint] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [connectionHint, setConnectionHint] = useState<string | null>(null);
  const [connectionTesting, setConnectionTesting] = useState(false);

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

  // Rows stagger in when the dialog opens (the overlay's own dialog intro is
  // handled by AppShell). Skipped under prefers-reduced-motion.
  useGSAP(
    () => {
      const root = dialogRef.current;
      if (!root) return;
      const rows = root.querySelectorAll<HTMLElement>("[data-settings-row]");
      if (prefersReducedMotion()) {
        gsap.set(rows, { clearProps: "opacity,transform" });
        return;
      }
      gsap.fromTo(
        rows,
        { y: 8, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.24,
          ease: MOTION.easing,
          stagger: MOTION.list.stagger,
          clearProps: "opacity,transform",
        },
      );
    },
    { scope: dialogRef },
  );

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

  const updateTranslation = (patch: Partial<TranslationSettings>) =>
    onTranslationSettingsChange({ ...translationSettings, ...patch });

  const translationFailureReason = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const fetchTranslationModels = async () => {
    if (!port || modelsLoading) return;
    setModelsLoading(true);
    setModelsHint(MODEL_LIST_HINTS.loading);
    try {
      const models = await port.listTranslationModels(
        translationSettings.endpoint,
        translationSettings.apiKey,
      );
      // Sorted like the installed-font list, so the picker order is stable
      // regardless of what the endpoint returns.
      setTranslationModels([...models].sort((a, b) => a.localeCompare(b)));
      setModelsHint(MODEL_LIST_HINTS.success(models.length));
    } catch (error) {
      setModelsHint(MODEL_LIST_HINTS.error(translationFailureReason(error)));
    } finally {
      setModelsLoading(false);
    }
  };

  const testConnection = async () => {
    if (!port || connectionTesting) return;
    setConnectionTesting(true);
    setConnectionHint(CONNECTION_HINTS.testing);
    try {
      const models = await port.listTranslationModels(
        translationSettings.endpoint,
        translationSettings.apiKey,
      );
      setConnectionHint(CONNECTION_HINTS.success(models.length));
    } catch (error) {
      setConnectionHint(CONNECTION_HINTS.error(translationFailureReason(error)));
    } finally {
      setConnectionTesting(false);
    }
  };

  const limits = EDITOR_PREFERENCE_LIMITS;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      className="settings-dialog"
      onKeyDown={onKeyDown}
    >
      <h2 id="settings-dialog-title">设置</h2>

      <section
        className="settings-section"
        aria-labelledby="settings-heading-appearance"
      >
        <h3 id="settings-heading-appearance" className="settings-section-heading">
          外观
        </h3>
        <div className="settings-group">
          <div className="settings-row" data-settings-row>
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
          </div>
        </div>
      </section>

      <section
        className="settings-section"
        aria-labelledby="settings-heading-editor"
      >
        <h3 id="settings-heading-editor" className="settings-section-heading">
          编辑器
        </h3>
        <div className="settings-group">
          <div className="settings-row" data-settings-row>
            <label htmlFor="settings-body-size">正文字号</label>
            <NumberField
              id="settings-body-size"
              min={limits.bodySizePx.min}
              max={limits.bodySizePx.max}
              value={editorPreferences.bodySizePx}
              onCommit={(value) => update({ bodySizePx: value })}
            />
          </div>

          <div className="settings-row" data-settings-row>
            <label htmlFor="settings-line-height">行高</label>
            <NumberField
              id="settings-line-height"
              min={limits.lineHeight.min}
              max={limits.lineHeight.max}
              step={0.05}
              value={editorPreferences.lineHeight}
              onCommit={(value) => update({ lineHeight: value })}
            />
          </div>

          <div className="settings-row" data-settings-row>
            <label htmlFor="settings-content-width">内容宽度</label>
            <NumberField
              id="settings-content-width"
              min={limits.contentWidthPx.min}
              max={limits.contentWidthPx.max}
              step={10}
              value={editorPreferences.contentWidthPx}
              onCommit={(value) => update({ contentWidthPx: value })}
            />
          </div>

          <div className="settings-row" data-settings-row>
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
          </div>

          {customSelected && (
            <div className="settings-row" data-settings-row>
              <label htmlFor="settings-font-custom">自定义字体</label>
              <FontSearchField
                id="settings-font-custom"
                value={
                  isPresetFont(editorPreferences.fontFamily)
                    ? ""
                    : editorPreferences.fontFamily
                }
                fonts={installedFonts}
                onChange={(value) => update({ fontFamily: value })}
              />
            </div>
          )}
        </div>
      </section>

      <section
        className="settings-section"
        aria-labelledby="settings-heading-translation"
      >
        <h3
          id="settings-heading-translation"
          className="settings-section-heading"
        >
          翻译
        </h3>
        <div className="settings-group">
          <div className="settings-row" data-settings-row>
            <label htmlFor="settings-translation-endpoint">API 端点</label>
            <TextField
              id="settings-translation-endpoint"
              value={translationSettings.endpoint}
              onCommit={(value) => updateTranslation({ endpoint: value })}
            />
          </div>

          <div className="settings-row" data-settings-row>
            <label htmlFor="settings-translation-api-key">API Key</label>
            <TextField
              id="settings-translation-api-key"
              type="password"
              placeholder="sk-..."
              value={translationSettings.apiKey}
              onCommit={(value) => updateTranslation({ apiKey: value })}
            />
          </div>

          <div className="settings-row" data-settings-row>
            <label htmlFor="settings-translation-model">模型</label>
            <div className="settings-update-controls">
              <SearchableField
                id="settings-translation-model"
                value={translationSettings.model}
                options={translationModels}
                fallbackPlaceholder="模型名称"
                searchPlaceholder="搜索模型…"
                listLabel="可用模型"
                onChange={(value) => updateTranslation({ model: value })}
              />
              <button
                type="button"
                disabled={port === undefined || modelsLoading}
                onClick={() => void fetchTranslationModels()}
              >
                获取模型列表
              </button>
              {modelsHint !== null && (
                <span role="status" className="settings-update-hint">
                  {modelsHint}
                </span>
              )}
            </div>
          </div>

          <div className="settings-row" data-settings-row>
            <span className="settings-row-label">连接</span>
            <div className="settings-update-controls">
              <button
                type="button"
                disabled={port === undefined || connectionTesting}
                onClick={() => void testConnection()}
              >
                测试连接
              </button>
              {connectionHint !== null && (
                <span role="status" className="settings-update-hint">
                  {connectionHint}
                </span>
              )}
            </div>
          </div>

          <div className="settings-row" data-settings-row>
            <label htmlFor="settings-translation-target-language">目标语言</label>
            <select
              id="settings-translation-target-language"
              value={translationSettings.targetLanguage}
              onChange={(event) =>
                updateTranslation({ targetLanguage: event.target.value })
              }
            >
              {TRANSLATION_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p>翻译结果会缓存在本机，原文不变时不重复调用 API。</p>
      </section>

      <section
        className="settings-section"
        aria-labelledby="settings-heading-about"
      >
        <h3 id="settings-heading-about" className="settings-section-heading">
          关于
        </h3>
        <div className="settings-group">
          <div className="settings-row" data-settings-row>
            <span className="settings-row-label">版本</span>
            <span className="settings-version-value">v{APP_VERSION}</span>
          </div>
          <div className="settings-row" data-settings-row>
            <span className="settings-row-label">更新</span>
            <div className="settings-update-controls">
              <button
                type="button"
                onClick={onCheckForUpdates}
                disabled={updateCheckState === "checking"}
              >
                检查更新
              </button>
              {updateCheckState !== "idle" && (
                <span role="status" className="settings-update-hint">
                  {UPDATE_HINTS[updateCheckState]}
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  );
}
