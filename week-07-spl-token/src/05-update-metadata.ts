// ============================================================================
// Шаг 5. Обновление on-chain metadata
// Добавляем/меняем произвольное поле. Если metadata растёт, аккаунту нужен
// дополнительный rent — хелпер *WithRentTransfer доплачивает его автоматически.
// ============================================================================
import {
  TOKEN_2022_PROGRAM_ID,
  getTokenMetadata,
  tokenMetadataUpdateFieldWithRentTransfer,
} from "@solana/spl-token";
import { connection, header, payer, recordSignature, requireMint, runIfMain } from "./common.js";

export async function updateMetadata(field = "website", value = "https://github.com/Abdulla-Nurislam") {
  header(`5. Update metadata field "${field}"`);
  const mint = requireMint();

  const sig = await tokenMetadataUpdateFieldWithRentTransfer(
    connection, payer, mint, payer, field, value, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID,
  );
  recordSignature(`updateMetadata:${field}`, sig);

  const md = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("✅ Текущая metadata:");
  console.log(`   name=${md?.name}  symbol=${md?.symbol}`);
  console.log(`   uri=${md?.uri}`);
  for (const [k, v] of md?.additionalMetadata ?? []) console.log(`   ${k} = ${v}`);
  return md;
}

runIfMain(import.meta.url, () => updateMetadata());
