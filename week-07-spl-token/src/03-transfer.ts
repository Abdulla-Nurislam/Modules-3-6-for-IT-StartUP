// ============================================================================
// Шаг 3. Перевод с комиссией (TransferFee extension)
// transferCheckedWithFee требует явно указать ожидаемую комиссию — защита от
// того, что authority поменяет ставку между подписью и исполнением транзакции.
// Комиссия НЕ уходит сразу в казну: она "удерживается" (withheld) на аккаунте
// получателя и собирается отдельно (шаг 4).
// ============================================================================
import {
  TOKEN_2022_PROGRAM_ID,
  calculateEpochFee,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  getTransferFeeAmount,
  getTransferFeeConfig,
  transferCheckedWithFee,
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
  toBaseUnits,
} from "./common.js";

export async function transferTokens(amount = 10_000) {
  header(`3. Transfer ${amount.toLocaleString()} ${TOKEN.symbol} (with 0.5% fee)`);
  const mint = requireMint();
  const recipient = getRecipient();

  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintInfo);
  if (!feeConfig) throw new Error("У mint нет TransferFeeConfig");

  const raw = toBaseUnits(amount);
  const { epoch } = await connection.getEpochInfo();
  const fee = calculateEpochFee(feeConfig, BigInt(epoch), raw);
  console.log(`   Получатель: ${recipient.publicKey.toBase58()}`);
  console.log(`   Сумма: ${fromBaseUnits(raw)}, ожидаемая комиссия: ${fromBaseUnits(fee)} ${TOKEN.symbol}`);

  const tokenProgram = TOKEN_2022_PROGRAM_ID;
  const source = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint, payer.publicKey, false, "confirmed", undefined, tokenProgram,
  );
  // Плательщик (payer) оплачивает создание ATA получателя — получателю SOL не нужен
  const destination = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint, recipient.publicKey, false, "confirmed", undefined, tokenProgram,
  );

  const sig = await transferCheckedWithFee(
    connection,
    payer,
    source.address,
    mint,
    destination.address,
    payer,
    raw,
    TOKEN.decimals,
    fee,
    [],
    { commitment: "confirmed" },
    tokenProgram,
  );

  const dest = await getAccount(connection, destination.address, "confirmed", tokenProgram);
  const withheld = getTransferFeeAmount(dest)?.withheldAmount ?? 0n;
  console.log(`✅ Получатель получил: ${fromBaseUnits(dest.amount)} ${TOKEN.symbol}`);
  console.log(`   Удержано комиссии на аккаунте получателя: ${fromBaseUnits(withheld)} ${TOKEN.symbol}`);
  recordSignature("transferWithFee", sig);
  return { destination: destination.address, fee };
}

runIfMain(import.meta.url, () => transferTokens());
