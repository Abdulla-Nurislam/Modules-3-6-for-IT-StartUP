// ============================================================================
// Живые данные по доходности DeFi-источников для казны Roofic
//   • Marinade (mSOL)  — ликвидный стейкинг SOL
//   • Jito (JitoSOL)   — ликвидный стейкинг + MEV
//   • Kamino           — рынок кредитования (supply APY по резервам)
//   • Jupiter Price    — цены для расчёта TVL
// Всё — публичные read-only API.
// ============================================================================

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function main() {
  console.log("━━━ Источники дохода для казны Roofic (live) ━━━\n");

  // --- Marinade ---
  try {
    const m = await getJson<{ value: number }>("https://api.marinade.finance/msol/apy/30d");
    console.log(`Marinade mSOL   30d APY: ${(m.value * 100).toFixed(2)}%`);
  } catch (e) { console.log("Marinade        ⚠️ ", (e as Error).message); }

  // --- Jito ---
  try {
    const j = await getJson<{ apy: { data: number }[] }>("https://kobe.mainnet.jito.network/api/v1/stake_pool_stats");
    const last = j.apy?.at(-1)?.data;
    if (last !== undefined) console.log(`Jito JitoSOL    APY: ${(last * 100).toFixed(2)}%`);
  } catch (e) { console.log("Jito            ⚠️ ", (e as Error).message); }

  // --- Kamino main market: stablecoin supply APY ---
  try {
    const MAIN = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
    const reserves = await getJson<{ liquidityToken: string; supplyApy: string; totalSupplyUsd: string; maxLtv: string }[]>(
      `https://api.kamino.finance/kamino-market/${MAIN}/reserves/metrics`,
    );
    const stables = reserves
      .filter((r) => ["USDC", "USDT", "PYUSD", "USDS"].includes(r.liquidityToken))
      .sort((a, b) => Number(b.totalSupplyUsd) - Number(a.totalSupplyUsd));
    console.log("\nKamino lending (main market) — стейблкоины:");
    for (const r of stables.slice(0, 4)) {
      const tvl = Number(r.totalSupplyUsd);
      console.log(`   ${r.liquidityToken.padEnd(6)} supply APY ${(Number(r.supplyApy) * 100).toFixed(2).padStart(6)}%   TVL $${(tvl / 1e6).toFixed(1)}M   LTV ${r.maxLtv}`);
    }
  } catch (e) { console.log("Kamino          ⚠️ ", (e as Error).message); }

  // --- Jupiter Price API ---
  try {
    const ids = "So11111111111111111111111111111111111111112,JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const p = await getJson<Record<string, { usdPrice: number }>>(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
    console.log("\nЦены (Jupiter Price API):");
    for (const [mint, v] of Object.entries(p)) console.log(`   ${mint.slice(0, 6)}…  $${v.usdPrice.toFixed(4)}`);
  } catch (e) { console.log("Jupiter price   ⚠️ ", (e as Error).message); }

  console.log(`
Применение в Roofic:
  арендный доход в USDC, который ещё не востребован держателями, можно размещать
  в Kamino (supply) → дополнительный доход в пользу держателей; ликвидность
  остаётся доступной для claim. Это одна из функций будущей Treasury-программы.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
