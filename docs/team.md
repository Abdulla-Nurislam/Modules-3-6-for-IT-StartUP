# Команда Roofic и матрица вклада участников

| Участник | Роль | Ключевые артефакты в репозитории |
|----------|------|----------------------------------|
| **Абдулла Нурислам** | Lead Developer (Solana / Rust / Anchor) | Смарт-контракты [`capstone/programs/roofic/src/lib.rs`](../capstone/programs/roofic/src/lib.rs), [`week-08-mvp/programs/roofic_mvp/src/lib.rs`](../week-08-mvp/programs/roofic_mvp/src/lib.rs), [`week-11-cpi/programs/`](../week-11-cpi/programs/), интеграционные тесты LiteSVM ([`roofic_test.rs`](../capstone/programs/roofic/tests/roofic_test.rs)), деплой в Devnet ([`docs/devnet-deployments.md`](devnet-deployments.md)) |
| **Кадирханов Жангир** | Full-stack, DeFi & Security / QA | Веб-приложения [`capstone/app/`](../capstone/app/), [`week-08-mvp/app/`](../week-08-mvp/app/), [`week-10-dashboard/`](../week-10-dashboard/), модуль скоринга [`capstone/scoring/engine.py`](../capstone/scoring/engine.py), DeFi/Pyth-интеграция [`week-09-defi/src/`](../week-09-defi/src/) и [`capstone/app/src/lib/defi.ts`](../capstone/app/src/lib/defi.ts), лаборатория эксплойтов [`week-12-security-lab/`](../week-12-security-lab/) |
| **Йылмаз Мухаммедали** | Product Manager & RWA / FinModel Analyst | Архитектура токенизации SPV и матрица рисков [`week-13-rwa-design/RWA_DESIGN.md`](../week-13-rwa-design/RWA_DESIGN.md), платёжная модель стейблкоинов [`week-13-rwa-design/PAYMENTS.md`](../week-13-rwa-design/PAYMENTS.md), эталонная финансовая модель и тесты водопада доходов [`week-13-rwa-design/model/unit_economics.py`](../week-13-rwa-design/model/unit_economics.py), аналитика протоколов [`week-09-defi/DEFI_LANDSCAPE.md`](../week-09-defi/DEFI_LANDSCAPE.md) |
| **Әбілдаев Нұрым** | Team Lead, Pitch & Compliance | Видение продукта, сценарий Demo Day и технические ответы для защиты [`docs/pitch-and-demo.md`](pitch-and-demo.md), бизнес-обоснование гибридной модели комиссий (`sale_fee_bps` + `rent_fee_bps`), приёмочное UX-тестирование пользовательских сценариев инвестора и управляющей компании |

## Распределение ответственности по неделям

| Неделя | Тема | Ведущий автор | Соавторы и ревью |
|-------:|------|---------------|------------------|
| 3–6 | Индивидуальные лабораторные (Rust CLI, Native, Anchor, PDA) | Нурислам | — |
| 7 | SPL Tokens & Token Extensions (`ROOF` Token-2022) | Нурислам | Жангир (скрипты проверки) |
| 8 | РК1 · Build Sprint: первый Web3 MVP | Нурислам (контракт), Жангир (UI) | Мухаммедали (user flow), Нұрым (питч РК1) |
| 9 | DeFi на Solana (Pyth, Jupiter, Kamino) | Жангир (`src/pyth.ts`, `jupiter.ts`, `yields.ts`) | Мухаммедали (`DEFI_LANDSCAPE.md`) |
| 10 | RPC, API и blockchain data (Solana Dashboard) | Жангир (`src/lib/solana.ts`, UI) | Нурислам (парсер транзакций и тесты) |
| 11 | CPI и composable applications (`roofic_shares` + `roofic_portfolio`) | Нурислам | Жангир (TypeScript e2e `demo.ts`) |
| 12 | Security & Exploit Lab (`exploit_lab` + `evil_program`) | Жангир | Нурислам (LiteSVM эксплойт-тесты) |
| 13 | RWA, Stablecoins и платежи (`RWA_DESIGN`, `PAYMENTS`, `unit_economics.py`) | Мухаммедали | Нұрым (юридическая рамка SPV), Жангир (модель риска) |
| 14 | Capstone Build Week (`roofic` + `scoring` + `app`) | Нурислам (контракт и деплой), Жангир (Next.js UI, DeFi, скоринг) | Мухаммедали (пресеты объектов и финмодель), Нұрым (QA и сценарий демо) |
| 15–16 | РК2 · Solana Demo Day и финальная защита | Нұрым (спикер #1), Мухаммедали (спикер #2) | Жангир (спикер #3, Live Demo), Нурислам (спикер #4, архитектура и безопасность) |

## Процесс командной разработки и интеграции
- Разработка велась в рамках еженедельных спринтов с совместным проектированием архитектуры (off-chain расчёты, аналитика и дизайн в Google Docs / локальных ветках участников) и последующей сборкой, проверкой тестов (`cargo test`, `unittest`, `npm test`) и пушем в единую ветку `main` ведущим разработчиком (**Абдулла Нурислам**).
- На защите (Недели 15–16) каждый участник защищает свой контур по регламенту [`docs/pitch-and-demo.md`](pitch-and-demo.md).
