// Minimal hand-rolled EIP-4361 (Sign-In with Ethereum) message builder/parser.
// Deliberately not using the `siwe` npm package: it hard-requires `ethers` at
// import time (see node_modules/siwe/dist/ethersCompat.js) purely for ECDSA
// recovery, which viem's own publicClient.verifyMessage already does (and
// additionally supports ERC-6492/EIP-1271 smart-contract wallets) — so pulling
// in a second, unused-elsewhere web3 library just to satisfy that dependency
// isn't worth it. The message format below is the same EIP-4361 shape SIWE
// produces; only the (de)serialization is local.

export interface SiweMessageFields {
  domain: string;
  address: `0x${string}`;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string; // ISO 8601
}

const STATEMENT = "Sign in to UniAgent to link this wallet to your referral activity.";

export function buildSiweMessage(f: SiweMessageFields): string {
  return `${f.domain} wants you to sign in with your Ethereum account:
${f.address}

${STATEMENT}

URI: ${f.uri}
Version: 1
Chain ID: ${f.chainId}
Nonce: ${f.nonce}
Issued At: ${f.issuedAt}`;
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function parseSiweMessage(message: string): SiweMessageFields | null {
  const lines = message.split("\n");
  const domain = lines[0]?.replace(/ wants you to sign in with your Ethereum account:$/, "").trim();
  const address = lines[1]?.trim();
  const uri = lines.find((l) => l.startsWith("URI: "))?.slice(5).trim();
  const chainIdStr = lines.find((l) => l.startsWith("Chain ID: "))?.slice(10).trim();
  const nonce = lines.find((l) => l.startsWith("Nonce: "))?.slice(7).trim();
  const issuedAt = lines.find((l) => l.startsWith("Issued At: "))?.slice(11).trim();
  if (!domain || !address || !uri || !chainIdStr || !nonce || !issuedAt) return null;
  if (!ADDRESS_RE.test(address)) return null;
  const chainId = Number(chainIdStr);
  if (!Number.isFinite(chainId)) return null;
  return { domain, address: address as `0x${string}`, uri, chainId, nonce, issuedAt };
}
