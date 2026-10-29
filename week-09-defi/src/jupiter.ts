// ============================================================================
// Jupiter — DEX-агрегатор: котировка и сборка swap-транзакции
//
// Jupiter существует только в mainnet, поэтому здесь мы:
//   1. получаем РЕАЛЬНУЮ котировку SOL → USDC (read-only, без подписи и без средств)
//   2. разбираем маршрут (через какие пулы пойдёт обмен)
//   3. собираем неподписанную swap-транзакцию и декодируем её инструкции
//   4. объясняем, как это встраивается в Roofic (конвертация SOL-аренды в USDC)
// Транзакция НЕ отправляется.
// ============================================================================
import { VersionedTransaction } from "@solana/web3.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.JUPITER_API ?? "https://lite-api.jup.ag";
export const MINTS = {
  SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
} as const;

interface QuoteResponse {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { percent: number; swapInfo: { label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string } }[];
  contextSlot: number;
}

export async function quote(amountLamports: bigint, slippageBps = 50): Promise<QuoteResponse> {
  const url = new URL(`${API}/swap/v1/quote`);
  url.searchParams.set("inputMint", MINTS.SOL.mint);
  url.searchParams.set("outputMint", MINTS.USDC.mint);
  url.searchParams.set("amount", amountLamports.toString());
  url.searchParams.set("slippageBps", String(slippageBps));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${await res.text()}`);
  return res.json() as Promise<QuoteResponse>;
}

async function main() {
  const amount = 1_000_000_000n; // 1 SOL
  const q = await quote(amount);
  const out = Number(q.outAmount) / 10 ** MINTS.USDC.decimals;
  const min = Number(q.otherAmountThreshold) / 10 ** MINTS.USDC.decimals;

  console.log("━━━ Jupiter quote: 1 SOL → USDC ━━━\n");
  console.log(`Получим:          ${out.toFixed(4)} USDC  (по курсу ${out.toFixed(2)} $/SOL)`);
  console.log(`Минимум (slip ${q.slippageBps / 100}%): ${min.toFixed(4)} USDC — ниже транзакция откатится`);
  console.log(`Price impact:     ${(Number(q.priceImpactPct) * 100).toFixed(5)}%`);
  console.log(`Slot котировки:   ${q.contextSlot}`);
  console.log("Маршрут:");
  for (const leg of q.routePlan) console.log(`   ${String(leg.percent).padStart(3)}%  ${leg.swapInfo.label}`);

  // Сборка swap-транзакции для произвольного (публичного) адреса — без подписи
  const user = "96J4Ff8y3ekxsXQyVGZWpSPHhwdvk4MvnJ7PXJaRRp3U";
  const res = await fetch(`${API}/swap/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: user, wrapAndUnwrapSol: true }),
  });
  if (!res.ok) throw new Error(`Jupiter swap ${res.status}: ${await res.text()}`);
  const { swapTransaction } = (await res.json()) as { swapTransaction: string };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  console.log(`\nСобрана транзакция (v0): ${msg.compiledInstructions.length} инструкций, ${keys.length} static accounts, ${msg.addressTableLookups.length} address lookup tables`);
  console.log("Инструкции:");
  for (const ix of msg.compiledInstructions) {
    const pid = keys[ix.programIdIndex]?.toBase58() ?? "(из lookup table)";
    console.log(`   ${NAMES[pid] ?? pid.slice(0, 8) + "…"}  (${ix.accountKeyIndexes.length} accounts, ${ix.data.length} bytes data)`);
  }
  console.log("\n⚠️  Транзакция не подписана и не отправлена (demo only).");
}

const NAMES: Record<string, string> = {
  ComputeBudget111111111111111111111111111111: "ComputeBudget",
  "11111111111111111111111111111111": "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6 (aggregator)",
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
