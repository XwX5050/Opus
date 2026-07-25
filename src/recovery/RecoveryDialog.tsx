import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { RecoveryDraftInfo } from "../document/types";

export interface RecoveryDialogProps {
  readonly drafts: ReadonlyArray<RecoveryDraftInfo>;
  readonly onRestore: (info: RecoveryDraftInfo) => void;
  readonly onDiscard: (info: RecoveryDraftInfo) => void;
  readonly readSource: (draftId: string) => Promise<string>;
}

/**
 * Modal crash-recovery dialog shown on launch when leftover drafts exist.
 * Drafts are never silently opened as clean documents and never silently
 * deleted: every draft requires an explicit restore or discard click, so the
 * dialog has no Escape dismissal.
 */
export default function RecoveryDialog({
  drafts,
  onRestore,
  onDiscard,
  readSource,
}: RecoveryDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const toggleSource = (draftId: string) => {
    if (expandedId === draftId) {
      setExpandedId(null);
      setSource(null);
      return;
    }
    setExpandedId(draftId);
    setSource(null);
    void readSource(draftId).then(
      (text) => setSource(text),
      () => setSource("（无法读取草稿内容）"),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Every draft requires an explicit decision; Escape is not one.
      event.preventDefault();
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
      aria-labelledby="recovery-dialog-title"
      onKeyDown={onKeyDown}
    >
      <h2 id="recovery-dialog-title">恢复未保存的更改</h2>
      <p>检测到上次会话中未保存的草稿。请选择恢复、查看源码或丢弃。</p>
      <ul>
        {drafts.map((info) => (
          <li key={info.draftId}>
            <strong>{info.title}</strong>
            {info.originalPath && <span> {info.originalPath}</span>}
            <button type="button" onClick={() => onRestore(info)}>恢复</button>
            <button
              type="button"
              aria-expanded={expandedId === info.draftId}
              onClick={() => toggleSource(info.draftId)}
            >
              查看源码
            </button>
            <button type="button" onClick={() => onDiscard(info)}>丢弃</button>
            {expandedId === info.draftId && (
              <pre aria-label={`${info.title} 的草稿源码`}>
                {source ?? "载入中…"}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
