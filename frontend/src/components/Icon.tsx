/**
 * A small set of line icons, inlined.
 *
 * Emoji were doing this job - a 🔔 in the header, ✓/✕/! glyphs in the status
 * badges - which renders as a different picture on every platform and, for
 * the bell, a full-colour cartoon in a monochrome toolbar. These inherit
 * currentColor and size with the text.
 *
 * No icon library: eight glyphs do not justify a dependency, and inlining
 * them means no extra request and nothing to purge.
 */
import type { SVGProps } from 'react';

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative by default: the accessible name comes from the control
      // that wraps it, so a screen reader must not read the icon twice.
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const BellIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </Svg>
);

export const CheckIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const AlertIcon = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16h.01" />
  </Svg>
);

export const CrossIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const InfoIcon = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-5M12 8h.01" />
  </Svg>
);

export const SunIcon = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const MoonIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8" />
  </Svg>
);

export const InboxIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </Svg>
);

export const SearchIcon = (p: Props) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);

/**
 * The product mark, matching public/favicon.svg.
 *
 * Two unequal bars - a debit and a credit, the pair every journal entry is
 * made of. Used where the brand rather than a specific page is meant.
 */
export const BrandMark = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <rect x="10" y="20" width="44" height="9" rx="4.5" fill="currentColor" />
    <rect x="10" y="36" width="27" height="9" rx="4.5" fill="currentColor" opacity="0.72" />
  </svg>
);

export const ChevronDownIcon = (p: Props) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const LogOutIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </Svg>
);

/**
 * Brand marks are filled glyphs, not line icons, so they do not go through
 * Svg above - a 2px stroke on the GitHub octocat renders as a smudge at 16px.
 * They still inherit currentColor, so they pick up hover and theme like the
 * rest of the set.
 */
export const GitHubIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.55v-1.94c-3.2.7-3.88-1.54-3.88-1.54-.52-1.34-1.28-1.7-1.28-1.7-1.05-.71.08-.7.08-.7 1.16.09 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.18-1.49 3.14-1.18 3.14-1.18.63 1.59.24 2.76.12 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.26 5.69.42.36.79 1.07.79 2.16v3.2c0 .3.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
  </svg>
);

export const LinkedInIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.42v1.56h.05a3.75 3.75 0 0 1 3.37-1.85c3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14Zm1.78 13.02H3.55V9h3.57v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z" />
  </svg>
);
