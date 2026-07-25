import { useEffect, useRef, type KeyboardEvent } from "react";

export interface ConflictDialogProps {
  readonly title: string;
  readonly path: string | null;
  readonly onLoadDisk: () => void;
  readonly onKeepLocal: () => void;
  readonly onSaveAs: () => void;
}

/**
 * Modal resolution dialog for a tab whose file changed on disk while it held
 * unsaved edits. Loading the disk version discards local edits, so it always
 * requires an explicit click; Escape maps to the only non-destructive choice
 * (keeping the local buffer).
 */
export default function ConflictDialog({
  title,
  path,
  onLoadDisk,
  onKeepLocal,
  onSaveAs,
}: ConflictDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    keepButtonRef.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onKeepLocal();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    ];
    const first = buttons[0];
    const last = buttons.at(-1);
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

  return (
    <div
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby="conflict-dialog-title"
      onKeyDown={onKeyDown}
    >
      <h2 id="conflict-dialog-title">文件已在磁盘上更改</h2>
      <p>
        {path ?? title} 已被其他程序修改。载入磁盘版本会放弃当前未保存的修改。
      </p>
      <button type="button" onClick={onLoadDisk}>载入磁盘版本</button>
      <button ref={keepButtonRef} type="button" onClick={onKeepLocal}>保留当前版本</button>
      <button type="button" onClick={onSaveAs}>另存为…</button>
    </div>
  );
}
