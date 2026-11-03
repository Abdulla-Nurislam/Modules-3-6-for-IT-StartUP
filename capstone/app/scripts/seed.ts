// ============================================================================
// Seed script for Capstone `roofic` program (`EvLmbfYUs5m5YHWm4QWCeQfy63df4BBiaBiZw8Rf12mo`)
//   1. Creates a 6-decimal USDC test mint + treasury ATA and calls `initialize_platform`
//      (or reuses existing `PlatformConfig` if already initialized on cluster)
//   2. Approves KYC (`approve_investor`) for admin + second investor
//   3. Evaluates 3 properties via `scoring.ts` (matching `capstone/scoring/engine.py`)
//      and lists them via `create_property` with on-chain `valuation_hash`
//   4. Mints test USDC, buys Token-2022 `NonTransferable` shares, and deposits rent
// ============================================================================

import { AnchorProvider, BN, Program, Wallet } from "@anchor-lang/core";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createInitializeAccount3Instruction,
  createMint,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import idl from "../src/idl/roofic.json" with { type: "json" };
import type { Roofic } from "../src/idl/roofic";
import { PRESET_CATALOG, evaluateProperty } from "../src/lib/scoring";

const local = process.env.CLUSTER === "localnet";
const connection = new Connection(local ? "http://127.0.0.1:8899" : clusterApiUrl("devnet"), "confirmed");
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
);

const programFor = (kp: Keypair) =>
  new Program<Roofic>(
    idl as unknown as Roofic,
    new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" }),
  );

const PID = new PublicKey(idl.address);
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PID)[0];
const DECIMALS = 6;
const toUsdc = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));

async function fundSol(to: PublicKey, sol: number) {
  if (local) {
    await connection.confirmTransaction(await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL));
  } else {
    const provider = programFor(admin).provider as AnchorProvider;
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: to,
          lamports: Math.round(sol * LAMPORTS_PER_SOL),
        }),
      ),
    );
  }
}

/**
 * Ensures a dedicated `owner_payment` token account exists for `owner` so that even when
 * `owner == investor` (same wallet listing & buying in a demo), `investor_payment` and
 * `owner_payment` are distinct accounts (satisfying Anchor's duplicate-mutable check).
 */
async function ensureOwnerProceedsAccount(
  payer: Keypair,
  paymentMint: PublicKey,
  tokenProgram = TOKEN_PROGRAM_ID,
): Promise<PublicKey> {
  const seed = `proceeds-${paymentMint.toBase58().slice(0, 8)}`;
  const acct = await PublicKey.createWithSeed(payer.publicKey, seed, tokenProgram);
  if (await connection.getAccountInfo(acct)) return acct;

  const lamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const provider = programFor(payer).provider as AnchorProvider;
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.createAccountWithSeed({
        fromPubkey: payer.publicKey,
        basePubkey: payer.publicKey,
        seed,
        newAccountPubkey: acct,
        lamports,
        space: ACCOUNT_SIZE,
        programId: tokenProgram,
      }),
      createInitializeAccount3Instruction(acct, paymentMint, payer.publicKey, tokenProgram),
    ),
  );
  return acct;
}

async function main() {
  if (local) await fundSol(admin.publicKey, 10);
  const program = programFor(admin);
  const config = pda([Buffer.from("config")]);

  let paymentMint: PublicKey;
  let treasury: PublicKey;

  const existingCfg = await program.account.platformConfig.fetchNullable(config);
  if (!existingCfg) {
    paymentMint = await createMint(connection, admin, admin.publicKey, null, DECIMALS);
    const treasuryOwner = Keypair.generate();
    treasury = await createAssociatedTokenAccountIdempotent(
      connection,
      admin,
      paymentMint,
      treasuryOwner.publicKey,
    );
    const bpfLoaderUpgradeable = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    const [programData] = PublicKey.findProgramAddressSync([PID.toBuffer()], bpfLoaderUpgradeable);
    const sig = await program.methods
      .initializePlatform(100, 150) // 1.0% rent fee, 1.5% sale fee
      .accountsPartial({
        config,
        paymentMint,
        treasury,
        admin: admin.publicKey,
        program: PID,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`⚙️  Initialized PlatformConfig: ${config.toBase58()} (tx: ${sig})`);
    console.log(`💵 Payment Mint (Demo USDC):   ${paymentMint.toBase58()}`);
    console.log(`🏦 Treasury ATA:               ${treasury.toBase58()}`);
  } else {
    paymentMint = existingCfg.paymentMint;
    treasury = existingCfg.treasury;
    console.log(`ℹ️  Reusing PlatformConfig:     ${config.toBase58()}`);
    console.log(`💵 Payment Mint (Demo USDC):   ${paymentMint.toBase58()}`);
    console.log(`🏦 Treasury ATA:               ${treasury.toBase58()}`);
  }

  // Ensure admin is KYC-approved and has Demo USDC
  const adminInvestorPda = pda([Buffer.from("investor"), admin.publicKey.toBuffer()]);
  if (!(await connection.getAccountInfo(adminInvestorPda))) {
    await program.methods
      .approveInvestor()
      .accountsPartial({
        config,
        investorRecord: adminInvestorPda,
        wallet: admin.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`✅ KYC approved admin: ${admin.publicKey.toBase58()}`);
  }

  const adminPaymentAta = await createAssociatedTokenAccountIdempotent(
    connection,
    admin,
    paymentMint,
    admin.publicKey,
  );
  await mintTo(connection, admin, paymentMint, adminPaymentAta, admin, 500_000n * 10n ** BigInt(DECIMALS));
  const ownerProceedsAta = await ensureOwnerProceedsAccount(admin, paymentMint, TOKEN_PROGRAM_ID);

  // Second investor for multi-holder pro-rata demonstration
  const investor2 = Keypair.generate();
  await fundSol(investor2.publicKey, local ? 2 : 0.05);
  const inv2Record = pda([Buffer.from("investor"), investor2.publicKey.toBuffer()]);
  await program.methods
    .approveInvestor()
    .accountsPartial({
      config,
      investorRecord: inv2Record,
      wallet: investor2.publicKey,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  const inv2PaymentAta = await createAssociatedTokenAccountIdempotent(
    connection,
    admin,
    paymentMint,
    investor2.publicKey,
  );
  await mintTo(connection, admin, paymentMint, inv2PaymentAta, admin, 200_000n * 10n ** BigInt(DECIMALS));

  for (const item of PRESET_CATALOG) {
    const report = evaluateProperty(item.input);
    const id = new BN(item.input.property_id);
    const property = pda([
      Buffer.from("property"),
      admin.publicKey.toBuffer(),
      id.toArrayLike(Buffer, "le", 8),
    ]);
    const shareMint = pda([Buffer.from("share_mint"), property.toBuffer()]);
    const vault = pda([Buffer.from("vault"), property.toBuffer()]);

    let propAcct = await program.account.property.fetchNullable(property);
    if (!propAcct) {
      await program.methods
        .createProperty(
          id,
          item.input.name,
          new BN(item.totalShares),
          toUsdc(item.pricePerShareUsdc),
          admin.publicKey,
          report.valuation_hash_bytes,
        )
        .accountsPartial({
          config,
          ownerKyc: adminInvestorPda,
          property,
          shareMint,
          vault,
          paymentMint,
          owner: admin.publicKey,
          shareTokenProgram: TOKEN_2022_PROGRAM_ID,
          paymentTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(
        `🏠 Created ${item.input.name}: ${property.toBase58()} (grade ${report.risk_grade}, hash 0x${report.valuation_hash_hex.slice(0, 12)}…)`,
      );
      propAcct = await program.account.property.fetch(property);
    } else {
      console.log(`🏠 Property already exists: ${item.input.name} (${property.toBase58()})`);
    }

    if (propAcct.sharesSold.isZero()) {
      const buyers: Array<[Keypair, PublicKey, number]> = [
        [admin, adminPaymentAta, Math.floor(item.totalShares * 0.25)],
        [investor2, inv2PaymentAta, Math.floor(item.totalShares * 0.15)],
      ];

      for (const [kp, buyerAta, shares] of buyers) {
        await programFor(kp)
          .methods.buyShares(new BN(shares))
          .accountsPartial({
            config,
            investorRecord: pda([Buffer.from("investor"), kp.publicKey.toBuffer()]),
            property,
            shareMint,
            position: pda([Buffer.from("position"), property.toBuffer(), kp.publicKey.toBuffer()]),
            investorShares: getAssociatedTokenAddressSync(
              shareMint,
              kp.publicKey,
              false,
              TOKEN_2022_PROGRAM_ID,
            ),
            paymentMint,
            investorPayment: buyerAta,
            ownerPayment: ownerProceedsAta,
            treasury,
            investor: kp.publicKey,
            shareTokenProgram: TOKEN_2022_PROGRAM_ID,
            paymentTokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        console.log(`   👤 ${kp.publicKey.toBase58().slice(0, 6)}… bought ${shares} shares`);
      }

      const monthlyRentUsdc = Math.round((item.input.price_usd * item.input.gross_yield) / 12);
      await program.methods
        .depositRent(toUsdc(monthlyRentUsdc))
        .accountsPartial({
          config,
          property,
          shareMint,
          vault,
          paymentMint,
          managerPayment: adminPaymentAta,
          treasury,
          manager: admin.publicKey,
          shareTokenProgram: TOKEN_2022_PROGRAM_ID,
          paymentTokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      console.log(`   💰 Deposited ${monthlyRentUsdc} USDC rent into vault ${vault.toBase58()}`);
    }
  }

  console.log("🎉 Capstone seed complete!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
