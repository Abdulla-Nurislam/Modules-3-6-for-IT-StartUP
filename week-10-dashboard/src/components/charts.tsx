// Dependency-free SVG charts: a sparkline for time series and a bar histogram.

export function Sparkline({
  values,
  height = 68,
  color = "var(--emerald)",
}: {
  values: number[];
  height?: number;
  color?: string;
}) {
  if (values.length < 2) return <div className="muted small">Недостаточно выборок</div>;
  const w = 320;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(max - min, 1e-9);
  const pts = values.map(
    (v, i) => [(i / (values.length - 1)) * w, height - 6 - ((v - min) / span) * (height - 12)] as const,
  );
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label="График TPS"
      style={{ display: "block" }}
    >
      <polygon points={`0,${height} ${line} ${w},${height}`} fill={color} opacity="0.1" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Bars({ values, height = 52 }: { values: number[]; height?: number }) {
  const max = Math.max(...values, 1);
  return (
    <div className="bars" style={{ height }} role="img" aria-label="Гистограмма транзакций">
      {values.map((v, i) => (
        <div
          key={i}
          className="bar"
          style={{ height: `${Math.max((v / max) * 100, v > 0 ? 8 : 3)}%`, opacity: v > 0 ? 0.9 : 0.2 }}
          title={`${v} tx`}
        />
      ))}
    </div>
  );
}
