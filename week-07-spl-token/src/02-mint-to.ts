// ============================================================================
// Шаг 2. Выпуск (mint) токенов на Associated Token Account владельца
// ATA — детерминированный адрес (PDA ATA-программы) от [owner, tokenProgram, mint]
// ============================================================================
import { TOKEN_2022_PROGRAM_ID, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  TOKEN,
  connection,
  fromBaseUnits,
  header,
  payer,
  recordSignature,
  requireMint,
  runIfMain,
  toBaseUnits,
} from "./common.js";

export const INITIAL_SUPPLY = 1_000_000; // 1M ROOF

export async function mintTokens(amount = INITIAL_SUPPLY) {
  header(`2. Mint ${amount.toLocaleString()} ${TOKEN.symbol}`);
  const mint = requireMint();

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  console.log(`   ATA владельца: ${ata.address.toBase58()}`);

  const sig = await mintTo(
    connection,
    payer,
    mint,
    ata.address,
    payer, // mint authority
    toBaseUnits(amount),
    [],
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID,
  );

  const after = await getAccount(connection, ata.address, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log(`✅ Баланс владельца: ${fromBaseUnits(after.amount)} ${TOKEN.symbol}`);
  recordSignature("mintTo", sig);
}

runIfMain(import.meta.url, () => mintTokens());
