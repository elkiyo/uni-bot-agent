import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      // @walletconnect/core's own relay transport only re-opens itself on
      // return-to-foreground (checks document.visibilityState before
      // retrying a dropped connection) in its UMD build — confirmed absent
      // from both the ESM and CJS builds, across every published version up
      // to the current latest (2.23.10), which is what Turbopack/webpack
      // resolve by default via the package's "module"/"main" fields. That
      // gap is the mechanism behind WalletConnect sessions silently dying
      // when the mobile browser tab backgrounds during wallet approval and
      // never recovering. The UMD build sets the __esModule interop marker
      // and assigns every named export onto the same object, so it should
      // be a safe drop-in for bundlers expecting ESM-style named imports.
      "@walletconnect/core": "@walletconnect/core/dist/index.umd.js",
    },
  },
};

export default nextConfig;
