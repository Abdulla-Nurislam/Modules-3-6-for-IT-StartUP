# Неделя 3 — Rust для Solana-разработчика

| | |
|---|---|
| **Задание** | Создать небольшую CLI-программу на Rust с использованием конструкций, которые понадобятся в Solana-разработке |
| **РО** | РО2 — разработка Solana Programs на Rust |
| **Исходный код** | [`src/main.rs`](src/main.rs) |

## Что сделано

Консольная утилита на Rust, моделирующая жизненный цикл аккаунтов, бинарную сериализацию/десериализацию и обработку инструкций в Solana без внешних зависимостей:

| Конструкция в [`src/main.rs`](src/main.rs) | Аналог в Solana Program |
|---|---|
| `enum Instruction` (`CreateWallet`, `Transfer`, `GetBalance`, `CloseWallet`) | Enum инструкций программы (Borsh-дискриминатор + аргументы) |
| `struct WalletAccount` (`owner`, `balance`, `is_initialized`) | Данные on-chain аккаунта (`AccountInfo::data`) |
| `trait Serializable` (`serialize(&self) -> Vec<u8>`, `deserialize(&[u8]) -> Result<Self, ProgramError>`) | Двусторонняя бинарная сериализация (1 байт флага + `u32` длина строки + UTF-8 + `u64` little-endian), аналогично `BorshSerialize` / `BorshDeserialize` |
| `enum ProgramError` (`AccountNotFound`, `AccountAlreadyExists`, `InsufficientFunds`, `ArithmeticOverflow`, `AccountClosed`, `InvalidInstruction`, `SerializationError`) | `solana_program::program_error::ProgramError` и кастомные коды ошибок Anchor |
| `Processor::process_instruction` | Точка входа `entrypoint!(process_instruction)`, роутинг через `match` и безопасная арифметика `checked_sub` / `checked_add` |

## Запуск и тесты

```bash
# Юнит-тесты (7 тестов: round-trip сериализации, дубликаты, переводы, переполнение u64, закрытие аккаунта)
cargo test

# Полный демонстрационный сценарий из 13 шагов
cargo run

# Вызов отдельных CLI-команд (состояние сохраняется между вызовами в .wallets.bin, при ошибке возвращается exit code 1)
cargo run -- create charlie 10000000
cargo run -- transfer alice charlie 250000
cargo run -- balance charlie
cargo run -- close charlie
```

## Проверка

В режиме без аргументов (`cargo run`) программа последовательно выполняет 13 шагов (позитивные и негативные сценарии):
1. Создание двух кошельков (`alice` и `bob`) с сериализацией состояния в `Vec<u8>` и проверкой десериализации.
2. Отказ при повторной инициализации (`AccountAlreadyExists`).
3. Перевод `3_000_000` lamports от `alice` к `bob`.
4. Отказ при попытке перевести больше доступного баланса (`InsufficientFunds`).
5. Защита от арифметического переполнения баланса получателя `u64::MAX + 1` (`ArithmeticOverflow`).
6. Закрытие аккаунта `bob` (`CloseWallet`) с обнулением баланса и флага `is_initialized = false`.
7. Отказ при переводе на закрытый аккаунт (`AccountClosed`).
