/**
 * Shared stroke-only ("hollow") icons for the player dock and hero actions.
 * All inherit currentColor so the button's text color drives the icon.
 */

function Svg({
  size = 18,
  children,
}: {
  size?: number;
  children: React.ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function PlayIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polygon points="6 4 20 12 6 20 6 4" />
    </Svg>
  );
}

export function PauseIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="5" y="4" width="4" height="16" rx="1" />
      <rect x="15" y="4" width="4" height="16" rx="1" />
    </Svg>
  );
}

export function SkipForwardIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </Svg>
  );
}

export function SkipBackIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polygon points="19 20 9 12 19 4 19 20" />
      <line x1="5" y1="19" x2="5" y2="5" />
    </Svg>
  );
}

/** Speaker; `level` 0 = muted (×), 1 = one wave, 2 = two waves. */
export function VolumeIcon({ size, level }: { size?: number; level: 0 | 1 | 2 }) {
  return (
    <Svg size={size}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {level === 0 ? (
        <>
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </>
      ) : (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          {level === 2 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
        </>
      )}
    </Svg>
  );
}

export function ShuffleIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polyline points="16 3 21 3 21 8" />
      <line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" />
      <line x1="15" y1="15" x2="21" y2="21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </Svg>
  );
}

/** Open hand — the "clap along / keep it going" tap button. */
export function HandIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
      <path d="m7 15-1.76-1.76a2 2 0 0 0-2.83 2.82l3.6 3.6A8 8 0 0 0 12 22h2a8 8 0 0 0 8-8V7a2 2 0 0 0-2-2a2 2 0 0 0-2 2v5" />
    </Svg>
  );
}
