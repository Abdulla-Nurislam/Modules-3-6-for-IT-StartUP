"use client";

import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useMemo } from "react";
import idl from "@/idl/roofic.json";
import type { Roofic } from "@/idl/roofic";

export const PROGRAM_ID = new PublicKey(idl.address);
export const SHARE_TOKEN_PROGRAM_ID = TOKEN_2022_PROGRAM_ID;
export { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID };

export function useProgram(): Program<Roofic> | null {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  return useMemo(() => {
    if (!wallet) return null;
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    return new Program<Roofic>(idl as unknown as Roofic, provider);
  }, [connection, wallet]);
}

/** Read-only Program instance (works without a connected wallet) */
export function useReadonlyProgram(): Program<Roofic> {
  const { connection } = useConnection();
  return useMemo(() => new Program<Roofic>(idl as unknown as Roofic, { connection }), [connection]);
}

// ============================================================================
// PDA Derivations (matching `capstone/programs/roofic/src/lib.rs`)
// ============================================================================

export const configPda = (): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];

export const investorPda = (wallet: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("investor"), wallet.toBuffer()], PROGRAM_ID)[0];

export const propertyPda = (owner: PublicKey, id: BN): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("property"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  )[0];

export const shareMintPda = (property: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("share_mint"), property.toBuffer()], PROGRAM_ID)[0];

export const vaultPda = (property: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), property.toBuffer()], PROGRAM_ID)[0];

export const positionPda = (property: PublicKey, investor: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("position"), property.toBuffer(), investor.toBuffer()],
    PROGRAM_ID,
  )[0];

// ============================================================================
// Reward-per-share & Fee Math (matching `lib.rs`)
// ============================================================================

export const ACC_SCALE = new BN("1000000000000");
export const BPS = new BN(10_000);

export function pendingRent(shares: BN, acc: BN, rewardDebt: BN, unclaimed: BN): BN {
  const accrued = shares.mul(acc).div(ACC_SCALE);
  const owed = accrued.gt(rewardDebt) ? accrued.sub(rewardDebt) : new BN(0);
  return owed.add(unclaimed);
}

export function bpsOf(amount: BN, bps: number): BN {
  return amount.mul(new BN(bps)).div(BPS);
}

// ============================================================================
// Formatting & Explorer Links
// ============================================================================

export function formatToken(raw: BN | number | bigint, decimals = 6, maxFrac = 2): string {
  const n = typeof raw === "number" ? raw : Number(raw.toString());
  return (n / 10 ** decimals).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFrac,
  });
}

export function toRawUnits(humanAmount: number, decimals = 6): BN {
  return new BN(Math.round(humanAmount * 10 ** decimals));
}

export function shortKey(pk: PublicKey | string): string {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export const explorerTx = (sig: string): string =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export const explorerAddress = (addr: PublicKey | string): string =>
  `https://explorer.solana.com/address/${typeof addr === "string" ? addr : addr.toBase58()}?cluster=devnet`;

