// ============================================================================
// Client для First Solana Program
// Взаимодействие с нативной Solana Program через @solana/web3.js
// ============================================================================

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Задеплоенный Program ID в Solana Devnet (используется, если нет локального keypair) */
const DEVNET_PROGRAM_ID = new PublicKey("F5drLsn3jPFrcZM9S4Yb9aFK32s8xY52ME6jDXgaUUV");

// ============================================================================
// Borsh Schema — должен совпадать с Rust-программой
// ============================================================================

// Enum variant tags (Borsh кодирует enum как u8 tag + payload)
const INITIALIZE = 0;
const INCREMENT = 1;
const DECREMENT = 2;
const SET = 3;

function createInitializeInstruction(): Buffer {
  return Buffer.from([INITIALIZE]);
}

function createIncrementInstruction(): Buffer {
  return Buffer.from([INCREMENT]);
}

function createDecrementInstruction(): Buffer {
  return Buffer.from([DECREMENT]);
}

function createSetInstruction(value: bigint): Buffer {
  const buf = Buffer.alloc(9);
  buf.writeUInt8(SET, 0);
  buf.writeBigUInt64LE(value, 1);
  return buf;
}

function readCounterValue(data: Buffer): bigint {
  return data.readBigUInt64LE(0);
}

// ============================================================================
// Загрузка keypair из файла (стандартный формат Solana CLI)
// ============================================================================
function loadKeypair(filepath: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║    🌐 First Solana Program — Client                    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // 1. Подключение к Devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  console.log("✅ Connected to Devnet");

  // 2. Загружаем payer keypair
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const payer = loadKeypair(keypairPath);
  console.log(`👤 Payer: ${payer.publicKey.toBase58()}`);

  // 3. Проверяем баланс
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`💰 Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    console.log("⚠️  Low balance! Requesting airdrop...");
    try {
      const sig = await connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
      console.log("✅ Airdrop received!");
    } catch {
      console.error("❌ Airdrop failed. Try: solana airdrop 1");
      return;
    }
  }

  // 4. Program ID — читаем из локального keypair при наличии, иначе используем Devnet Program ID
  const programKeypairPath = path.join(
    __dirname,
    "..",
    "target",
    "deploy",
    "first_solana_program-keypair.json"
  );

  const programId = fs.existsSync(programKeypairPath)
    ? loadKeypair(programKeypairPath).publicKey
    : DEVNET_PROGRAM_ID;
  console.log(`📦 Program ID: ${programId.toBase58()}`);

  // 5. Создаём аккаунт для хранения данных счётчика
  const counterAccount = Keypair.generate();
  console.log(`🔑 Counter Account: ${counterAccount.publicKey.toBase58()}`);

  const COUNTER_SIZE = 8; // u64 = 8 bytes
  const lamports = await connection.getMinimumBalanceForRentExemption(COUNTER_SIZE);

  console.log("\n─── Creating Counter Account ───");
  const createAccountTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: counterAccount.publicKey,
      lamports,
      space: COUNTER_SIZE,
      programId,
    })
  );

  const createSig = await sendAndConfirmTransaction(connection, createAccountTx, [
    payer,
    counterAccount,
  ]);
  console.log(`✅ Account created! Tx: ${createSig}`);

  const defaultKeys = [
    { pubkey: counterAccount.publicKey, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
  ];

  // 6. Initialize
  console.log("\n─── Initialize Counter ───");
  const initTx = new Transaction().add(
    new TransactionInstruction({
      keys: defaultKeys,
      programId,
      data: createInitializeInstruction(),
    })
  );

  const initSig = await sendAndConfirmTransaction(connection, initTx, [payer]);
  console.log(`✅ Initialized! Tx: ${initSig}`);

  let accountInfo = await connection.getAccountInfo(counterAccount.publicKey);
  console.log(`📊 Counter value: ${readCounterValue(accountInfo!.data as Buffer)}`);

  // 7. Increment x3
  console.log("\n─── Increment Counter (x3) ───");
  for (let i = 0; i < 3; i++) {
    const incTx = new Transaction().add(
      new TransactionInstruction({
        keys: defaultKeys,
        programId,
        data: createIncrementInstruction(),
      })
    );
    const sig = await sendAndConfirmTransaction(connection, incTx, [payer]);
    accountInfo = await connection.getAccountInfo(counterAccount.publicKey);
    console.log(
      `  ✅ Increment #${i + 1} → Counter: ${readCounterValue(accountInfo!.data as Buffer)} | Tx: ${sig.slice(0, 20)}...`
    );
  }

  // 8. Set value
  console.log("\n─── Set Counter to 42 ───");
  const setTx = new Transaction().add(
    new TransactionInstruction({
      keys: defaultKeys,
      programId,
      data: createSetInstruction(42n),
    })
  );
  const setSig = await sendAndConfirmTransaction(connection, setTx, [payer]);
  accountInfo = await connection.getAccountInfo(counterAccount.publicKey);
  console.log(`✅ Counter set to ${readCounterValue(accountInfo!.data as Buffer)} | Tx: ${setSig}`);

  // 9. Decrement
  console.log("\n─── Decrement Counter ───");
  const decTx = new Transaction().add(
    new TransactionInstruction({
      keys: defaultKeys,
      programId,
      data: createDecrementInstruction(),
    })
  );
  const decSig = await sendAndConfirmTransaction(connection, decTx, [payer]);
  accountInfo = await connection.getAccountInfo(counterAccount.publicKey);
  console.log(
    `✅ Counter decremented to ${readCounterValue(accountInfo!.data as Buffer)} | Tx: ${decSig}`
  );

  console.log("\n🎉 All operations completed successfully!");
  console.log(`   View on Explorer: https://explorer.solana.com/address/${programId.toBase58()}?cluster=devnet`);
}

main().catch(console.error);
