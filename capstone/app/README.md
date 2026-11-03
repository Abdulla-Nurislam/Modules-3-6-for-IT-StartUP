# Roofic Capstone Frontend (`capstone/app`)

Веб-терминал институциональной токенизации арендной недвижимости **Roofic** на **Next.js 16 + Solana Wallet Adapter + `@anchor-lang/core` + `@solana/spl-token`**.

## Возможности

1. **Обзор протокола и DeFi-телеметрия (`#overview`):**
   - Чтение `PlatformConfig` PDA (`admin`, `payment_mint`, `treasury`, `rent_fee_bps`, `sale_fee_bps`, `paused`).
   - Ончейн-чтение пулл-оракулов **Pyth (`PriceUpdateV2`)** для `SOL/USD` и `USDC/USD` с проверкой владельца (`rec5EKMG…`), уровня верификации `Full`, возраста котировки и доверительного интервала `price ± conf`.
   - Живая котировка маршрута **Jupiter v6 (`1 SOL → USDC`)** и бенчмарк доходности резерва **Kamino USDC**.
2. **Контур инвестора (`#investor`):**
   - Проверка и демо-активация ончейн-допуска KYC (`Investor` PDA `["investor", wallet]`).
   - Баланс расчётного стейблкоина (Demo USDC) и песочница-кран (`/api/faucet`, защищён лимитом суммы, rate-limit и проверкой кластера Devnet).
3. **Каталог объектов RWA (`#properties`):**
   - Покупка долей Token-2022 (`NonTransferable`) за USDC (`buy_shares`).
   - Вывод накопленного арендного дохода из `vault` PDA (`claim_rent`, работает даже при аварийной паузе протокола).
   - Внесение арендного дохода управляющей компанией (`deposit_rent`, доступно только `Property.manager`).
4. **Модель оценки и риска (`#scoring`) + Эмиссия объекта (`#create`):**
   - Расчёт чистой доходности инвестора (`bear` / `base` / `bull`), 4-факторного риск-скора (`0..100`, грейды `A`–`D`) и канонического `SHA-256` хэша (`valuation_hash`).
   - Сверка клиентского расчёта (`src/lib/scoring.ts`) с эталонным Python-модулем [`../scoring/engine.py`](../scoring/engine.py) через `/api/score`.
   - Регистрация нового объекта в Solana Devnet (`create_property`, требует верифицированного `owner_kyc` PDA эмитента).
5. **Управление протоколом (`#admin`):**
   - Управление белым списком KYC (`approve_investor` / `revoke_investor`), комиссиями (`set_fees`) и аварийным рубильником (`set_paused`).

## Быстрый старт

```bash
npm install
npm run sync-idl      # синхронизирует IDL и типы из ../target после anchor build
npm run typecheck     # проверка типов TypeScript
npm run dev           # запуск на http://localhost:3014
```

Для первичного наполнения Devnet демонстрационными объектами (требуется ключ администратора в `~/.config/solana/id.json`):

```bash
npm run seed
```

