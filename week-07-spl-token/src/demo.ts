// ============================================================================
// Полный сценарий недели 7 одной командой + проверки (assert).
// Используется как интеграционный тест на локальном валидаторе:
//   solana-test-validator -r   (в отдельном терминале)
//   CLUSTER=localnet npm run demo
// ============================================================================
import assert from "node:assert/strict";
import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  getTokenMetadata,
  mintTo,
  transferCheckedWithFee,
  withdrawWithheldTokensFromMint,
} from "@solana/spl-token";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CLUSTER, TOKEN, connection, getRecipient, payer, toBaseUnits } from "./common.js";
import { createMint } from "./01-create-mint.js";
import { INITIAL_SUPPLY, mintTokens } from "./02-mint-to.js";
import { transferTokens } from "./03-transfer.js";
import { collectFees } from "./04-collect-fees.js";
import { updateMetadata } from "./05-update-metadata.js";
import { inspect } from "./06-inspect.js";

/** Проверяет, что отказ случился именно по ожидаемой причине (код ошибки Token-2022), а не по постороннему поводу */
const failsWith = (code: string) => (err: unknown) => {
  const text = [(err as { logs?: string[] }).logs?.join("\n"), (err as Error).message].join("\n");
  assert.ok(text.includes(`custom program error: ${code}`), `ожидали ${code}, получили: ${text.slice(0, 300)}`);
  return true;
};
const FEE_MISMATCH = "0x20"; // TokenError::FeeMismatch
const OWNER_MISMATCH = "0x4"; // TokenError::OwnerMismatch

async function main() {
  if (CLUSTER === "localnet" && (await connection.getBalance(payer.publicKey)) < LAMPORTS_PER_SOL) {
    await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL));
  }

  const mint = await createMint();
  await mintTokens();
  const amount = 10_000;
  const { destination, fee } = await transferTokens(amount);
  const collected = await collectFees();
  await updateMetadata("website", "https://github.com/Abdulla-Nurislam");
  await inspect();

  // ---------------- Проверки ----------------
  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(mintInfo.supply, toBaseUnits(INITIAL_SUPPLY), "supply");
  assert.equal(fee, (toBaseUnits(amount) * BigInt(TOKEN.feeBasisPoints)) / 10_000n, "fee = 0.5%");

  const dest = await getAccount(connection, destination, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(dest.amount, toBaseUnits(amount) - fee, "получатель получает сумму за вычетом комиссии");
  assert.equal(collected, fee, "в казну выведена вся комиссия");

  const md = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(md?.symbol, TOKEN.symbol);
  assert.ok(md?.additionalMetadata.some(([k]) => k === "website"), "новое поле metadata");

  // ---------------- Негативные проверки (тестер: «что НЕ должно получиться») ----------------
  const recipient = getRecipient();
  const ownerAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const supplyBefore = (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;

  // 1) неверно указанная ожидаемая комиссия → Token-2022 отклоняет перевод (защита от смены ставки)
  await assert.rejects(
    transferCheckedWithFee(
      connection, payer, ownerAta, mint, destination, payer, toBaseUnits(amount), TOKEN.decimals,
      fee + 1n, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID,
    ),
    failsWith(FEE_MISMATCH),
  );

  // 2) выпуск токенов чужим ключом (не mint authority) отклоняется, supply не меняется
  await assert.rejects(
    mintTo(connection, payer, mint, ownerAta, recipient, 1n, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID),
    failsWith(OWNER_MISMATCH),
  );

  // 3) вывод комиссий чужим ключом (не withdrawWithheldAuthority) отклоняется
  const treasury = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint, payer.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID,
  );
  await assert.rejects(
    withdrawWithheldTokensFromMint(
      connection, payer, mint, treasury.address, recipient, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID,
    ),
    failsWith(OWNER_MISMATCH),
  );

  const supplyAfter = (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  assert.equal(supplyAfter, supplyBefore, "supply не изменился после отклонённых операций");
  console.log("\n🛡️  Негативные проверки пройдены: неверная комиссия, чужой mint authority, чужой fee authority отклонены");

  console.log("\n🎉 Все проверки пройдены");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
