import { useEffect, useRef } from "react";

/**
 * Shared inline name editor: an unstyled text input that focuses and selects
 * its content on mount, commits on Enter and cancels on Escape. Used for
 * in-tree renames (FileSidebar) and the document-title rename (AppShell).
 * The value is uncontrolled (`defaultValue` applies on mount only), so a
 * background re-render never wipes what the user is typing.
 *
 * With `commitOnBlur`, losing focus also commits (Finder/Obsidian-style), so
 * the editor can never be left behind as an unfocused, unreachable box.
 * A settled guard keeps Enter/blur sequences from committing twice.
 */
export default function InlineNameInput({
  defaultValue = "",
  ariaLabel = "文件名",
  commitOnBlur = false,
  onCommit,
  onCancel,
}: {
  defaultValue?: string;
  ariaLabel?: string;
  commitOnBlur?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);
  // Focus and select once on mount only. A ref callback would get a new
  // identity every render, so a background tree update would re-select the
  // text and the user's next keystroke would wipe it.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = (value: string) => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };
  return (
    <input
      type="text"
      aria-label={ariaLabel}
      defaultValue={defaultValue}
      ref={inputRef}
      onBlur={commitOnBlur ? (event) => commit(event.currentTarget.value) : undefined}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
}
