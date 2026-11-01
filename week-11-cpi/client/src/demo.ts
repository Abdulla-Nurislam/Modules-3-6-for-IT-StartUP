// ============================================================================
// Неделя 11 — клиент для составного (composable) сценария:
//
//   инвестор ──► roofic_portfolio.buy_and_track
//                   └─CPI─► roofic_shares.buy_shares
//                              ├─CPI─► Associated Token  (создаёт token account инвестора)
//                              ├─CPI─► System            (платёж владельцу объекта)
//                              └─CPI─► Token-2022        (mint_to, подпись PDA листинга)
//
// Скрипт выполняет сценарий на реальном кластере и проверяет результат (assert):
// деньги, токены, портфель, лимит долей, защиту от подмены программы и переводимость долей.
//
//   Localnet: solana-test-validator -r --bpf-program <id> <so> ... ; CLUSTER=localnet npm run demo
//   Devnet:   npm run demo   (кошелёк ~/.config/solana/id.json, нужно ~0.05 SOL)
// ============================================================================
// @anchor-lang/core — CommonJS-пакет: в ESM именованные импорты работают только для типов,
// поэтому значения берём из default-экспорта.
import anchor, { type Idl } from "@anchor-lang/core";
import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  transferChecked,
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
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { AnchorProvider, BN, Program, Wallet } = anchor;
type BN = InstanceType<typeof BN>;

const here = dirname(fileURLToPath(import.meta.url));
const readIdl = (name: string) => JSON.parse(readFileSync(join(here, "..", "idl", `${name}.json`), "utf8")) as Idl;
const sharesIdl = readIdl("roofic_shares");
const portfolioIdl = readIdl("roofic_portfolio");

const LOCAL = process.env.CLUSTER === "localnet";
const connection = new Connection(LOCAL ? "http://127.0.0.1:8899" : clusterApiUrl("devnet"), "confirmed");
const owner = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR ?? join(homedir(), ".config/solana/id.json"), "utf8"))),
);

const explorer = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${LOCAL ? "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899" : "?cluster=devnet"}`;

const programsFor = (kp: Keypair) => {
  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });
  return { shares: new Program(sharesIdl, provider), portfolio: new Program(portfolioIdl, provider) };
};

const SHARES_ID = new PublicKey(sharesIdl.address);
const PORTFOLIO_ID = new PublicKey(portfolioIdl.address);

const listingPda = (authority: PublicKey, id: BN) =>
  PublicKey.findProgramAddressSync([Buffer.from("listing"), authority.toBuffer(), id.toArrayLike(Buffer, "le", 8)], SHARES_ID)[0];
const mintPda = (listing: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("share_mint"), listing.toBuffer()], SHARES_ID)[0];
const portfolioPda = (investor: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("portfolio"), investor.toBuffer()], PORTFOLIO_ID)[0];

async function fund(to: PublicKey, sol: number) {
  if (LOCAL) {
    await connection.confirmTransaction(await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL));
  } else {
    const p = new AnchorProvider(connection, new Wallet(owner), { commitment: "confirmed" });
    await p.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports: sol * LAMPORTS_PER_SOL })));
  }
}

/** Ожидаем отказ именно по конкретной причине (код/текст ошибки), а не просто «упало» */
async function expectFailure(label: string, run: () => Promise<unknown>, needle: string) {
  try {
    await run();
  } catch (e) {
    const text = [(e as { logs?: string[] }).logs?.join("\n"), (e as Error).message, String(e)].join("\n");
    assert.ok(text.includes(needle), `${label}: ожидали "${needle}", получили: ${text.slice(0, 400)}`);
    console.log(`   ✅ ${label} → отклонено (${needle})`);
    return;
  }
  assert.fail(`${label}: транзакция должна была упасть`);
}

async function main() {
  console.log(`Кластер: ${LOCAL ? "localnet" : "devnet"}   владелец: ${owner.publicKey.toBase58()}`);
  if (LOCAL && (await connection.getBalance(owner.publicKey)) < 5 * LAMPORTS_PER_SOL) await fund(owner.publicKey, 10);

  const buyer = Keypair.generate();
  const friend = Keypair.generate();
  await fund(buyer.publicKey, LOCAL ? 5 : 0.03);

  // ---------------------------------------------------------------- 1. листинг
  const id = new BN(Date.now());
  const price = new BN(1_000_000); // 0.001 SOL за долю
  const total = 100;
  const listing = listingPda(owner.publicKey, id);
  const mint = mintPda(listing);
  const sig1 = await programsFor(owner)
    .shares.methods.createListing(id, "Client Demo Loft", new BN(total), price)
    .accountsPartial({ listing, mint, authority: owner.publicKey })
    .rpc();
  console.log(`\n1. create_listing (roofic_shares)\n   listing ${listing.toBase58()}\n   mint    ${mint.toBase58()}\n   ${explorer(sig1)}`);

  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(mintInfo.decimals, 0, "1 токен = 1 доля");
  assert.equal(mintInfo.mintAuthority?.toBase58(), listing.toBase58(), "mint authority — PDA листинга, а не человек");
  assert.equal(mintInfo.supply, 0n);

  // ---------------------------------------------------------------- 2. покупка через вторую программу
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const buy = (shares: number, who = buyer, extra: Record<string, PublicKey> = {}) =>
    programsFor(who)
      .portfolio.methods.buyAndTrack(new BN(shares))
      .accountsPartial({
        portfolio: portfolioPda(who.publicKey),
        listing,
        authority: owner.publicKey,
        investor: who.publicKey,
        mint,
        investorAta: getAssociatedTokenAddressSync(mint, who.publicKey, false, TOKEN_2022_PROGRAM_ID),
        ...extra,
      })
      .rpc();

  const ownerBefore = await connection.getBalance(owner.publicKey);
  const sig2 = await buy(10);
  console.log(`\n2. buy_and_track(10): portfolio → shares → ATA/System/Token-2022 (вложенный CPI)\n   ${explorer(sig2)}`);
  assert.equal((await connection.getBalance(owner.publicKey)) - ownerBefore, 10 * price.toNumber(), "владелец получил ровно 10 × цена");
  assert.equal((await getAccount(connection, buyerAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 10n, "10 токенов долей");

  const sig3 = await buy(5);
  console.log(`   повторная покупка 5: ${explorer(sig3)}`);
  assert.equal((await getAccount(connection, buyerAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 15n);
  // Idl без сгенерированных типов: аккаунты доступны по имени из IDL
  const accounts = programsFor(buyer).portfolio.account as unknown as Record<string, { fetch(k: PublicKey): Promise<Record<string, BN | number>> }>;
  const pf = await accounts["portfolio"].fetch(portfolioPda(buyer.publicKey));
  assert.equal(Number(pf.purchases), 2);
  assert.equal(Number(pf.totalShares), 15);
  assert.equal(Number(pf.totalSpent), 15 * price.toNumber());
  console.log(`   Portfolio: purchases=2, totalShares=15, totalSpent=${15 * price.toNumber()} lamports ✅`);

  // ---------------------------------------------------------------- 3. негативные сценарии
  console.log("\n3. Негативные сценарии");
  await expectFailure("покупка сверх лимита", () => buy(total), "NotEnoughShares");
  await expectFailure("подмена roofic_shares на чужую программу (arbitrary CPI)", () => buy(1, buyer, { sharesProgram: SystemProgram.programId }), "InvalidProgramId");
  const unchanged = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(unchanged.supply, 15n, "supply не изменился после отклонённых покупок");

  // ---------------------------------------------------------------- 4. доли — обычный токен
  const friendAta = await getOrCreateAssociatedTokenAccount(connection, owner, mint, friend.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
  const sig4 = await transferChecked(connection, owner, buyerAta, mint, friendAta.address, buyer, 3n, 0, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
  console.log(`\n4. Перевод 3 долей другу стандартным TransferChecked\n   ${explorer(sig4)}`);
  assert.equal((await getAccount(connection, friendAta.address, "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 3n);
  assert.equal((await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply, 15n, "перевод не меняет supply");

  console.log("\n🎉 Все проверки пройдены");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
