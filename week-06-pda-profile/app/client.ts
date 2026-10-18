// ============================================================================
// TypeScript Client для Profile PDA Program
// Демонстрация взаимодействия с on-chain профилями через Anchor
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Загружаем IDL (сгенерирован через anchor build)
import idl from "../target/idl/profile_program.json" assert { type: "json" };

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║    👤 Profile PDA Program — Client                     ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // 1. Подключение к Devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  // 2. Загружаем wallet
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(secretKey)));

  console.log(`👤 Wallet: ${wallet.publicKey.toBase58()}`);

  // 3. Настройка провайдера и программы
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program(idl as any, provider);
  console.log(`📦 Program ID: ${program.programId.toBase58()}`);

  // 4. Вычисляем PDA для профиля
  const [profilePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), wallet.publicKey.toBuffer()],
    program.programId
  );
  console.log(`🔑 Profile PDA: ${profilePda.toBase58()}\n`);

  // 5. Проверяем существует ли профиль
  let profileAccount = await connection.getAccountInfo(profilePda);

  if (!profileAccount) {
    // Создаём профиль
    console.log("─── Creating Profile ───");
    const tx = await program.methods
      .createProfile(
        "Nurislam",
        "Solana Developer | Anchor Enthusiast | Building on-chain profiles",
        "https://avatars.githubusercontent.com/nurislam"
      )
      .accounts({
        authority: wallet.publicKey,
      })
      .rpc();

    console.log(`✅ Profile created! Tx: ${tx}\n`);
  } else {
    console.log("ℹ️  Profile already exists\n");
  }

  // 6. Читаем профиль
  console.log("─── Reading Profile ───");
  let profile = await program.account.userProfile.fetch(profilePda);

  console.log(`  👤 Name: ${profile.name}`);
  console.log(`  📝 Bio: ${profile.bio}`);
  console.log(`  🖼️  Avatar: ${profile.avatarUrl}`);
  console.log(`  🔑 Authority: ${profile.authority.toBase58()}`);
  console.log(`  📅 Created: ${new Date(profile.createdAt.toNumber() * 1000).toISOString()}`);
  console.log(`  📅 Updated: ${new Date(profile.updatedAt.toNumber() * 1000).toISOString()}`);

  // 7. Обновляем профиль
  console.log("\n─── Updating Profile ───");
  const updateTx = await program.methods
    .updateProfile(
      null,  // не меняем имя
      "Senior Solana Developer | Building DeFi & NFT protocols | PDA expert", // новое bio
      null   // не меняем avatar
    )
    .accounts({
      authority: wallet.publicKey,
    })
    .rpc();

  console.log(`✅ Profile updated! Tx: ${updateTx}\n`);

  // 8. Читаем обновлённый профиль
  console.log("─── Updated Profile ───");
  profile = await program.account.userProfile.fetch(profilePda);

  console.log(`  👤 Name: ${profile.name}`);
  console.log(`  📝 Bio: ${profile.bio}`);
  console.log(`  📅 Updated: ${new Date(profile.updatedAt.toNumber() * 1000).toISOString()}`);

  console.log("\n🎉 All operations completed!");
  console.log(`   Explorer: https://explorer.solana.com/address/${profilePda.toBase58()}?cluster=devnet`);
}

main().catch(console.error);
