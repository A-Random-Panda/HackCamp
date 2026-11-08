import type { Diagram } from "@/lib/renovo-types";

export function DiagramView({ d }: { d: Diagram }) {
  const pad = 40;
  const scale = 520 / Math.max(d.width, d.height, 1);
  const W = d.width * scale + pad * 2;
  const H = d.height * scale + pad * 2;
  return (
    <figure className="glass rounded-2xl p-4">
      <figcaption className="mb-2 font-display text-sm font-bold text-brand">{d.title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={d.title}>
        <rect x={pad} y={pad} width={d.width * scale} height={d.height * scale} fill="var(--brand-dark)" fillOpacity={0.35} stroke="var(--brand)" strokeWidth={3} />
        <text x={pad + (d.width * scale) / 2} y={pad - 12} textAnchor="middle" fill="var(--foreground)" fontSize={14}>
          {d.width} {d.unit}
        </text>
        <text x={pad - 12} y={pad + (d.height * scale) / 2} textAnchor="middle" fill="var(--foreground)" fontSize={14} transform={`rotate(-90 ${pad - 12} ${pad + (d.height * scale) / 2})`}>
          {d.height} {d.unit}
        </text>
        {d.shapes.map((s, i) => {
          const x = pad + s.x * scale, y = pad + s.y * scale, w = s.w * scale, h = s.h * scale;
          return (
            <g key={i}>
              <rect x={x} y={y} width={w} height={h} rx={4} fill="var(--brand)" fillOpacity={0.18} stroke="var(--foreground)" strokeDasharray="5 4" strokeWidth={1.5} />
              <text x={x + w / 2} y={y + h / 2 - 2} textAnchor="middle" fill="var(--foreground)" fontSize={12} fontWeight={700}>{s.label}</text>
              <text x={x + w / 2} y={y + h / 2 + 13} textAnchor="middle" fill="var(--foreground)" fillOpacity={0.7} fontSize={11}>
                {s.w}×{s.h} {d.unit}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
