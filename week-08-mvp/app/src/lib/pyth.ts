"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useState } from "react";

/** Pyth sponsored feed SOL/USD (одинаковый адрес в devnet и mainnet) */
const SOL_USD_FEED = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/** Декодер PriceUpdateV2 — см. week-09-defi/src/pyth.ts (там же описан layout) */
function decode(data: Uint8Array): { price: number; conf: number; ageSec: number; full: boolean } {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8 + 32;
  const level = v.getUint8(o);
  o += level === 0 ? 2 : 1;
  o += 32; // feed_id
  const price = v.getBigInt64(o, true); o += 8;
  const conf = v.getBigUint64(o, true); o += 8;
  const expo = v.getInt32(o, true); o += 4;
  const publishTime = Number(v.getBigInt64(o, true));
  const scale = 10 ** expo;
  return {
    price: Number(price) * scale,
    conf: Number(conf) * scale,
    ageSec: Date.now() / 1000 - publishTime,
    full: level !== 0,
  };
}

/**
 * Курс SOL/USD из on-chain оракула Pyth. Возвращает null, если аккаунта нет
 * (например, локальный валидатор) или цена не прошла проверки безопасности.
 */
export function useSolUsd(refreshMs = 30_000): number | null {
  const { connection } = useConnection();
  const [usd, setUsd] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const acc = await connection.getAccountInfo(SOL_USD_FEED);
        if (!acc || !acc.owner.equals(PYTH_RECEIVER)) return alive && setUsd(null);
        const p = decode(acc.data);
        const ok = p.full && p.ageSec < 600 && p.conf / p.price < 0.02;
        if (alive) setUsd(ok ? p.price : null);
      } catch {
        if (alive) setUsd(null);
      }
    };
    load();
    const t = setInterval(load, refreshMs);
    return () => { alive = false; clearInterval(t); };
  }, [connection, refreshMs]);

  return usd;
}
