"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useState } from "react";

/** Pyth Receiver program and sponsored PriceUpdateV2 feeds (Devnet & Mainnet) */
export const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const SOL_USD_FEED = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
export const USDC_USD_FEED = new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX");

export interface PythFeedSnapshot {
  pair: "SOL/USD" | "USDC/USD";
  address: string;
  price: number;
  conf: number;
  conservativePrice: number; // price - conf
  emaPrice: number;
  ageSec: number;
  verifiedFull: boolean;
  healthy: boolean;
}

export interface JupiterQuoteSummary {
  inSol: number;
  outUsdc: number;
  minOutUsdc: number;
  priceImpactPct: number;
  routeLabel: string;
}

export interface DeFiTelemetry {
  solUsd: PythFeedSnapshot | null;
  usdcUsd: PythFeedSnapshot | null;
  jupiterQuote: JupiterQuoteSummary | null;
  kaminoUsdcSupplyApyPct: number;
}

/**
 * Decodes a Pyth `PriceUpdateV2` account and enforces the 5 oracle safety checks
 * from Week 9 (`owner == Pyth Receiver`, `VerificationLevel::Full`, `age < 600s`,
 * `conf / price < 2%`, conservative `price - conf` valuation).
 */
export function decodePriceUpdateV2(
  pair: "SOL/USD" | "USDC/USD",
  address: PublicKey,
  owner: PublicKey,
  data: Uint8Array,
): PythFeedSnapshot | null {
  if (!owner.equals(PYTH_RECEIVER) || data.byteLength < 110) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8 + 32; // 8-byte Anchor discriminator + 32-byte write_authority
  const level = v.getUint8(o);
  o += level === 0 ? 2 : 1; // Partial(u8) takes 2 bytes; Full takes 1 byte
  o += 32; // feed_id [u8; 32]

  const rawPrice = v.getBigInt64(o, true);
  o += 8;
  const rawConf = v.getBigUint64(o, true);
  o += 8;
  const expo = v.getInt32(o, true);
  o += 4;
  const publishTime = Number(v.getBigInt64(o, true));
  o += 8;
  o += 8; // prev_publish_time
  const rawEma = v.getBigInt64(o, true);

  const scale = 10 ** expo;
  const price = Number(rawPrice) * scale;
  const conf = Number(rawConf) * scale;
  const emaPrice = Number(rawEma) * scale;
  const ageSec = Math.max(0, Math.round(Date.now() / 1000 - publishTime));
  const verifiedFull = level !== 0;
  const healthy = verifiedFull && price > 0 && ageSec < 600 && conf / price < 0.02;

  return {
    pair,
    address: address.toBase58(),
    price,
    conf,
    conservativePrice: Math.max(0, price - conf),
    emaPrice,
    ageSec,
    verifiedFull,
    healthy,
  };
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function useDeFiTelemetry(refreshMs = 30_000): DeFiTelemetry {
  const { connection } = useConnection();
  const [state, setState] = useState<DeFiTelemetry>({
    solUsd: null,
    usdcUsd: null,
    jupiterQuote: null,
    kaminoUsdcSupplyApyPct: 4.85,
  });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const infos = await connection.getMultipleAccountsInfo([SOL_USD_FEED, USDC_USD_FEED]);
        const solUsd =
          infos[0] ? decodePriceUpdateV2("SOL/USD", SOL_USD_FEED, infos[0].owner, infos[0].data) : null;
        const usdcUsd =
          infos[1] ? decodePriceUpdateV2("USDC/USD", USDC_USD_FEED, infos[1].owner, infos[1].data) : null;

        let jupiterQuote: JupiterQuoteSummary | null = null;
        try {
          const res = await fetch(
            `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&slippageBps=50`,
          );
          if (res.ok) {
            const q = (await res.json()) as {
              outAmount: string;
              otherAmountThreshold: string;
              priceImpactPct: string;
              routePlan?: Array<{ swapInfo?: { label?: string } }>;
            };
            const labels = (q.routePlan ?? [])
              .map((r) => r.swapInfo?.label)
              .filter(Boolean)
              .join(" → ");
            jupiterQuote = {
              inSol: 1,
              outUsdc: Number(q.outAmount) / 1e6,
              minOutUsdc: Number(q.otherAmountThreshold) / 1e6,
              priceImpactPct: Number(q.priceImpactPct) * 100,
              routeLabel: labels || "Jupiter v6 Aggregator",
            };
          }
        } catch {
          // Offline / rate-limited fallback: derive indicative quote from Pyth oracle
          if (solUsd) {
            jupiterQuote = {
              inSol: 1,
              outUsdc: solUsd.price,
              minOutUsdc: solUsd.conservativePrice * 0.995,
              priceImpactPct: 0.01,
              routeLabel: "Pyth Oracle Indicative",
            };
          }
        }

        if (alive) {
          setState({
            solUsd,
            usdcUsd,
            jupiterQuote,
            kaminoUsdcSupplyApyPct: 4.85,
          });
        }
      } catch {
        // Ignore transient RPC errors on localnet
      }
    };
    load();
    const timer = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [connection, refreshMs]);

  return state;
}

