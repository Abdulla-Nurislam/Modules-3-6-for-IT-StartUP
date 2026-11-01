// ============================================================================
// Слой доступа к данным: чистые RPC-функции без React
//   • баланс и токены (SPL Token + Token-2022 с on-chain metadata)
//   • история транзакций с разбором программ и изменения баланса
//   • активность программ: объём, доля ошибок, распределение по времени
//   • состояние кластера: TPS, slot, epoch, версия
// ============================================================================
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  type ParsedAccountData,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

export type NetworkId = "devnet" | "mainnet" | "localnet";

export const NETWORKS: Record<NetworkId, { label: string; url: string; explorer: string }> = {
  devnet: { label: "Devnet", url: "https://api.devnet.solana.com", explorer: "?cluster=devnet" },
  mainnet: { label: "Mainnet", url: "https://api.mainnet-beta.solana.com", explorer: "" },
  localnet: {
    label: "Localnet",
    url: "http://127.0.0.1:8899",
    explorer: `?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`,
  },
};

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Человекочитаемые названия известных программ */
export const PROGRAM_LABELS: Record<string, string> = {
  "11111111111111111111111111111111": "System",
  [TOKEN_PROGRAM]: "SPL Token",
  [TOKEN_2022_PROGRAM]: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  "4qSqEcJ7KhcFsLnURE6dHuQ8KSRkkEX56oFYiRk8zKKf": "Roofic MVP",
  DJuq8q9WhsLAbji7AbTS48tvLasnj3EoxECHsgyrQFdt: "Roofic Shares",
  "8XJaa7FSPhVBXX6SW6kxRCGNZBLt565VWHxKiSFZ7cT4": "Roofic Portfolio",
  EvLmbfYUs5m5YHWm4QWCeQfy63df4BBiaBiZw8Rf12mo: "Roofic Capstone",
  rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ: "Pyth Receiver",
  Vote111111111111111111111111111111111111111: "Vote",
};

export const DEFAULT_WATCHED: Record<NetworkId, string[]> = {
  devnet: ["4qSqEcJ7KhcFsLnURE6dHuQ8KSRkkEX56oFYiRk8zKKf", TOKEN_2022_PROGRAM, "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"],
  mainnet: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", TOKEN_2022_PROGRAM, "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"],
  localnet: ["4qSqEcJ7KhcFsLnURE6dHuQ8KSRkkEX56oFYiRk8zKKf", TOKEN_2022_PROGRAM, TOKEN_PROGRAM],
};

/** Известные mainnet-токены: у обычных SPL-токенов metadata хранится в Metaplex, а не в mint */
const KNOWN_MINTS: Record<string, { symbol: string; name: string }> = {
  So11111111111111111111111111111111111111112: { symbol: "wSOL", name: "Wrapped SOL" },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD" },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: "mSOL", name: "Marinade staked SOL" },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: "JitoSOL", name: "Jito Staked SOL" },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter" },
};

export const short = (s: string, n = 4) => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

export const programLabel = (id: string) => PROGRAM_LABELS[id] ?? short(id);

// ---------------------------------------------------------------------------
// Баланс и токены
// ---------------------------------------------------------------------------
export interface TokenHolding {
  mint: string;
  account: string;
  amount: number;
  decimals: number;
  program: "SPL Token" | "Token-2022";
  symbol: string;
  name: string;
  uri?: string;
  extensions: string[];
  supply?: number;
}

export async function fetchSolBalance(conn: Connection, owner: PublicKey): Promise<number> {
  return (await conn.getBalance(owner, "confirmed")) / LAMPORTS_PER_SOL;
}

interface ParsedMintInfo {
  supply: string;
  decimals: number;
  extensions?: { extension: string; state: Record<string, unknown> }[];
}

/** Лимит RPC `getMultipleAccounts`: не более 100 адресов за запрос */
export const MAX_MULTIPLE_ACCOUNTS = 100;

/** Загружает parsed-данные mint-ов пачками по 100 штук (с дедупликацией) → Map<mint, data> */
export async function fetchParsedMints(conn: Connection, mints: string[]): Promise<Map<string, ParsedAccountData | Buffer | undefined>> {
  const unique = [...new Set(mints)];
  const out = new Map<string, ParsedAccountData | Buffer | undefined>();
  for (let i = 0; i < unique.length; i += MAX_MULTIPLE_ACCOUNTS) {
    const chunk = unique.slice(i, i + MAX_MULTIPLE_ACCOUNTS);
    const res = await conn.getMultipleParsedAccounts(
      chunk.map((m) => new PublicKey(m)),
      { commitment: "confirmed" },
    );
    chunk.forEach((m, j) => out.set(m, res.value[j]?.data));
  }
  return out;
}

export async function fetchTokens(conn: Connection, owner: PublicKey): Promise<TokenHolding[]> {
  const programs = [
    { id: new PublicKey(TOKEN_PROGRAM), name: "SPL Token" as const },
    { id: new PublicKey(TOKEN_2022_PROGRAM), name: "Token-2022" as const },
  ];

  const accounts = (
    await Promise.all(
      programs.map(async (p) => {
        const res = await conn.getParsedTokenAccountsByOwner(owner, { programId: p.id }, "confirmed");
        return res.value.map((v) => ({ v, program: p.name }));
      }),
    )
  ).flat();

  if (accounts.length === 0) return [];

  // Данные mint нужны для metadata (Token-2022) и supply.
  // getMultipleAccounts принимает максимум 100 адресов, поэтому mint-ы дедуплицируются и режутся на пачки.
  const mintAccounts = await fetchParsedMints(conn, accounts.map(({ v }) => v.account.data.parsed.info.mint as string));

  return accounts
    .map(({ v, program }): TokenHolding => {
      const info = v.account.data.parsed.info;
      const mint = info.mint as string;
      const parsedMint = mintAccounts.get(mint);
      const mintInfo =
        parsedMint && "parsed" in parsedMint ? (parsedMint.parsed.info as ParsedMintInfo) : undefined;

      const exts = mintInfo?.extensions ?? [];
      const meta = exts.find((e) => e.extension === "tokenMetadata")?.state as
        | { name?: string; symbol?: string; uri?: string }
        | undefined;
      const known = KNOWN_MINTS[mint];

      return {
        mint,
        account: v.pubkey.toBase58(),
        amount: Number(info.tokenAmount.uiAmountString ?? info.tokenAmount.uiAmount ?? 0),
        decimals: info.tokenAmount.decimals as number,
        program,
        symbol: meta?.symbol ?? known?.symbol ?? short(mint, 3),
        name: meta?.name ?? known?.name ?? "Unknown token",
        uri: meta?.uri,
        extensions: exts.map((e) => e.extension).filter((e) => e !== "tokenMetadata" && e !== "metadataPointer"),
        supply: mintInfo ? Number(mintInfo.supply) / 10 ** mintInfo.decimals : undefined,
      };
    })
    .sort((a, b) => b.amount - a.amount);
}

// ---------------------------------------------------------------------------
// Транзакции аккаунта
// ---------------------------------------------------------------------------
export interface TxRow {
  signature: string;
  slot: number;
  time: number | null;
  ok: boolean;
  error?: string;
  feeSol: number;
  solChange: number;
  programs: string[];
  summary: string;
}

function summarize(tx: ParsedTransactionWithMeta): { programs: string[]; summary: string } {
  const programs = new Set<string>();
  const kinds: string[] = [];
  for (const ix of tx.transaction.message.instructions) {
    const pid = ix.programId.toBase58();
    if (pid === "ComputeBudget111111111111111111111111111111") continue;
    programs.add(pid);
    if ("parsed" in ix && ix.parsed && typeof ix.parsed === "object" && "type" in ix.parsed) {
      kinds.push(String(ix.parsed.type));
    }
  }
  const label = [...programs].map(programLabel);
  const summary = kinds.length ? [...new Set(kinds)].slice(0, 3).join(", ") : label[0] ? `call ${label[0]}` : "—";
  return { programs: [...programs], summary };
}

export async function fetchTransactions(conn: Connection, owner: PublicKey, limit = 12): Promise<TxRow[]> {
  const sigs = await conn.getSignaturesForAddress(owner, { limit }, "confirmed");
  if (sigs.length === 0) return [];

  const txs = await conn.getParsedTransactions(
    sigs.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  );

  return sigs.map((s, i): TxRow => {
    const tx = txs[i];
    if (!tx?.meta) {
      return { signature: s.signature, slot: s.slot, time: s.blockTime ?? null, ok: !s.err, feeSol: 0, solChange: 0, programs: [], summary: "—" };
    }
    const keys = tx.transaction.message.accountKeys;
    const idx = keys.findIndex((k) => k.pubkey.equals(owner));
    const delta = idx >= 0 ? tx.meta.postBalances[idx] - tx.meta.preBalances[idx] : 0;
    const { programs, summary } = summarize(tx);
    return {
      signature: s.signature,
      slot: s.slot,
      time: s.blockTime ?? tx.blockTime ?? null,
      ok: !tx.meta.err,
      error: tx.meta.err ? JSON.stringify(tx.meta.err) : undefined,
      feeSol: tx.meta.fee / LAMPORTS_PER_SOL,
      solChange: delta / LAMPORTS_PER_SOL,
      programs,
      summary,
    };
  });
}

// ---------------------------------------------------------------------------
// Активность программы
// ---------------------------------------------------------------------------
export interface ProgramActivity {
  programId: string;
  label: string;
  total: number;
  failed: number;
  firstTime: number | null;
  lastTime: number | null;
  /** количество транзакций в равных временных корзинах от старой к новой */
  buckets: number[];
  recent: { signature: string; ok: boolean; time: number | null }[];
}

export async function fetchProgramActivity(
  conn: Connection,
  programId: string,
  limit = 100,
  bucketCount = 24,
): Promise<ProgramActivity> {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(programId), { limit }, "confirmed");
  const times = sigs.map((s) => s.blockTime).filter((t): t is number => t != null);
  const first = times.length ? Math.min(...times) : null;
  const last = times.length ? Math.max(...times) : null;

  const buckets = new Array<number>(bucketCount).fill(0);
  if (first != null && last != null) {
    const span = Math.max(last - first, 1);
    for (const t of times) {
      buckets[Math.min(bucketCount - 1, Math.floor(((t - first) / span) * bucketCount))]++;
    }
  }

  return {
    programId,
    label: programLabel(programId),
    total: sigs.length,
    failed: sigs.filter((s) => s.err).length,
    firstTime: first,
    lastTime: last,
    buckets,
    recent: sigs.slice(0, 5).map((s) => ({ signature: s.signature, ok: !s.err, time: s.blockTime ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Кластер
// ---------------------------------------------------------------------------
export interface ClusterStats {
  slot: number;
  blockHeight: number;
  epoch: number;
  epochProgress: number;
  tps: number;
  tpsSeries: number[];
  /** true if TPS excludes vote transactions (node returned numNonVoteTransactions) */
  tpsNonVote: boolean;
  version: string;
}

export async function fetchCluster(conn: Connection): Promise<ClusterStats> {
  const [epoch, perf, version] = await Promise.all([
    conn.getEpochInfo("confirmed"),
    conn.getRecentPerformanceSamples(30).catch(() => []),
    conn.getVersion().catch(() => ({ "solana-core": "—" })),
  ]);
  // web3.js types only expose numTransactions (votes included), but RPC nodes also return
  // numNonVoteTransactions, which is what people mean by "real" TPS. Use it when present.
  type Sample = (typeof perf)[number] & { numNonVoteTransactions?: number };
  const samples = perf as Sample[];
  const tpsNonVote = samples.length > 0 && samples.every((p) => typeof p.numNonVoteTransactions === "number");
  const series = samples
    .map((p) => (p.samplePeriodSecs ? (tpsNonVote ? p.numNonVoteTransactions! : p.numTransactions) / p.samplePeriodSecs : 0))
    .reverse();
  return {
    slot: epoch.absoluteSlot,
    blockHeight: epoch.blockHeight ?? 0,
    epoch: epoch.epoch,
    epochProgress: epoch.slotsInEpoch ? epoch.slotIndex / epoch.slotsInEpoch : 0,
    tps: series.at(-1) ?? 0,
    tpsSeries: series,
    tpsNonVote,
    version: version["solana-core"],
  };
}
