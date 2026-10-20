// ============================================================================
// Шаг 4. Сбор удержанных комиссий в казну
//   1) harvestWithheldTokensToMint — permissionless: переносит withheld из
//      token-аккаунтов в сам mint (может вызвать кто угодно)
//   2) withdrawWithheldTokensFromMint — только withdrawWithheldAuthority:
//      выводит накопленное из mint на аккаунт казны
// ============================================================================
import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  getTransferFeeConfig,
  harvestWithheldTokensToMint,
  withdrawWithheldTokensFromMint,
} from "@solana/spl-token";
import {
  TOKEN,
  connection,
  fromBaseUnits,
  getRecipient,
  header,
  payer,
  recordSignature,
  requireMint,
  runIfMain,
} from "./common.js";

export async function collectFees() {
  header("4. Harvest & withdraw withheld transfer fees");
  const mint = requireMint();
  const tokenProgram = TOKEN_2022_PROGRAM_ID;
  const recipientAta = getAssociatedTokenAddressSync(mint, getRecipient().publicKey, false, tokenProgram);

  const harvestSig = await harvestWithheldTokensToMint(
    connection, payer, mint, [recipientAta], { commitment: "confirmed" }, tokenProgram,
  );
  const mintInfo = await getMint(connection, mint, "confirmed", tokenProgram);
  const withheldInMint = getTransferFeeConfig(mintInfo)?.withheldAmount ?? 0n;
  console.log(`   Harvest → в mint накоплено: ${fromBaseUnits(withheldInMint)} ${TOKEN.symbol}`);
  recordSignature("harvestFees", harvestSig);

  // Казна платформы — в демо это ATA владельца
  const treasury = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint, payer.publicKey, false, "confirmed", undefined, tokenProgram,
  );
  const before = treasury.amount;
  const withdrawSig = await withdrawWithheldTokensFromMint(
    connection, payer, mint, treasury.address, payer, [], { commitment: "confirmed" }, tokenProgram,
  );
  const after = (await getAccount(connection, treasury.address, "confirmed", tokenProgram)).amount;
  console.log(`✅ В казну выведено: ${fromBaseUnits(after - before)} ${TOKEN.symbol}`);
  recordSignature("withdrawFees", withdrawSig);
  return after - before;
}

runIfMain(import.meta.url, collectFees);
