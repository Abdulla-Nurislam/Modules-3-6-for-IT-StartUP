"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";
import { Bars, Sparkline } from "@/components/charts";
import { useAsync } from "@/lib/hooks";
import {
  DEFAULT_WATCHED,
  NETWORKS,
  fetchCluster,
  fetchProgramActivity,
  fetchSolBalance,
  fetchTokens,
  fetchTransactions,
  programLabel,
  short,
  type NetworkId,
} from "@/lib/rpc";
import { useNetwork } from "./providers";

const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d });
const ago = (t: number | null) => {
  if (t == null) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const parseKey = (s: string): PublicKey | null => {
  try {
    return s ? new PublicKey(s.trim()) : null;
  } catch {
    return null;
  }
};

function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box">
      [ERR] {message}{" "}
      {onRetry && (
        <button className="btn ghost sm" style={{ marginInlineStart: 8 }} onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 01. Cluster Telemetry (Asymmetric Bento Grid)
// ---------------------------------------------------------------------------
function ClusterSection({ network }: { network: NetworkId }) {
  const { connection } = useConnection();
  const { data, error, loading, reload } = useAsync(() => fetchCluster(connection), `cluster:${network}`, 15_000);

  return (
    <section id="cluster" className="section-block" aria-labelledby="sec-cluster">
      <div className="section-header">
        <div className="section-header-left">
          <span className="section-index">ТЕЛЕМЕТРИЯ КЛАСТЕРА</span>
          <h2 id="sec-cluster">Производительность узла и прогресс эпохи</h2>
          <p className="section-desc">
            Прямое чтение методов <code>getEpochInfo</code>, <code>getRecentPerformanceSamples</code> и{" "}
            <code>getVersion</code> с интервалом опроса 15 секунд.
          </p>
        </div>
        <button type="button" className="btn ghost sm" onClick={reload}>
          Опросить RPC
        </button>
      </div>

      {error && !data ? (
        <ErrorBox message={`Не удалось подключиться к ${NETWORKS[network].label} RPC: ${error}`} onRetry={reload} />
      ) : loading || !data ? (
        <div className="bento-cell">
          <Skeleton rows={4} />
        </div>
      ) : (
        <div className="bento-grid">
          {/* Span 5, Row-span 2: TPS + Sparkline */}
          <div className="bento-cell span-5 row-span-2 accent-cell">
            <div>
              <div className="metric-top">
                <span className="metric-label">
                  {data.tpsNonVote ? "Пропускная способность (Non-Vote TPS)" : "Пропускная способность (Total TPS)"}
                </span>
                <span className="badge emerald">LIVE 15S</span>
              </div>
              <div className="metric-value lg">{fmt(data.tps, 0)} tx/s</div>
            </div>
            <div>
              <Sparkline values={data.tpsSeries} />
              <div className="metric-sub" style={{ marginTop: "8px" }}>
                <span>Выборка: {data.tpsSeries.length} интервалов (getRecentPerformanceSamples)</span>
              </div>
            </div>
          </div>

          {/* Span 4: Slot & Block Height */}
          <div className="bento-cell span-4">
            <div>
              <div className="metric-top">
                <span className="metric-label">Текущий слот (Slot)</span>
                <span className="badge">CONFIRMED</span>
              </div>
              <div className="metric-value">{data.slot.toLocaleString("en-US")}</div>
            </div>
            <div className="metric-sub">
              <span>Высота блока (blockHeight):</span>
              <strong className="mono">{data.blockHeight.toLocaleString("en-US")}</strong>
            </div>
          </div>

          {/* Span 3: Validator Core Version */}
          <div className="bento-cell span-3">
            <div>
              <div className="metric-top">
                <span className="metric-label">Версия ядра</span>
              </div>
              <div className="metric-value" style={{ fontSize: "1.4rem" }}>
                v{data.version}
              </div>
            </div>
            <div className="metric-sub">
              <span>Кластер:</span>
              <strong className="mono">{NETWORKS[network].label}</strong>
            </div>
          </div>

          {/* Span 7: Epoch Progress */}
          <div className="bento-cell span-7">
            <div className="metric-top">
              <span className="metric-label">Эпоха {data.epoch} (Epoch Progress)</span>
              <span className="mono" style={{ fontSize: "0.86rem", fontWeight: 600 }}>
                {fmt(data.epochProgress * 100, 2)}%
              </span>
            </div>
            <div>
              <div className="progress">
                <div style={{ width: `${data.epochProgress * 100}%` }} />
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 02 & 03. Address Inspection, Token Portfolio & Transaction Journal
// ---------------------------------------------------------------------------
function PortfolioAndTxSections({ network }: { network: NetworkId }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [input, setInput] = useState("");

  useEffect(() => {
    if (publicKey) setInput(publicKey.toBase58());
  }, [publicKey]);

  const owner = useMemo(() => parseKey(input), [input]);
  const key = owner ? `${network}:${owner.toBase58()}` : null;

  const balance = useAsync(() => fetchSolBalance(connection, owner!), key && `bal:${key}`, 30_000);
  const tokens = useAsync(() => fetchTokens(connection, owner!), key && `tok:${key}`, 30_000);
  const txs = useAsync(() => fetchTransactions(connection, owner!, 12), key && `tx:${key}`, 30_000);

  const explorer = (path: string) => `https://explorer.solana.com/${path}${NETWORKS[network].explorer}`;

  return (
    <>
      {/* SECTION: ADDRESS & TOKEN PORTFOLIO */}
      <section id="portfolio" className="section-block" aria-labelledby="sec-portfolio">
        <div className="section-header">
          <div className="section-header-left">
            <span className="section-index">ИНСПЕКЦИЯ АДРЕСА И ТОКЕНЫ</span>
            <h2 id="sec-portfolio">Балансы SPL Token и Token-2022</h2>
            <p className="section-desc">
              Запрашивает <code>getBalance</code> и декодирует токен-аккаунты обеих программ (включая расширения{" "}
              <code>NonTransferable</code>, <code>TransferFeeConfig</code>, <code>MetadataPointer</code>).
            </p>
          </div>
          {!input && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setInput("96J4Ff8y3ekxsXQyVGZWpSPHhwdvk4MvnJ7PXJaRRp3U")}
            >
              Подставить демо-адрес Roofic
            </button>
          )}
        </div>

        <div className="bento-grid">
          {/* Span 5: Target Address Input & Summary Metrics */}
          <div className="bento-cell span-5">
            <div className="field">
              <label htmlFor="inspect-address">Исследуемый публичный ключ (Base58)</label>
              <div className="row">
                <input
                  id="inspect-address"
                  className="input mono"
                  placeholder="Введите адрес кошелька или PDA…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  spellCheck={false}
                />
                {input && (
                  <button type="button" className="btn ghost" onClick={() => setInput("")}>
                    Сброс
                  </button>
                )}
              </div>
              {input && !owner && <div className="error-box">[ERR] Некорректный Base58-ключ Solana.</div>}
            </div>

            {owner && (
              <div className="tech-grid">
                <div className="tech-item">
                  <span className="tech-item-label">Баланс SOL</span>
                  <span className="tech-item-value">
                    {balance.data !== null ? `${fmt(balance.data, 4)} SOL` : balance.error ? "—" : "…"}
                  </span>
                </div>
                <div className="tech-item">
                  <span className="tech-item-label">Токен-счетов</span>
                  <span className="tech-item-value">{tokens.data ? tokens.data.length : "…"}</span>
                </div>
                <div className="tech-item">
                  <span className="tech-item-label">Успешность TX</span>
                  <span className="tech-item-value">
                    {txs.data && txs.data.length
                      ? `${Math.round((txs.data.filter((t) => t.ok).length / txs.data.length) * 100)}%`
                      : "—"}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Span 7: Token Accounts Table */}
          <div className="bento-cell span-7">
            <div className="metric-top">
              <span className="metric-label">Реестр токен-аккаунтов</span>
              <span className="badge">SPL + Token-2022</span>
            </div>

            {!owner ? (
              <div className="muted small">Укажите валидный адрес в поле слева для чтения токен-счетов.</div>
            ) : tokens.error && !tokens.data ? (
              <ErrorBox message={tokens.error} onRetry={tokens.reload} />
            ) : !tokens.data ? (
              <Skeleton rows={4} />
            ) : tokens.data.length === 0 ? (
              <div className="muted small">На выбранном адресе нет открытых токен-аккаунтов в {NETWORKS[network].label}.</div>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-label="Таблица токенов кошелька"
                className="table-wrapper"
              >
                <table
                  className="data"
                  style={
                    {
                      "--label-2": '"Баланс"',
                      "--label-3": '"Стандарт"',
                    } as React.CSSProperties
                  }
                >
                  <thead>
                    <tr>
                      <th>Токен / Минт</th>
                      <th className="num">Баланс</th>
                      <th>Стандарт</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.data.map((t) => (
                      <tr key={t.account}>
                        <td>
                          <div>
                            <a href={explorer(`address/${t.mint}`)} target="_blank" rel="noreferrer" className="mono">
                              <b>{t.symbol}</b> ↗
                            </a>{" "}
                            <span className="muted small">{t.name}</span>
                          </div>
                          {t.extensions.length > 0 && (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                              {t.extensions.map((e) => (
                                <span key={e} className="tag ok">
                                  {e}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="num mono">{fmt(t.amount, Math.min(t.decimals, 6))}</td>
                        <td className="mono small muted">{t.program}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* SECTION: TRANSACTION JOURNAL */}
      <section id="transactions" className="section-block" aria-labelledby="sec-tx">
        <div className="section-header">
          <div className="section-header-left">
            <span className="section-index">ЖУРНАЛ ТРАНЗАКЦИЙ</span>
            <h2 id="sec-tx">История вызовов и изменение баланса SOL</h2>
            <p className="section-desc">
              Последние 12 транзакций адреса по данным <code>getSignaturesForAddress</code> и{" "}
              <code>getParsedTransactions</code>.
            </p>
          </div>
          {owner && (
            <button type="button" className="btn ghost sm" onClick={txs.reload}>
              Обновить журнал
            </button>
          )}
        </div>

        <div className="bento-grid">
          <div className="bento-cell span-12">
            {!owner ? (
              <div className="muted small">Укажите адрес в секции инспекции для загрузки истории транзакций.</div>
            ) : txs.error && !txs.data ? (
              <ErrorBox message={txs.error} onRetry={txs.reload} />
            ) : !txs.data ? (
              <Skeleton rows={5} />
            ) : txs.data.length === 0 ? (
              <div className="muted small">Транзакций не найдено.</div>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-label="Журнал последних транзакций"
                className="table-wrapper"
              >
                <table
                  className="data"
                  style={
                    {
                      "--label-2": '"Вызванные программы"',
                      "--label-3": '"Δ SOL"',
                      "--label-4": '"Время"',
                    } as React.CSSProperties
                  }
                >
                  <thead>
                    <tr>
                      <th>Подпись (Signature)</th>
                      <th>Инструкции и Программы</th>
                      <th className="num">Δ SOL</th>
                      <th className="num">Время</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txs.data.map((t) => (
                      <tr key={t.signature}>
                        <td>
                          <a className="mono" href={explorer(`tx/${t.signature}`)} target="_blank" rel="noreferrer">
                            {short(t.signature, 6)} ↗
                          </a>{" "}
                          <span className={`tag ${t.ok ? "ok" : "fail"}`} title={t.error}>
                            {t.ok ? "OK" : "ERR"}
                          </span>
                        </td>
                        <td>
                          <div className="small">{t.summary}</div>
                          <div className="muted small mono">{t.programs.map(programLabel).join(" · ")}</div>
                        </td>
                        <td className={`num mono ${t.solChange > 0 ? "pos" : t.solChange < 0 ? "neg" : ""}`}>
                          {t.solChange > 0 ? "+" : ""}
                          {fmt(t.solChange, 5)}
                        </td>
                        <td className="num muted small mono">{ago(t.time)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 04. Program Activity Telemetry (Asymmetric Bento Grid)
// ---------------------------------------------------------------------------
function ProgramCard({
  programId,
  spanClass,
  network,
  onRemove,
}: {
  programId: string;
  spanClass: string;
  network: NetworkId;
  onRemove: () => void;
}) {
  const { connection } = useConnection();
  const { data, error, loading, reload } = useAsync(
    () => fetchProgramActivity(connection, programId, 100, 24),
    `prog:${network}:${programId}`,
    60_000,
  );

  return (
    <div className={`bento-cell ${spanClass}`}>
      <div className="metric-top">
        <div>
          <h3 style={{ fontSize: "1.05rem" }}>{programLabel(programId)}</h3>
          <div className="muted small mono" style={{ marginTop: 4 }}>
            {short(programId, 8)}
          </div>
        </div>
        <button className="btn ghost sm" onClick={onRemove} aria-label="Удалить программу из мониторинга">
          ✕
        </button>
      </div>

      {error && !data ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : loading || !data ? (
        <Skeleton rows={3} />
      ) : data.total === 0 ? (
        <div className="muted small">Нет транзакций в выборке {NETWORKS[network].label}.</div>
      ) : (
        <>
          <div className="tech-grid">
            <div className="tech-item">
              <span className="tech-item-label">Выборка ({data.total} tx)</span>
              <span className="tech-item-value">{ago(data.lastTime)}</span>
            </div>
            <div className="tech-item">
              <span className="tech-item-label">Доля ошибок</span>
              <span className={`tech-item-value ${data.failed ? "neg" : "pos"}`}>
                {fmt((data.failed / data.total) * 100, 1)}%
              </span>
            </div>
          </div>

          <div>
            <Bars values={data.buckets} />
            <div className="muted small" style={{ marginTop: 6 }}>
              Распределение вызовов по временным окнам (старые → новые)
            </div>
          </div>

          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {data.recent.map((r) => (
              <a
                key={r.signature}
                className={`tag ${r.ok ? "ok" : "fail"} mono`}
                href={`https://explorer.solana.com/tx/${r.signature}${NETWORKS[network].explorer}`}
                target="_blank"
                rel="noreferrer"
              >
                {short(r.signature, 4)}
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProgramsSection({ network }: { network: NetworkId }) {
  const [programs, setPrograms] = useState<string[]>(DEFAULT_WATCHED[network]);
  const [input, setInput] = useState("");

  useEffect(() => setPrograms(DEFAULT_WATCHED[network]), [network]);

  const add = () => {
    const k = parseKey(input);
    if (!k) return;
    const id = k.toBase58();
    setPrograms((p) => (p.includes(id) ? p : [...p, id]));
    setInput("");
  };
  const invalid = input !== "" && !parseKey(input);

  return (
    <section id="programs" className="section-block" aria-labelledby="sec-programs">
      <div className="section-header">
        <div className="section-header-left">
          <span className="section-index">МОНИТОРИНГ ОНЧЕЙН-ПРОГРАММ</span>
          <h2 id="sec-programs">Частота вызовов и процент отказов</h2>
          <p className="section-desc">
            Гистограмма активности на базе последних сигнатур каждого отслеживаемого Program ID.
          </p>
        </div>
      </div>

      <div className="bento-grid">
        <div className="bento-cell span-12">
          <div className="row">
            <input
              className="input mono"
              placeholder="Добавить Program ID или PDA для отслеживания…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              spellCheck={false}
            />
            <button className="btn" onClick={add} disabled={!input || invalid}>
              Добавить в мониторинг
            </button>
          </div>
          {invalid && <div className="error-box">[ERR] Некорректный Base58-адрес программы.</div>}
        </div>

        {programs.length === 0 ? (
          <div className="empty span-12">Список отслеживаемых программ пуст.</div>
        ) : (
          programs.map((id, idx) => {
            const spanClass =
              idx % 2 === 0
                ? programs.length === idx + 1
                  ? "span-12"
                  : "span-7"
                : "span-5";
            return (
              <ProgramCard
                key={`${network}:${id}`}
                programId={id}
                spanClass={spanClass}
                network={network}
                onRemove={() => setPrograms((p) => p.filter((x) => x !== id))}
              />
            );
          })
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
export default function Dashboard() {
  const { network, setNetwork } = useNetwork();

  return (
    <>
      <div className="topbar">
        <div className="container header">
          <div className="brand-group">
            <div className="logo">
              <div className="logo-mark">R</div>
              <span>ROOFIC</span>
            </div>
            <span className="badge emerald">RPC TELEMETRY</span>
          </div>

          <nav className="nav-links" aria-label="Секции дашборда">
            <a href="#cluster" className="nav-link">
              Кластер
            </a>
            <a href="#portfolio" className="nav-link">
              Адрес и Токены
            </a>
            <a href="#transactions" className="nav-link">
              Журнал TX
            </a>
            <a href="#programs" className="nav-link">
              Программы
            </a>
          </nav>

          <div className="header-actions">
            <select
              className="input mono"
              value={network}
              onChange={(e) => setNetwork(e.target.value as NetworkId)}
              aria-label="Выбор кластера Solana"
            >
              {(Object.keys(NETWORKS) as NetworkId[]).map((n) => (
                <option key={n} value={n}>
                  {NETWORKS[n].label}
                </option>
              ))}
            </select>
            <WalletMultiButton />
          </div>
        </div>
      </div>

      <main className="container">
        <section className="page-intro">
          <div className="kicker">
            <span className="kicker-dot" />
            SOLANA JSON-RPC INSPECTOR · ZERO INDEXER
          </div>
          <h1>Прямая телеметрия кластера и аккаунтов Solana</h1>
          <p>
            Мониторинг пропускной способности сети, декодирование расширений SPL Token-2022, аудит журнала транзакций и
            отслеживание отказов смарт-контрактов напрямую через JSON-RPC.
          </p>
        </section>

        <ClusterSection network={network} />
        <PortfolioAndTxSections network={network} />
        <ProgramsSection network={network} />

        <footer className="footer">
          <div>ROOFIC RPC TELEMETRY · WEEK 10</div>
          <div className="mono">{NETWORKS[network].url}</div>
        </footer>
      </main>
    </>
  );
}
