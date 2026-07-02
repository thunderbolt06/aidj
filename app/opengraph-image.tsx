import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background:
            "radial-gradient(ellipse 80% 60% at 50% 115%, rgba(34,211,238,0.22), transparent), #05080f",
        }}
      >
        <span
          style={{
            fontSize: 180,
            color: "#22d3ee",
            fontWeight: 700,
            lineHeight: 1,
            textShadow: "0 0 60px rgba(34,211,238,0.9)",
          }}
        >
          ∞
        </span>
        <div
          style={{
            display: "flex",
            marginTop: 8,
            fontSize: 90,
            fontWeight: 700,
            color: "#e8f4f8",
          }}
        >
          Ever<span style={{ color: "#22d3ee" }}>play</span>
        </div>
        <div style={{ display: "flex", marginTop: 14, fontSize: 32, color: "#8aa0ab" }}>
          Tell it a vibe. It never stops.
        </div>
      </div>
    ),
    size
  );
}
