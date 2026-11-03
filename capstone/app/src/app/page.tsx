"use client";

import { BN, type IdlAccounts, type ProgramAccount } from "@anchor-lang/core";
import {
  ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Roofic } from "@/idl/roofic";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PROGRAM_ID,
  SHARE_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  bpsOf,
  configPda,
  explorerAddress,
  explorerTx,
  formatToken,
  investorPda,
  pendingRent,
  positionPda,
  propertyPda,
  shareMintPda,
  shortKey,
  toRawUnits,
  useProgram,
  useReadonlyProgram,
  vaultPda,
} from "@/lib/program";
import {
  KNOWN_REPORTS_BY_HASH,
  PRESET_CATALOG,
  bytesToHex,
  evaluateProperty,
  type PropertyInput,
  type ScoreReport,
} from "@/lib/scoring";
import { useDeFiTelemetry } from "@/lib/defi";

type PlatformConfig = IdlAccounts<Roofic>["platformConfig"];
type Property = ProgramAccount<IdlAccounts<Roofic>["property"]>;
type Position = IdlAccounts<Roofic>["position"];
type InvestorRecord = IdlAccounts<Roofic>["investor"];
type Toast = { kind: "ok" | "error"; text: string; sig?: string } | null;

export default function CapstonePage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const program = useProgram();
  const reader = useReadonlyProgram();
  const defi = useDeFiTelemetry();

  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [paymentDecimals, setPaymentDecimals] = useState<number>(6);
  const [paymentTokenProgram, setPaymentTokenProgram] = useState<PublicKey>(TOKEN_PROGRAM_ID);
  const [usdcBalance, setUsdcBalance] = useState<bigint>(BigInt(0));
  const [myKyc, setMyKyc] = useState<InvestorRecord | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [customReports, setCustomReports] = useState<
    Record<string, { input: PropertyInput; report: ScoreReport }>
  >({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  // Scoring Engine & Create Property shared state
  const [scoreInput, setScoreInput] = useState<PropertyInput>(PRESET_CATALOG[0].input);
  const [sharesToCreate, setSharesToCreate] = useState<number>(PRESET_CATALOG[0].totalShares);
  const [priceUsdc, setPriceUsdc] = useState<number>(PRESET_CATALOG[0].pricePerShareUsdc);
  const [managerStr, setManagerStr] = useState<string>("");
  const [pyVerifiedHash, setPyVerifiedHash] = useState<string | null>(null);

  // Sync aria-invalid with CSS :user-invalid state
  useEffect(() => {
    const syncAria = (target: EventTarget | null) => {
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      if (typeof CSS !== "undefined" && CSS.supports("selector(:user-invalid)")) {
        target.setAttribute("aria-invalid", target.matches(":user-invalid") ? "true" : "false");
      } else {
        const valid = target.checkValidity();
        target.classList.toggle("user-invalid-fallback", !valid);
        target.classList.toggle("user-valid-fallback", valid);
        target.setAttribute("aria-invalid", !valid ? "true" : "false");
      }
    };
    const onBlur = (e: Event) => syncAria(e.target);
    const onInput = (e: Event) => {
      if (e.target instanceof HTMLElement && e.target.hasAttribute("aria-invalid")) {
        syncAria(e.target);
      }
    };
    document.addEventListener("blur", onBlur, true);
    document.addEventListener("input", onInput);
    return () => {
      document.removeEventListener("blur", onBlur, true);
      document.removeEventListener("input", onInput);
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      let cfg: PlatformConfig | null = null;
      try {
        cfg = await reader.account.platformConfig.fetch(configPda());
        setConfig(cfg);
      } catch {
        setConfig(null);
      }

      let tokenProg = TOKEN_PROGRAM_ID;
      let decimals = 6;
      if (cfg) {
        const mintInfoAcct = await connection.getAccountInfo(cfg.paymentMint);
        if (mintInfoAcct) {
          tokenProg = mintInfoAcct.owner.equals(TOKEN_2022_PROGRAM_ID)
            ? TOKEN_2022_PROGRAM_ID
            : TOKEN_PROGRAM_ID;
          setPaymentTokenProgram(tokenProg);
          try {
            const mintData = await getMint(connection, cfg.paymentMint, "confirmed", tokenProg);
            decimals = mintData.decimals;
            setPaymentDecimals(decimals);
          } catch {
            // keep default 6
          }
        }
      }

      const allProps = await reader.account.property.all();
      allProps.sort((a, b) => b.account.id.cmp(a.account.id));
      setProperties(allProps);

      if (publicKey) {
        try {
          const rec = await reader.account.investor.fetch(investorPda(publicKey));
          setMyKyc(rec);
        } catch {
          setMyKyc(null);
        }

        const mine = await reader.account.position.all([
          { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
        ]);
        setPositions(Object.fromEntries(mine.map((p) => [p.account.property.toBase58(), p.account])));

        if (cfg) {
          try {
            const ata = getAssociatedTokenAddressSync(cfg.paymentMint, publicKey, false, tokenProg);
            const tokAcct = await getAccount(connection, ata, "confirmed", tokenProg);
            setUsdcBalance(tokAcct.amount);
          } catch {
            setUsdcBalance(BigInt(0));
          }
        }
      } else {
        setMyKyc(null);
        setPositions({});
        setUsdcBalance(BigInt(0));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [reader, connection, publicKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (publicKey && !managerStr) {
      setManagerStr(publicKey.toBase58());
    }
  }, [publicKey, managerStr]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7500);
    return () => clearTimeout(t);
  }, [toast]);

  const effectiveScoreInput = useMemo<PropertyInput>(
    () => ({
      ...scoreInput,
      platform_rent_fee_bps: config?.rentFeeBps ?? scoreInput.platform_rent_fee_bps,
      platform_sale_fee_bps: config?.saleFeeBps ?? scoreInput.platform_sale_fee_bps,
    }),
    [scoreInput, config],
  );

  const liveReport = useMemo<ScoreReport | null>(() => {
    try {
      return evaluateProperty(effectiveScoreInput);
    } catch {
      return null;
    }
  }, [effectiveScoreInput]);

  const run = async (key: string, label: string, fn: () => Promise<string | undefined>) => {
    setBusy(key);
    try {
      const sig = await fn();
      setToast({ kind: "ok", text: label, sig });
      await refresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ kind: "error", text: msg.split("\n")[0].slice(0, 200) });
    } finally {
      setBusy(null);
    }
  };

  const verifyWithPython = async () => {
    if (!liveReport) return;
    await run("py-score", "Хеш сверен с Python scoring/engine.py", async () => {
      const res = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(effectiveScoreInput),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Scoring API failed");
      setPyVerifiedHash(data.valuation_hash_hex);
      setCustomReports((prev) => ({
        ...prev,
        [data.valuation_hash_hex]: { input: effectiveScoreInput, report: liveReport },
      }));
      return undefined;
    });
  };

  const requestFaucetUsdc = () => {
    if (!publicKey) return;
    return run("faucet-usdc", "Начислено 1,000 Demo USDC", async () => {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mint_usdc", wallet: publicKey.toBase58(), amount: 1_000 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Faucet error");
      return data.sig;
    });
  };

  const approveWalletKyc = (targetWallet: PublicKey) => {
    const isAdmin = publicKey && config && publicKey.equals(config.admin);
    return run(`kyc-${targetWallet.toBase58()}`, `KYC подтверждён: ${shortKey(targetWallet)}`, async () => {
      if (isAdmin && program) {
        return program.methods
          .approveInvestor()
          .accountsPartial({
            config: configPda(),
            investorRecord: investorPda(targetWallet),
            wallet: targetWallet,
            admin: publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "kyc_approve", wallet: targetWallet.toBase58() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "KYC approval failed");
      return data.sig;
    });
  };

  const stats = useMemo(() => {
    const raised = properties.reduce(
      (s, p) => s + Number(p.account.sharesSold.mul(p.account.pricePerShare).toString()),
      0,
    );
    const rentDeposited = properties.reduce(
      (s, p) => s + Number(p.account.totalRentDeposited.toString()),
      0,
    );
    const rentClaimed = properties.reduce(
      (s, p) => s + Number(p.account.totalRentClaimed.toString()),
      0,
    );
    const totalSharesSold = properties.reduce(
      (s, p) => s + Number(p.account.sharesSold.toString()),
      0,
    );
    const totalSharesSupply = properties.reduce(
      (s, p) => s + Number(p.account.totalShares.toString()),
      0,
    );

    let myPendingTotal = new BN(0);
    let myClaimedTotal = new BN(0);
    for (const p of properties) {
      const pos = positions[p.publicKey.toBase58()];
      if (pos) {
        myPendingTotal = myPendingTotal.add(
          pendingRent(pos.shares, p.account.accRentPerShare, pos.rewardDebt, pos.unclaimed),
        );
        myClaimedTotal = myClaimedTotal.add(pos.totalClaimed);
      }
    }

    return {
      count: properties.length,
      raised,
      rentDeposited,
      rentClaimed,
      totalSharesSold,
      totalSharesSupply,
      myPositions: Object.keys(positions).length,
      myPendingTotal,
      myClaimedTotal,
    };
  }, [properties, positions]);

  const isAdmin = Boolean(publicKey && config && publicKey.equals(config.admin));

  return (
    <>
      <div className="topbar">
        <div className="container header">
          <div className="brand-group">
            <div className="logo">
              <div className="logo-mark">R</div>
              <span>ROOFIC</span>
            </div>
            <span className="badge neutral">DEVNET · TOKEN-2022</span>
            {config?.paused && <span className="badge danger">! PAUSED</span>}
          </div>

          <nav className="nav-links" aria-label="Секции платформы">
            <a href="#overview" className="nav-link">
              Обзор
            </a>
            <a href="#investor" className="nav-link">
              Кошелёк и KYC
            </a>
            <a href="#properties" className="nav-link">
              Объекты ({stats.count})
            </a>
            <a href="#scoring" className="nav-link">
              Скоринг SHA-256
            </a>
            <a href="#create" className="nav-link">
              Эмиссия
            </a>
            <a href="#admin" className="nav-link">
              Протокол
            </a>
          </nav>

          <div className="header-actions">
            <WalletMultiButton />
          </div>
        </div>
      </div>

      <main className="container">
        {/* Page Header */}
        <section className="page-intro">
          <div className="kicker">
            <span className="kicker-dot" />
            RWA RENTAL PROTOCOL · SOLANA DEVNET
          </div>
          <h1>Долевая токенизация арендной недвижимости</h1>
          <p>
            Доли объектов выпускаются как SPL Token-2022 с расширением <code>NonTransferable</code> (0 decimals).
            Покупка долей и распределение арендного потока выполняются в стейблкоине USDC через{" "}
            <code>TokenInterface</code>. Модели оценки и риск-скоринга фиксируются ончейн через 32-байтный SHA-256{" "}
            <code>valuation_hash</code>.
          </p>
        </section>

        {/* SECTION 01: PROTOCOL TELEMETRY & METRICS BENTO */}
        <section id="overview" className="section-block" aria-labelledby="sec-01-title">
          <div className="section-header">
            <div className="section-header-left">
              <span className="section-index">ТЕЛЕМЕТРИЯ И МЕТРИКИ</span>
              <h2 id="sec-01-title">Состояние смарт-контракта и казначейства</h2>
              <p className="section-desc">
                Агрегированные показатели пулов ликвидности и адреса конфигурации контракта в сети Solana Devnet.
              </p>
            </div>
            <button type="button" className="btn ghost sm" onClick={refresh}>
              Синхронизировать с RPC
            </button>
          </div>

          <div className="bento-grid">
            {/* Span 7, Row-span 2: Contract Telemetry */}
            <div className="bento-cell span-7 row-span-2">
              <div>
                <div className="metric-top">
                  <span className="metric-label">Конфигурация протокола (PlatformConfig PDA)</span>
                  <span className={config?.paused ? "badge danger" : "badge"}>
                    {config?.paused ? "! PAUSED (Claim Active)" : "✓ ACTIVE"}
                  </span>
                </div>
                <p style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginTop: "8px" }}>
                  Контракт проверяет статус верификации инвестора в PDA-реестре перед минтом долей и удерживает
                  комиссию протокола в пользу казначейского счёта.
                </p>
              </div>

              <div className="tech-grid">
                <div className="tech-item">
                  <span className="tech-item-label">Program ID</span>
                  <a
                    href={explorerAddress(PROGRAM_ID)}
                    target="_blank"
                    rel="noreferrer"
                    className="tech-item-value"
                  >
                    {shortKey(PROGRAM_ID)} ↗
                  </a>
                  <span className="tech-item-sub">Anchor v0.31 · Rust</span>
                </div>

                <div className="tech-item">
                  <span className="tech-item-label">Payment Mint (USDC)</span>
                  {config ? (
                    <a
                      href={explorerAddress(config.paymentMint)}
                      target="_blank"
                      rel="noreferrer"
                      className="tech-item-value"
                    >
                      {shortKey(config.paymentMint)} ↗
                    </a>
                  ) : (
                    <span className="tech-item-value">—</span>
                  )}
                  <span className="tech-item-sub">{paymentDecimals} decimals · SPL Token</span>
                </div>

                <div className="tech-item">
                  <span className="tech-item-label">Treasury ATA</span>
                  {config ? (
                    <a
                      href={explorerAddress(config.treasury)}
                      target="_blank"
                      rel="noreferrer"
                      className="tech-item-value"
                    >
                      {shortKey(config.treasury)} ↗
                    </a>
                  ) : (
                    <span className="tech-item-value">—</span>
                  )}
                  <span className="tech-item-sub">Получатель комиссий</span>
                </div>

                <div className="tech-item">
                  <span className="tech-item-label">Admin Authority</span>
                  {config ? (
                    <a
                      href={explorerAddress(config.admin)}
                      target="_blank"
                      rel="noreferrer"
                      className="tech-item-value"
                    >
                      {shortKey(config.admin)} ↗
                    </a>
                  ) : (
                    <span className="tech-item-value">—</span>
                  )}
                  <span className="tech-item-sub">Управление KYC и паузой</span>
                </div>

                <div className="tech-item">
                  <span className="tech-item-label">Sale Fee (первичный рынок)</span>
                  <span className="tech-item-value">
                    {config ? `${(config.saleFeeBps / 100).toFixed(2)}%` : "1.50%"}
                  </span>
                  <span className="tech-item-sub">{config?.saleFeeBps ?? 150} bps (макс. 2000 bps)</span>
                </div>

                <div className="tech-item">
                  <span className="tech-item-label">Rent Fee (арендный поток)</span>
                  <span className="tech-item-value">
                    {config ? `${(config.rentFeeBps / 100).toFixed(2)}%` : "1.00%"}
                  </span>
                  <span className="tech-item-sub">{config?.rentFeeBps ?? 100} bps при deposit_rent</span>
                </div>
              </div>
            </div>

            {/* Span 5: Capital Raised */}
            <div className="bento-cell span-5 accent-cell">
              <div>
                <div className="metric-top">
                  <span className="metric-label">Привлечённый капитал (TVL)</span>
                  <span className="badge">USDC</span>
                </div>
                <div className="metric-value lg">${formatToken(stats.raised, paymentDecimals)}</div>
              </div>
              <div>
                <div className="progress">
                  <div
                    style={{
                      width: `${
                        stats.totalSharesSupply
                          ? Math.min(100, (stats.totalSharesSold / stats.totalSharesSupply) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <div className="progress-meta">
                  <span>
                    Размещено долей: {stats.totalSharesSold.toLocaleString("en-US")} /{" "}
                    {stats.totalSharesSupply.toLocaleString("en-US")}
                  </span>
                  <span>
                    {stats.totalSharesSupply
                      ? ((stats.totalSharesSold / stats.totalSharesSupply) * 100).toFixed(1)
                      : "0.0"}
                    %
                  </span>
                </div>
              </div>
            </div>

            {/* Span 3: Rent Vault */}
            <div className="bento-cell span-3">
              <div>
                <div className="metric-top">
                  <span className="metric-label">Арендный пул (Net Vault)</span>
                </div>
                <div className="metric-value">${formatToken(stats.rentDeposited, paymentDecimals)}</div>
              </div>
              <div className="metric-sub">
                <span>Выплачено:</span>
                <strong className="mono">${formatToken(stats.rentClaimed, paymentDecimals)}</strong>
              </div>
            </div>

            {/* Span 2: Active Assets */}
            <div className="bento-cell span-2">
              <div>
                <div className="metric-top">
                  <span className="metric-label">Объекты</span>
                </div>
                <div className="metric-value">{stats.count}</div>
              </div>
              <div className="metric-sub">
                <span>Позиций:</span>
                <strong className="mono">{stats.myPositions}</strong>
              </div>
            </div>

            {/* Span 12: Live DeFi & Oracle Telemetry (Pyth PriceUpdateV2 + Jupiter v6 + Kamino) */}
            <div className="bento-cell span-12">
              <div className="metric-top">
                <span className="metric-label">
                  ОНЧЕЙН-ОРАКУЛЫ И МАРШРУТИЗАЦИЯ ЛИКВИДНОСТИ (PYTH PRICEUPDATEV2 · JUPITER V6 · KAMINO)
                </span>
                <span className={defi.solUsd?.healthy ? "badge" : "badge neutral"}>
                  {defi.solUsd
                    ? `PYTH ${defi.solUsd.verifiedFull ? "FULL" : "PARTIAL"} · AGE ${defi.solUsd.ageSec}s`
                    : "SYNCING ORACLES…"}
                </span>
              </div>
              <div className="tech-grid" style={{ marginTop: "8px" }}>
                <div className="tech-item">
                  <span className="tech-item-label">Pyth SOL/USD (On-Chain Pull Feed)</span>
                  <span className="tech-item-value">
                    {defi.solUsd
                      ? `$${defi.solUsd.price.toFixed(2)} ± $${defi.solUsd.conf.toFixed(2)}`
                      : "Чтение PDA…"}
                  </span>
                  <span className="tech-item-sub">
                    {defi.solUsd
                      ? `Conservative (price − conf): $${defi.solUsd.conservativePrice.toFixed(2)} · EMA $${defi.solUsd.emaPrice.toFixed(2)}`
                      : "Проверка owner == rec5…LtFJ"}
                  </span>
                </div>

                <div className="tech-item">
                  <span className="tech-item-label">Pyth USDC/USD Peg Guard</span>
                  <span className="tech-item-value">
                    {defi.usdcUsd
                      ? `$${defi.usdcUsd.price.toFixed(4)} ± $${defi.usdcUsd.conf.toFixed(4)}`
                      : "Чтение PDA…"}
                  </span>
                  <span className="tech-item-sub">
                    {defi.usdcUsd
                      ? `Peg: ${Math.abs(defi.usdcUsd.price - 1) < 0.005 ? "✓ В пределах 50 bps" : "! Отклонение"} · age ${defi.usdcUsd.ageSec}s`
                      : "Контроль расчётного стейблкоина"}
                  </span>
                </div>

                <div className="tech-item">
                  <span className="tech-item-label">Jupiter v6 Quote (1 SOL → USDC)</span>
                  <span className="tech-item-value">
                    {defi.jupiterQuote
                      ? `$${defi.jupiterQuote.outUsdc.toFixed(2)} USDC`
                      : defi.solUsd
                        ? `≈ $${defi.solUsd.conservativePrice.toFixed(2)} USDC (Pyth)`
                        : "Запрос маршрута…"}
                  </span>
                  <span className="tech-item-sub">
                    {defi.jupiterQuote
                      ? `Маршрут: ${defi.jupiterQuote.routeLabel} · impact ${defi.jupiterQuote.priceImpactPct.toFixed(3)}%`
                      : "Автоконвертация SOL → USDC при входе"}
                  </span>
                </div>

                <div className="tech-item">
                  <span className="tech-item-label">Kamino Idle-Vault Benchmark</span>
                  <span className="tech-item-value">{defi.kaminoUsdcSupplyApyPct.toFixed(2)}% APY</span>
                  <span className="tech-item-sub">
                    Ориентир доходности свободного USDC в резерве между выплатами
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 02: INVESTOR WORKSPACE (KYC, FAUCET, PORTFOLIO SUMMARY) */}
        <section id="investor" className="section-block" aria-labelledby="sec-02-title">
          <div className="section-header">
            <div className="section-header-left">
              <span className="section-index">КОНТУР ИНВЕСТОРА</span>
              <h2 id="sec-02-title">Верификация кошелька, баланс USDC и сводка позиций</h2>
              <p className="section-desc">
                Управление ончейн-допуском (KYC allow-list), пополнение тестового баланса USDC и контроль начисленного
                дохода.
              </p>
            </div>
          </div>

          <div className="bento-grid">
            {/* Cell 1: KYC Verification (span-4) */}
            <div className="bento-cell span-4">
              <div>
                <div className="metric-top">
                  <span className="metric-label">Допуск KYC (Investor PDA)</span>
                  {publicKey ? (
                    <span className={myKyc ? "badge" : "badge warn"}>
                      {myKyc ? "✓ VERIFIED" : "! UNVERIFIED"}
                    </span>
                  ) : (
                    <span className="badge neutral">NO WALLET</span>
                  )}
                </div>
                <div className="metric-value" style={{ fontSize: "1.25rem", marginTop: "12px" }}>
                  {!publicKey
                    ? "Кошелёк не подключён"
                    : myKyc
                      ? "Аккаунт в белом списке"
                      : "Требуется запись в реестре"}
                </div>
                <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", marginTop: "8px" }}>
                  Инструкция <code>buy_shares</code> проверяет наличие PDA <code>[&quot;investor&quot;, wallet]</code>.
                  Вывод дохода <code>claim_rent</code> доступен всегда.
                </p>
              </div>

              <div>
                {publicKey && !myKyc ? (
                  <button
                    type="button"
                    className="btn"
                    style={{ width: "100%" }}
                    disabled={busy !== null}
                    onClick={() => approveWalletKyc(publicKey)}
                  >
                    {busy?.startsWith("kyc-") ? "Запись PDA…" : "Активировать KYC (Demo)"}
                  </button>
                ) : publicKey && myKyc ? (
                  <div className="tech-item">
                    <span className="tech-item-label">Investor PDA</span>
                    <a
                      href={explorerAddress(investorPda(publicKey))}
                      target="_blank"
                      rel="noreferrer"
                      className="tech-item-value"
                    >
                      {shortKey(investorPda(publicKey))} ↗
                    </a>
                  </div>
                ) : (
                  <span className="rules-list">Подключите Solana-кошелёк в верхнем меню.</span>
                )}
              </div>
            </div>

            {/* Cell 2: Payment Token Balance & Faucet (span-4) */}
            <div className="bento-cell span-4">
              <div>
                <div className="metric-top">
                  <span className="metric-label">Баланс расчётного токена</span>
                  <span className="badge neutral">Demo USDC</span>
                </div>
                <div className="metric-value">
                  ${publicKey ? formatToken(usdcBalance, paymentDecimals) : "0.00"}
                </div>
                <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", marginTop: "8px" }}>
                  Используется для оплаты долей при <code>buy_shares</code> и внесения арендных платежей через{" "}
                  <code>deposit_rent</code>.
                </p>
              </div>

              <div>
                <button
                  type="button"
                  className="btn ghost"
                  style={{ width: "100%" }}
                  disabled={!publicKey || !config || busy === "faucet-usdc"}
                  onClick={requestFaucetUsdc}
                >
                  {busy === "faucet-usdc" ? "Минт токенов…" : "Получить +1,000 Demo USDC"}
                </button>
              </div>
            </div>

            {/* Cell 3: Portfolio Yield Summary (span-4) */}
            <div className="bento-cell span-4">
              <div>
                <div className="metric-top">
                  <span className="metric-label">Накопленный доход к выводу</span>
                  <span className="badge">{stats.myPositions} поз.</span>
                </div>
                <div className="metric-value">
                  ${publicKey ? formatToken(stats.myPendingTotal, paymentDecimals) : "0.00"}
                </div>
                <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", marginTop: "8px" }}>
                  Расчёт по формуле <code>acc_rent_per_share</code> (масштаб <code>1e12</code>) пропорционально балансу
                  долей в каждом объекте.
                </p>
              </div>

              <div className="metric-sub">
                <span>Всего выведено ранее:</span>
                <strong className="mono">
                  ${publicKey ? formatToken(stats.myClaimedTotal, paymentDecimals) : "0.00"} USDC
                </strong>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 03: TOKENIZED PROPERTIES CATALOG (ASYMMETRIC BENTO) */}
        <section id="properties" className="section-block" aria-labelledby="sec-03-title">
          <div className="section-header">
            <div className="section-header-left">
              <span className="section-index">РЕЕСТР ОБЪЕКТОВ RWA</span>
              <h2 id="sec-03-title">Токенизированные объекты недвижимости ({properties.length})</h2>
              <p className="section-desc">
                Каждый объект изолирован в собственном PDA с отдельным хранилищем <code>vault</code> и минтом долей{" "}
                <code>Token-2022 NonTransferable</code>.
              </p>
            </div>
          </div>

          {loading ? (
            <div className="empty">Чтение аккаунтов программы `roofic` из Solana Devnet…</div>
          ) : properties.length === 0 ? (
            <div className="empty">
              В реестре нет объектов. Выполните <code>npm run seed</code> или создайте объект в секции эмиссии.
            </div>
          ) : (
            <div className="bento-grid">
              {properties.map((p, idx) => {
                const hashHex = bytesToHex(p.account.valuationHash);
                const matched = KNOWN_REPORTS_BY_HASH[hashHex] ?? customReports[hashHex];
                // Asymmetric Bento layout: first item spans 12 cols (horizontal split), next items alternate 7 and 5 cols
                const spanClass =
                  idx === 0
                    ? "span-12"
                    : idx % 2 === 1
                      ? properties.length === idx + 1
                        ? "span-12"
                        : "span-7"
                      : "span-5";

                return (
                  <PropertyCard
                    key={p.publicKey.toBase58()}
                    p={p}
                    featured={idx === 0}
                    spanClass={spanClass}
                    config={config}
                    paymentDecimals={paymentDecimals}
                    position={positions[p.publicKey.toBase58()]}
                    me={publicKey}
                    myKyc={Boolean(myKyc)}
                    matchedReport={matched?.report}
                    matchedCity={matched?.input.city}
                    solUsd={defi.solUsd?.conservativePrice ?? null}
                    busy={busy}
                    onBuy={(shares) =>
                      run(`buy-${p.publicKey.toBase58()}`, `Куплено долей: ${shares}`, async () => {
                        if (!program || !publicKey || !config) throw new Error("Подключите кошелёк");
                        const investorPayment = getAssociatedTokenAddressSync(
                          config.paymentMint,
                          publicKey,
                          false,
                          paymentTokenProgram,
                        );
                        const investorShares = getAssociatedTokenAddressSync(
                          p.account.shareMint,
                          publicKey,
                          false,
                          SHARE_TOKEN_PROGRAM_ID,
                        );
                        const preIxs: TransactionInstruction[] = [
                          createAssociatedTokenAccountIdempotentInstruction(
                            publicKey,
                            investorPayment,
                            publicKey,
                            config.paymentMint,
                            paymentTokenProgram,
                          ),
                        ];

                        let ownerPayment: PublicKey;
                        if (publicKey.equals(p.account.owner)) {
                          const seed = `proceeds-${config.paymentMint.toBase58().slice(0, 8)}`;
                          ownerPayment = await PublicKey.createWithSeed(
                            publicKey,
                            seed,
                            paymentTokenProgram,
                          );
                          if (!(await connection.getAccountInfo(ownerPayment))) {
                            const lamports =
                              await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
                            preIxs.push(
                              SystemProgram.createAccountWithSeed({
                                fromPubkey: publicKey,
                                basePubkey: publicKey,
                                seed,
                                newAccountPubkey: ownerPayment,
                                lamports,
                                space: ACCOUNT_SIZE,
                                programId: paymentTokenProgram,
                              }),
                              createInitializeAccount3Instruction(
                                ownerPayment,
                                config.paymentMint,
                                publicKey,
                                paymentTokenProgram,
                              ),
                            );
                          }
                        } else {
                          ownerPayment = getAssociatedTokenAddressSync(
                            config.paymentMint,
                            p.account.owner,
                            false,
                            paymentTokenProgram,
                          );
                          preIxs.push(
                            createAssociatedTokenAccountIdempotentInstruction(
                              publicKey,
                              ownerPayment,
                              p.account.owner,
                              config.paymentMint,
                              paymentTokenProgram,
                            ),
                          );
                        }

                        return program.methods
                          .buyShares(new BN(shares))
                          .preInstructions(preIxs)
                          .accountsPartial({
                            config: configPda(),
                            investorRecord: investorPda(publicKey),
                            property: p.publicKey,
                            shareMint: p.account.shareMint,
                            position: positionPda(p.publicKey, publicKey),
                            investorShares,
                            paymentMint: config.paymentMint,
                            investorPayment,
                            ownerPayment,
                            treasury: config.treasury,
                            investor: publicKey,
                            shareTokenProgram: SHARE_TOKEN_PROGRAM_ID,
                            paymentTokenProgram,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                          })
                          .rpc();
                      })
                    }
                    onDeposit={(usdcAmount) =>
                      run(`dep-${p.publicKey.toBase58()}`, `Внесено аренды: ${usdcAmount} USDC`, async () => {
                        if (!program || !publicKey || !config) throw new Error("Подключите кошелёк");
                        const managerPayment = getAssociatedTokenAddressSync(
                          config.paymentMint,
                          publicKey,
                          false,
                          paymentTokenProgram,
                        );
                        return program.methods
                          .depositRent(toRawUnits(usdcAmount, paymentDecimals))
                          .accountsPartial({
                            config: configPda(),
                            property: p.publicKey,
                            shareMint: p.account.shareMint,
                            vault: p.account.vault,
                            paymentMint: config.paymentMint,
                            managerPayment,
                            treasury: config.treasury,
                            manager: publicKey,
                            shareTokenProgram: SHARE_TOKEN_PROGRAM_ID,
                            paymentTokenProgram,
                          })
                          .rpc();
                      })
                    }
                    onClaim={() =>
                      run(`claim-${p.publicKey.toBase58()}`, "Арендный доход выплачен в USDC", async () => {
                        if (!program || !publicKey || !config) throw new Error("Подключите кошелёк");
                        const investorPayment = getAssociatedTokenAddressSync(
                          config.paymentMint,
                          publicKey,
                          false,
                          paymentTokenProgram,
                        );
                        return program.methods
                          .claimRent()
                          .preInstructions([
                            createAssociatedTokenAccountIdempotentInstruction(
                              publicKey,
                              investorPayment,
                              publicKey,
                              config.paymentMint,
                              paymentTokenProgram,
                            ),
                          ])
                          .accountsPartial({
                            config: configPda(),
                            property: p.publicKey,
                            position: positionPda(p.publicKey, publicKey),
                            vault: p.account.vault,
                            paymentMint: config.paymentMint,
                            investorPayment,
                            investor: publicKey,
                            paymentTokenProgram,
                          })
                          .rpc();
                      })
                    }
                  />
                );
              })}
            </div>
          )}
        </section>

        {/* SECTION 04: YIELD & RISK SCORING ENGINE */}
        <section id="scoring" className="section-block" aria-labelledby="sec-04-title">
          <div className="section-header">
            <div className="section-header-left">
              <span className="section-index">МОДЕЛЬ ОЦЕНКИ И РИСКА</span>
              <h2 id="sec-04-title">Детерминированный скоринг и расчёт SHA-256 слепка</h2>
              <p className="section-desc">
                Модуль <code>scoring/engine.py</code> вычисляет чистую доходность в трёх сценариях, оценивает 4 фактора
                риска по 25-балльной шкале и формирует криптографический хеш параметров объекта.
              </p>
            </div>
            <div className="segmented" role="group" aria-label="Пресеты объектов">
              {PRESET_CATALOG.map((item) => (
                <button
                  key={item.input.property_id}
                  type="button"
                  className={`seg-btn ${
                    scoreInput.property_id === item.input.property_id && scoreInput.name === item.input.name
                      ? "active"
                      : ""
                  }`}
                  onClick={() => {
                    setScoreInput(item.input);
                    setSharesToCreate(item.totalShares);
                    setPriceUsdc(item.pricePerShareUsdc);
                    setPyVerifiedHash(null);
                  }}
                >
                  {item.input.city} #{item.input.property_id}
                </button>
              ))}
            </div>
          </div>

          <div className="bento-grid">
            {/* Left Cell (span-5, row-span-2): Input Parameters */}
            <div className="bento-cell span-5 row-span-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  verifyWithPython();
                }}
              >
                <fieldset className="fieldset-reset">
                  <legend className="sr-legend">Входные параметры объекта</legend>
                  <div className="form-grid-2">
                    <div className="field">
                      <label htmlFor="score-name">Название объекта</label>
                      <input
                        id="score-name"
                        name="name"
                        className="input"
                        required
                        maxLength={48}
                        value={scoreInput.name}
                        onChange={(e) => setScoreInput({ ...scoreInput, name: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="score-city">Город</label>
                      <input
                        id="score-city"
                        name="city"
                        className="input"
                        required
                        value={scoreInput.city}
                        onChange={(e) => setScoreInput({ ...scoreInput, city: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="score-price">Стоимость актива (USD)</label>
                      <input
                        id="score-price"
                        name="price_usd"
                        className="input mono"
                        type="number"
                        required
                        min={1000}
                        step="any"
                        value={scoreInput.price_usd}
                        onChange={(e) => setScoreInput({ ...scoreInput, price_usd: Number(e.target.value) })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="score-yield">Валовая аренда (Gross, %)</label>
                      <input
                        id="score-yield"
                        name="gross_yield"
                        className="input mono"
                        type="number"
                        required
                        min={1}
                        max={49}
                        step={0.1}
                        value={Number((scoreInput.gross_yield * 100).toFixed(2))}
                        onChange={(e) =>
                          setScoreInput({ ...scoreInput, gross_yield: Number(e.target.value) / 100 })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="score-vacancy">Вакантность (%)</label>
                      <input
                        id="score-vacancy"
                        name="vacancy_rate"
                        className="input mono"
                        type="number"
                        required
                        min={0}
                        max={90}
                        step={0.5}
                        value={Number((scoreInput.vacancy_rate * 100).toFixed(2))}
                        onChange={(e) =>
                          setScoreInput({ ...scoreInput, vacancy_rate: Number(e.target.value) / 100 })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="score-opex">Расходы OpEx (%)</label>
                      <input
                        id="score-opex"
                        name="opex_ratio"
                        className="input mono"
                        type="number"
                        required
                        min={0}
                        max={80}
                        step={0.5}
                        value={Number((scoreInput.opex_ratio * 100).toFixed(2))}
                        onChange={(e) =>
                          setScoreInput({ ...scoreInput, opex_ratio: Number(e.target.value) / 100 })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="score-mgr">Комиссия УК (%)</label>
                      <input
                        id="score-mgr"
                        name="manager_fee_ratio"
                        className="input mono"
                        type="number"
                        required
                        min={0}
                        max={30}
                        step={0.5}
                        value={Number((scoreInput.manager_fee_ratio * 100).toFixed(2))}
                        onChange={(e) =>
                          setScoreInput({
                            ...scoreInput,
                            manager_fee_ratio: Number(e.target.value) / 100,
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="score-age">Возраст здания (лет)</label>
                      <input
                        id="score-age"
                        name="building_age_years"
                        className="input mono"
                        type="number"
                        required
                        min={0}
                        max={100}
                        value={scoreInput.building_age_years}
                        onChange={(e) =>
                          setScoreInput({ ...scoreInput, building_age_years: Number(e.target.value) })
                        }
                      />
                    </div>
                  </div>

                  <button type="submit" className="btn ghost" disabled={busy === "py-score"}>
                    {busy === "py-score" ? "Выполнение Python engine.py…" : "Сверить с Python scoring/engine.py"}
                  </button>
                </fieldset>
              </form>
            </div>

            {/* Top-Right Cell (span-4): Net Yield Scenarios */}
            <div className="bento-cell span-4">
              <div className="metric-top">
                <span className="metric-label">Чистая доходность (Net Yield)</span>
                <span className="badge neutral">После OpEx, УК и комиссий</span>
              </div>
              {liveReport && (
                <div className="scenario-grid">
                  <div className="scenario-box">
                    <div className="scenario-label">Bear (стресс)</div>
                    <div className="scenario-val">{(liveReport.net_yield_bear * 100).toFixed(2)}%</div>
                  </div>
                  <div className="scenario-box base">
                    <div className="scenario-label">Base (база)</div>
                    <div className="scenario-val">{(liveReport.net_yield_base * 100).toFixed(2)}%</div>
                  </div>
                  <div className="scenario-box">
                    <div className="scenario-label">Bull (рост)</div>
                    <div className="scenario-val">{(liveReport.net_yield_bull * 100).toFixed(2)}%</div>
                  </div>
                </div>
              )}
            </div>

            {/* Top-Far-Right Cell (span-3): Integral Risk Score */}
            <div className="bento-cell span-3">
              <div className="metric-top">
                <span className="metric-label">Индекс риска</span>
                {liveReport && (
                  <div className={`grade-badge grade-${liveReport.risk_grade}`} title="Грейд риска">
                    {liveReport.risk_grade}
                  </div>
                )}
              </div>
              {liveReport && (
                <>
                  <div className="metric-value">{liveReport.risk_score} / 100</div>
                  <div className="metric-sub">
                    <span>0 — мин., 100 — макс.</span>
                  </div>
                </>
              )}
            </div>

            {/* Bottom-Right Cell (span-7): Factor Breakdown & Cryptographic Hash */}
            <div className="bento-cell span-7">
              {liveReport && (
                <>
                  <div className="metric-top">
                    <span className="metric-label">Декомпозиция факторов риска (по 25 баллов)</span>
                    {pyVerifiedHash === liveReport.valuation_hash_hex && (
                      <span className="badge">✓ Совпадает с Python engine.py</span>
                    )}
                  </div>

                  <div className="factor-list">
                    <FactorBar label="Вакантность" pts={liveReport.factors.vacancy} />
                    <FactorBar label="Нагрузка OpEx + УК" pts={liveReport.factors.operating_costs} />
                    <FactorBar label="Износ здания" pts={liveReport.factors.building_age} />
                    <FactorBar label="Чувствительность (Bear)" pts={liveReport.factors.downside_yield} />
                  </div>

                  {liveReport.warnings.length > 0 && (
                    <ul className="warn-list">
                      {liveReport.warnings.map((w) => (
                        <li key={w}>! {w}</li>
                      ))}
                    </ul>
                  )}

                  <div>
                    <span className="tech-item-label">
                      SHA-256 valuation_hash ([u8; 32], канонический JSON)
                    </span>
                    <div className="hash-box">0x{liveReport.valuation_hash_hex}</div>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        {/* SECTION 05: ON-CHAIN PROPERTY ISSUANCE */}
        <section id="create" className="section-block" aria-labelledby="sec-05-title">
          <div className="section-header">
            <div className="section-header-left">
              <span className="section-index">ЭМИССИЯ ОБЪЕКТА ON-CHAIN</span>
              <h2 id="sec-05-title">Регистрация объекта и выпуск долей Token-2022</h2>
              <p className="section-desc">
                Инструкция <code>create_property</code> инициализирует аккаунт <code>Property</code>, хранилище{" "}
                <code>vault</code> и минт <code>share_mint</code> с расширением <code>NonTransferable</code>.
              </p>
            </div>
          </div>

          <div className="bento-grid">
            {/* Left Cell (span-7): Create Property Form */}
            <div className="bento-cell span-7">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!program || !publicKey || !config || !liveReport) return;
                  const id = new BN(Date.now());
                  const propPda = propertyPda(publicKey, id);
                  const mgrKey = new PublicKey(managerStr.trim() || publicKey.toBase58());
                  const rawPrice = toRawUnits(priceUsdc, paymentDecimals);

                  setCustomReports((prev) => ({
                    ...prev,
                    [liveReport.valuation_hash_hex]: { input: effectiveScoreInput, report: liveReport },
                  }));

                  run("create-prop", `Объект «${effectiveScoreInput.name}» зарегистрирован`, () =>
                    program.methods
                      .createProperty(
                        id,
                        effectiveScoreInput.name,
                        new BN(sharesToCreate),
                        rawPrice,
                        mgrKey,
                        liveReport.valuation_hash_bytes,
                      )
                      .accountsPartial({
                        config: configPda(),
                        ownerKyc: investorPda(publicKey),
                        property: propPda,
                        shareMint: shareMintPda(propPda),
                        vault: vaultPda(propPda),
                        paymentMint: config.paymentMint,
                        owner: publicKey,
                        shareTokenProgram: SHARE_TOKEN_PROGRAM_ID,
                        paymentTokenProgram,
                        systemProgram: SystemProgram.programId,
                      })
                      .rpc(),
                  );
                }}
              >
                <fieldset className="fieldset-reset">
                  <legend className="sr-legend">Параметры смарт-контракта</legend>

                  <div className="field">
                    <label htmlFor="create-prop-name">Название объекта (Property.name)</label>
                    <input
                      id="create-prop-name"
                      name="property_name"
                      className="input"
                      required
                      minLength={1}
                      maxLength={48}
                      aria-describedby="create-name-hint"
                      value={scoreInput.name}
                      onChange={(e) => setScoreInput({ ...scoreInput, name: e.target.value })}
                    />
                    <span id="create-name-hint" className="rules-list">
                      1–48 байт UTF-8. Синхронизировано с моделью оценки.
                    </span>
                  </div>

                  <div className="form-grid-2">
                    <div className="field">
                      <label htmlFor="create-shares">Общий выпуск долей (total_shares)</label>
                      <input
                        id="create-shares"
                        name="total_shares"
                        className="input mono"
                        type="number"
                        required
                        min={1}
                        max={1000000}
                        value={sharesToCreate}
                        onChange={(e) => setSharesToCreate(Number(e.target.value))}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="create-price-usdc">Цена 1 доли (USDC)</label>
                      <input
                        id="create-price-usdc"
                        name="price_per_share"
                        className="input mono"
                        type="number"
                        required
                        min={0.01}
                        step="any"
                        value={priceUsdc}
                        onChange={(e) => setPriceUsdc(Number(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="create-manager">Кошелёк управляющей компании (manager)</label>
                    <input
                      id="create-manager"
                      name="manager"
                      className="input mono"
                      required
                      pattern="[1-9A-HJ-NP-Za-km-z]{32,44}"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      aria-describedby="create-manager-hint"
                      value={managerStr}
                      onChange={(e) => setManagerStr(e.target.value)}
                    />
                    <span id="create-manager-hint" className="rules-list">
                      Base58-адрес Solana. Только этот ключ авторизован вызывать <code>deposit_rent</code>.
                    </span>
                  </div>

                  <button
                    type="submit"
                    className="btn"
                    disabled={busy === "create-prop" || !publicKey || !myKyc || !config || config.paused}
                  >
                    {!publicKey
                      ? "Подключите кошелёк для эмиссии"
                      : !myKyc
                        ? "Требуется KYC/KYB эмитента (активируйте в разделе 02)"
                        : busy === "create-prop"
                          ? "Отправка транзакции в Devnet…"
                          : "Зарегистрировать объект в Solana Devnet"}
                  </button>
                </fieldset>
              </form>
            </div>

            {/* Right Cell (span-5): Deployment Specification Preview */}
            <div className="bento-cell span-5">
              <div>
                <div className="metric-top">
                  <span className="metric-label">Спецификация эмиссии</span>
                  <span className="badge">Token-2022</span>
                </div>
                <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "8px" }}>
                  Сводка параметров, которые будут зафиксированы в аккаунте <code>Property</code> при вызове
                  инструкции.
                </p>
              </div>

              <div className="tech-grid" style={{ gridTemplateColumns: "1fr" }}>
                <div className="tech-item">
                  <span className="tech-item-label">Полная капитализация пула</span>
                  <span className="tech-item-value">
                    ${(sharesToCreate * priceUsdc).toLocaleString("en-US")} USDC
                  </span>
                  <span className="tech-item-sub">
                    {sharesToCreate.toLocaleString("en-US")} долей × ${priceUsdc} USDC (0 decimals)
                  </span>
                </div>

                <div className="tech-item">
                  <span className="tech-item-label">Расширение токена долей</span>
                  <span className="tech-item-value">ExtensionType::NonTransferable</span>
                  <span className="tech-item-sub">Soulbound-токен: запрет вторичного перевода без KYC</span>
                </div>

                <div className="tech-item">
                  <span className="tech-item-label">Привязанный риск-грейд и Base Yield</span>
                  <span className="tech-item-value">
                    Grade {liveReport?.risk_grade ?? "—"} ({liveReport?.risk_score ?? 0}/100) ·{" "}
                    {liveReport ? `${(liveReport.net_yield_base * 100).toFixed(2)}% годовых` : "—"}
                  </span>
                  <span className="tech-item-sub">
                    SHA-256: 0x{liveReport?.valuation_hash_hex.slice(0, 16)}…
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 06: PROTOCOL GOVERNANCE & KYC REGISTRY */}
        <section id="admin" className="section-block" aria-labelledby="sec-06-title">
          <div className="section-header">
            <div className="section-header-left">
              <span className="section-index">УПРАВЛЕНИЕ ПРОТОКОЛОМ</span>
              <h2 id="sec-06-title">Администрирование PlatformConfig и реестра KYC</h2>
              <p className="section-desc">
                {isAdmin
                  ? "Вы подключены с ключа администратора протокола (config.admin)."
                  : "Инструкции revoke_investor, set_fees и set_paused требуют подписи config.admin. Для approve_investor на Devnet доступен демо-ключ."}
              </p>
            </div>
          </div>

          {config ? (
            <AdminBento
              config={config}
              isAdmin={isAdmin}
              busy={busy}
              onApprove={(w) => approveWalletKyc(w)}
              onRevoke={(w) =>
                run(`revoke-${w.toBase58()}`, `KYC отозван: ${shortKey(w)}`, async () => {
                  if (!program || !publicKey) throw new Error("Подключите кошелёк администратора");
                  return program.methods
                    .revokeInvestor()
                    .accountsPartial({
                      config: configPda(),
                      investorRecord: investorPda(w),
                      admin: publicKey,
                    })
                    .rpc();
                })
              }
              onTogglePause={(nextPaused) =>
                run("pause", nextPaused ? "Протокол переведён в режим паузы" : "Пауза снята", async () => {
                  if (!program || !publicKey) throw new Error("Подключите кошелёк администратора");
                  return program.methods
                    .setPaused(nextPaused)
                    .accountsPartial({ config: configPda(), admin: publicKey })
                    .rpc();
                })
              }
              onUpdateFees={(rentBps, saleBps) =>
                run("fees", `Комиссии обновлены: ${rentBps} / ${saleBps} bps`, async () => {
                  if (!program || !publicKey) throw new Error("Подключите кошелёк администратора");
                  return program.methods
                    .setFees(rentBps, saleBps)
                    .accountsPartial({ config: configPda(), admin: publicKey })
                    .rpc();
                })
              }
            />
          ) : (
            <div className="empty">Аккаунт PlatformConfig не найден в сети.</div>
          )}
        </section>

        <footer className="footer">
          <div>
            ROOFIC PROTOCOL · CAPSTONE ·{" "}
            <a href={explorerAddress(PROGRAM_ID)} target="_blank" rel="noreferrer" className="mono">
              {PROGRAM_ID.toBase58()}
            </a>
          </div>
          <div className="mono">SPL TOKEN-2022 · NON-TRANSFERABLE · SHA-256 VALUATION</div>
        </footer>

        {toast && (
          <div className={`toast ${toast.kind}`} role="status" aria-live="polite">
            <span className="mono">{toast.kind === "ok" ? "[OK]" : "[ERR]"}</span>
            <span>{toast.text}</span>
            {toast.sig && (
              <a href={explorerTx(toast.sig)} target="_blank" rel="noreferrer" className="mono">
                Explorer ↗
              </a>
            )}
          </div>
        )}
      </main>
    </>
  );
}

function FactorBar({ label, pts }: { label: string; pts: number }) {
  const pct = Math.min(100, (pts / 25) * 100);
  return (
    <div className="factor-item">
      <div className="factor-top">
        <span>{label}</span>
        <b>{pts} / 25</b>
      </div>
      <div className="progress">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AdminBento({
  config,
  isAdmin,
  busy,
  onApprove,
  onRevoke,
  onTogglePause,
  onUpdateFees,
}: {
  config: PlatformConfig;
  isAdmin: boolean;
  busy: string | null;
  onApprove: (wallet: PublicKey) => void;
  onRevoke: (wallet: PublicKey) => void;
  onTogglePause: (paused: boolean) => void;
  onUpdateFees: (rentFeeBps: number, saleFeeBps: number) => void;
}) {
  const [kycWallet, setKycWallet] = useState("");
  const [rentFee, setRentFee] = useState(config.rentFeeBps);
  const [saleFee, setSaleFee] = useState(config.saleFeeBps);

  return (
    <div className="bento-grid">
      {/* Span 5: KYC Allow-List Management */}
      <div className="bento-cell span-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onApprove(new PublicKey(kycWallet.trim()));
          }}
        >
          <fieldset className="fieldset-reset">
            <legend className="sr-legend">Реестр инвесторов (approve_investor / revoke_investor)</legend>
            <div className="field">
              <label htmlFor="admin-kyc-wallet">Публичный ключ инвестора (Base58)</label>
              <input
                id="admin-kyc-wallet"
                name="kyc_wallet"
                className="input mono"
                required
                pattern="[1-9A-HJ-NP-Za-km-z]{32,44}"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Адрес кошелька Solana…"
                aria-describedby="admin-kyc-hint"
                value={kycWallet}
                onChange={(e) => setKycWallet(e.target.value)}
              />
              <span id="admin-kyc-hint" className="rules-list">
                Инициализирует или закрывает PDA <code>[&quot;investor&quot;, wallet]</code> с возвратом rent.
              </span>
            </div>
            <div className="row">
              <button type="submit" className="btn teal sm" disabled={busy !== null}>
                Одобрить KYC
              </button>
              <button
                type="button"
                className="btn danger sm"
                disabled={busy !== null || !isAdmin || !kycWallet.trim()}
                onClick={() => onRevoke(new PublicKey(kycWallet.trim()))}
              >
                Отозвать KYC
              </button>
            </div>
          </fieldset>
        </form>
      </div>

      {/* Span 4: Fee Parameters */}
      <div className="bento-cell span-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onUpdateFees(rentFee, saleFee);
          }}
        >
          <fieldset className="fieldset-reset">
            <legend className="sr-legend">Комиссии протокола (set_fees, макс. 2000 bps)</legend>
            <div className="form-grid-2">
              <div className="field">
                <label htmlFor="admin-rent-fee">Аренда (rent_fee_bps)</label>
                <input
                  id="admin-rent-fee"
                  name="rent_fee_bps"
                  className="input mono"
                  type="number"
                  required
                  min={0}
                  max={2000}
                  value={rentFee}
                  onChange={(e) => setRentFee(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="admin-sale-fee">Продажа (sale_fee_bps)</label>
                <input
                  id="admin-sale-fee"
                  name="sale_fee_bps"
                  className="input mono"
                  type="number"
                  required
                  min={0}
                  max={2000}
                  value={saleFee}
                  onChange={(e) => setSaleFee(Number(e.target.value))}
                />
              </div>
            </div>
            <button type="submit" className="btn ghost sm" disabled={busy === "fees" || !isAdmin}>
              Применить комиссии (set_fees)
            </button>
          </fieldset>
        </form>
      </div>

      {/* Span 3: Emergency Circuit Breaker */}
      <div className="bento-cell span-3">
        <div>
          <div className="metric-top">
            <span className="metric-label">Аварийный контур</span>
            <span className={config.paused ? "badge danger" : "badge"}>
              {config.paused ? "PAUSED" : "OPERATIONAL"}
            </span>
          </div>
          <p style={{ fontSize: "0.76rem", color: "var(--text-secondary)", marginTop: "8px" }}>
            Останавливает <code>create_property</code>, <code>buy_shares</code> и <code>deposit_rent</code>. Инструкция{" "}
            <code>claim_rent</code> не блокируется.
          </p>
        </div>
        <button
          type="button"
          className={`btn sm ${config.paused ? "teal" : "danger"}`}
          style={{ width: "100%" }}
          disabled={busy === "pause" || !isAdmin}
          onClick={() => onTogglePause(!config.paused)}
        >
          {config.paused ? "Снять паузу (set_paused(false))" : "Включить паузу (set_paused(true))"}
        </button>
      </div>
    </div>
  );
}

function PropertyCard({
  p,
  featured,
  spanClass,
  config,
  paymentDecimals,
  position,
  me,
  myKyc,
  matchedReport,
  matchedCity,
  solUsd,
  busy,
  onBuy,
  onDeposit,
  onClaim,
}: {
  p: Property;
  featured: boolean;
  spanClass: string;
  config: PlatformConfig | null;
  paymentDecimals: number;
  position?: Position;
  me: PublicKey | null;
  myKyc: boolean;
  matchedReport?: ScoreReport;
  matchedCity?: string;
  solUsd: number | null;
  busy: string | null;
  onBuy: (shares: number) => void;
  onDeposit: (usdc: number) => void;
  onClaim: () => void;
}) {
  const [shares, setShares] = useState(5);
  const [rentUsdc, setRentUsdc] = useState(50);
  const [activeTab, setActiveTab] = useState<"buy" | "claim" | "manage">("buy");

  const a = p.account;
  const key = p.publicKey.toBase58();
  const isOwner = me?.equals(a.owner) ?? false;
  const isManager = me?.equals(a.manager) ?? false;
  const sold = Number(a.sharesSold.toString());
  const total = Number(a.totalShares.toString());
  const pct = total ? (sold / total) * 100 : 0;
  const hashHex = bytesToHex(a.valuationHash);

  const claimable = position
    ? pendingRent(position.shares, a.accRentPerShare, position.rewardDebt, position.unclaimed)
    : null;

  const grossBuyCost = a.pricePerShare.mul(new BN(Math.max(0, shares)));
  const saleFee = config ? bpsOf(grossBuyCost, config.saleFeeBps) : new BN(0);
  const ownerProceeds = grossBuyCost.sub(saleFee);

  const telemetryBlock = (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div className="prop-header">
        <div>
          <h3 className="prop-title">{a.name}</h3>
          <div className="prop-meta">
            {matchedCity && <span>{matchedCity}</span>}
            <span>·</span>
            <span className="mono">
              Mint:{" "}
              <a href={explorerAddress(a.shareMint)} target="_blank" rel="noreferrer">
                {shortKey(a.shareMint)} ↗
              </a>
            </span>
            <span>·</span>
            <span className="mono">NonTransferable</span>
          </div>
        </div>
        {isOwner ? (
          <span className="badge">Owner</span>
        ) : isManager ? (
          <span className="badge">Manager</span>
        ) : (
          <span className="badge neutral">${formatToken(a.pricePerShare, paymentDecimals)} / доля</span>
        )}
      </div>

      {/* Valuation & Risk Strip */}
      <div className="valuation-bar">
        <div className="valuation-row">
          <span className="mono" style={{ color: "var(--text-secondary)" }} title={`0x${hashHex}`}>
            SHA-256: 0x{hashHex.slice(0, 10)}…{hashHex.slice(-6)}
          </span>
          {matchedReport ? (
            <span className="badge">
              Grade {matchedReport.risk_grade} · Risk {matchedReport.risk_score}/100
            </span>
          ) : (
            <span className="badge neutral">Hash Committed</span>
          )}
        </div>
        {matchedReport && (
          <div className="yield-pills">
            <div className="yield-pill">
              <span className="yield-pill-label">Bear</span>
              <span className="yield-pill-val">{(matchedReport.net_yield_bear * 100).toFixed(2)}%</span>
            </div>
            <div className="yield-pill base">
              <span className="yield-pill-label">Base Yield</span>
              <span className="yield-pill-val">{(matchedReport.net_yield_base * 100).toFixed(2)}%</span>
            </div>
            <div className="yield-pill">
              <span className="yield-pill-label">Bull</span>
              <span className="yield-pill-val">{(matchedReport.net_yield_bull * 100).toFixed(2)}%</span>
            </div>
          </div>
        )}
      </div>

      {/* Share Distribution Bar */}
      <div>
        <div className="progress">
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-meta">
          <span>
            Размещено {sold.toLocaleString("en-US")} / {total.toLocaleString("en-US")} долей
          </span>
          <span>{pct.toFixed(1)}%</span>
        </div>
      </div>

      {/* Technical Metrics */}
      <div className="tech-grid">
        <div className="tech-item">
          <span className="tech-item-label">Цена доли</span>
          <span className="tech-item-value">${formatToken(a.pricePerShare, paymentDecimals)} USDC</span>
          <span className="tech-item-sub">
            {solUsd && solUsd > 0
              ? `≈ ${(Number(a.pricePerShare.toString()) / 10 ** paymentDecimals / solUsd).toFixed(4)} SOL (Pyth) · `
              : ""}
            {config && a.owner.equals(config.admin) ? "✓ Verified SPV" : "✓ KYB Issuer"} ({shortKey(a.owner)})
          </span>
        </div>
        <div className="tech-item">
          <span className="tech-item-label">Арендный пул (Net Vault)</span>
          <span className="tech-item-value">${formatToken(a.totalRentDeposited, paymentDecimals)} USDC</span>
          <span className="tech-item-sub">
            Выплачено: ${formatToken(a.totalRentClaimed, paymentDecimals)} USDC
          </span>
        </div>
      </div>
    </div>
  );

  const operationsBlock = (
    <div className="action-box">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span className="metric-label">Операции с объектом</span>
        <div className="segmented" role="tablist" aria-label="Действия по объекту">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "buy"}
            className={`seg-btn ${activeTab === "buy" ? "active" : ""}`}
            onClick={() => setActiveTab("buy")}
          >
            Покупка
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "claim"}
            className={`seg-btn ${activeTab === "claim" ? "active" : ""}`}
            onClick={() => setActiveTab("claim")}
          >
            Позиция {position ? `(${position.shares.toString()})` : ""}
          </button>
          {isManager && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "manage"}
              className={`seg-btn ${activeTab === "manage" ? "active" : ""}`}
              onClick={() => setActiveTab("manage")}
            >
              УК (Аренда)
            </button>
          )}
        </div>
      </div>

      {activeTab === "buy" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onBuy(shares);
          }}
        >
          <div className="field">
            <label htmlFor={`buy-amount-${key}`}>
              Количество долей к покупке (доступно: {(total - sold).toLocaleString("en-US")})
            </label>
            <div className="row">
              <input
                id={`buy-amount-${key}`}
                name="shares"
                className="input mono"
                type="number"
                required
                min={1}
                max={Math.max(1, total - sold)}
                value={shares}
                onChange={(e) => setShares(Number(e.target.value))}
              />
              <button
                type="submit"
                id={`buy-${key}`}
                className="btn"
                disabled={!me || sold >= total || busy === `buy-${key}` || !myKyc || Boolean(config?.paused)}
              >
                {!me
                  ? "Подключите кошелёк"
                  : !myKyc
                    ? "Требуется KYC"
                    : busy === `buy-${key}`
                      ? "Покупка…"
                      : `Купить за $${formatToken(grossBuyCost, paymentDecimals)}`}
              </button>
            </div>
            <span className="rules-list mono">
              Владельцу: ${formatToken(ownerProceeds, paymentDecimals)} USDC · Комиссия протокола: $
              {formatToken(saleFee, paymentDecimals)} USDC
            </span>
          </div>
        </form>
      )}

      {activeTab === "claim" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {position && claimable ? (
            <>
              <div className="tech-grid">
                <div className="tech-item">
                  <span className="tech-item-label">Баланс долей (Position)</span>
                  <span className="tech-item-value">{position.shares.toString()} долей</span>
                  <span className="tech-item-sub">
                    Доля пула: {sold > 0 ? ((Number(position.shares.toString()) / sold) * 100).toFixed(2) : "0"}%
                  </span>
                </div>
                <div className="tech-item">
                  <span className="tech-item-label">Доступно к выводу</span>
                  <span className="tech-item-value" style={{ color: "var(--emerald-light)" }}>
                    ${formatToken(claimable, paymentDecimals)} USDC
                  </span>
                  <span className="tech-item-sub">
                    Получено ранее: ${formatToken(position.totalClaimed, paymentDecimals)} USDC
                  </span>
                </div>
              </div>
              <button
                type="button"
                id={`claim-${key}`}
                className="btn teal"
                disabled={claimable.isZero() || busy === `claim-${key}`}
                onClick={onClaim}
              >
                {busy === `claim-${key}` ? "Вывод средств…" : "Вывести арендный доход (claim_rent)"}
              </button>
            </>
          ) : (
            <div className="rules-list">
              У подключённого кошелька нет открытой позиции <code>Position</code> по данному объекту.
            </div>
          )}
        </div>
      )}

      {activeTab === "manage" && isManager && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onDeposit(rentUsdc);
          }}
        >
          <div className="field">
            <label htmlFor={`rent-amount-${key}`}>
              Сумма арендного платежа в пул (USDC, комиссия {((config?.rentFeeBps ?? 100) / 100).toFixed(2)}%)
            </label>
            <div className="row">
              <input
                id={`rent-amount-${key}`}
                name="rent_usdc"
                className="input mono"
                type="number"
                required
                min={0.01}
                step="any"
                value={rentUsdc}
                onChange={(e) => setRentUsdc(Number(e.target.value))}
              />
              <button
                type="submit"
                id={`deposit-${key}`}
                className="btn ghost"
                disabled={busy === `dep-${key}` || sold === 0 || Boolean(config?.paused)}
              >
                {busy === `dep-${key}` ? "Внесение…" : "Внести аренду (deposit_rent)"}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );

  return (
    <article className={`bento-cell ${spanClass}`}>
      {featured ? (
        <div className="prop-Split">
          {telemetryBlock}
          {operationsBlock}
        </div>
      ) : (
        <>
          {telemetryBlock}
          {operationsBlock}
        </>
      )}
    </article>
  );
}
