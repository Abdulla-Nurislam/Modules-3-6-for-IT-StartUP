"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import { useMemo, type ReactNode } from "react";
import "@solana/wallet-adapter-react-ui/styles.css";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? clusterApiUrl("devnet");

let nextAvailableSlot = 0;
const MIN_GAP_MS = 140;

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
  // Phantom / Solflare / Backpack auto-discovered via Wallet Standard
  const wallets = useMemo(() => [], []);
  const config = useMemo(() => ({ commitment: "confirmed" as const, fetch: rpcFetch }), []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={config}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
