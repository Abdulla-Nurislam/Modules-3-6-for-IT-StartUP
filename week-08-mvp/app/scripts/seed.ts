// ============================================================================
// Seed-скрипт для демо: 3 объекта, 2 инвестора, внесение аренды
//   CLUSTER=localnet npx tsx scripts/seed.ts   (или devnet по умолчанию)
// ============================================================================
import { AnchorProvider, BN, Program, Wallet } from "@anchor-lang/core";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, clusterApiUrl } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import idl from "../src/idl/roofic_mvp.json" with { type: "json" };
import type { RooficMvp } from "../src/idl/roofic_mvp";

const local = process.env.CLUSTER === "localnet";
const connection = new Connection(local ? "http://127.0.0.1:8899" : clusterApiUrl("devnet"), "confirmed");
const owner = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
);
const programFor = (kp: Keypair) =>
  new Program<RooficMvp>(idl as RooficMvp, new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" }));

const PID = new PublicKey(idl.address);
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PID)[0];

const LISTINGS = [
  { name: "Almaty Loft #1", location: "Almaty, Medeu district", shares: 1000, price: 0.002 },
  { name: "Astana Business Center", location: "Astana, Yesil district", shares: 5000, price: 0.001 },
  { name: "Shymkent Family House", location: "Shymkent, Al-Farabi district", shares: 500, price: 0.004 },
];

async function fund(to: PublicKey, sol: number) {
  if (local) {
    await connection.confirmTransaction(await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL));
  } else {
    const p = programFor(owner).provider as AnchorProvider;
    const { Transaction } = await import("@solana/web3.js");
    await p.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports: sol * LAMPORTS_PER_SOL })));
  }
}

async function main() {
  if (local) await fund(owner.publicKey, 10);
  const program = programFor(owner);
  const secondInvestor = Keypair.generate();
  await fund(secondInvestor.publicKey, local ? 5 : 1.4);
  const investors = [owner, secondInvestor];

  for (const [n, l] of LISTINGS.entries()) {
    const id = new BN(Date.now() + n);
    const property = pda([Buffer.from("property"), owner.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)]);
    await program.methods
      .createProperty(id, l.name, l.location, new BN(l.shares), new BN(Math.round(l.price * LAMPORTS_PER_SOL)))
      .accountsPartial({ property, authority: owner.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`🏠 ${l.name}: ${property.toBase58()}`);

    for (const [k, inv] of investors.entries()) {
      const shares = Math.floor(l.shares * (k === 0 ? 0.3 : 0.15));
      await programFor(inv).methods
        .buyShares(new BN(shares))
        .accountsPartial({
          property,
          position: pda([Buffer.from("position"), property.toBuffer(), inv.publicKey.toBuffer()]),
          investor: inv.publicKey,
          authority: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`   👤 investor${k + 1} bought ${shares}`);
    }

    const rent = new BN(Math.round(l.shares * l.price * 0.01 * LAMPORTS_PER_SOL)); // 1% стоимости объекта
    await program.methods.depositRent(rent).accountsPartial({ property, authority: owner.publicKey, systemProgram: SystemProgram.programId }).rpc();
    console.log(`   💰 rent deposited ${rent.toNumber() / LAMPORTS_PER_SOL} SOL`);
  }
  console.log("✅ seed complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
