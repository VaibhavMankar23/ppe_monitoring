import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

const make = (paths: string[]) =>
  function Icon({ size = 16, ...rest }: P) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
        {paths.map((d) => <path key={d} d={d} />)}
      </svg>
    );
  };

/** Inline icon set (no icon dependency). */
export const Icon = {
  dashboard: make(["M3 3h8v8H3z", "M13 3h8v5h-8z", "M13 10h8v11h-8z", "M3 13h8v8H3z"]),
  alert: make(["M12 3 2 20h20L12 3z", "M12 10v4", "M12 17.5v.01"]),
  settings: make(["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"]),
  play: make(["M7 4l13 8-13 8z"]),
  stop: make(["M6 6h12v12H6z"]),
  boxes: make(["M3 3h7v7H3z", "M14 14h7v7h-7z", "M14 3h7v7h-7"]),
  expand: make(["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"]),
  close: make(["M6 6l12 12", "M18 6 6 18"]),
  chevronLeft: make(["M15 18l-6-6 6-6"]),
  chevronRight: make(["M9 18l6-6-6-6"]),
  download: make(["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"]),
  trash: make(["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"]),
  plus: make(["M12 5v14", "M5 12h14"]),
  check: make(["M5 12l5 5 9-10"]),
  info: make(["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 16v-4", "M12 8h.01"]),
  history: make(["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5", "M12 7v5l3 2"]),
  undo: make(["M9 14 4 9l5-5", "M4 9h10a6 6 0 0 1 0 12h-3"]),
  save: make(["M5 3h11l3 3v15H5z", "M8 3v5h8", "M8 14h8v7H8z"]),
  camera: make(["M3 7h4l2-3h6l2 3h4v13H3z", "M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"]),
  file: make(["M14 3H6v18h12V7z", "M14 3v4h4"]),
  code: make(["M8 7l-5 5 5 5", "M16 7l5 5-5 5"]),
  form: make(["M4 5h16", "M4 12h16", "M4 19h10"]),
  filter: make(["M3 5h18l-7 8v6l-4-2v-4z"]),
  search: make(["M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-5-5"]),
  image: make(["M3 5h18v14H3z", "M3 16l5-5 4 4 3-3 6 6", "M15.5 9.5h.01"]),
  shield: make(["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z", "M9 12l2 2 4-4"]),
  chart: make(["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"]),
  users: make(["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M2 21v-1a6 6 0 0 1 12 0v1", "M16 3.5a4 4 0 0 1 0 7", "M22 21v-1a6 6 0 0 0-4-5.6"]),
  user: make(["M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z", "M4 21v-1a7 7 0 0 1 14 0v1"]),
  clipboard: make(["M9 4h6v3H9z", "M9 5H6v16h12V5h-3", "M9 12h6", "M9 16h4"]),
  lock: make(["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"]),
  key: make(["M14.5 9.5a4 4 0 1 0-4 4", "M10.5 13.5 3 21", "M6 18l2 2", "M8.5 15.5l2 2", "M14.5 9.5h.01"]),
  logout: make(["M15 4h4v16h-4", "M10 8l-4 4 4 4", "M6 12h11"]),
  eye: make(["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"]),
  eyeOff: make(["M3 3l18 18", "M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4", "M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6", "M9.9 9.9a3 3 0 0 0 4.2 4.2"]),
  calendar: make(["M4 5h16v16H4z", "M4 10h16", "M9 3v4", "M15 3v4"]),
  pulse: make(["M3 12h4l2-6 4 12 2-6h6"]),
  plug: make(["M9 3v5", "M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0z", "M12 17v4"]),
  upload: make(["M12 16V4", "M7 9l5-5 5 5", "M5 20h14"]),
  server: make(["M4 4h16v6H4z", "M4 14h16v6H4z", "M8 7h.01", "M8 17h.01"]),
  printer: make(["M7 9V3h10v6", "M5 9h14v8h-2", "M7 17H5V9", "M7 14h10v7H7z"]),
  sun: make(["M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", "M12 1v2", "M12 21v2", "M4.2 4.2l1.4 1.4", "M18.4 18.4l1.4 1.4", "M1 12h2", "M21 12h2", "M4.2 19.8l1.4-1.4", "M18.4 5.6l1.4-1.4"]),
  moon: make(["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"]),
  monitor: make(["M3 4h18v12H3z", "M8 20h8", "M12 16v4"]),
};
