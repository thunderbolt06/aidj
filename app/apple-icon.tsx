import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#05080f",
        }}
      >
        <span
          style={{
            fontSize: 120,
            color: "#22d3ee",
            fontWeight: 700,
            lineHeight: 1,
            textShadow: "0 0 32px rgba(34,211,238,0.85)",
          }}
        >
          ∞
        </span>
      </div>
    ),
    size
  );
}
