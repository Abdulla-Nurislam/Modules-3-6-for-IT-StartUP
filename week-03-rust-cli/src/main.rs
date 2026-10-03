// ============================================================================
// Rust CLI для Solana-разработчика
// Демонстрация конструкций Rust, необходимых для Solana-разработки
// ============================================================================

use std::collections::HashMap;
use std::env;
use std::fmt;
use std::fs;
use std::path::Path;
use std::process;

const STATE_FILE: &str = ".wallets.bin";

// ============================================================================
// 1. ENUM — Аналог Instruction в Solana
//    В Solana программах enum используется для определения инструкций
// ============================================================================
#[derive(Debug, Clone, PartialEq, Eq)]
enum Instruction {
    CreateWallet { owner: String, balance: u64 },
    Transfer { from: String, to: String, amount: u64 },
    GetBalance { owner: String },
    CloseWallet { owner: String },
}

// ============================================================================
// 2. STRUCT — Аналог Account Data в Solana
//    Хранит данные аккаунта (баланс, owner, статус)
// ============================================================================
#[derive(Debug, Clone, PartialEq, Eq)]
struct WalletAccount {
    owner: String,
    balance: u64,
    is_initialized: bool,
}

// ============================================================================
// 3. TRAIT — Аналог сериализации/десериализации (BorshSerialize/Deserialize)
//    Определяем собственный трейт для сериализации в Vec<u8> и обратно
// ============================================================================
trait Serializable: Sized {
    fn serialize(&self) -> Vec<u8>;
    fn deserialize(bytes: &[u8]) -> Result<Self, ProgramError>;
    fn description(&self) -> String;
}

impl Serializable for WalletAccount {
    /// Сериализация в байты — в Solana используется Borsh:
    /// [is_initialized: u8][owner_len: u32 LE][owner: UTF-8][balance: u64 LE]
    fn serialize(&self) -> Vec<u8> {
        let mut data = Vec::new();

        // Записываем флаг инициализации (1 байт)
        data.push(u8::from(self.is_initialized));

        // Записываем длину owner (u32 LE) + UTF-8 байты строки
        let owner_bytes = self.owner.as_bytes();
        data.extend_from_slice(&(owner_bytes.len() as u32).to_le_bytes());
        data.extend_from_slice(owner_bytes);

        // Записываем баланс (8 байт, little-endian — как в Solana)
        data.extend_from_slice(&self.balance.to_le_bytes());

        data
    }

    /// Десериализация из байтового среза с проверкой границ и UTF-8
    fn deserialize(bytes: &[u8]) -> Result<Self, ProgramError> {
        // Минимум: 1 (bool) + 4 (len) + 0 (str) + 8 (u64) = 13 байт
        if bytes.len() < 13 {
            return Err(ProgramError::SerializationError(
                "Buffer too short for WalletAccount header".to_string(),
            ));
        }

        let is_initialized = match bytes[0] {
            0 => false,
            1 => true,
            b => {
                return Err(ProgramError::SerializationError(format!(
                    "Invalid bool tag: {b}"
                )))
            }
        };

        let owner_len = u32::from_le_bytes(
            bytes[1..5]
                .try_into()
                .map_err(|_| ProgramError::SerializationError("Invalid length bytes".to_string()))?,
        ) as usize;

        let expected_len = 1usize
            .checked_add(4)
            .and_then(|n| n.checked_add(owner_len))
            .and_then(|n| n.checked_add(8))
            .ok_or_else(|| ProgramError::SerializationError("Length overflow".to_string()))?;

        if bytes.len() != expected_len {
            return Err(ProgramError::SerializationError(format!(
                "Expected {expected_len} bytes, got {}",
                bytes.len()
            )));
        }

        let owner = std::str::from_utf8(&bytes[5..5 + owner_len])
            .map_err(|_| ProgramError::SerializationError("Invalid UTF-8 in owner".to_string()))?
            .to_string();

        let balance_offset = 5 + owner_len;
        let balance = u64::from_le_bytes(
            bytes[balance_offset..balance_offset + 8]
                .try_into()
                .map_err(|_| ProgramError::SerializationError("Invalid balance bytes".to_string()))?,
        );

        Ok(WalletAccount {
            owner,
            balance,
            is_initialized,
        })
    }

    fn description(&self) -> String {
        format!(
            "Wallet[owner={}, balance={} lamports, initialized={}]",
            self.owner, self.balance, self.is_initialized
        )
    }
}

// ============================================================================
// 4. Display TRAIT — Для красивого вывода
// ============================================================================
impl fmt::Display for WalletAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "👛 {} | Balance: {} lamports | Status: {}",
            self.owner,
            self.balance,
            if self.is_initialized {
                "✅ Active"
            } else {
                "❌ Closed"
            }
        )
    }
}

// ============================================================================
// 5. CUSTOM ERROR — Аналог ProgramError в Solana
//    В Solana каждая программа определяет свои ошибки
// ============================================================================
#[derive(Debug, Clone, PartialEq, Eq)]
enum ProgramError {
    AccountNotFound(String),
    AccountAlreadyExists(String),
    InsufficientFunds { available: u64, requested: u64 },
    ArithmeticOverflow,
    AccountClosed(String),
    InvalidInstruction(String),
    SerializationError(String),
}

impl fmt::Display for ProgramError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProgramError::AccountNotFound(addr) => {
                write!(f, "❌ Account not found: {addr}")
            }
            ProgramError::AccountAlreadyExists(addr) => {
                write!(f, "❌ Account already exists: {addr}")
            }
            ProgramError::InsufficientFunds {
                available,
                requested,
            } => {
                write!(
                    f,
                    "❌ Insufficient funds: available={available}, requested={requested}"
                )
            }
            ProgramError::ArithmeticOverflow => {
                write!(f, "❌ Arithmetic overflow while updating balance")
            }
            ProgramError::AccountClosed(addr) => {
                write!(f, "❌ Account is closed: {addr}")
            }
            ProgramError::InvalidInstruction(msg) => {
                write!(f, "❌ Invalid instruction: {msg}")
            }
            ProgramError::SerializationError(msg) => {
                write!(f, "❌ Serialization error: {msg}")
            }
        }
    }
}

// ============================================================================
// 6. PROCESSOR — Аналог process_instruction в Solana
//    HashMap используется как симуляция account storage (AccountInfo[])
// ============================================================================
struct Processor {
    accounts: HashMap<String, WalletAccount>,
}

impl Processor {
    fn new() -> Self {
        Processor {
            accounts: HashMap::new(),
        }
    }

    /// Сохраняет все аккаунты в бинарный файл (используя Borsh-подобный формат)
    fn save_to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut keys: Vec<&String> = self.accounts.keys().collect();
        keys.sort();
        out.extend_from_slice(&(keys.len() as u32).to_le_bytes());
        for k in keys {
            let encoded = self.accounts[k].serialize();
            out.extend_from_slice(&(encoded.len() as u32).to_le_bytes());
            out.extend_from_slice(&encoded);
        }
        out
    }

    /// Загружает состояние аккаунтов из бинарного среза
    fn load_from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() < 4 {
            return Err(ProgramError::SerializationError(
                "State buffer too short".to_string(),
            ));
        }
        let count = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        let mut offset = 4usize;
        let mut accounts = HashMap::with_capacity(count);
        for _ in 0..count {
            if offset + 4 > bytes.len() {
                return Err(ProgramError::SerializationError(
                    "Unexpected EOF reading frame length".to_string(),
                ));
            }
            let frame_len =
                u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4;
            if offset + frame_len > bytes.len() {
                return Err(ProgramError::SerializationError(
                    "Unexpected EOF reading account frame".to_string(),
                ));
            }
            let acct = WalletAccount::deserialize(&bytes[offset..offset + frame_len])?;
            offset += frame_len;
            accounts.insert(acct.owner.clone(), acct);
        }
        Ok(Processor { accounts })
    }

    fn load_or_seed(path: &Path) -> Self {
        if let Ok(Ok(valid)) = fs::read(path).map(|b| Self::load_from_bytes(&b)) {
            return valid;
        }
        let mut proc = Self::new();
        proc.accounts.insert(
            "alice".to_string(),
            WalletAccount {
                owner: "alice".to_string(),
                balance: 1_000_000,
                is_initialized: true,
            },
        );
        proc.accounts.insert(
            "bob".to_string(),
            WalletAccount {
                owner: "bob".to_string(),
                balance: 500_000,
                is_initialized: true,
            },
        );
        proc
    }

    /// Основной обработчик — аналог entrypoint process_instruction
    /// В Solana: fn process_instruction(program_id, accounts, instruction_data) -> ProgramResult
    fn process_instruction(&mut self, instruction: Instruction) -> Result<String, ProgramError> {
        match instruction {
            Instruction::CreateWallet { owner, balance } => self.create_wallet(&owner, balance),
            Instruction::Transfer { from, to, amount } => self.transfer(&from, &to, amount),
            Instruction::GetBalance { owner } => self.get_balance(&owner),
            Instruction::CloseWallet { owner } => self.close_wallet(&owner),
        }
    }

    fn create_wallet(&mut self, owner: &str, balance: u64) -> Result<String, ProgramError> {
        if self.accounts.contains_key(owner) {
            return Err(ProgramError::AccountAlreadyExists(owner.to_string()));
        }

        let account = WalletAccount {
            owner: owner.to_string(),
            balance,
            is_initialized: true,
        };

        // Сериализация + проверка round-trip десериализации
        let serialized = account.serialize();
        let decoded = WalletAccount::deserialize(&serialized)?;
        debug_assert_eq!(account, decoded);
        println!(
            "  📦 Serialized data ({} bytes): {:?}",
            serialized.len(),
            serialized
        );

        self.accounts.insert(owner.to_string(), account);

        Ok(format!(
            "✅ Wallet created for '{owner}' with {balance} lamports"
        ))
    }

    fn transfer(&mut self, from: &str, to: &str, amount: u64) -> Result<String, ProgramError> {
        let sender = self
            .accounts
            .get(from)
            .ok_or_else(|| ProgramError::AccountNotFound(from.to_string()))?;

        if !sender.is_initialized {
            return Err(ProgramError::AccountClosed(from.to_string()));
        }

        let new_sender_balance =
            sender
                .balance
                .checked_sub(amount)
                .ok_or(ProgramError::InsufficientFunds {
                    available: sender.balance,
                    requested: amount,
                })?;

        let receiver = self
            .accounts
            .get(to)
            .ok_or_else(|| ProgramError::AccountNotFound(to.to_string()))?;

        if !receiver.is_initialized {
            return Err(ProgramError::AccountClosed(to.to_string()));
        }

        let new_receiver_balance = if from == to {
            sender.balance
        } else {
            receiver
                .balance
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?
        };

        // Записываем проверенные балансы
        self.accounts.get_mut(from).unwrap().balance = new_sender_balance;
        self.accounts.get_mut(to).unwrap().balance = new_receiver_balance;

        Ok(format!(
            "✅ Transferred {amount} lamports: '{from}' → '{to}'"
        ))
    }

    fn get_balance(&self, owner: &str) -> Result<String, ProgramError> {
        let account = self
            .accounts
            .get(owner)
            .ok_or_else(|| ProgramError::AccountNotFound(owner.to_string()))?;

        Ok(format!("  {account}"))
    }

    fn close_wallet(&mut self, owner: &str) -> Result<String, ProgramError> {
        let account = self
            .accounts
            .get_mut(owner)
            .ok_or_else(|| ProgramError::AccountNotFound(owner.to_string()))?;

        if !account.is_initialized {
            return Err(ProgramError::AccountClosed(owner.to_string()));
        }

        // В Solana: возвращаем lamports rent-payer'у и обнуляем данные
        let remaining = account.balance;
        account.balance = 0;
        account.is_initialized = false;

        Ok(format!(
            "✅ Wallet '{owner}' closed. Returned {remaining} lamports."
        ))
    }

    fn list_accounts(&self) {
        println!("\n📋 All Accounts:");
        println!("{}", "─".repeat(60));
        if self.accounts.is_empty() {
            println!("  (no accounts)");
        }
        for account in self.accounts.values() {
            println!("  {account}");
            println!("    └─ {}", account.description());
        }
        println!("{}", "─".repeat(60));
    }
}

// ============================================================================
// 7. PARSE CLI ARGS — Парсинг аргументов командной строки
//    Аналог десериализации instruction_data из байтов
// ============================================================================
fn parse_instruction(args: &[String]) -> Result<Instruction, ProgramError> {
    if args.is_empty() {
        return Err(ProgramError::InvalidInstruction(
            "No command provided".to_string(),
        ));
    }

    match args[0].as_str() {
        "create" => {
            if args.len() < 3 {
                return Err(ProgramError::InvalidInstruction(
                    "Usage: create <owner> <balance>".to_string(),
                ));
            }
            let balance = args[2].parse::<u64>().map_err(|_| {
                ProgramError::InvalidInstruction("Balance must be a number".to_string())
            })?;
            Ok(Instruction::CreateWallet {
                owner: args[1].clone(),
                balance,
            })
        }
        "transfer" => {
            if args.len() < 4 {
                return Err(ProgramError::InvalidInstruction(
                    "Usage: transfer <from> <to> <amount>".to_string(),
                ));
            }
            let amount = args[3].parse::<u64>().map_err(|_| {
                ProgramError::InvalidInstruction("Amount must be a number".to_string())
            })?;
            Ok(Instruction::Transfer {
                from: args[1].clone(),
                to: args[2].clone(),
                amount,
            })
        }
        "balance" => {
            if args.len() < 2 {
                return Err(ProgramError::InvalidInstruction(
                    "Usage: balance <owner>".to_string(),
                ));
            }
            Ok(Instruction::GetBalance {
                owner: args[1].clone(),
            })
        }
        "close" => {
            if args.len() < 2 {
                return Err(ProgramError::InvalidInstruction(
                    "Usage: close <owner>".to_string(),
                ));
            }
            Ok(Instruction::CloseWallet {
                owner: args[1].clone(),
            })
        }
        cmd => Err(ProgramError::InvalidInstruction(format!(
            "Unknown command: '{cmd}'. Available: create, transfer, balance, close"
        ))),
    }
}

// ============================================================================
// MAIN — Точка входа
// ============================================================================
fn main() {
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║    🦀 Rust CLI — Solana Developer Concepts Demo        ║");
    println!("╚══════════════════════════════════════════════════════════╝");
    println!();

    let args: Vec<String> = env::args().collect();

    // Если есть аргументы — выполняем одиночную команду с сохранением состояния в .wallets.bin
    if args.len() > 1 {
        let state_path = Path::new(STATE_FILE);
        let mut processor = Processor::load_or_seed(state_path);

        let instruction_args = &args[1..];
        match parse_instruction(instruction_args) {
            Ok(instruction) => {
                println!("📨 Instruction: {instruction:?}");
                match processor.process_instruction(instruction) {
                    Ok(msg) => {
                        let _ = fs::write(state_path, processor.save_to_bytes());
                        println!("{msg}");
                    }
                    Err(e) => {
                        eprintln!("{e}");
                        process::exit(1);
                    }
                }
            }
            Err(e) => {
                eprintln!("{e}");
                process::exit(1);
            }
        }
        return;
    }

    // Если нет аргументов — запускаем полную демонстрацию из 13 шагов
    println!("🚀 Running full demo (no CLI args provided)...\n");

    let mut processor = Processor::new();

    let instructions = vec![
        // 1–2. Создаём кошельки
        Instruction::CreateWallet {
            owner: "alice".to_string(),
            balance: 10_000_000, // 0.01 SOL в lamports
        },
        Instruction::CreateWallet {
            owner: "bob".to_string(),
            balance: 5_000_000,
        },
        // 3. Попытка создать дубликат — ошибка AccountAlreadyExists
        Instruction::CreateWallet {
            owner: "alice".to_string(),
            balance: 100,
        },
        // 4–5. Проверяем балансы
        Instruction::GetBalance {
            owner: "alice".to_string(),
        },
        Instruction::GetBalance {
            owner: "bob".to_string(),
        },
        // 6. Переводим средства
        Instruction::Transfer {
            from: "alice".to_string(),
            to: "bob".to_string(),
            amount: 3_000_000,
        },
        // 7–8. Проверяем балансы после перевода
        Instruction::GetBalance {
            owner: "alice".to_string(),
        },
        Instruction::GetBalance {
            owner: "bob".to_string(),
        },
        // 9. Попытка перевести больше, чем есть — InsufficientFunds
        Instruction::Transfer {
            from: "alice".to_string(),
            to: "bob".to_string(),
            amount: 999_999_999,
        },
        // 10–11. Проверка защиты от переполнения u64 (ArithmeticOverflow)
        Instruction::CreateWallet {
            owner: "whale".to_string(),
            balance: u64::MAX,
        },
        Instruction::Transfer {
            from: "alice".to_string(),
            to: "whale".to_string(),
            amount: 1,
        },
        // 12. Закрываем кошелёк bob
        Instruction::CloseWallet {
            owner: "bob".to_string(),
        },
        // 13. Попытка перевести на закрытый аккаунт — AccountClosed
        Instruction::Transfer {
            from: "alice".to_string(),
            to: "bob".to_string(),
            amount: 100,
        },
    ];

    for (i, instruction) in instructions.iter().enumerate() {
        println!("─── Step {} ───", i + 1);
        println!("📨 {instruction:?}");

        match processor.process_instruction(instruction.clone()) {
            Ok(msg) => println!("{msg}"),
            Err(e) => eprintln!("{e}"),
        }
        println!();
    }

    processor.list_accounts();

    println!("\n📖 CLI Usage:");
    println!("  cargo run -- create <name> <balance>");
    println!("  cargo run -- transfer <from> <to> <amount>");
    println!("  cargo run -- balance <name>");
    println!("  cargo run -- close <name>");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_deserialize_roundtrip() {
        let acct = WalletAccount {
            owner: "alice".to_string(),
            balance: 10_000_000,
            is_initialized: true,
        };
        let bytes = acct.serialize();
        let decoded = WalletAccount::deserialize(&bytes).expect("deserialize must succeed");
        assert_eq!(acct, decoded);
    }

    #[test]
    fn deserialize_rejects_corrupted_bytes() {
        assert!(matches!(
            WalletAccount::deserialize(&[1, 2, 3]),
            Err(ProgramError::SerializationError(_))
        ));
        let mut bytes = WalletAccount {
            owner: "bob".to_string(),
            balance: 500,
            is_initialized: true,
        }
        .serialize();
        bytes[0] = 9; // invalid bool tag
        assert!(matches!(
            WalletAccount::deserialize(&bytes),
            Err(ProgramError::SerializationError(_))
        ));
    }

    #[test]
    fn create_and_duplicate_wallet_rejected() {
        let mut proc = Processor::new();
        proc.process_instruction(Instruction::CreateWallet {
            owner: "alice".to_string(),
            balance: 1_000,
        })
        .unwrap();
        let err = proc
            .process_instruction(Instruction::CreateWallet {
                owner: "alice".to_string(),
                balance: 500,
            })
            .unwrap_err();
        assert_eq!(err, ProgramError::AccountAlreadyExists("alice".to_string()));
    }

    #[test]
    fn transfer_updates_balances_and_rejects_insufficient_funds() {
        let mut proc = Processor::new();
        proc.create_wallet("alice", 1_000).unwrap();
        proc.create_wallet("bob", 200).unwrap();

        proc.transfer("alice", "bob", 300).unwrap();
        assert_eq!(proc.accounts["alice"].balance, 700);
        assert_eq!(proc.accounts["bob"].balance, 500);

        let err = proc.transfer("alice", "bob", 800).unwrap_err();
        assert_eq!(
            err,
            ProgramError::InsufficientFunds {
                available: 700,
                requested: 800
            }
        );
    }

    #[test]
    fn transfer_rejects_u64_overflow() {
        let mut proc = Processor::new();
        proc.create_wallet("alice", 100).unwrap();
        proc.create_wallet("whale", u64::MAX).unwrap();

        let err = proc.transfer("alice", "whale", 1).unwrap_err();
        assert_eq!(err, ProgramError::ArithmeticOverflow);
        // Баланс отправителя не должен измениться при ошибке получателя
        assert_eq!(proc.accounts["alice"].balance, 100);
    }

    #[test]
    fn close_wallet_zeros_balance_and_blocks_transfers() {
        let mut proc = Processor::new();
        proc.create_wallet("alice", 1_000).unwrap();
        proc.create_wallet("bob", 500).unwrap();
        proc.close_wallet("bob").unwrap();

        assert_eq!(proc.accounts["bob"].balance, 0);
        assert!(!proc.accounts["bob"].is_initialized);
        assert_eq!(
            proc.transfer("alice", "bob", 10).unwrap_err(),
            ProgramError::AccountClosed("bob".to_string())
        );
    }

    #[test]
    fn processor_state_persistence_roundtrip() {
        let mut proc = Processor::new();
        proc.create_wallet("alice", 42_000).unwrap();
        proc.create_wallet("bob", 99_000).unwrap();
        let bytes = proc.save_to_bytes();
        let restored = Processor::load_from_bytes(&bytes).unwrap();
        assert_eq!(restored.accounts["alice"], proc.accounts["alice"]);
        assert_eq!(restored.accounts["bob"], proc.accounts["bob"]);
    }
}
