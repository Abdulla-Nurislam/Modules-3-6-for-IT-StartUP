# Недели 15–16 — Питч, сценарий Live Demo (5–7 минут) и защита проекта

Документ подготовлен для **РК2 · Solana Demo Day (Неделя 15)** и **финальной защиты проекта (Неделя 16)** в соответствии с требованиями силлабуса курса.

---

## 1. Регламент и распределение ролей (6 минут 00 секунд)

| Время | Блок | Спикер | Что на экране |
|:---:|---|---|---|
| **0:00 – 1:00** | Проблема рынка и ценность Roofic на Solana | **Әбілдаев Нұрым** *(Team Lead)* | Герой-секция Capstone dApp (`localhost:3014`) + телеметрия Pyth / Jupiter |
| **1:00 – 2:15** | RWA-архитектура (SPV), стейблкоины и юнит-экономика комиссий | **Йылмаз Мухаммедали** *(Product & Analyst)* | Схема SPV и таблица сценариев из [`RWA_DESIGN.md`](../week-13-rwa-design/RWA_DESIGN.md) / [`PAYMENTS.md`](../week-13-rwa-design/PAYMENTS.md) |
| **2:15 – 4:30** | **Live Demo:** скоринг доходности/риска, KYC, покупка долей Token-2022 и вывод аренды в USDC | **Кадирханов Жангир** *(Full-stack / Security)* & **Абдулла Нурислам** *(Lead Dev)* | Рабочее приложение [`capstone/app`](../capstone/app/) + Solana Explorer Devnet |
| **4:30 – 6:00** | Архитектура смарт-контракта, PDA seeds, безопасность (Week 12 → Capstone) | **Абдулла Нурислам** *(Lead Dev)* | Код [`programs/roofic/src/lib.rs`](../capstone/programs/roofic/src/lib.rs) и панель Admin/Pause |

---

## 2. Пошаговый сценарий выступления и Live Demo

### Блок 1 (0:00 – 1:00) · Проблема и решение (Нұрым)
- **Проблема:** Порог входа в доходную недвижимость — от \$50 000–\$100 000, сделки занимают недели, а распределение арендного дохода непрозрачно.
- **Решение Roofic:** Платформа фракционной токенизации арендной недвижимости на Solana со стоимостью одной доли **\$100 USDC**.
- **Почему именно блокчейн Solana:**
  1. Программируемые расширения **Token-2022** (`NonTransferable`, `TransferFeeConfig`, on-chain `TokenMetadata`).
  2. Мгновенная финализация и комиссии доли цента позволяют выплачивать арендный доход хоть каждую неделю без банковских издержек.
  3. Неизменяемая привязка отчёта оценки и риска объекта к смарт-контракту через SHA-256 хэш (`valuation_hash`).

### Блок 2 (1:00 – 2:15) · Бизнес-модель, RWA и юнит-экономика (Мухаммедали)
- **Юридическая связка (SPV):** Токен представляет долю участия и право на доход в SPV (специальном юрлице под конкретный объект), что изолирует риски между объектами.
- **Отказ от расчётов в SOL в пользу USDC:** На неделе 8 в MVP расчёты шли в SOL, но волатильность SOL в 30% съедает 6–8% годовой рентной доходности. В Capstone все расчёты переведены на стейблкоины через `TokenInterface` и `transfer_checked` (поддерживаются и классический SPL Token USDC, и Token-2022 PYUSD), а в шапке терминала в реальном времени работают ончейн-оракулы **Pyth (`SOL/USD`, `USDC/USD`)** и котировка **Jupiter v6 (`1 SOL → USDC`)**.
- **Почему в контракте две комиссии (`rent_fee_bps` и `sale_fee_bps`):**
  - Наша финансовая модель ([`unit_economics.py`](../week-13-rwa-design/model/unit_economics.py)) показала: при комиссии 1% с аренды один объект за \$100 000 приносит платформе всего **\$62 в год** — для окупаемости затрат \$36 000/год понадобилось бы **580 объектов**.
  - Добавление разовой комиссии при первичном размещении (`sale_fee_bps = 150` bps = 1.5%, удерживается с владельца объекта) снижает точку безубыточности до **24 листингов в год**.

### Блок 3 (2:15 – 4:30) · Live Demo в реальном времени (Жангир + Нурислам)

**Подготовка перед выходом (терминал):**
```bash
cd capstone/app && npm run dev    # открыт http://localhost:3014 с подключённым кошельком Devnet
```

1. **Модуль оценки доходности и риска (2:15 – 3:00):**
   - В секции модели оценки выбираем пресет **«Almaty Loft #1»** (\$100 000, валовая доходность 9.5%, вакантность 7%, OpEx 18%, УК 5%, возраст 4 года).
   - Показываем три сценария чистой доходности инвестора: **Bear 4.95% · Base 6.73% · Bull 8.09%** и риск-грейд **B (37 / 100)** с разложением по 4 факторам.
   - Нажимаем **«Сверить с Python `scoring/engine.py`»** — появляется зелёная метка `✓ PYTHON MATCH` и 32-байтный SHA-256 хэш `0x65801abf07…`, который записывается ончейн при создании объекта.
2. **KYC-проверка и покупка долей (3:00 – 3:45):**
   - В контуре инвестора виден бейдж `✓ VERIFIED` (PDA `["investor", wallet]`) и баланс Demo USDC.
   - На карточке объекта **Almaty Loft #1** виден верифицированный ончейн-хэш `SHA-256: 0x65801abf07…`, бейдж эмитента `✓ Verified SPV`, эквивалент цены в SOL по оракулу Pyth и бейдж `Grade B · Risk 37/100`.
   - Вводим `5` долей и нажимаем **«Купить 5 долей за \$500 USDC»** (`buy_shares`). Подписываем транзакцию в кошельке.
   - Показываем уведомление со ссылкой на **Solana Explorer**: инвестор заплатил ровно \$500 USDC (\$492.50 ушло владельцу, \$7.50 — комиссия 1.5% в казну), а на кошелёк выпущены 5 долей **Token-2022 (`NonTransferable`)**.
3. **Внесение аренды и вывод дохода (3:45 – 4:30):**
   - Во вкладке «УК (Manager)» вводим `100` USDC и нажимаем **«Внести \$100 USDC в пул»** (`deposit_rent`). 1% (\$1 USDC) уходит в казну, \$99 USDC поступает в `vault` объекта, а аккумулятор `acc_rent_per_share` мгновенно пересчитывает выплаты всем держателям за $O(1)$.
   - Переходим во вкладку «Позиция» и нажимаем **«Вывести доход в USDC (claim_rent)»** — накопленный доход в USDC переводится из `vault` по PDA-подписи объекта на счёт инвестора.

### Блок 4 (4:30 – 6:00) · Техническая защита архитектуры и безопасности (Нурислам)
- Открываем секцию **«Управление протоколом»**:
  - Показываем, что аварийная пауза (`set_paused(true)`) останавливает листинг, покупку долей и внесение аренды, но **никогда не блокирует `claim_rent`**, чтобы средства инвесторов в `vault` никогда не могли быть заблокированы администратором.
  - Показываем разделение ролей (`admin`, `owner` с KYB, `manager`, `investor` с KYC) и покрытие контракта **22 интеграционными тестами LiteSVM** (включая защиту от сжигания share-токенов, защиту `initialize_platform` через `ProgramData` и закон сохранения денег до копейки).

---

## 3. Техническое обоснование для личной защиты (Неделя 16 · Q&A)

### Вопрос 1: Обоснуйте выбор и расчёт комиссий в смарт-контракте
- **Как устроено в коде ([`lib.rs`](../capstone/programs/roofic/src/lib.rs)):**
  - Две настраиваемые ставки в базисных пунктах (`1 bps = 0.01%`) хранятся в `PlatformConfig`: `sale_fee_bps` и `rent_fee_bps`.
  - Установлен жёсткий потолок на уровне смарт-контракта: `pub const MAX_FEE_BPS: u16 = 2_000` (20%). Любая попытка `initialize_platform` или `set_fees` установить комиссию выше 20% отвергается с ошибкой `RooficError::FeeTooHigh` (`6003`, проверено тестом `only_the_admin_can_pause_and_fees_are_capped`).
  - При покупке долей (`buy_shares`) инвестор платит ровно `cost = shares * price_per_share`; комиссия `fee = cost * sale_fee_bps / 10_000` удерживается из выручки продавца (`to_owner = cost - fee`), поэтому цена входа для инвестора всегда прозрачна.
  - При внесении аренды (`deposit_rent`) комиссия `fee = amount * rent_fee_bps / 10_000` переводится в `treasury`, а чистый доход `net = amount - fee` зачисляется в `vault` и распределяется через `acc_rent_per_share`.

### Вопрос 2: Как реализована проверка прав доступа (Access Control)?
В системе строго разделены **4 роли**:
1. **`admin` (Платформа):** при инициализации `initialize_platform` проверяется, что `admin` является `upgrade_authority` программы через аккаунт `ProgramData` (`program_data.upgrade_authority_address == Some(admin.key())`). В остальных инструкциях проверяется через `#[account(seeds = [b"config"], bump = config.bump, has_one = admin @ RooficError::NotAdmin)]` и `admin: Signer<'info>`. Может вызывать `set_paused`, `set_fees`, `set_admin`, `approve_investor`, `revoke_investor`. Не может забрать деньги из `vault` (authority у `vault` — PDA объекта, а не админ).
2. **`owner` (Эмитент / Владелец недвижимости):** обязан иметь верифицированный PDA `owner_kyc` (`seeds = [b"investor", owner.key().as_ref()]`) для вызова `create_property` (тест `unapproved_issuer_cannot_create_property`) и получает выручку от продажи долей (`token::authority = property.owner` на аккаунте `owner_payment`).
3. **`manager` (Управляющая компания):** зафиксирован в `Property.manager` и проверяется через `has_one = manager @ RooficError::NotManager` + `manager: Signer<'info>`. Только `manager` может вызывать `deposit_rent` (даже `owner` получит отказ `NotManager`, что доказано тестом `only_the_property_manager_can_deposit_rent`).
4. **`investor` (Верифицированный инвестор):** при вызове `buy_shares` обязан предоставить существующий PDA `investor_record` с `seeds = [b"investor", investor.key().as_ref()]`, который может создать только `admin`. После отзыва KYC (`revoke_investor`) новые покупки блокируются, но вывод уже начисленной аренды через `claim_rent` остаётся доступным (тест `revoked_investor_can_still_claim_accrued_rent`).

### Вопрос 3: Обоснуйте выбор seeds для всех PDA
Все 6 PDA-адресов спроектированы так, чтобы клиент находил любой аккаунт детерминированно без стороннего индексера, а программа имела эксклюзивное право подписи (`invoke_signed`):

| PDA-аккаунт | Seeds | Обоснование выбора |
|---|---|---|
| `PlatformConfig` | `[b"config"]` | Глобальный синглтон конфигурации платформы (1 на программу) |
| `Investor` | `[b"investor", wallet.key()]` | Строго 1 KYC/KYB-запись на кошелёк; проверка наличия допуска за $O(1)$ прямо в constraints `CreateProperty` и `BuyShares` |
| `Property` | `[b"property", owner.key(), &id.to_le_bytes()]` | Один верифицированный эмитент может залистить несколько объектов с разными `id`; сам `Property` PDA выступает **mint authority** для `share_mint` и **token authority** для `vault` |
| `share_mint` | `[b"share_mint", property.key()]` | Однозначная связь 1-к-1 между объектом и его Token-2022 mint долей |
| `vault` | `[b"vault", property.key()]` | Изолированное хранилище арендного дохода каждого объекта (средства разных объектов никогда не смешиваются в общем пуле) |
| `Position` | `[b"position", property.key(), investor.key()]` | Уникальная позиция инвестора в конкретном объекте; поскольку `investor` — `Signer`, никто не может передать чужой `Position` в `claim_rent` |

### Вопрос 4: Как программа защищена от типовых и продвинутых атак?
1. **Missing Signer Check (Неделя 12, Баг 1):** Все управляющие аккаунты (`admin`, `owner`, `manager`, `investor`) типизированы как `Signer<'info>`.
2. **Missing Ownership / Relationship Check (Неделя 12, Баг 2):** Связи между аккаунтами закреплены через `has_one = admin`, `has_one = manager`, `has_one = share_mint`, `has_one = vault`, `address = config.payment_mint`, `address = config.treasury`, `token::authority = property.owner`.
3. **Arithmetic Overflow / Underflow (Неделя 12, Баг 3):** Вся математика стоимости, комиссий и аккумулятора использует `checked_mul`, `checked_add`, `checked_sub` с возвратом `RooficError::MathOverflow` + в `Cargo.toml` включён `overflow-checks = true`. Масштаб аккумулятора `ACC_SCALE = 1_000_000_000_000` (`u128`) защищает от потери точности при делении.
4. **Type Cosplay / Fake Account Owner (Неделя 12, Баг 4):** Все аккаунты состояния десериализуются через типизированные `Account<'info, T>` и `InterfaceAccount<'info, T>`, которые автоматически проверяют 8-байтный дискриминатор и программу-владельца.
5. **Arbitrary CPI (Неделя 12, Баг 5):** Программы токенов и системы передаются только через типизированные `Program<'info, Token2022>`, `Interface<'info, TokenInterface>`, `Program<'info, AssociatedToken>` и `Program<'info, System>` (проверено тестом `wrong_payment_token_program_is_rejected`).
6. **Front-Running `initialize_platform` (Неделя 12, Находка #6):** Инструкция `initialize_platform` проверяет `program.programdata_address()? == Some(program_data.key())` и `program_data.upgrade_authority_address == Some(admin.key())` (тест `initialize_platform_rejects_non_upgrade_authority`).
7. **Защита от рассинхронизации `Position.shares` и `share_mint.supply` (Transfer & Burn Invariance):**
   - Расширение Token-2022 **`NonTransferable`** блокирует переводы долей между кошельками (`shares_cannot_be_transferred_between_wallets`).
   - Поскольку Token-2022 разрешает владельцу токена вызвать `Burn` на `NonTransferable` токене, программа в `buy_shares` и `deposit_rent` опирается исключительно на монотонный счётчик `property.shares_sold` (`= Σ Position.shares`), а не на `share_mint.supply`. Даже если держатель сожжёт свои share-токены, он не сможет ни выкупить доли сверх `total_shares`, ни завысить свою долю в `vault` (доказано регрессионными тестами `burning_share_tokens_cannot_steal_other_holders_rent` и `burning_share_tokens_cannot_oversell_beyond_total_shares`).
8. **Защита от `payment_mint` с комиссией на перевод (`TransferFeeConfig`):** При `initialize_platform` функция `assert_clean_payment_mint` инспектирует TLV-расширения Token-2022 и отвергает расчётные токены с `TransferFeeConfig`, `TransferHook` или `PermanentDelegate` (тест `fee_bearing_payment_mint_is_rejected_at_init`), гарантируя, что в `vault` всегда поступает ровно `net = amount - fee`.
