# Неделя 4 — Первая Solana Program (Native Counter)

| | |
|---|---|
| **Задание** | Написать и задеплоить первую Solana Program (Hello World / Counter) в Devnet |
| **РО** | РО2 — разработка Solana Programs на Rust; РО3 — работа с тестовой сетью Solana Devnet |
| **Program ID (Devnet)** | [`F5drLsn3jPFrcZM9S4Yb9aFK32s8xY52ME6jDXgaUUV`](https://explorer.solana.com/address/F5drLsn3jPFrcZM9S4Yb9aFK32s8xY52ME6jDXgaUUV?cluster=devnet) |
| **Account (Devnet)** | [`H18nD4G1zUrd3jEtyb5yZ8J9XKmQxZ9vK5H4R5xG1b8B`](https://explorer.solana.com/address/H18nD4G1zUrd3jEtyb5yZ8J9XKmQxZ9vK5H4R5xG1b8B?cluster=devnet) |
| **Подтверждающая транзакция** | [`2NUF6YJ1…DDjmN86`](https://explorer.solana.com/tx/2NUF6YJ1SwYwhzXsCm2EfD95i2syojecxzSde7MSWSnby2JUDF7QWQQNrYnXtoSDHavLrAqxGBZxDWsuaDDjmN86?cluster=devnet) (`Initialize` + `Increment` × 3 + `Set(42)` + `Decrement`) |

## Архитектура

```
week-04-native-program/
├── src/
│   └── lib.rs           # Программа: entrypoint, инструкции, проверки безопасности, юнит-тесты
├── client/
│   ├── client.ts        # TypeScript-клиент (@solana/web3.js, fallback на Devnet Program ID)
│   ├── package.json
│   └── tsconfig.json
└── Cargo.toml
```

## Инструкции программы и проверки безопасности

Каждая мутирующая инструкция проходит валидацию в `validate_counter_account`:
1. `counter_account.owner == program_id` (`ProgramError::IncorrectProgramId`)
2. `counter_account.is_writable` (`ProgramError::InvalidArgument`)
3. `counter_account.data_len() >= 8` (`ProgramError::AccountDataTooSmall`)
4. Наличие подписи (`authority.is_signer` или `counter_account.is_signer` → `ProgramError::MissingRequiredSignature`)

| Инструкция | Описание |
|-----------|----------|
| `Initialize` | Инициализирует счётчик (`count = 0`) |
| `Increment` | Увеличивает счётчик на 1 (`checked_add`, защита от переполнения) |
| `Decrement` | Уменьшает счётчик на 1 (`checked_sub`, отказ при `count == 0`) |
| `Set { value }` | Устанавливает конкретное значение `u64` |

## Тесты, сборка и деплой

```bash
# Юнит-тесты (4 теста: Borsh-сериализация, полный цикл process_instruction, отказ при неверном owner/writable/signer/underflow)
cargo test

# Сборка SBF-бинарника
PATH="$HOME/.cargo/bin:$PATH" cargo build-sbf

# Деплой в Devnet
solana program deploy target/deploy/first_solana_program.so
```

## Клиент

Клиент автоматически использует задеплоенный в Devnet адрес `F5drLsn3jPFrcZM9S4Yb9aFK32s8xY52ME6jDXgaUUV`, если локальный `target/deploy/first_solana_program-keypair.json` отсутствует:

```bash
cd client
npm install
npx ts-node --esm client.ts
```
