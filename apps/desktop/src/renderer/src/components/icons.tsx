import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: P): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ChevronRight = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
);

export const ChevronsLeft = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M8 3.5 3.5 8 8 12.5M13 3.5 8.5 8 13 12.5" />
  </Svg>
);

export const Hamburger = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Svg>
);

export const HomeIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2.5 7 8 2.5 13.5 7v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
  </Svg>
);

export const SearchIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3 3" />
  </Svg>
);

/** "Open this in full" — the ↗ affordance on the search preview panel (Fig. 11). */
export const ArrowUpRight = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M5.5 10.5 10.5 5.5M6 5.5h4.5V10" />
  </Svg>
);

export const TrashIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2.75 4.25h10.5M6 4.25V3a.75.75 0 0 1 .75-.75h2.5A.75.75 0 0 1 10 3v1.25M4 4.25l.6 8.4a1 1 0 0 0 1 .85h4.8a1 1 0 0 0 1-.85l.6-8.4" />
  </Svg>
);

export const PlusIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const EllipsisIcon = (p: P): JSX.Element => (
  <Svg {...p} strokeWidth="0" fill="currentColor">
    <circle cx="3.25" cy="8" r="1.15" />
    <circle cx="8" cy="8" r="1.15" />
    <circle cx="12.75" cy="8" r="1.15" />
  </Svg>
);

export const StarIcon = ({ filled, ...p }: P & { filled?: boolean }): JSX.Element => (
  <Svg {...p} fill={filled ? "currentColor" : "none"}>
    <path d="M8 2.2 9.8 6l4.1.55-3 2.85.74 4.05L8 11.55 4.36 13.45 5.1 9.4l-3-2.85L6.2 6z" />
  </Svg>
);

export const DocIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M4 2.25h5L12.25 5.5v8.25H4z" />
    <path d="M9 2.25V5.5h3.25" />
  </Svg>
);

export const SettingsIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.75v1.6M8 12.65v1.6M1.75 8h1.6M12.65 8h1.6M3.6 3.6l1.15 1.15M11.25 11.25l1.15 1.15M12.4 3.6l-1.15 1.15M4.75 11.25 3.6 12.4" />
  </Svg>
);

export const CheckIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
);

export const LinkIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M6.7 9.3a2.6 2.6 0 0 0 3.9.3l1.8-1.8a2.6 2.6 0 0 0-3.7-3.7l-1 1" />
    <path d="M9.3 6.7a2.6 2.6 0 0 0-3.9-.3L3.6 8.2a2.6 2.6 0 0 0 3.7 3.7l1-1" />
  </Svg>
);

export const LockIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="3.5" y="7" width="9" height="6.25" rx="1.2" />
    <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" />
  </Svg>
);

export const ImageIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="2.5" y="3.25" width="11" height="9.5" rx="1.5" />
    <circle cx="6" cy="6.5" r="1" />
    <path d="m3.5 11.5 3-3 2.5 2.5 1.75-1.5 2.25 2" />
  </Svg>
);

/* --------------------------------------------------------------- Phase 7 */

export const ImportIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M8 2v7.5" />
    <path d="m5 6.75 3 3 3-3" />
    <path d="M2.75 11.25v1.5a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-1.5" />
  </Svg>
);

export const ExportIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M8 10V2.5" />
    <path d="m5 5.5 3-3 3 3" />
    <path d="M2.75 11.25v1.5a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-1.5" />
  </Svg>
);

export const SlidersIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2.5 5h11M2.5 11h11" />
    <circle cx="6" cy="5" r="1.6" />
    <circle cx="10.5" cy="11" r="1.6" />
  </Svg>
);

export const AlertIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M8 2.75 14 13H2z" />
    <path d="M8 6.75v3M8 11.4v.1" />
  </Svg>
);

export const FolderIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2.5 12.25v-8a.75.75 0 0 1 .75-.75h2.6l1.4 1.75h5.5a.75.75 0 0 1 .75.75v6.25a.75.75 0 0 1-.75.75H3.25a.75.75 0 0 1-.75-.75Z" />
  </Svg>
);

export const ArchiveIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="2.5" y="2.75" width="11" height="3" rx="0.8" />
    <path d="M3.5 5.75v6.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-6.5" />
    <path d="M6.75 8.5h2.5" />
  </Svg>
);

/* Page action palette (Fig. 16) gives every command a leading glyph. */

export const CopyIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.2" />
    <path d="M10.25 5.75V4a1.25 1.25 0 0 0-1.25-1.25H4A1.25 1.25 0 0 0 2.75 4v5a1.25 1.25 0 0 0 1.25 1.25h1.75" />
  </Svg>
);

export const TextSizeIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2.25 12.5 5.5 3.5l3.25 9" />
    <path d="M3.25 9.75h4.5" />
    <path d="M10.5 12.5 12.5 7l2 5.5" />
    <path d="M11.15 10.75h2.7" />
  </Svg>
);

export const WidthIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2.25 4.25v7.5" />
    <path d="M13.75 4.25v7.5" />
    <path d="M4.75 8h6.5" />
    <path d="m6.5 6 -2 2 2 2" />
    <path d="m9.5 6 2 2-2 2" />
  </Svg>
);

export const HistoryIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M3.1 8a4.9 4.9 0 1 0 1.5-3.5L2.75 6.3" />
    <path d="M2.5 3.5v3h3" />
    <path d="M8 5.5V8l1.75 1.25" />
  </Svg>
);

export const TemplateIcon = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5" />
    <path d="M2.75 6.25h10.5" />
    <path d="M6.5 6.25v7" />
  </Svg>
);
