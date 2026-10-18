# Неделя 6 — Accounts, PDAs и архитектура программ: On-Chain Профиль

| | |
|---|---|
| **Задание** | Создать децентрализованный on-chain профиль пользователя с детерминированной генерацией и валидацией PDA |
| **РО** | РО2 — работа с Accounts и Program Derived Addresses (PDA) в Anchor |
| **Program ID (Devnet)** | [`2RAyCS5nhX6osbmoqKeXoyXC9kxY57fvE4mRQxS3ZAdP`](https://explorer.solana.com/address/2RAyCS5nhX6osbmoqKeXoyXC9kxY57fvE4mRQxS3ZAdP?cluster=devnet) (tx: [`zPf65zfS…R46XmyaG`](https://explorer.solana.com/tx/zPf65zfShoMNQfzuC4tV9aDeUv7w5AEqjBt8JbogYqaxk6D9HV2sof4uVJQ6CbHo8i9CYxHPVJ7upoTR46XmyaG?cluster=devnet)) |

## Что сделано

Программа [`profile_program`](programs/profile_program/src/lib.rs), управляющая децентрализованным профилем пользователя (`UserProfile`), адрес которого однозначно выводится из публичного ключа владельца без необходимости хранить таблицу адресов:

| Инструкция | Описание |
|------------|----------|
| `create_profile(name, bio, avatar_url)` | Инициализирует PDA `["profile", authority]`, проверяет лимиты длины строк и записывает `created_at` / `updated_at` из `Clock::get()` |
| `update_profile(name?, bio?, avatar_url?)` | Частичное обновление полей через `Option<String>` (только владелец профиля) |
| `delete_profile()` | Закрывает PDA профиля (`close = authority`) и возвращает rent-exempt баланс владельцу |

### Структура аккаунта `UserProfile` (`InitSpace`)
- `authority: Pubkey` (32 байта)
- `name: String` (`#[max_len(50)]` — до 50 байт UTF-8)
- `bio: String` (`#[max_len(200)]` — до 200 байт UTF-8)
- `avatar_url: String` (`#[max_len(200)]` — до 200 байт UTF-8)
- `created_at: i64`, `updated_at: i64` (по 8 байт)
- `bump: u8` (1 байт — канонический bump сохраняется при инициализации и проверяется при каждом обновлении)

## Сборка и тесты (LiteSVM)

```bash
anchor build
cargo test
```

В [`programs/profile_program/tests/profile_test.rs`](programs/profile_program/tests/profile_test.rs) реализованы **7 интеграционных тестов**:

| Тест | Что проверяет |
|------|---------------|
| `test_create_profile` | Детерминированный вывод PDA `["profile", authority]` и запись данных |
| `test_update_profile` | Частичное обновление `name` и `bio` с сохранением `avatar_url` |
| `test_delete_profile` | Удаление аккаунта и освобождение памяти |
| `test_name_too_long` | Отказ при превышении лимита `MAX_NAME_LEN = 50` (`NameTooLong`) |
| `test_empty_name` | Отказ при пустом имени (`NameEmpty`) |
| `test_unauthorized_update` | Отказ при попытке изменить чужой профиль (`ConstraintSeeds` / `Unauthorized`) |
| `test_duplicate_profile` | Невозможность создать второй профиль на тот же кошелёк |

## Запуск TypeScript-клиента

```bash
npx ts-node app/client.ts
```

