import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { cn } from "~/lib/utils";
import type {
  ComparedMetric,
  CompletionRate,
  HeadlineMetrics,
  RangeKey,
} from "~/services/analyticsService";

// ─── Analytics UI ───
// Shared by the analytics overview and the per-course analytics page.

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "12m", label: "12 months" },
  { key: "all", label: "All time" },
];

/** Integer cents as USD, e.g. 123456 → "$1,234.56". */
export function formatUsd(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export function formatPercent(ratio: number) {
  return `${Math.round(ratio * 100)}%`;
}

/** Links that set `range` in the URL, keeping any other search params. */
export function RangeSelector({
  selected,
  searchParams,
}: {
  selected: RangeKey;
  searchParams: URLSearchParams;
}) {
  return (
    <div
      role="group"
      aria-label="Time range"
      className="inline-flex flex-wrap rounded-lg border bg-muted p-1"
    >
      {RANGE_OPTIONS.map(({ key, label }) => {
        const params = new URLSearchParams(searchParams);
        params.set("range", key);
        const active = key === selected;
        return (
          <Link
            key={key}
            to={`?${params}`}
            preventScrollReset
            aria-current={active ? "true" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}

function ChangeLabel({ metric }: { metric: ComparedMetric }) {
  if (metric.previous === null) return null;

  let text: string;
  let tone = "text-muted-foreground";
  if (metric.change === null) {
    // Previous period was 0: a percentage would be meaningless.
    text = metric.current > 0 ? "new" : "—";
  } else {
    const pct = Math.round(metric.change * 100);
    text = `${pct > 0 ? "+" : ""}${pct}%`;
    if (pct > 0) tone = "text-emerald-600 dark:text-emerald-400";
    if (pct < 0) tone = "text-red-600 dark:text-red-400";
  }

  return <span className={cn("font-medium", tone)}>{text}</span>;
}

function ComparedCard({
  title,
  metric,
  format = (n) => n.toLocaleString("en-US"),
}: {
  title: string;
  metric: ComparedMetric;
  format?: (n: number) => string;
}) {
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="text-2xl font-bold">{format(metric.current)}</div>
        {metric.previous !== null && (
          <p className="text-xs text-muted-foreground">
            <ChangeLabel metric={metric} /> vs {format(metric.previous)}{" "}
            previous period
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CompletionCard({ completion }: { completion: CompletionRate }) {
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Average completion rate
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="text-2xl font-bold">
          {completion.rate === null ? "—" : formatPercent(completion.rate)}
        </div>
        <p className="text-xs text-muted-foreground">
          {completion.completed} / {completion.enrolled} students · all time
        </p>
        <p className="text-xs text-muted-foreground">
          Measured against current lessons, so adding lessons can lower this.
        </p>
      </CardContent>
    </Card>
  );
}

export function HeadlineCards({ metrics }: { metrics: HeadlineMetrics }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <ComparedCard
        title="Revenue"
        metric={metrics.revenue}
        format={formatUsd}
      />
      <ComparedCard title="New enrollments" metric={metrics.enrollments} />
      <ComparedCard title="Active students" metric={metrics.activeStudents} />
      <CompletionCard completion={metrics.completion} />
    </div>
  );
}
