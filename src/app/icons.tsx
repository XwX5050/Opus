/**
 * Inline SVG icons (Lucide-style: 24 viewBox, 2px strokes, round caps).
 * Decorative-only: every icon is aria-hidden and sized to 20px; the
 * accessible name lives on the button wrapping it. Strokes follow
 * currentColor, so both themes come from the surrounding text color.
 */

const iconProps = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const PanelLeftIcon = () => (
  <svg {...iconProps}>
    <rect
      data-panel-fill=""
      x="3"
      y="3"
      width="6"
      height="18"
      rx="2"
      fill="currentColor"
      stroke="none"
      opacity="0"
    />
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <line data-panel-divider="" x1="9" y1="3" x2="9" y2="21" />
  </svg>
);

export const BookOpenIcon = () => (
  <svg {...iconProps} data-view-icon="book">
    <path d="M12 7v14" />
    <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
  </svg>
);

export const PencilLineIcon = () => (
  <svg {...iconProps} data-view-icon="pencil">
    <path d="M12 20h9" />
    <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
    <path d="m15 5 3 3" />
  </svg>
);

export const TranslateIcon = () => (
  <svg {...iconProps} data-translate-icon>
    <g data-translate-part="left">
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
    </g>
    <g data-translate-part="right">
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </g>
  </svg>
);

const outlineIconProps = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const ListTreeIcon = () => (
  <svg {...outlineIconProps}>
    <path d="M4 6h.01" />
    <path d="M8 6h12" />
    <path d="M4 12h.01" />
    <path d="M8 12h12" />
    <path d="M4 18h.01" />
    <path d="M8 18h12" />
  </svg>
);

export const PanelRightIcon = () => (
  <svg {...outlineIconProps}>
    <rect
      data-panel-fill=""
      x="15"
      y="3"
      width="6"
      height="18"
      rx="2"
      fill="currentColor"
      stroke="none"
      opacity="0"
    />
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <line data-panel-divider="" x1="15" y1="3" x2="15" y2="21" />
  </svg>
);

export const CollapseAllIcon = () => (
  <svg {...outlineIconProps}>
    <path data-chevron="top" d="m6 5 6 4 6-4" />
    <path data-chevron="bottom" d="m6 19 6-4 6 4" />
  </svg>
);

export const FileTextIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...outlineIconProps} width={size} height={size}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </svg>
);

export const FolderIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...outlineIconProps} width={size} height={size}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

export const ExpandAllIcon = () => (
  <svg {...outlineIconProps}>
    <path data-chevron="top" d="m6 9 6-4 6 4" />
    <path data-chevron="bottom" d="m6 15 6 4 6-4" />
  </svg>
);

export const DisclosureChevronIcon = () => (
  <svg
    {...outlineIconProps}
    width="14"
    height="14"
    viewBox="0 0 16 16"
  >
    <path d="m6 4 4 4-4 4" />
  </svg>
);
