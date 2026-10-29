"use client";

import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useMemo } from "react";
import idl from "@/idl/roofic_mvp.json";
import type { RooficMvp } from "@/idl/roofic_mvp";

export const PROGRAM_ID = new PublicKey(idl.address);

export function useProgram(): Program<RooficMvp> | null {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  return useMemo(() => {
    if (!wallet) return null;
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    return new Program<RooficMvp>(idl as RooficMvp, provider);
  }, [connection, wallet]);
}

/** Read-only программа (без кошелька) — для списка объектов */
export function useReadonlyProgram(): Program<RooficMvp> {
  const { connection } = useConnection();
  return useMemo(() => new Program<RooficMvp>(idl as RooficMvp, { connection }), [connection]);
}

export const propertyPda = (authority: PublicKey, id: BN) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("property"), authority.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  )[0];

export const positionPda = (property: PublicKey, investor: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), property.toBuffer(), investor.toBuffer()], PROGRAM_ID)[0];

export const ACC_SCALE = new BN("1000000000000");

/** Клиентский расчёт доступного к выводу дохода (та же формула, что on-chain) */
export function pendingRent(shares: BN, acc: BN, rewardDebt: BN, unclaimed: BN): BN {
  return shares.mul(acc).div(ACC_SCALE).sub(rewardDebt).add(unclaimed);
}

export const LAMPORTS = 1_000_000_000;
export const sol = (lamports: BN | number) =>
  (Number(lamports.toString()) / LAMPORTS).toLocaleString("en-US", { maximumFractionDigits: 4 });

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
