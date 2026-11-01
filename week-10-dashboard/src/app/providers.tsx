"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NETWORKS, type NetworkId } from "@/lib/rpc";
import "@solana/wallet-adapter-react-ui/styles.css";

interface NetworkCtx {
  network: NetworkId;
  setNetwork: (n: NetworkId) => void;
}

const NetworkContext = createContext<NetworkCtx>({ network: "devnet", setNetwork: () => {} });
export const useNetwork = () => useContext(NetworkContext);

const STORAGE_KEY = "roofic-dashboard:network";

let nextAvailableSlot = 0;
const MIN_GAP_MS = 160;

async function rpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const now = Date.now();
  const waitMs = Math.max(0, nextAvailableSlot - now);
  nextAvailableSlot = Math.max(now, nextAvailableSlot) + MIN_GAP_MS;
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const delays = [1500, 3000, 5000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= delays.length) {
      return res;
    }
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const [network, setNetworkState] = useState<NetworkId>("devnet");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in NETWORKS) setNetworkState(saved as NetworkId);
  }, []);

  const setNetwork = (n: NetworkId) => {
    setNetworkState(n);
    localStorage.setItem(STORAGE_KEY, n);
  };

  const wallets = useMemo(() => [], []);
  const ctx = useMemo(() => ({ network, setNetwork }), [network]);
  const config = useMemo(() => ({ commitment: "confirmed" as const, fetch: rpcFetch }), []);

  return (
    <NetworkContext.Provider value={ctx}>
      <ConnectionProvider endpoint={NETWORKS[network].url} config={config}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </NetworkContext.Provider>
  );
}
