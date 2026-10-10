import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts'

export function Bad() {
  return (
    <LineChart data={[]}>
      <CartesianGrid vertical={false} /> {/* expect: chart-chrome-tokens */}
      <CartesianGrid stroke="currentColor" /> {/* expect: chart-chrome-tokens */}
      <XAxis dataKey="t" tick={{ fill: 'var(--muted-foreground)' }} /> {/* expect: chart-chrome-tokens */}
      <YAxis stroke="var(--border)" tick={{ fontSize: 12 }} /> {/* expect: chart-chrome-tokens */}
      <Tooltip /> {/* expect: chart-chrome-tokens */}
      <Tooltip cursor={false} /> {/* expect: chart-chrome-tokens */}
      <CartesianGrid stroke="var(--border)" vertical={false} />
      <XAxis dataKey="t" stroke="var(--border)" tick={{ fill: 'var(--color-muted-foreground)' }} />
      <YAxis stroke="var(--border)" tick={false} />
      <YAxis hide />
      <Tooltip cursor={{ fill: 'var(--muted)' }} />
      <Line dataKey="value" />
    </LineChart>
  )
}
