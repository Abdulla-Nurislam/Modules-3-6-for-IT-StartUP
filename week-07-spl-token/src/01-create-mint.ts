// ============================================================================
// Шаг 1. Создание Token-2022 mint с расширениями
//   • TransferFeeConfig — 0.5% комиссия с каждого перевода (казна платформы)
//   • MetadataPointer   — указывает, что metadata хранится в самом mint
//   • TokenMetadata     — name / symbol / uri + дополнительные поля on-chain
// Все инструкции идут ОДНОЙ атомарной транзакцией: расширения должны быть
// инициализированы ДО InitializeMint.
// ============================================================================
import {
  ExtensionType,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TYPE_SIZE,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  getMintLen,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  createUpdateFieldInstruction,
  pack,
  type TokenMetadata,
} from "@solana/spl-token-metadata";
import { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN, connection, explorer, header, payer, recordSignature, runIfMain, writeState } from "./common.js";

export async function createMint() {
  header("1. Create Token-2022 mint (TransferFee + Metadata)");
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const metadata: TokenMetadata = {
    mint,
    updateAuthority: payer.publicKey,
    name: TOKEN.name,
    symbol: TOKEN.symbol,
    uri: TOKEN.uri,
    additionalMetadata: TOKEN.additionalMetadata,
  };

  // Размер аккаунта: базовый mint + расширения фиксированного размера.
  // TokenMetadata — переменной длины: под неё доплачиваем rent заранее,
  // а программа сама сделает realloc при инициализации metadata.
  const extensions = [ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer];
  const mintLen = getMintLen(extensions);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(
      mint,
      payer.publicKey, // transferFeeConfigAuthority — может менять ставку
      payer.publicKey, // withdrawWithheldAuthority — может забирать накопленные комиссии
      TOKEN.feeBasisPoints,
      TOKEN.maxFee,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMetadataPointerInstruction(mint, payer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, TOKEN.decimals, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      updateAuthority: payer.publicKey,
      mint,
      mintAuthority: payer.publicKey,
      name: TOKEN.name,
      symbol: TOKEN.symbol,
      uri: TOKEN.uri,
    }),
    ...TOKEN.additionalMetadata.map(([field, value]) =>
      createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: payer.publicKey,
        field,
        value,
      }),
    ),
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [payer, mintKeypair]);
  writeState({ mint: mint.toBase58() });

  console.log(`✅ Mint создан: ${mint.toBase58()}`);
  console.log(`   ${explorer("address", mint.toBase58())}`);
  console.log(`   decimals=${TOKEN.decimals}, fee=${TOKEN.feeBasisPoints / 100}%, rent=${lamports} lamports`);
  recordSignature("createMint", sig);
  return mint;
}

runIfMain(import.meta.url, createMint);
