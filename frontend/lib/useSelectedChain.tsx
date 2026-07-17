"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CHAINS, DEFAULT_CHAIN_ID, getChain, deployedChains, type ChainDef } from "./chains";

const STORAGE_KEY = "uniagent:selectedChain";

interface SelectedChainContextValue {
  selectedChainId: number;
  selectedChain: ChainDef;
  setSelectedChainId: (id: number) => void;
}

const SelectedChainContext = createContext<SelectedChainContextValue | undefined>(undefined);

/**
 * The chain the user is BROWSING — deliberately independent of the wallet's
 * connected chain (confirmed with the user 2026-07-17: they want to look at
 * Arbitrum vaults/pools without having to switch their wallet's network
 * first, and only switch at the moment of actually signing something — see
 * the write-flow guard in each write handler). Persisted to localStorage so
 * it survives reloads; defaults to Celo for first-time and disconnected
 * visitors, same as before this existed.
 */
export function SelectedChainProvider({ children }: { children: ReactNode }) {
  const [selectedChainId, setSelectedChainIdState] = useState<number>(DEFAULT_CHAIN_ID);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const id = stored ? Number(stored) : DEFAULT_CHAIN_ID;
    // Guard against a stale chain id from a previous session that's no
    // longer deployed (e.g. Arbitrum's factoryAddress got unset again).
    setSelectedChainIdState(CHAINS[id] ? id : DEFAULT_CHAIN_ID);
  }, []);

  function setSelectedChainId(id: number) {
    setSelectedChainIdState(id);
    window.localStorage.setItem(STORAGE_KEY, String(id));
  }

  return (
    <SelectedChainContext.Provider
      value={{ selectedChainId, selectedChain: getChain(selectedChainId), setSelectedChainId }}
    >
      {children}
    </SelectedChainContext.Provider>
  );
}

export function useSelectedChain(): SelectedChainContextValue {
  const ctx = useContext(SelectedChainContext);
  if (!ctx) throw new Error("useSelectedChain must be used within a SelectedChainProvider");
  return ctx;
}

/** Chains available to pick in the selector UI — only ones actually deployed. */
export function useAvailableChains(): ChainDef[] {
  return deployedChains();
}
