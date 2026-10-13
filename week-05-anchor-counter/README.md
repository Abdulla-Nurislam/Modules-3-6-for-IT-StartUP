# Неделя 5 — Anchor Framework: Counter Program

| | |
|---|---|
| **Задание** | Создать Counter Program на фреймворке Anchor и взаимодействовать с ней через клиентский скрипт |
| **РО** | РО2 — разработка Solana Programs с использованием Rust и Anchor Framework |
| **Program ID (Devnet)** | [`5ACn229Xq3arXb1MgF4Ux1iXY9yRTrN7VkaALLLttnLv`](https://explorer.solana.com/address/5ACn229Xq3arXb1MgF4Ux1iXY9yRTrN7VkaALLLttnLv?cluster=devnet) (tx: [`317AKeHQ…mtLc8J4N`](https://explorer.solana.com/tx/317AKeHQWENuVgPCfWL4uKBrRDWejws4rwXESygzpWxACmcpVi2gNeMorXFKNnFZyBMpjwtp7nqvJQJMmtLc8J4N?cluster=devnet)) |

## Что сделано

Переход от нативной программы (неделя 4) к фреймворку **Anchor**: автоматическая генерация 8-байтных дискриминаторов, IDL, декларативная валидация аккаунтов через `#[derive(Accounts)]` и хранение состояния в детерминированном PDA.

| Файл | Назначение |
|------|-----------|
| [`programs/counter_program/src/lib.rs`](programs/counter_program/src/lib.rs) | Смарт-контракт `counter_program`: `initialize`, `increment`, `decrement`, `set`, `close` |
| [`programs/counter_program/tests/counter_test.rs`](programs/counter_program/tests/counter_test.rs) | 7 интеграционных тестов на базе LiteSVM с десериализацией состояния и проверкой кодов ошибок |
| [`client/client.ts`](client/client.ts) | TypeScript-клиент (`@coral-xyz/anchor`) для вызова всех инструкций в Devnet |

### Архитектура и ограничения (Constraints)
- **PDA счётчика:** `seeds = [b"counter", authority.key().as_ref()]` — у каждого кошелька собственный детерминированный счётчик.
- **Контроль прав доступа:** `has_one = authority` + `authority: Signer<'info>` гарантируют, что изменить или закрыть счётчик может только его владелец.
- **Безопасная арифметика:** `checked_add(1)` и `require!(counter.count > 0, ErrorCode::Underflow)`.
- **Возврат rent:** инструкция `close` использует `#[account(mut, close = authority)]` для обнуления данных и возврата lamports владельцу.

## Сборка и тесты (LiteSVM)

```bash
anchor build
cargo test
```

| Тест | Что проверяет |
|------|---------------|
| `test_initialize` | Создание PDA счётчика (`8 + 8 + 32 + 1 = 49` байт) и проверка полей `count == 0`, `authority`, `bump` |
| `test_increment` | Трёхкратное увеличение счётчика с проверкой `count == 1..3` |
| `test_decrement` | Уменьшение счётчика после инкремента (`1 → 0`) |
| `test_decrement_underflow_fails` | Отказ при декременте от `0` с кодом ошибки `ErrorCode::Underflow` (`6001`) |
| `test_set_value` | Установка произвольного значения (`42`) владельцем |
| `test_close` | Закрытие аккаунта и возврат rent |
| `test_unauthorized_update_fails` | Попытка изменения чужого счётчика сторонним подписантом отвергается с `ConstraintSeeds` (`2006`) |

## Запуск TypeScript-клиента (Devnet)

Перед первым запуском клиента убедитесь, что выполнен `anchor build` (генерирует `target/idl/counter_program.json`):

```bash
anchor build
cd client
npm install
npm start
```
