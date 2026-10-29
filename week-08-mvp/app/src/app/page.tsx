"use client";

import { BN, type ProgramAccount, type IdlAccounts } from "@anchor-lang/core";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RooficMvp } from "@/idl/roofic_mvp";
import {
  explorerTx,
  pendingRent,
  positionPda,
  propertyPda,
  sol,
  useProgram,
  useReadonlyProgram,
} from "@/lib/program";
import { useSolUsd } from "@/lib/pyth";

type Property = ProgramAccount<IdlAccounts<RooficMvp>["property"]>;
type Position = IdlAccounts<RooficMvp>["position"];
type Toast = { kind: "ok" | "error"; text: string; sig?: string } | null;

export default function Home() {
  const { publicKey } = useWallet();
  const program = useProgram();
  const reader = useReadonlyProgram();
  const solUsd = useSolUsd(45_000);
  const usd = (lamports: BN | number): string | null =>
    solUsd === null
      ? null
      : `≈ $${((Number(lamports.toString()) / 1e9) * solUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  const [properties, setProperties] = useState<Property[]>([]);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await reader.account.property.all();
      all.sort((a, b) => b.account.sharesSold.cmp(a.account.sharesSold));
      setProperties(all);
      if (publicKey) {
        const mine = await reader.account.position.all([
          { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
        ]);
        setPositions(Object.fromEntries(mine.map((p) => [p.account.property.toBase58(), p.account])));
      } else setPositions({});
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [reader, publicKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  const run = async (key: string, label: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      const sig = await fn();
      setToast({ kind: "ok", text: label, sig });
      await refresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ kind: "error", text: msg.split("\n")[0].slice(0, 180) });
    } finally {
      setBusy(null);
    }
  };

  const stats = useMemo(() => {
    const raised = properties.reduce(
      (s, p) => s + Number(p.account.sharesSold.mul(p.account.pricePerShare).toString()),
      0,
    );
    const rent = properties.reduce((s, p) => s + Number(p.account.totalRentDeposited.toString()), 0);
    return { count: properties.length, raised, rent, investors: Object.keys(positions).length };
  }, [properties, positions]);

  return (
    <>
      <div className="topbar">
        <div className="container header">
          <div className="brand-group">
            <div className="logo">
              <div className="logo-mark">R</div>
              <span>ROOFIC</span>
            </div>
            <span className="badge emerald">MVP · SOL + PYTH</span>
          </div>

          <nav className="nav-links" aria-label="Навигация MVP">
            <a href="#metrics" className="nav-link">
              Метрики
            </a>
            <a href="#catalog" className="nav-link">
              Объекты ({stats.count})
            </a>
            <a href="#create" className="nav-link">
              Листинг
            </a>
          </nav>

          <WalletMultiButton />
        </div>
      </div>

      <main className="container">
        <section className="page-intro">
          <div className="kicker">
            <span className="kicker-dot" />
            SOLANA DEVNET · PYTH PRICEFEED V2
          </div>
          <h1>Протокол долевой аренды в нативном SOL</h1>
          <p>
            Покупка долей объектов недвижимости за нативный SOL с пропорциональным начислением арендного пула через{" "}
            <code>acc_rent_per_share</code> и котировкой SOL/USD из ончейн-оракула Pyth.
          </p>
        </section>

        {/* SECTION: METRICS BENTO */}
        <section id="metrics" className="section-block" aria-labelledby="sec-mvp-metrics">
          <div className="section-header">
            <div className="section-header-left">
              <span className="section-index">ТЕЛЕМЕТРИЯ ПУЛА</span>
              <h2 id="sec-mvp-metrics">Капитализация и курс оракула Pyth</h2>
            </div>
            <button className="btn ghost" onClick={refresh} id="refresh-btn">
              Обновить состояние
            </button>
          </div>

          <div className="bento-grid">
            <div className="bento-cell span-5 accent-cell">
              <div className="metric-top">
                <span className="metric-label">Привлечено в пулы</span>
                <span className="badge emerald">SOL</span>
              </div>
              <div className="metric-value">{sol(stats.raised)} SOL</div>
              {usd(stats.raised) && <div className="metric-sub">{usd(stats.raised)} (Pyth SOL/USD)</div>}
            </div>

            <div className="bento-cell span-4">
              <div className="metric-top">
                <span className="metric-label">Депозиты аренды</span>
              </div>
              <div className="metric-value">{sol(stats.rent)} SOL</div>
              {usd(stats.rent) && <div className="metric-sub">{usd(stats.rent)}</div>}
            </div>

            <div className="bento-cell span-3">
              <div className="metric-top">
                <span className="metric-label">Объекты / Позиции</span>
              </div>
              <div className="metric-value">
                {stats.count} / {stats.investors}
              </div>
              <div className="metric-sub">
                {solUsd ? `SOL/USD: $${solUsd.toFixed(2)}` : "Синхронизация Pyth…"}
              </div>
            </div>
          </div>
        </section>

        {/* SECTION: CATALOG BENTO */}
        <section id="catalog" className="section-block" aria-labelledby="sec-mvp-catalog">
          <div className="section-header">
            <div className="section-header-left">
              <span className="section-index">КАТАЛОГ ОБЪЕКТОВ</span>
              <h2 id="sec-mvp-catalog">Активные пулы недвижимости ({properties.length})</h2>
            </div>
          </div>

          {loading ? (
            <div className="empty">Чтение аккаунтов из Solana Devnet…</div>
          ) : properties.length === 0 ? (
            <div className="empty">В реестре нет объектов. Зарегистрируйте объект в секции листинга ниже.</div>
          ) : (
            <div className="bento-grid">
              {properties.map((p, idx) => {
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
                    spanClass={spanClass}
                    position={positions[p.publicKey.toBase58()]}
                    me={publicKey}
                    usd={usd}
                    busy={busy}
                    onBuy={(shares) =>
                      run(`buy-${p.publicKey}`, `Куплено долей: ${shares}`, () =>
                        program!.methods
                          .buyShares(new BN(shares))
                          .accountsPartial({
                            property: p.publicKey,
                            position: positionPda(p.publicKey, publicKey!),
                            investor: publicKey!,
                            authority: p.account.authority,
                            systemProgram: SystemProgram.programId,
                          })
                          .rpc(),
                      )
                    }
                    onDeposit={(amount) =>
                      run(`dep-${p.publicKey}`, `Внесено аренды: ${amount} SOL`, () =>
                        program!.methods
                          .depositRent(new BN(Math.round(amount * LAMPORTS_PER_SOL)))
                          .accountsPartial({
                            property: p.publicKey,
                            authority: publicKey!,
                            systemProgram: SystemProgram.programId,
                          })
                          .rpc(),
                      )
                    }
                    onClaim={() =>
                      run(`claim-${p.publicKey}`, "Доход выплачен", () =>
                        program!.methods
                          .claimRent()
                          .accountsPartial({
                            property: p.publicKey,
                            position: positionPda(p.publicKey, publicKey!),
                            investor: publicKey!,
                          })
                          .rpc(),
                      )
                    }
                  />
                );
              })}
            </div>
          )}
        </section>

        {/* SECTION: CREATE PROPERTY */}
        <section id="create" className="section-block" aria-labelledby="sec-mvp-create">
          <div className="section-header">
            <div className="section-header-left">
              <span className="section-index">ЭМИССИЯ ОБЪЕКТА</span>
              <h2 id="sec-mvp-create">Регистрация нового объекта (create_property)</h2>
            </div>
          </div>

          {publicKey && program ? (
            <CreateProperty
              busy={busy}
              onSubmit={(args) =>
                run("create", "Объект зарегистрирован", async () => {
                  const id = new BN(Date.now());
                  return program.methods
                    .createProperty(
                      id,
                      args.name,
                      args.location,
                      new BN(args.shares),
                      new BN(Math.round(args.price * LAMPORTS_PER_SOL)),
                    )
                    .accountsPartial({
                      property: propertyPda(publicKey, id),
                      authority: publicKey,
                      systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                })
              }
            />
          ) : (
            <div className="empty">Подключите кошелёк в верхнем меню для регистрации нового объекта.</div>
          )}
        </section>

        <footer className="footer">
          <div>ROOFIC MVP · SOLANA DEVNET</div>
          <a href="https://github.com/Abdulla-Nurislam/Roofic" target="_blank" rel="noreferrer" className="mono">
            GitHub ↗
          </a>
        </footer>

        {toast && (
          <div className={`toast ${toast.kind}`} role="status">
            <span className="mono">{toast.kind === "ok" ? "[OK]" : "[ERR]"}</span> {toast.text}
            {toast.sig && (
              <>
                {" · "}
                <a href={explorerTx(toast.sig)} target="_blank" rel="noreferrer" className="mono">
                  Explorer ↗
                </a>
              </>
            )}
          </div>
        )}
      </main>
    </>
  );
}

function CreateProperty({
  busy,
  onSubmit,
}: {
  busy: string | null;
  onSubmit: (a: { name: string; location: string; shares: number; price: number }) => void;
}) {
  const [name, setName] = useState("Almaty Loft #1");
  const [location, setLocation] = useState("Almaty, Kazakhstan");
  const [shares, setShares] = useState(1000);
  const [price, setPrice] = useState(0.01);
  return (
    <form
      className="bento-cell form-card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, location, shares, price });
      }}
    >
      <label className="field">
        Название
        <input id="create-name" className="input" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Локация
        <input
          id="create-location"
          className="input"
          value={location}
          maxLength={64}
          onChange={(e) => setLocation(e.target.value)}
        />
      </label>
      <label className="field">
        Всего долей
        <input
          id="create-shares"
          className="input mono"
          type="number"
          min={1}
          value={shares}
          onChange={(e) => setShares(+e.target.value)}
        />
      </label>
      <label className="field">
        Цена доли (SOL)
        <input
          id="create-price"
          className="input mono"
          type="number"
          min={0.000001}
          step="any"
          value={price}
          onChange={(e) => setPrice(+e.target.value)}
        />
      </label>
      <button id="create-submit" className="btn" disabled={busy === "create" || !name}>
        {busy === "create" ? "Отправка…" : "Создать объект"}
      </button>
    </form>
  );
}

function PropertyCard({
  p,
  spanClass,
  position,
  me,
  usd,
  busy,
  onBuy,
  onDeposit,
  onClaim,
}: {
  p: Property;
  spanClass: string;
  position?: Position;
  me: PublicKey | null;
  usd: (lamports: BN | number) => string | null;
  busy: string | null;
  onBuy: (shares: number) => void;
  onDeposit: (sol: number) => void;
  onClaim: () => void;
}) {
  const [shares, setShares] = useState(10);
  const [rent, setRent] = useState(0.05);
  const a = p.account;
  const key = p.publicKey.toBase58();
  const isOwner = me?.equals(a.authority) ?? false;
  const sold = Number(a.sharesSold.toString());
  const total = Number(a.totalShares.toString());
  const pct = total ? (sold / total) * 100 : 0;
  const claimable = position
    ? pendingRent(position.shares, a.accRentPerShare, position.rewardDebt, position.unclaimed)
    : null;

  return (
    <article className={`bento-cell ${spanClass}`}>
      <div className="metric-top">
        <div>
          <h3 style={{ fontSize: "1.1rem" }}>{a.name}</h3>
          <div style={{ color: "var(--text-secondary)", fontSize: "0.78rem", marginTop: 4 }}>
            {a.location || "—"}
          </div>
        </div>
        {isOwner ? (
          <span className="pill mine">Authority</span>
        ) : (
          <span className="pill">{sol(a.pricePerShare)} SOL / доля</span>
        )}
      </div>

      <div>
        <div className="progress">
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-label">
          <span>
            Размещено {sold.toLocaleString("en-US")} / {total.toLocaleString("en-US")}
          </span>
          <span>{pct.toFixed(1)}%</span>
        </div>
      </div>

      <div className="kv">
        <div>
          <span>Цена доли</span>
          <strong>{sol(a.pricePerShare)} SOL</strong>
          {usd(a.pricePerShare) && <small className="usd">{usd(a.pricePerShare)}</small>}
        </div>
        <div>
          <span>Пул аренды</span>
          <strong>{sol(a.totalRentDeposited)} SOL</strong>
          {usd(a.totalRentDeposited) && <small className="usd">{usd(a.totalRentDeposited)}</small>}
        </div>
      </div>

      {position && claimable && (
        <div className="position">
          <span>
            Доли: <b>{position.shares.toString()}</b> · Доступно: <b>{sol(claimable)} SOL</b>
          </span>
          <button
            id={`claim-${key}`}
            className="btn teal"
            disabled={claimable.isZero() || busy === `claim-${key}`}
            onClick={onClaim}
          >
            Claim
          </button>
        </div>
      )}

      {me && sold < total && (
        <div className="row">
          <input
            id={`buy-amount-${key}`}
            className="input mono"
            type="number"
            min={1}
            max={total - sold}
            value={shares}
            onChange={(e) => setShares(+e.target.value)}
          />
          <button
            id={`buy-${key}`}
            className="btn"
            disabled={busy === `buy-${key}` || shares < 1}
            onClick={() => onBuy(shares)}
          >
            Купить за {sol(a.pricePerShare.mul(new BN(shares || 0)))} SOL
          </button>
        </div>
      )}

      {isOwner && (
        <div className="row">
          <input
            id={`rent-amount-${key}`}
            className="input mono"
            type="number"
            min={0}
            step="any"
            value={rent}
            onChange={(e) => setRent(+e.target.value)}
          />
          <button
            id={`deposit-${key}`}
            className="btn ghost"
            disabled={busy === `dep-${key}` || sold === 0 || rent <= 0}
            onClick={() => onDeposit(rent)}
          >
            Внести аренду
          </button>
        </div>
      )}
    </article>
  );
}
