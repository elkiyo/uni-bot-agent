export type Granularity = "day" | "week" | "month" | "year";

export interface Bucket {
  key: string;
  label: string;
  sortKey: number;
  value: number;
  count: number;
}

const MONTH_LABELS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export const MAX_BUCKET_POINTS: Record<Granularity, number> = { day: 14, week: 12, month: 12, year: 6 };

function bucketKey(ts: number, granularity: Granularity): { key: string; label: string; sortKey: number } {
  const d = new Date(ts * 1000);
  if (granularity === "day") {
    const key = d.toISOString().slice(0, 10);
    return { key, label: `${d.getDate()}/${d.getMonth() + 1}`, sortKey: d.setHours(0, 0, 0, 0) };
  }
  if (granularity === "week") {
    const monday = new Date(d);
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    monday.setDate(d.getDate() - dow);
    monday.setHours(0, 0, 0, 0);
    return {
      key: monday.toISOString().slice(0, 10),
      label: `${monday.getDate()}/${monday.getMonth() + 1}`,
      sortKey: monday.getTime(),
    };
  }
  if (granularity === "month") {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return { key, label: MONTH_LABELS[d.getMonth()], sortKey: new Date(d.getFullYear(), d.getMonth(), 1).getTime() };
  }
  const key = String(d.getFullYear());
  return { key, label: key, sortKey: new Date(d.getFullYear(), 0, 1).getTime() };
}

/**
 * Buckets timestamped items into day/week/month/year periods, summing a
 * numeric value per bucket — the same grouping VolumeChart.tsx uses for its
 * own bar chart, generalized so the dashboard can reuse it for volume, fees,
 * and rebalance counts alike instead of re-deriving the same date-bucketing
 * logic three times. Caps to the most recent `MAX_BUCKET_POINTS[granularity]`
 * buckets so a long history doesn't render an unreadably wide chart.
 */
export function bucketByTime<T>(
  items: readonly T[],
  getTimestamp: (item: T) => number,
  getValue: (item: T) => number,
  granularity: Granularity,
): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const item of items) {
    const { key, label, sortKey } = bucketKey(getTimestamp(item), granularity);
    const value = getValue(item);
    const existing = buckets.get(key);
    if (existing) {
      existing.value += value;
      existing.count += 1;
    } else {
      buckets.set(key, { key, label, sortKey, value, count: 1 });
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.sortKey - b.sortKey)
    .slice(-MAX_BUCKET_POINTS[granularity]);
}
