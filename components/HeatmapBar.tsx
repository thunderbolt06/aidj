"use client";

import { useRef, useState } from "react";
import type { TrackMeta } from "@/lib/types";

/**
 * Replay-heatmap strip with famous-part marker and live playhead.
 * With `onSeek`, it's also the transport: click anywhere to jump, or drag ,
 * a ghost playhead follows the pointer and the seek fires on release.
 */
export function HeatmapBar({
  meta,
  position,
  onSeek,
}: {
  meta: TrackMeta;
  position?: number;
  onSeek?: (sec: number) => void;
}) {
  const d = meta.duration || 1;
  const barRef = useRef<HTMLDivElement>(null);
  const [dragFrac, setDragFrac] = useState<number | null>(null);
  // pointerup already seeks; swallow the click that follows the same gesture
  const pointerHandled = useRef(false);

  const fracFromEvent = (clientX: number): number => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  return (
    <div
      ref={barRef}
      className={`relative h-10 w-full overflow-hidden rounded bg-zinc-900 ${
        onSeek ? "cursor-pointer touch-none select-none" : ""
      }`}
      onPointerDown={(e) => {
        if (!onSeek) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic/lost pointer - drag still works while over the bar */
        }
        setDragFrac(fracFromEvent(e.clientX));
      }}
      onPointerMove={(e) => {
        if (!onSeek || dragFrac === null) return;
        setDragFrac(fracFromEvent(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!onSeek || dragFrac === null) return;
        setDragFrac(null);
        pointerHandled.current = true;
        onSeek(fracFromEvent(e.clientX) * d);
      }}
      onPointerCancel={() => setDragFrac(null)}
      onClick={(e) => {
        // fallback for click-only environments (keyboard activation, tests);
        // real pointer gestures were already handled on pointerup
        if (!onSeek) return;
        if (pointerHandled.current) {
          pointerHandled.current = false;
          return;
        }
        onSeek(fracFromEvent(e.clientX) * d);
      }}
    >
      <div className="absolute inset-0 flex items-end">
        {meta.heatmap.map((p, i) => (
          <div
            key={i}
            style={{
              left: `${(p.start / d) * 100}%`,
              width: `${Math.max(0.5, ((p.end - p.start) / d) * 100)}%`,
              height: `${Math.max(8, p.value * 100)}%`,
            }}
            className="absolute bottom-0 bg-fuchsia-700/70"
          />
        ))}
      </div>
      {meta.famousStart !== null && (
        <div
          style={{ left: `${(meta.famousStart / d) * 100}%` }}
          className="absolute top-0 h-full w-0.5 bg-amber-400"
          title={`Famous part @ ${meta.famousStart}s`}
        />
      )}
      {position !== undefined && (
        <div
          style={{ left: `${(Math.min(position, d) / d) * 100}%` }}
          className="absolute top-0 h-full w-0.5 bg-white"
        />
      )}
      {/* ghost playhead while scrubbing */}
      {dragFrac !== null && (
        <div
          style={{ left: `${dragFrac * 100}%` }}
          className="absolute top-0 h-full w-0.5 bg-fuchsia-300"
        >
          <span className="absolute -top-0.5 left-1.5 rounded bg-zinc-950/90 px-1 text-[9px] tabular-nums text-fuchsia-300">
            {Math.floor((dragFrac * d) / 60)}:
            {String(Math.floor((dragFrac * d) % 60)).padStart(2, "0")}
          </span>
        </div>
      )}
    </div>
  );
}
