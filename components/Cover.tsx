"use client";

import { useState } from "react";

/**
 * A song's cover art in a square frame (the art itself is square). The frame
 * keeps a neutral backing so a cover that fails to load - any file can 404 -
 * reads as a blank tile instead of a broken-image icon. Size and rounding come
 * from `className`.
 */
export function Cover({
  src,
  alt = "",
  lazy = false,
  className = "",
}: {
  src?: string;
  /** Leave empty where the title is already printed next to the cover. */
  alt?: string;
  /** Long lists: only fetch covers as their rows scroll near. */
  lazy?: boolean;
  className?: string;
}) {
  // remember WHICH url failed, so the frame recovers when it is handed a new song
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={`block aspect-square shrink-0 overflow-hidden bg-zinc-800 ${className}`}>
      {src && src !== failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading={lazy ? "lazy" : undefined}
          decoding="async"
          // inside draggable rows the row should drag, not the picture
          draggable={false}
          onError={() => setFailed(src)}
          className="h-full w-full object-cover"
        />
      )}
    </span>
  );
}
