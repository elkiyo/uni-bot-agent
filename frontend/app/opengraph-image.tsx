import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#050505",
          padding: "80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div
            style={{
              width: 76,
              height: 76,
              borderRadius: 16,
              background: "#fcff52",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#050505",
              fontSize: 44,
              fontWeight: 800,
            }}
          >
            A
          </div>
          <div style={{ display: "flex", fontSize: 52, fontWeight: 700, color: "#ffffff" }}>AutoRange</div>
        </div>
        <div style={{ display: "flex", marginTop: 40, fontSize: 30, color: "#a1a1aa", maxWidth: 920, lineHeight: 1.4 }}>
          Vaults no-custodiales de liquidez concentrada en Uniswap V3, gestionados por un agente keeper.
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 44,
            fontSize: 22,
            color: "#fcff52",
            letterSpacing: 4,
            textTransform: "uppercase",
          }}
        >
          Siempre en rango
        </div>
      </div>
    ),
    { ...size },
  );
}
