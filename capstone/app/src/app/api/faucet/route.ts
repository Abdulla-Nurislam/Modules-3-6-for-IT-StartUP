import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, clusterApiUrl } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import idl from "@/idl/roofic.json";
import type { Roofic } from "@/idl/roofic";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? clusterApiUrl("devnet");
const PROGRAM_ID = new PublicKey(idl.address);

/** Hard ceiling per faucet request to prevent unlimited minting */
const MAX_FAUCET_USDC = 5_000;
/** Sliding-window rate limit (requests per 60 seconds per wallet / IP) */
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 4;
const requestLog = new Map<string, number[]>();

const configPda = (): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];

const investorPda = (wallet: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("investor"), wallet.toBuffer()], PROGRAM_ID)[0];

function isSandboxCluster(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes("mainnet")) return false;
  return lower.includes("devnet") || lower.includes("127.0.0.1") || lower.includes("localhost");
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const prev = (requestLog.get(key) ?? []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (prev.length >= MAX_REQUESTS_PER_WINDOW) {
    requestLog.set(key, prev);
    return false;
  }
  prev.push(now);
  requestLog.set(key, prev);
  return true;
}

/**
 * Supports role-separated keys in staging/production (`KYC_APPROVER_KEYPAIR_PATH` vs
 * `FAUCET_KEYPAIR_PATH`), falling back to `ADMIN_KEYPAIR_PATH` / `~/.config/solana/id.json`
 * only on localnet/devnet sandbox clusters.
 */
function loadRoleKeypair(roleEnvVar: "KYC_APPROVER_KEYPAIR_PATH" | "FAUCET_KEYPAIR_PATH"): Keypair {
  const fallback = process.env.ADMIN_KEYPAIR_PATH ?? `${homedir()}/.config/solana/id.json`;
  const keypairPath = process.env[roleEnvVar] ?? fallback;
  const raw = JSON.parse(readFileSync(/*turbopackIgnore: true*/ keypairPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * POST /api/faucet
 * Sandbox-only (Devnet / Localnet) demo helper with rate limiting and amount caps:
 *  - `{ action: "mint_usdc", wallet: "<pubkey>", amount?: 1000 }` (capped at 5,000 USDC)
 *  - `{ action: "kyc_approve", wallet: "<pubkey>" }`
 */
export async function POST(req: Request) {
  try {
    if (process.env.ENABLE_DEVNET_FAUCET === "false" || !isSandboxCluster(RPC_URL)) {
      return NextResponse.json(
        { error: "Faucet and demo self-KYC are disabled outside Devnet/Localnet sandbox" },
        { status: 403 },
      );
    }

    const body = (await req.json()) as {
      action: "mint_usdc" | "kyc_approve";
      wallet: string;
      amount?: number;
    };
    const targetWallet = new PublicKey(body.wallet);
    const clientIp = req.headers.get("x-forwarded-for") ?? "local";
    if (!checkRateLimit(`${clientIp}:${targetWallet.toBase58()}:${body.action}`)) {
      return NextResponse.json(
        { error: "Rate limit exceeded (max 4 requests per minute). Please wait before retrying." },
        { status: 429 },
      );
    }

    const connection = new Connection(RPC_URL, "confirmed");

    if (body.action === "kyc_approve") {
      const kycApprover = loadRoleKeypair("KYC_APPROVER_KEYPAIR_PATH");
      const provider = new AnchorProvider(connection, new Wallet(kycApprover), { commitment: "confirmed" });
      const program = new Program<Roofic>(idl as unknown as Roofic, provider);
      const recordPda = investorPda(targetWallet);
      const existing = await connection.getAccountInfo(recordPda);
      if (existing) {
        return NextResponse.json({ ok: true, alreadyApproved: true, pda: recordPda.toBase58() });
      }
      const sig = await program.methods
        .approveInvestor()
        .accountsPartial({
          config: configPda(),
          investorRecord: recordPda,
          wallet: targetWallet,
          admin: kycApprover.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return NextResponse.json({ ok: true, sig });
    }

    if (body.action === "mint_usdc") {
      const humanAmount = body.amount ?? 1_000;
      if (!Number.isFinite(humanAmount) || humanAmount <= 0 || humanAmount > MAX_FAUCET_USDC) {
        return NextResponse.json(
          { error: `Invalid faucet amount: must be between 1 and ${MAX_FAUCET_USDC} USDC` },
          { status: 400 },
        );
      }

      const faucetSigner = loadRoleKeypair("FAUCET_KEYPAIR_PATH");
      const provider = new AnchorProvider(connection, new Wallet(faucetSigner), { commitment: "confirmed" });
      const program = new Program<Roofic>(idl as unknown as Roofic, provider);
      const cfg = await program.account.platformConfig.fetch(configPda());

      const paymentMint = cfg.paymentMint;
      const mintAcct = await connection.getAccountInfo(paymentMint);
      if (!mintAcct) throw new Error("Payment mint account not found on cluster");
      const tokenProg = mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;
      const mintInfo = await getMint(connection, paymentMint, "confirmed", tokenProg);
      const ata = getAssociatedTokenAddressSync(paymentMint, targetWallet, false, tokenProg);
      const rawAmount = BigInt(Math.round(humanAmount * 10 ** mintInfo.decimals));

      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          faucetSigner.publicKey,
          ata,
          targetWallet,
          paymentMint,
          tokenProg,
        ),
        createMintToCheckedInstruction(
          paymentMint,
          ata,
          faucetSigner.publicKey,
          rawAmount,
          mintInfo.decimals,
          [],
          tokenProg,
        ),
      );
      const sig = await provider.sendAndConfirm(tx);
      return NextResponse.json({ ok: true, sig, ata: ata.toBase58(), amount: humanAmount });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
