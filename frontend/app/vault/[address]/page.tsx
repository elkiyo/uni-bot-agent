import { VaultDetail } from "./VaultDetail";

// Next.js 16: `params` is async-only now (see node_modules/next/dist/docs
// .../18-upgrading.md "Async Request APIs") — this page stays a thin server
// wrapper that awaits it and hands a plain string down to the client component,
// which is where all the wagmi/viem hooks actually live.
export default async function VaultPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <VaultDetail address={address as `0x${string}`} />;
}
