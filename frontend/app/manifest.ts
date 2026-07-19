import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AutoRange — AI Agent",
    short_name: "AutoRange",
    description:
      "Vaults no-custodiales de liquidez concentrada en Uniswap V3, gestionados por un agente keeper.",
    start_url: "/",
    display: "standalone",
    background_color: "#050505",
    theme_color: "#050505",
    icons: [
      { src: "/brand/logo-mark-128.png", sizes: "128x128", type: "image/png" },
      { src: "/brand/logo-mark-180.png", sizes: "180x180", type: "image/png" },
      { src: "/brand/logo-mark-256.png", sizes: "256x256", type: "image/png" },
      { src: "/brand/logo-mark-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
