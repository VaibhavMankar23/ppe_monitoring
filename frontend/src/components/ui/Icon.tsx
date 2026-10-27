import type { ReactNode, SVGProps } from "react";

/** 24-grid line icons, 1.75 stroke. One visual weight across the app; size via the `size` prop. */
const PATHS = {
  live: <><rect x="3" y="4" width="8" height="7" rx="1.5" /><rect x="13" y="4" width="8" height="7" rx="1.5" /><rect x="3" y="13" width="8" height="7" rx="1.5" /><rect x="13" y="13" width="8" height="7" rx="1.5" /></>,
  review: <><path d="M4 5h16M4 12h9M4 19h7" /><path d="m15 17 2.5 2.5L22 15" /></>,
  chart: <><path d="M4 20V4" /><path d="M4 20h16" /><path d="m7 15 4-5 3 3 5-7" /></>,
  camera: <><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h9A1.5 1.5 0 0 1 15 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 15.5z" /><path d="m15 10.5 5.2-2.6a.5.5 0 0 1 .8.4v7.4a.5.5 0 0 1-.8.4L15 13.5" /></>,
  sliders: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  pulse: <path d="M3 12h4l2.5-7 4 14 2.5-7H21" />,
  users: <><circle cx="9" cy="8" r="3.2" /><path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.8c1.6.7 2.6 2.300 3 4.700" /></>,
  log: <><path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20z" /><path d="M14.500 3.500V8H19M9 12.500h7M9 16h5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.500 4.500 4.500L19 7.500" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  download: <><path d="M12 4v11" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></>,
  upload: <><path d="M12 16V5" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></>,
  search: <><circle cx="11" cy="11" r="6.500" /><path d="m20 20-4.300-4.300" /></>,
  alert: <><path d="M12 4 2.800 19.500h18.400z" /><path d="M12 10v4.500M12 17.200v.1" /></>,
  shield: <><path d="M12 3.500 5 6v5.500c0 4.300 2.800 7.600 7 9 4.200-1.400 7-4.700 7-9V6z" /><path d="m9 12 2.200 2.200L15.200 10" /></>,
  play: <path d="M7.500 5.200v13.600a.500.500 0 0 0 .8.400l10.400-6.800a.500.500 0 0 0 0-.8L8.300 4.800a.500.500 0 0 0-.8.400z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.500" />,
  eye: <><path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z" /><circle cx="12" cy="12" r="2.800" /></>,
  eyeOff: <><path d="M4 4l16 16" /><path d="M9.500 5.900A9 9 0 0 1 12 5.500c6 0 9.500 6.500 9.500 6.500a16 16 0 0 1-2.900 3.600M6.200 7.700A16 16 0 0 0 2.500 12S6 18.500 12 18.500c1.300 0 2.500-.3 3.600-.8" /></>,
  trash: <><path d="M4.500 7h15M9.500 7V4.500h5V7M6.500 7l.8 12.500h9.400L17.500 7" /><path d="M10 11v5M14 11v5" /></>,
  edit: <><path d="M4 20h4L19.500 8.500l-4-4L4 16z" /><path d="m13.500 6.500 4 4" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.300-5.600" /><path d="M20 4.500V9h-4.500" /></>,
  lock: <><rect x="5" y="10.500" width="14" height="9.500" rx="1.500" /><path d="M8 10.500V8a4 4 0 0 1 8 0v2.500" /></>,
  logout: <><path d="M14 4.500H6.500A1.500 1.500 0 0 0 5 6v12a1.500 1.500 0 0 0 1.500 1.500H14" /><path d="M10.500 12H21M17.500 8.500 21 12l-3.500 3.500" /></>,
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  clock: <><circle cx="12" cy="12" r="8.500" /><path d="M12 7.500V12l3 2" /></>,
  zone: <><path d="M5 6.500 13 4l6.500 5.500-2.500 9L7 19.500z" /><circle cx="5" cy="6.500" r="1.400" /><circle cx="13" cy="4" r="1.400" /><circle cx="19.500" cy="9.500" r="1.400" /><circle cx="17" cy="18.500" r="1.400" /><circle cx="7" cy="19.500" r="1.400" /></>,
  filter: <path d="M4 5.500h16l-6 7.500v5.500l-4 1.500V13z" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8.500-8.500M16 7l2.500 2.500" /></>,
  person: <><circle cx="12" cy="7" r="3.200" /><path d="M5.500 20c.6-4 3.200-6 6.500-6s5.900 2 6.500 6" /></>,
  bell: <><path d="M6 16.500V11a6 6 0 0 1 12 0v5.500l1.500 2h-15z" /><path d="M10 20.500a2 2 0 0 0 4 0" /></>,
  info: <><circle cx="12" cy="12" r="8.500" /><path d="M12 11v5.500M12 7.700v.1" /></>,
  copy: <><rect x="8.500" y="8.500" width="11" height="11" rx="1.500" /><path d="M15.500 8.500V6A1.500 1.500 0 0 0 14 4.500H6A1.500 1.500 0 0 0 4.500 6v8A1.500 1.500 0 0 0 6 15.500h2.500" /></>,
  dataset: <><ellipse cx="12" cy="6" rx="7.500" ry="2.800" /><path d="M4.500 6v6c0 1.500 3.400 2.800 7.500 2.800s7.500-1.300 7.500-2.800V6M4.500 12v6c0 1.500 3.400 2.800 7.500 2.800s7.500-1.300 7.500-2.800v-6" /></>,
  phone: <><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 17.500h2" /></>,
  undo: <><path d="M8 5 4 9l4 4" /><path d="M4 9h10.500a5.500 5.500 0 0 1 0 11H9" /></>,
  printer: <><path d="M7 8V4h10v4" /><rect x="4" y="8" width="16" height="8" rx="1.5" /><path d="M7 14h10v6H7z" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  overview: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  monitoring: <><rect x="2.5" y="5" width="13" height="14" rx="2" /><path d="M15.5 10l6-3.5v11l-6-3.5" /></>,
  incidents: <><path d="M12 3l9.5 16.5h-19z" /><path d="M12 10v4M12 17h.01" /></>,
  reports: <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />,
  devices: <><path d="M3 8h3l2-3h8l2 3h3v11H3z" /><circle cx="12" cy="13" r="3.5" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></>,
  helmet: <><path d="M4 16a8 8 0 0 1 16 0z" /><path d="M3 16h18v2H3zM12 8v4" /></>,
  vest: <path d="M8 3 5 6v15h5v-6h4v6h5V6l-3-3-2 4h-4z" />,
  gloves: <path d="M7 21v-8l-2-3 1-1 3 2V5a1 1 0 0 1 2 0v5-6a1 1 0 0 1 2 0v6-5a1 1 0 0 1 2 0v6-3a1 1 0 0 1 2 0v9l-2 7z" />,
  mask: <><path d="M4 9c3-1 5-2 8-2s5 1 8 2v3c0 4-4 6-8 6s-8-2-8-6z" /><path d="M8 12h8" /></>,
  goggles: <><rect x="3" y="8" width="18" height="8" rx="4" /><path d="M12 10v4" /></>,
  boots: <path d="M7 3h6v10l6 3v4H5V3z" />,
  ear: <path d="M8 15a5 5 0 1 1 8-4c0 3-3 3-3 6a3 3 0 0 1-5 2" />,
  restricted: <><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></>,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  external: <><path d="M13 5h6v6" /><path d="M19 5 10 14" /><path d="M17 14v4.500a1 1 0 0 1-1 1H6.500a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H10" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {PATHS[name]}
    </svg>
  );
}
