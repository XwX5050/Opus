import type { ReactNode } from "react";
import { detectPathPlatform } from "../document/platform";
import type { RecentItem } from "../document/types";
import {
  DisclosureChevronIcon,
  FileTextIcon,
  FolderIcon,
  PencilLineIcon,
} from "./icons";
import "./welcome.css";

const RECENT_VISIBLE_LIMIT = 5;

export interface WelcomeScreenProps {
  readonly recent: ReadonlyArray<RecentItem>;
  onNewDocument(): void;
  onOpenFiles(): void;
  onOpenWorkspace(): void;
  onOpenRecent(item: RecentItem): void;
}

interface ShortcutLabels {
  readonly newDocument: string;
  readonly openFiles: string;
  readonly openWorkspace: string;
}

const shortcutLabels = (macos: boolean): ShortcutLabels =>
  macos
    ? { newDocument: "⌘N", openFiles: "⌘O", openWorkspace: "⇧⌘O" }
    : {
        newDocument: "Ctrl+N",
        openFiles: "Ctrl+O",
        openWorkspace: "Ctrl+Shift+O",
      };

/** Last path segment, handling both POSIX and Windows separators. */
const itemName = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  const name = separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
  return name || path;
};

const abbreviateHome = (path: string): string => {
  const posixHome = /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path);
  if (posixHome) return `~${path.slice(posixHome[0].length)}`;
  return path.replace(
    /^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i,
    "~",
  );
};

/** Parent directory of a file or folder, compacted like the recent rows. */
const parentLocation = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  if (separator < 0) return "";
  const parent = trimmed.slice(0, separator);
  if (!parent) return trimmed.slice(0, 1);
  return abbreviateHome(
    /^[A-Za-z]:$/.test(parent) ? `${parent}${trimmed[separator]}` : parent,
  );
};

interface RecentRowProps {
  readonly item: RecentItem;
  onOpenRecent(item: RecentItem): void;
}

function RecentRow({ item, onOpenRecent }: RecentRowProps) {
  const name = itemName(item.path);
  const folder = item.kind === "folder";
  return (
    <li>
      <button
        type="button"
        className="welcome-recent-item"
        aria-label={`打开${folder ? "文件夹" : "文件"} ${name}：${item.path}`}
        title={item.path}
        onClick={() => onOpenRecent(item)}
      >
        <span className="welcome-recent-text">
          <span className="welcome-recent-label">
            <span className="welcome-recent-name">{name}</span>
            <span className="welcome-recent-kind" aria-hidden="true">
              {folder ? "文件夹" : "文件"}
            </span>
          </span>
          <span className="welcome-recent-path" aria-hidden="true">
            {parentLocation(item.path)}
          </span>
        </span>
      </button>
    </li>
  );
}

interface LaunchActionProps {
  readonly icon: ReactNode;
  readonly label: string;
  /** Spoken label when it differs from the visible one (an ellipsis means "opens a dialog"). */
  readonly ariaLabel: string;
  readonly shortcut: string;
  readonly ariaKeyshortcuts: string;
  readonly onClick: () => void;
}

function LaunchAction({
  icon,
  label,
  ariaLabel,
  shortcut,
  ariaKeyshortcuts,
  onClick,
}: LaunchActionProps) {
  return (
    <li>
      <button
        type="button"
        className="welcome-action"
        aria-label={ariaLabel}
        aria-keyshortcuts={ariaKeyshortcuts}
        onClick={onClick}
      >
        <span className="welcome-action-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="welcome-action-label">{label}</span>
        <kbd aria-hidden="true">{shortcut}</kbd>
      </button>
    </li>
  );
}

export default function WelcomeScreen({
  recent,
  onNewDocument,
  onOpenFiles,
  onOpenWorkspace,
  onOpenRecent,
}: WelcomeScreenProps) {
  const macos = detectPathPlatform() === "macos";
  const labels = shortcutLabels(macos);
  const visible = recent.slice(0, RECENT_VISIBLE_LIMIT);
  const remainder = recent.slice(RECENT_VISIBLE_LIMIT);

  return (
    <div className="welcome-screen">
      <div className="welcome-main">
        <header className="welcome-header">
          <h1
            className={`welcome-title${macos ? " welcome-title-script" : ""}`}
          >
            Opus
          </h1>
        </header>

        <section
          className="welcome-section"
          aria-labelledby="welcome-start-title"
        >
          <h2 id="welcome-start-title" className="welcome-section-title">
            启动
          </h2>
          <ul className="welcome-actions">
            <LaunchAction
              icon={<PencilLineIcon />}
              label="新建文件"
              ariaLabel="新建"
              shortcut={labels.newDocument}
              ariaKeyshortcuts="Meta+N Control+N"
              onClick={onNewDocument}
            />
            <LaunchAction
              icon={<FileTextIcon />}
              label="打开文件…"
              ariaLabel="打开文件"
              shortcut={labels.openFiles}
              ariaKeyshortcuts="Meta+O Control+O"
              onClick={onOpenFiles}
            />
            <LaunchAction
              icon={<FolderIcon />}
              label="打开文件夹…"
              ariaLabel="打开文件夹"
              shortcut={labels.openWorkspace}
              ariaKeyshortcuts="Meta+Shift+O Control+Shift+O"
              onClick={onOpenWorkspace}
            />
          </ul>
        </section>

        <section
          className="welcome-section welcome-recent"
          aria-labelledby="welcome-recent-title"
        >
          <h2 id="welcome-recent-title" className="welcome-section-title">
            最近
          </h2>
          {recent.length === 0 ? (
            <p className="welcome-recent-empty">暂无最近项目。</p>
          ) : (
            <>
              <ul className="welcome-recent-list">
                {visible.map((item) => (
                  <RecentRow
                    key={`${item.kind}:${item.path}`}
                    item={item}
                    onOpenRecent={onOpenRecent}
                  />
                ))}
              </ul>
              {remainder.length > 0 && (
                <details className="welcome-more">
                  <summary className="welcome-more-summary">
                    <span
                      className="welcome-more-chevron"
                      aria-hidden="true"
                    >
                      <DisclosureChevronIcon />
                    </span>
                    <span>更多…</span>
                  </summary>
                  <ul className="welcome-recent-list">
                    {remainder.map((item) => (
                      <RecentRow
                        key={`${item.kind}:${item.path}`}
                        item={item}
                        onOpenRecent={onOpenRecent}
                      />
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
