import { ImageResponse } from "next/og";
import { readFileSync } from "fs";
import { join } from "path";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const logoDataUri = `data:image/png;base64,${readFileSync(
  join(process.cwd(), "public/brand/logo-mark-256.png"),
).toString("base64")}`;

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
          <img src={logoDataUri} width={76} height={76} alt="" style={{ borderRadius: "50%" }} />
          <div style={{ display: "flex", fontSize: 52, fontWeight: 700, color: "#ffffff" }}>AI Agent</div>
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
