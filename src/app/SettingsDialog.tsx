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
  translationKeySlot,
  type TranslationKeyProtection,
  type TranslationSettings,
} from "../translate/types";
import { matchPreset, TRANSLATION_PRESETS } from "../translate/presets";
import { MOTION } from "../motion/motionConfig";
import { prefersReducedMotion } from "../motion/motionRuntime";
import type { UpdateCheckState } from "./updates";
import {
  InfoIcon,
  MonitorIcon,
  MoonIcon,
  PencilLineIcon,
  SunIcon,
  TranslateIcon,
} from "./icons";
import { version as APP_VERSION } from "../../package.json";
import "./settingsRefinements.css";

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

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  Icon: typeof SunIcon;
}> = [
  { value: "light", label: "浅色", Icon: SunIcon },
  { value: "dark", label: "深色", Icon: MoonIcon },
  { value: "system", label: "跟随系统", Icon: MonitorIcon },
];

const FONT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "system", label: "系统默认" },
  { value: "serif", label: "衬线" },
  { value: "monospace", label: "等宽" },
  { value: "custom", label: "自定义…" },
];

const SETTINGS_SECTIONS = [
  { id: "appearance", label: "外观", description: "选择应用的颜色与显示方式", Icon: SunIcon },
  { id: "editor", label: "编辑器", description: "调整正文排版、字体与阅读宽度", Icon: PencilLineIcon },
  { id: "translation", label: "翻译", description: "配置翻译服务、模型与目标语言", Icon: TranslateIcon },
  { id: "about", label: "关于", description: "查看应用版本并检查更新", Icon: InfoIcon },
] as const;

type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

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

/** Select value meaning "no preset": shown whenever the stored endpoint and
 * model identify no provider preset (or the user edited a preset's fields). */
const CUSTOM_PRESET_VALUE = "custom";

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

function FieldLabel({
  id,
  label,
  description,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}) {
  return (
    <span className="settings-field-label">
      <label htmlFor={id}>{label}</label>
      <span id={`${id}-description`} className="settings-field-description">
        {description}
      </span>
    </span>
  );
}

interface NumberFieldProps {
  readonly id: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  /** Visible unit suffix (px, 倍, 个…) inside the capsule. */
  readonly unit: string;
  readonly onCommit: (value: number) => void;
}

/**
 * Number input with a local string draft. Committing on every keystroke
 * would re-render the field with the clamped value mid-typing (typing "18"
 * at a 13–24 range becomes 13→138→24), so the draft commits on blur/Enter
 * instead; the controller then clamps once. Invalid drafts snap back to the
 * last committed value.
 */
function NumberField({
  id,
  value,
  min,
  max,
  step,
  unit,
  onCommit,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string) => {
    setDraft(null);
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed) || parsed === value) return;
    onCommit(parsed);
  };

  return (
    <span className="settings-number">
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        aria-describedby={`${id}-description ${id}-unit`}
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
      <span id={`${id}-unit`} className="settings-number-unit">
        {unit}
      </span>
    </span>
  );
}

interface TextFieldProps {
  readonly id: string;
  readonly value: string;
  readonly type?: "text" | "password";
  readonly placeholder?: string;
  /** Extra classes for the width rule (settings-control-*). */
  readonly className?: string;
  /** Native tooltip exposing the full value of a long field. */
  readonly title?: string;
  /** Extra description element appended after the row description. */
  readonly extraDescriptionId?: string;
  readonly onCommit: (value: string) => void;
}

/**
 * Text counterpart of NumberField: a local draft committed on blur/Enter, so
 * typing never round-trips through the parent mid-keystroke. An emptied field
 * commits as "" — the endpoint field relies on that, and the controller
 * repairs the blank value. The write-only API Key field is the exception: it
 * ignores empty commits, since removing a key is the 清除 button's job.
 */
function TextField({
  id,
  value,
  type = "text",
  placeholder,
  className,
  title,
  extraDescriptionId,
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
      className={className}
      title={title}
      aria-describedby={
        extraDescriptionId === undefined
          ? `${id}-description`
          : `${id}-description ${extraDescriptionId}`
      }
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

/** Cap on the number of options drawn at once: installed-font lists can hold
 * hundreds of entries, and drawing them all on focus is wasted work. The
 * keyboard and highlighting operate over this rendered subset. */
const MAX_DROPDOWN_OPTIONS = 100;

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
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    if (options === null) return null;
    const query = value.trim().toLocaleLowerCase();
    return query.length === 0
      ? options
      : options.filter((name) => name.toLocaleLowerCase().includes(query));
  }, [options, value]);

  // Only the first MAX_DROPDOWN_OPTIONS matches are drawn, so navigation and
  // highlighting stay in sync with the rendered list.
  const displayed = useMemo(
    () => (filtered === null ? null : filtered.slice(0, MAX_DROPDOWN_OPTIONS)),
    [filtered],
  );

  // Keep the highlighted option inside the rendered list while typing.
  useEffect(() => {
    setActiveIndex((current) =>
      displayed === null
        ? 0
        : Math.min(current, Math.max(displayed.length - 1, 0)),
    );
  }, [displayed]);

  // Keep the highlighted option visible while navigating with the keyboard.
  useEffect(() => {
    const active = listRef.current?.children[activeIndex] as
      | HTMLElement
      | undefined;
    // jsdom leaves scrollIntoView unimplemented; the optional call makes the
    // effect a no-op there.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, displayed]);

  const select = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (displayed === null) return;
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
      if (displayed.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) =>
        Math.min(displayed.length - 1, Math.max(0, current + delta)),
      );
      return;
    }
    if (event.key === "Enter" && open && displayed.length > 0) {
      event.preventDefault();
      select(displayed[Math.min(activeIndex, displayed.length - 1)]);
    }
  };

  const listVisible = open && displayed !== null && displayed.length > 0;
  const activeOptionId = listVisible
    ? `${id}-option-${Math.min(activeIndex, displayed.length - 1)}`
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
        aria-expanded={options === null ? undefined : listVisible}
        aria-controls={listVisible ? `${id}-listbox` : undefined}
        aria-activedescendant={listVisible ? activeOptionId : undefined}
        aria-describedby={`${id}-description`}
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
          ref={listRef}
          role="listbox"
          aria-label={listLabel}
          className="font-search-list"
        >
          {displayed.map((name, index) => (
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
 * Category-based settings dialog. Changes apply (and persist) immediately;
 * values are clamped by the controller. Follows the same modal discipline as
 * the other dialogs: labelled, focus-trapped, Escape closes.
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
  const firstControlRef = useRef<HTMLButtonElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>("appearance");
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
  // Model names offered by the model select, loaded on demand via the port.
  // `null` before the first fetch keeps the select down to the stored model
  // alone; the connection test shares the same request but only reports the
  // outcome.
  const [translationModels, setTranslationModels] = useState<
    readonly string[] | null
  >(null);
  const [modelsHint, setModelsHint] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [connectionHint, setConnectionHint] = useState<string | null>(null);
  const [connectionTesting, setConnectionTesting] = useState(false);
  // Whether the credential store holds a key for the slot the current
  // endpoint+model address. The key itself is never readable from here: the
  // field is write-only and this flag is all the dialog gets back.
  const [keyPresent, setKeyPresent] = useState(false);
  const [keyHint, setKeyHint] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  // Protection level of the credential store; null while unknown (no
  // warning is shown before the backend has answered).
  const [keyProtection, setKeyProtection] =
    useState<TranslationKeyProtection | null>(null);

  // Preset the current endpoint+model correspond to; undefined means custom.
  const matchedPreset = matchPreset(translationSettings);

  // The slot the active provider addresses its API key by: the matched
  // preset's id, or "custom" while the endpoint+model identify no preset.
  // Computed from the settings on every render, so it can never go stale:
  // switching preset (or editing endpoint/model) immediately addresses the
  // other slot, whose own key in the credential store is what counts.
  const currentKeySlot = translationKeySlot(translationSettings);

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

  // Re-check the key of whichever slot is now addressed. A failed lookup
  // counts as "no key": the dialog never claims a key it could not confirm.
  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    setKeyHint(null);
    void port
      .hasTranslationKey(currentKeySlot)
      .then((present) => {
        if (!cancelled) setKeyPresent(present);
      })
      .catch(() => {
        if (!cancelled) setKeyPresent(false);
      });
    return () => {
      cancelled = true;
    };
  }, [port, currentKeySlot]);

  // Clear stale fetched model list and hints when the endpoint changes.
  const prevEndpointRef = useRef(translationSettings.endpoint);
  useEffect(() => {
    if (prevEndpointRef.current === translationSettings.endpoint) return;
    prevEndpointRef.current = translationSettings.endpoint;
    setTranslationModels(null);
    setModelsHint(null);
    setConnectionHint(null);
  }, [translationSettings.endpoint]);

  // Protection level of the credential store, for the weak-protection note.
  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    void port
      .translationKeyProtection()
      .then((protection) => {
        if (!cancelled) setKeyProtection(protection);
      })
      .catch(() => {
        // Unknown protection: the note stays hidden rather than guessing.
      });
    return () => {
      cancelled = true;
    };
  }, [port]);

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

  const onSectionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = SETTINGS_SECTIONS.findIndex(
      (section) => section.id === activeSection,
    );
    let nextIndex: number;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % SETTINGS_SECTIONS.length;
        break;
      case "ArrowUp":
        nextIndex = (currentIndex - 1 + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = SETTINGS_SECTIONS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = SETTINGS_SECTIONS[nextIndex];
    setActiveSection(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };

  const onThemeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = THEME_OPTIONS.findIndex(
      (option) => option.value === theme,
    );
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % THEME_OPTIONS.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex =
          (currentIndex - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = THEME_OPTIONS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = THEME_OPTIONS[nextIndex];
    onThemeChange(next.value);
    document.getElementById(`settings-theme-${next.value}`)?.focus();
  };

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
    ].filter((control) => control.tabIndex >= 0);
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
        currentKeySlot,
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
        currentKeySlot,
      );
      setConnectionHint(CONNECTION_HINTS.success(models.length));
    } catch (error) {
      setConnectionHint(CONNECTION_HINTS.error(translationFailureReason(error)));
    } finally {
      setConnectionTesting(false);
    }
  };

  /**
   * Hands a newly typed key to the credential store of the current slot. The
   * field never echoes a stored key back, so an empty commit is a no-op —
   * removing a key is what the 清除 button is for.
   */
  const saveTranslationKey = async (value: string) => {
    if (!port) {
      setKeyHint("当前环境不支持保存 API Key");
      return;
    }
    if (keyBusy) return;
    const key = value.trim();
    if (key.length === 0) return;
    setKeyBusy(true);
    try {
      await port.storeTranslationKey(currentKeySlot, key);
      setKeyPresent(true);
      setKeyHint("已保存");
    } catch (error) {
      setKeyHint(`保存失败：${translationFailureReason(error)}`);
    } finally {
      setKeyBusy(false);
    }
  };

  const clearTranslationKey = async () => {
    if (!port || keyBusy) return;
    setKeyBusy(true);
    try {
      await port.deleteTranslationKey(currentKeySlot);
      setKeyPresent(false);
      setKeyHint("已清除");
    } catch (error) {
      setKeyHint(`清除失败：${translationFailureReason(error)}`);
    } finally {
      setKeyBusy(false);
    }
  };

  const limits = EDITOR_PREFERENCE_LIMITS;

  // Model names selectable in the model field: the fetched list plus, first,
  // the stored model when it is missing from it. The select is controlled by
  // translationSettings.model, so the stored value must always be one of the
  // options — including before the list is fetched, when it is the only one.
  const modelOptions = useMemo(() => {
    const models = translationModels ?? [];
    return models.includes(translationSettings.model)
      ? models
      : [translationSettings.model, ...models];
  }, [translationModels, translationSettings.model]);

  const clearKeyReason =
    port === undefined
      ? "当前环境不支持管理 API Key"
      : keyBusy
        ? "正在处理 API Key"
        : keyPresent
          ? "当前服务商已保存 API Key，可使用清除按钮删除"
          : "当前服务商尚未保存 API Key，清除按钮不可用";

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
      <header className="settings-header">
        <h2 id="settings-dialog-title" className="settings-dialog-title">
          设置
        </h2>
        <button
          type="button"
          className="icon-button settings-close"
          aria-label="关闭设置"
          onClick={onClose}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="设置导航">
          <div
            role="tablist"
            aria-label="设置分类"
            aria-orientation="vertical"
            className="settings-tabs"
            onKeyDown={onSectionKeyDown}
          >
            {SETTINGS_SECTIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                id={`settings-tab-${id}`}
                type="button"
                role="tab"
                aria-label={label}
                aria-selected={activeSection === id}
                tabIndex={activeSection === id ? 0 : -1}
                className="settings-tab"
                onClick={() => setActiveSection(id)}
              >
                <Icon size={17} />
                <span className="settings-tab-label">{label}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="settings-content">
          <div className="settings-body">
      {activeSection === "appearance" && (
      <section
        role="tabpanel"
        className="settings-section"
        aria-labelledby="settings-tab-appearance"
      >
        <div className="settings-group">
          <div className="settings-row settings-row-stacked" data-settings-row>
            <span className="settings-field-label">
              <span id="settings-theme-label" className="settings-row-title">
                主题
              </span>
              <span
                id="settings-theme-description"
                className="settings-field-description"
              >
                选择浅色、深色，或跟随系统设置
              </span>
            </span>
            <div
              role="radiogroup"
              aria-labelledby="settings-theme-label"
              aria-describedby="settings-theme-description"
              className="settings-theme-grid"
              onKeyDown={onThemeKeyDown}
            >
              {THEME_OPTIONS.map(({ value, label, Icon }) => {
                const selected = theme === value;
                return (
                  <button
                    key={value}
                    id={`settings-theme-${value}`}
                    ref={selected ? firstControlRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    className="settings-theme-card"
                    onClick={() => onThemeChange(value)}
                  >
                    <Icon size={20} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
      )}

      {activeSection === "editor" && (
      <section
        role="tabpanel"
        className="settings-section"
        aria-labelledby="settings-tab-editor"
      >
        <div className="settings-group">
          <div className="settings-row" data-settings-row>
            <FieldLabel id="settings-body-size" label="正文字号" description="设置 Markdown 正文的文字大小" />
            <NumberField
              id="settings-body-size"
              min={limits.bodySizePx.min}
              max={limits.bodySizePx.max}
              value={editorPreferences.bodySizePx}
              unit="px"
              onCommit={(value) => update({ bodySizePx: value })}
            />
          </div>

          <div className="settings-row" data-settings-row>
            <FieldLabel id="settings-line-height" label="行高" description="调整正文行与行之间的距离" />
            <NumberField
              id="settings-line-height"
              min={limits.lineHeight.min}
              max={limits.lineHeight.max}
              step={0.05}
              value={editorPreferences.lineHeight}
              unit="倍"
              onCommit={(value) => update({ lineHeight: value })}
            />
          </div>

          <div className="settings-row" data-settings-row>
            <FieldLabel id="settings-content-width" label="内容宽度" description="设置正文阅读栏宽度，也可直接拖动正文两侧边缘调整" />
            <NumberField
              id="settings-content-width"
              min={limits.contentWidthPx.min}
              max={limits.contentWidthPx.max}
              step={10}
              value={editorPreferences.contentWidthPx}
              unit="px"
              onCommit={(value) => update({ contentWidthPx: value, contentWidthPinned: true })}
            />
          </div>

          <div className="settings-row" data-settings-row>
            <FieldLabel id="settings-font" label="字体" description="选择编辑和阅读时使用的字体" />
            <select
              id="settings-font"
              className="settings-control"
              aria-describedby="settings-font-description"
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
              <FieldLabel id="settings-font-custom" label="自定义字体" description="输入本机已安装的字体名称" />
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
      )}

      {activeSection === "translation" && (
      <section
        role="tabpanel"
        className="settings-section"
        aria-labelledby="settings-tab-translation"
      >
        <div className="settings-group">
          <div className="settings-row" data-settings-row>
            <FieldLabel id="settings-translation-preset" label="服务商预设" description={matchedPreset?.note ?? "快速填入服务商的接口与模型配置"} />
            <select
              id="settings-translation-preset"
              className="settings-control settings-control-wide"
              aria-describedby="settings-translation-preset-description"
              value={matchedPreset?.id ?? CUSTOM_PRESET_VALUE}
              onChange={(event) => {
                const id = event.target.value;
                if (id === CUSTOM_PRESET_VALUE) {
                  // 自定义 is only the label for "matches no preset": the
                  // endpoint and model stay as they are, so nothing to change.
                  return;
                }
                const preset = TRANSLATION_PRESETS.find(
                  (candidate) => candidate.id === id,
                );
                if (preset === undefined) return;
                // Keys never move: each slot keeps its own key in the OS
                // credential store, so switching provider only swaps the
                // endpoint, model and concurrency and the key field simply
                // reports whether the new slot already has one.
                updateTranslation({
                  endpoint: preset.endpoint,
                  model: preset.model,
                  concurrency: preset.concurrency,
                });
              }}
            >
              {TRANSLATION_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value={CUSTOM_PRESET_VALUE}>自定义</option>
            </select>
          </div>

          <div className="settings-row settings-row-stacked" data-settings-row>
            <FieldLabel id="settings-translation-endpoint" label="API 端点" description="OpenAI 兼容的聊天补全接口地址" />
            <TextField
              id="settings-translation-endpoint"
              className="settings-control settings-control-fill settings-control-mono"
              title={translationSettings.endpoint}
              value={translationSettings.endpoint}
              onCommit={(value) => updateTranslation({ endpoint: value })}
            />
          </div>

          <div className="settings-row" data-settings-row>
            <FieldLabel
              id="settings-translation-api-key"
              label="API Key"
              description={keyProtection === "file"
                ? "系统凭据存储不可用：API Key 以文件形式保存在本机，保护较弱。"
                : "仅写入系统凭据存储，不会回显已保存的密钥"}
            />
            <div className="settings-update-controls">
              {/* Write-only: a stored key is acknowledged by the placeholder,
                  never read back into the field. */}
              <TextField
                id="settings-translation-api-key"
                type="password"
                className="settings-control settings-control-grow"
                placeholder={keyPresent ? "已保存" : "sk-..."}
                extraDescriptionId="settings-translation-api-key-clear-reason"
                value=""
                onCommit={(value) => void saveTranslationKey(value)}
              />
              <button
                type="button"
                className="settings-key-clear"
                disabled={port === undefined || !keyPresent || keyBusy}
                title={clearKeyReason}
                aria-describedby="settings-translation-api-key-clear-reason"
                onClick={() => void clearTranslationKey()}
              >
                清除
              </button>
              {/* A disabled button leaves the tab order; the state stays
                  available to assistive technology through the description
                  shared by the field and the button. */}
              <span
                id="settings-translation-api-key-clear-reason"
                className="visually-hidden"
              >
                {clearKeyReason}
              </span>
              {keyHint !== null && (
                <span role="status" className="settings-update-hint">
                  {keyHint}
                </span>
              )}
            </div>
          </div>

          <div className="settings-row" data-settings-row>
            <FieldLabel id="settings-translation-model" label="模型" description="选择文档翻译使用的模型" />
            <div className="settings-update-controls">
              <select
                id="settings-translation-model"
                className="settings-control settings-control-grow"
                aria-describedby="settings-translation-model-description"
                value={translationSettings.model}
                onChange={(event) =>
                  updateTranslation({ model: event.target.value })
                }
              >
                {modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
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
            <FieldLabel id="settings-translation-concurrency" label="并发数" description="同时翻译的段落数，范围 1-32，默认 10；调太高可能被服务商限流。" />
            <div className="settings-update-controls">
              <span className="settings-number">
                <input
                  id="settings-translation-concurrency"
                  type="number"
                  min={1}
                  max={32}
                  step={1}
                  aria-describedby="settings-translation-concurrency-description settings-translation-concurrency-unit"
                  value={translationSettings.concurrency}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    // An emptied field is ignored; the stored value stands.
                    if (raw === "") return;
                    const parsed = Number.parseInt(raw, 10);
                    if (Number.isNaN(parsed)) return;
                    // The controller clamps to 1-32 on write-back.
                    updateTranslation({ concurrency: parsed });
                  }}
                />
                <span
                  id="settings-translation-concurrency-unit"
                  className="settings-number-unit"
                >
                  个
                </span>
              </span>
            </div>
          </div>

          <div className="settings-row" data-settings-row>
            <span className="settings-row-label settings-field-label">
              <span>连接</span>
              <span className="settings-field-description">检查当前接口与密钥是否可用</span>
            </span>
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
            <FieldLabel id="settings-translation-target-language" label="目标语言" description="设置译文使用的语言" />
            <select
              id="settings-translation-target-language"
              className="settings-control"
              aria-describedby="settings-translation-target-language-description"
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
        <p className="settings-section-note">翻译结果会缓存在本机，原文不变时不重复调用 API。</p>
      </section>
      )}

      {activeSection === "about" && (
      <section
        role="tabpanel"
        className="settings-section"
        aria-labelledby="settings-tab-about"
      >
        <div className="settings-group">
          <div className="settings-row" data-settings-row>
            <span className="settings-row-label settings-field-label">
              <span>版本</span>
              <span className="settings-field-description">当前安装的 Opus 版本</span>
            </span>
            <span className="settings-version-value">v{APP_VERSION}</span>
          </div>
          <div className="settings-row" data-settings-row>
            <span className="settings-row-label settings-field-label">
              <span>更新</span>
              <span className="settings-field-description">检查是否有可用的新版本</span>
            </span>
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
      )}
          </div>
        </div>
      </div>
    </div>
  );
}
