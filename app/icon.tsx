import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
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
          borderRadius: 14,
        }}
      >
        <span
          style={{
            fontSize: 44,
            color: "#22d3ee",
            fontWeight: 700,
            lineHeight: 1,
            textShadow: "0 0 14px rgba(34,211,238,0.85)",
          }}
        >
          ∞
        </span>
      </div>
    ),
    size
  );
}
