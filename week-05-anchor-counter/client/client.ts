import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import fs from "fs";

// Импорт IDL
const idl = JSON.parse(fs.readFileSync("../target/idl/counter_program.json", "utf8"));
const programId = new PublicKey("5ACn229Xq3arXb1MgF4Ux1iXY9yRTrN7VkaALLLttnLv");

async function main() {
    console.log("🚀 Starting Counter Program Client...");

    // Подключение к devnet
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");

    // Загрузка кошелька
    const walletPath = require("os").homedir() + "/.config/solana/id.json";
    const walletKeypair = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
    );
    const wallet = new anchor.Wallet(walletKeypair);

    // Настройка провайдера
    const provider = new anchor.AnchorProvider(connection, wallet, {
        preflightCommitment: "confirmed",
    });
    anchor.setProvider(provider);

    // Инициализация программы
    const program = new Program(idl as any, provider) as any;

    // Поиск PDA для счётчика
    const [counterPda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("counter"), wallet.publicKey.toBuffer()],
        program.programId
    );

    console.log(`\n🔑 Wallet Address: ${wallet.publicKey.toBase58()}`);
    console.log(`📌 Counter PDA: ${counterPda.toBase58()}`);

    try {
        // 1. Инициализация
        console.log("\n📦 Initializing counter...");
        const txInit = await program.methods
            .initialize()
            .accounts({
                counter: counterPda,
                authority: wallet.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();
        console.log(`✅ Initialize TX: ${txInit}`);
    } catch (e) {
        console.log("⚠️ Counter might already be initialized.");
    }

    // Чтение данных
    let counterAccount = await program.account.counter.fetch(counterPda);
    console.log(`📊 Current Count: ${counterAccount.count.toString()}`);

    // 2. Инкремент
    console.log("\n📈 Incrementing counter...");
    const txInc = await program.methods
        .increment()
        .accounts({
            counter: counterPda,
            authority: wallet.publicKey,
        })
        .rpc();
    console.log(`✅ Increment TX: ${txInc}`);

    // Чтение данных
    counterAccount = await program.account.counter.fetch(counterPda);
    console.log(`📊 New Count: ${counterAccount.count.toString()}`);

    // 3. Декремент
    console.log("\n📉 Decrementing counter...");
    const txDec = await program.methods
        .decrement()
        .accounts({
            counter: counterPda,
            authority: wallet.publicKey,
        })
        .rpc();
    console.log(`✅ Decrement TX: ${txDec}`);

    // Чтение данных
    counterAccount = await program.account.counter.fetch(counterPda);
    console.log(`📊 New Count: ${counterAccount.count.toString()}`);

    // 4. Установка значения
    console.log("\n🎯 Setting counter to 100...");
    const txSet = await program.methods
        .set(new anchor.BN(100))
        .accounts({
            counter: counterPda,
            authority: wallet.publicKey,
        })
        .rpc();
    console.log(`✅ Set Value TX: ${txSet}`);

    // Чтение данных
    counterAccount = await program.account.counter.fetch(counterPda);
    console.log(`📊 Final Count: ${counterAccount.count.toString()}`);
}

main().catch((err) => {
    console.error(err);
});
