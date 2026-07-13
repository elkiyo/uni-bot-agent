"use client";

import Link from "next/link";
import { useAccount, useReadContract } from "wagmi";
import { Header } from "./components/Header";
import { vaultFactoryAbi } from "@/lib/contracts";
import { FACTORY_ADDRESS } from "@/lib/addresses";

export default function Home() {
  const { address, isConnected } = useAccount();

  const { data: vaults, isLoading } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: vaultFactoryAbi,
    functionName: "getVaultsByOwner",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && FACTORY_ADDRESS) },
  });

  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl w-full flex-1 px-6 py-10">
        <h1 className="text-2xl font-semibold mb-2">Mis vaults</h1>
        <p className="opacity-70 mb-8 max-w-2xl">
          Cada vault es no-custodial: vos depositás y retirás, el agente de la plataforma
          solo puede rebalancear dentro de los límites que vos configurás. Ver{" "}
          <code>PLAN.md</code> en el repo para el detalle completo.
        </p>

        {!FACTORY_ADDRESS && (
          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm">
            <code>NEXT_PUBLIC_FACTORY_ADDRESS</code> no está configurado todavía — el
            deploy de los contratos está pendiente (ver PLAN.md).
          </div>
        )}

        {FACTORY_ADDRESS && !isConnected && (
          <p className="opacity-70">Conectá tu wallet para ver tus vaults.</p>
        )}

        {FACTORY_ADDRESS && isConnected && isLoading && <p className="opacity-70">Cargando...</p>}

        {FACTORY_ADDRESS && isConnected && !isLoading && (
          <>
            {(!vaults || (vaults as string[]).length === 0) && (
              <div className="rounded-lg border border-black/10 dark:border-white/10 px-4 py-6 text-center">
                <p className="opacity-70 mb-4">Todavía no tenés ningún vault.</p>
                <Link
                  href="/create"
                  className="inline-block rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium"
                >
                  Crear mi primer vault
                </Link>
              </div>
            )}

            {vaults && (vaults as string[]).length > 0 && (
              <ul className="divide-y divide-black/10 dark:divide-white/10 rounded-lg border border-black/10 dark:border-white/10">
                {(vaults as string[]).map((vaultAddress) => (
                  <li key={vaultAddress}>
                    <Link
                      href={`/vault/${vaultAddress}`}
                      className="block px-4 py-3 font-mono text-sm hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      {vaultAddress}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </>
  );
}
