import type { ReactNode } from "react";
import { Link } from "react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { BarChart3, Star } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import { CourseStatus } from "~/db/schema";
import { COUNTRIES, PPP_TIERS } from "~/lib/ppp";
import { cn } from "~/lib/utils";
import type {
  ComparedMetric,
  CompletionRate,
  CountryRevenue,
  CourseSummary,
  HeadlineMetrics,
  RangeKey,
  RevenueBucket,
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

// ─── Sections ───

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 gap-4">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center rounded-lg border border-dashed text-center text-sm text-muted-foreground">
      <BarChart3 className="mb-2 size-8 text-muted-foreground/50" />
      {message}
    </div>
  );
}

const RANGE_DESCRIPTIONS: Record<RangeKey, string> = {
  "7d": "last 7 days",
  "30d": "last 30 days",
  "12m": "last 12 months",
  all: "all time",
};

const dayLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const monthLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});
const longDayLabel = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const longMonthLabel = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Month buckets for 12m and all-time, day buckets otherwise. */
function isMonthly(range: RangeKey) {
  return range === "12m" || range === "all";
}

function bucketLabel(bucketStart: string, range: RangeKey, long = false) {
  const date = new Date(`${bucketStart}T00:00:00.000Z`);
  if (isMonthly(range))
    return (long ? longMonthLabel : monthLabel).format(date);
  return (long ? longDayLabel : dayLabel).format(date);
}

const revenueChartConfig = {
  revenueCents: { label: "Revenue", color: "var(--chart-1)" },
} satisfies ChartConfig;

/** Revenue bar chart over the range's buckets; an empty state with no sales. */
export function RevenueChart({
  series,
  range,
}: {
  series: RevenueBucket[];
  range: RangeKey;
}) {
  const hasSales = series.some((bucket) => bucket.revenueCents > 0);
  return (
    <SectionCard
      title="Revenue over time"
      description={`${isMonthly(range) ? "Monthly" : "Daily"} revenue, ${RANGE_DESCRIPTIONS[range]} · UTC`}
    >
      {hasSales ? (
        <ChartContainer
          config={revenueChartConfig}
          className="aspect-auto h-64 w-full"
        >
          <BarChart data={series} margin={{ left: 0, right: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="bucketStart"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(start: string) => bucketLabel(start, range)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(cents: number) => compactUsd.format(cents / 100)}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const start = payload?.[0]?.payload?.bucketStart as
                      string | undefined;
                    return start ? bucketLabel(start, range, true) : "";
                  }}
                  formatter={(value) => (
                    <div className="flex w-full justify-between gap-4">
                      <span className="text-muted-foreground">Revenue</span>
                      <span className="font-mono font-medium tabular-nums">
                        {formatUsd(Number(value))}
                      </span>
                    </div>
                  )}
                />
              }
            />
            <Bar
              dataKey="revenueCents"
              fill="var(--color-revenueCents)"
              radius={[3, 3, 0, 0]}
            />
          </BarChart>
        </ChartContainer>
      ) : (
        <EmptyState message="No sales in this period yet." />
      )}
    </SectionCard>
  );
}

const STATUS_STYLES: Partial<Record<CourseStatus, string>> = {
  [CourseStatus.Published]:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  [CourseStatus.Archived]: "bg-muted text-muted-foreground",
};

const count = (n: number) => n.toLocaleString("en-US");

/** One row per published or archived course. */
export function CourseSummaryTable({
  rows,
  range,
}: {
  rows: CourseSummary[];
  range: RangeKey;
}) {
  return (
    <SectionCard
      title="Courses"
      description={`Revenue and enrollments for the ${RANGE_DESCRIPTIONS[range]}; completion and ratings all time`}
    >
      {rows.length === 0 ? (
        <EmptyState message="No published or archived courses yet." />
      ) : (
        <div className="-mx-6 overflow-x-auto px-6">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Course</th>
                <th className="py-2 pr-4 text-right font-medium">Revenue</th>
                <th className="py-2 pr-4 text-right font-medium">
                  Enrollments
                </th>
                <th className="py-2 pr-4 text-right font-medium">Completion</th>
                <th className="py-2 text-right font-medium">Rating</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.courseId} className="border-b last:border-0">
                  <td className="py-3 pr-4">
                    <Link
                      to={`/instructor/${row.courseId}/analytics?range=${range}`}
                      className="block w-fit font-medium hover:underline"
                    >
                      {row.title}
                    </Link>
                    <span
                      className={cn(
                        "mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        STATUS_STYLES[row.status]
                      )}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums">
                    {formatUsd(row.revenue)}
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums">
                    {count(row.enrollments)}
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums">
                    <div>
                      {row.completion.rate === null
                        ? "—"
                        : formatPercent(row.completion.rate)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {count(row.completion.completed)} /{" "}
                      {count(row.completion.enrolled)}
                    </div>
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    {row.rating.average === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        <div className="inline-flex items-center gap-1">
                          <Star className="size-3.5 fill-amber-400 text-amber-400" />
                          {row.rating.average.toFixed(1)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {count(row.rating.count)}{" "}
                          {row.rating.count === 1 ? "rating" : "ratings"}
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

const countryNames = new Map(COUNTRIES.map((c) => [c.code, c.name]));

/** Range revenue per country with its PPP tier. */
export function CountryRevenueTable({
  rows,
  range,
}: {
  rows: CountryRevenue[];
  range: RangeKey;
}) {
  return (
    <SectionCard
      title="Revenue by country"
      description={`The ${RANGE_DESCRIPTIONS[range]}, with each country's PPP discount tier`}
    >
      {rows.length === 0 ? (
        <EmptyState message="No sales in this period yet." />
      ) : (
        <div className="-mx-6 overflow-x-auto px-6">
          <table className="w-full min-w-[20rem] text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Country</th>
                <th className="py-2 pr-4 font-medium">PPP tier</th>
                <th className="py-2 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.country ?? "unknown"}
                  className="border-b last:border-0"
                >
                  <td className="py-3 pr-4 font-medium">
                    {row.country
                      ? (countryNames.get(row.country) ?? row.country)
                      : "Unknown"}
                  </td>
                  <td className="py-3 pr-4">
                    <div>Tier {row.tier}</div>
                    <div className="text-xs text-muted-foreground">
                      {PPP_TIERS[row.tier].label}
                    </div>
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    {formatUsd(row.revenueCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
