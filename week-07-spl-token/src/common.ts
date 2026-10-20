// ============================================================================
// Общие утилиты для скриптов недели 7
//  - подключение к кластеру (devnet по умолчанию, localnet для тестов)
//  - загрузка кошелька-плательщика из Solana CLI
//  - сохранение состояния (адрес mint, получатель) между скриптами
// ============================================================================
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Cluster = "devnet" | "localnet";

export const CLUSTER: Cluster = (process.env.CLUSTER as Cluster) ?? "devnet";
const RPC_URL =
  process.env.RPC_URL ?? (CLUSTER === "localnet" ? "http://127.0.0.1:8899" : clusterApiUrl("devnet"));

export const connection = new Connection(RPC_URL, "confirmed");

// ---------------------------------------------------------------------------
// Параметры токена ROOF
// ---------------------------------------------------------------------------
export const TOKEN = {
  name: "Roofic",
  symbol: "ROOF",
  decimals: 6,
  uri: "https://raw.githubusercontent.com/Abdulla-Nurislam/Roofic/main/week-07-spl-token/metadata/roof.json",
  /** Комиссия за перевод: 50 bps = 0.5% */
  feeBasisPoints: 50,
  /** Максимальная комиссия за один перевод: 5 000 ROOF */
  maxFee: 5_000n * 10n ** 6n,
  additionalMetadata: [
    ["project", "Roofic"],
    ["category", "RWA platform utility token"],
    ["course_week", "7"],
  ] as [string, string][],
};

/** Перевод "человеческих" единиц в base units (учитывая decimals) */
export const toBaseUnits = (amount: number | bigint): bigint =>
  BigInt(amount) * 10n ** BigInt(TOKEN.decimals);

export const fromBaseUnits = (amount: bigint): string => {
  const d = 10n ** BigInt(TOKEN.decimals);
  const frac = (amount % d).toString().padStart(TOKEN.decimals, "0").replace(/0+$/, "");
  return `${amount / d}${frac ? "." + frac : ""}`;
};

// ---------------------------------------------------------------------------
// Кошелёк
// ---------------------------------------------------------------------------
export function loadKeypair(path = process.env.KEYPAIR ?? join(homedir(), ".config/solana/id.json")): Keypair {
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export const payer = loadKeypair();

// ---------------------------------------------------------------------------
// Состояние между запусками скриптов: .state/<cluster>.json
// ---------------------------------------------------------------------------
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(ROOT, ".state", `${CLUSTER}.json`);

interface State {
  mint?: string;
  recipientSecret?: number[];
  signatures?: Record<string, string>;
}

export function readState(): State {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as State) : {};
}

export function writeState(patch: Partial<State>): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
}

export function recordSignature(step: string, signature: string): void {
  const state = readState();
  writeState({ signatures: { ...state.signatures, [step]: signature } });
  console.log(`   🔗 ${explorer("tx", signature)}`);
}

export function requireMint(): PublicKey {
  const { mint } = readState();
  if (!mint) throw new Error("Mint не найден. Сначала запустите: npm run create");
  return new PublicKey(mint);
}

/** Получатель для демонстрации transfer — создаётся один раз и сохраняется */
export function getRecipient(): Keypair {
  const state = readState();
  if (state.recipientSecret) return Keypair.fromSecretKey(Uint8Array.from(state.recipientSecret));
  const kp = Keypair.generate();
  writeState({ recipientSecret: Array.from(kp.secretKey) });
  return kp;
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------
export function explorer(kind: "tx" | "address", value: string): string {
  const cluster =
    CLUSTER === "localnet"
      ? `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`
      : "?cluster=devnet";
  return `https://explorer.solana.com/${kind}/${value}${cluster}`;
}

export function header(title: string): void {
  console.log(`\n━━━ ${title} ━━━  [${CLUSTER}]`);
}

/** Запускает функцию, если файл вызван напрямую (а не импортирован demo.ts) */
export function runIfMain(metaUrl: string, fn: () => Promise<unknown>): void {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl)) {
    fn().catch((err) => {
      console.error("❌", err);
      process.exit(1);
    });
  }
}
