"use client";

import type { TrackMeta } from "@/lib/types";

/** Replay-heatmap strip with famous-part marker and live playhead. */
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
  return (
    <div
      className="relative h-10 w-full cursor-pointer overflow-hidden rounded bg-zinc-900"
      onClick={(e) => {
        if (!onSeek) return;
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - r.left) / r.width) * d);
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
    </div>
  );
}
