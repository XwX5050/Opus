import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { detectPathPlatform } from "../document/platform";

// Same union as the (unexported) ResizeDirection of @tauri-apps/api/window.
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

/**
 * Windows-only window chrome. The Windows build runs undecorated
 * (set_decorations(false)), so the app draws its own caption buttons
 * (minimize / maximize-close to the right of the header) and invisible
 * window-edge resize strips that replace the native resize border. macOS
 * keeps the native traffic lights and Linux stays button-free, so nothing
 * here renders off the Windows native build.
 */
export const isWindowsNative = (): boolean =>
  detectPathPlatform() === "windows" && "__TAURI_INTERNALS__" in window;

/** Tracks the maximized state for the restore icon and the resize gating. */
const useWindowMaximized = (): boolean => {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isWindowsNative()) return;
    let disposed = false;
    const win = getCurrentWindow();
    const refresh = () => {
      void win.isMaximized().then((value) => {
        if (!disposed) setMaximized(value);
      });
    };
    refresh();
    const stop = win.onResized(refresh);
    return () => {
      disposed = true;
      void stop.then((unlisten) => unlisten());
    };
  }, []);
  return maximized;
};

const windowIconProps = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const MinimizeIcon = () => (
  <svg {...windowIconProps}>
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const MaximizeIcon = () => (
  <svg {...windowIconProps}>
    <rect x="5" y="5" width="14" height="14" />
  </svg>
);

const RestoreIcon = () => (
  <svg {...windowIconProps}>
    <rect x="9" y="9" width="10" height="10" />
    <path d="M5 15V5h10" />
  </svg>
);

const CloseIcon = () => (
  <svg {...windowIconProps}>
    <path d="m6 6 12 12" />
    <path d="M18 6 6 18" />
  </svg>
);

/**
 * Caption buttons for the undecorated Windows window. Closing calls
 * Window.close(), which still emits closeRequested, so the unsaved-changes
 * protection in TauriDocumentPort keeps working.
 */
export default function WindowControls() {
  const maximized = useWindowMaximized();
  if (!isWindowsNative()) return null;
  const win = getCurrentWindow();
  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-control"
        aria-label="最小化"
        title="最小化"
        onClick={() => void win.minimize()}
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? "还原" : "最大化"}
        title={maximized ? "还原" : "最大化"}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        aria-label="关闭"
        title="关闭"
        onClick={() => void win.close()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

type ResizeZone = {
  readonly className: string;
  readonly direction: ResizeDirection;
};

const RESIZE_ZONES: readonly ResizeZone[] = [
  { className: "window-resize-hotzone-n", direction: "North" },
  { className: "window-resize-hotzone-s", direction: "South" },
  { className: "window-resize-hotzone-e", direction: "East" },
  { className: "window-resize-hotzone-w", direction: "West" },
  { className: "window-resize-hotzone-ne", direction: "NorthEast" },
  { className: "window-resize-hotzone-nw", direction: "NorthWest" },
  { className: "window-resize-hotzone-se", direction: "SouthEast" },
  { className: "window-resize-hotzone-sw", direction: "SouthWest" },
];

/**
 * Invisible resize border: 6px strips along each window edge plus 10px
 * corner squares, each starting the native edge resize on mousedown. Hidden
 * while maximized, since a maximized window cannot be edge-resized.
 */
export function WindowResizeHandles() {
  const maximized = useWindowMaximized();
  if (!isWindowsNative() || maximized) return null;
  const startResize = (direction: ResizeDirection) => (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startResizeDragging(direction);
  };
  return (
    <div className="window-resize-hotzones">
      {RESIZE_ZONES.map((zone) => (
        <div
          key={zone.className}
          className={`window-resize-hotzone ${zone.className}`}
          data-resize-direction={zone.direction}
          onMouseDown={startResize(zone.direction)}
        />
      ))}
    </div>
  );
}
