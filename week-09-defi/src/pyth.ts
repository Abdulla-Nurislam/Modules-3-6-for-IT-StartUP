// ============================================================================
// Pyth Network — чтение цены напрямую из on-chain аккаунта (pull oracle)
//
// Pyth публикует цены в аккаунты PriceUpdateV2 (владелец — Pyth Receiver
// program rec5EKMG…). "Sponsored feeds" обновляются самим Pyth и имеют
// одинаковые адреса в mainnet и devnet — их можно читать без API-ключа.
//
// Layout PriceUpdateV2 (Borsh):
//   8   discriminator
//   32  write_authority
//   1+  verification_level  (0 = Partial{u8}, 1 = Full)
//   32  feed_id
//   8   price        i64
//   8   conf         u64
//   4   exponent     i32
//   8   publish_time i64
//   8   prev_publish_time i64
//   8   ema_price    i64
//   8   ema_conf     u64
//   8   posted_slot  u64
// ============================================================================
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/** Sponsored price feed accounts (shard 0) — одинаковы в devnet и mainnet */
export const FEEDS = {
  "SOL/USD": new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  "USDC/USD": new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
  "USDT/USD": new PublicKey("HT2PLQBcG5EiCcNSaMHAjSgd9F98ecpATbk4Sk5oYuM"),
} as const;

export interface PythPrice {
  feedId: string;
  price: number;
  conf: number;
  emaPrice: number;
  publishTime: Date;
  ageSec: number;
  verification: "Full" | "Partial";
  postedSlot: bigint;
}

export function decodePriceUpdateV2(data: Buffer): PythPrice {
  let o = 8 + 32; // discriminator + write_authority
  const level = data.readUInt8(o);
  o += level === 0 ? 2 : 1; // Partial несёт u8 num_signatures
  const feedId = data.subarray(o, o + 32).toString("hex");
  o += 32;
  const price = data.readBigInt64LE(o); o += 8;
  const conf = data.readBigUInt64LE(o); o += 8;
  const expo = data.readInt32LE(o); o += 4;
  const publishTime = Number(data.readBigInt64LE(o)); o += 8;
  o += 8; // prev_publish_time
  const ema = data.readBigInt64LE(o); o += 8;
  o += 8; // ema_conf
  const postedSlot = data.readBigUInt64LE(o);

  const scale = 10 ** expo;
  return {
    feedId: `0x${feedId}`,
    price: Number(price) * scale,
    conf: Number(conf) * scale,
    emaPrice: Number(ema) * scale,
    publishTime: new Date(publishTime * 1000),
    ageSec: Math.round(Date.now() / 1000 - publishTime),
    verification: level === 0 ? "Partial" : "Full",
    postedSlot,
  };
}

/**
 * Безопасное чтение цены: те же проверки, что делает on-chain программа
 * через pyth-solana-receiver-sdk (get_price_no_older_than).
 */
export async function getPrice(
  connection: Connection,
  feed: PublicKey,
  { maxAgeSec = 120, maxConfRatio = 0.02 } = {},
): Promise<PythPrice> {
  const acc = await connection.getAccountInfo(feed);
  if (!acc) throw new Error(`Feed ${feed.toBase58()} не найден`);
  if (!acc.owner.equals(PYTH_RECEIVER)) throw new Error("Аккаунт не принадлежит Pyth Receiver — возможна подмена оракула");
  const p = decodePriceUpdateV2(acc.data);
  if (p.verification !== "Full") throw new Error("Цена не полностью верифицирована Wormhole guardians");
  if (p.ageSec > maxAgeSec) throw new Error(`Цена устарела: ${p.ageSec}s > ${maxAgeSec}s`);
  if (p.conf / p.price > maxConfRatio) throw new Error(`Слишком широкий доверительный интервал: ±${p.conf}`);
  return p;
}

async function main() {
  const connection = new Connection(process.env.RPC_URL ?? clusterApiUrl("devnet"), "confirmed");
  console.log("━━━ Pyth price feeds (on-chain, devnet) ━━━\n");
  for (const [name, feed] of Object.entries(FEEDS)) {
    try {
      const p = await getPrice(connection, feed, { maxAgeSec: 3600 });
      console.log(`${name.padEnd(9)} $${p.price.toFixed(4).padStart(10)}  ±${p.conf.toFixed(4)}  EMA $${p.emaPrice.toFixed(4)}  age ${p.ageSec}s  [${p.verification}]`);
    } catch (e) {
      console.log(`${name.padEnd(9)} ⚠️  ${(e as Error).message}`);
    }
  }

  // Применение в Roofic: пересчёт цены доли из SOL в USD
  const sol = await getPrice(connection, FEEDS["SOL/USD"], { maxAgeSec: 3600 });
  const sharePriceSol = 0.002;
  console.log(`\nRoofic: доля за ${sharePriceSol} SOL ≈ $${(sharePriceSol * sol.price).toFixed(2)}`);
  console.log(`        консервативная оценка (price − conf): $${(sharePriceSol * (sol.price - sol.conf)).toFixed(2)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
