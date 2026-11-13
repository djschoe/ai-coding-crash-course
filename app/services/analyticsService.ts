// ─── Analytics Service ───
// Instructor analytics: headline metrics over a time range. Every metric is
// computed with a fixed number of aggregate queries, never one per course or
// per lesson. Only published and archived courses are included.

import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  CourseStatus,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  videoWatchEvents,
} from "~/db/schema";

// ─── Time range ───

export const RANGE_KEYS = ["7d", "30d", "12m", "all"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];
export const DEFAULT_RANGE: RangeKey = "30d";

/** A half-open UTC window [start, end) as ISO strings. `start` null = unbounded. */
export interface TimeWindow {
  start: string | null;
  end: string;
}

export interface ParsedRange {
  key: RangeKey;
  /** Revenue series bucket size for this range. */
  bucket: "day" | "month";
  current: TimeWindow;
  /** The previous window of the same length; null for all-time. */
  previous: TimeWindow | null;
}

function isRangeKey(value: string | null | undefined): value is RangeKey {
  return (RANGE_KEYS as readonly string[]).includes(value ?? "");
}

function utcDay(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day)).toISOString();
}

/**
 * Turns a `range` search param into the current and previous windows.
 * Windows are aligned to UTC days (7d, 30d) or UTC months (12m) and end at
 * the start of tomorrow, so today is always included. Invalid or missing
 * values fall back to 30d.
 */
export function parseRange(
  param: string | null | undefined,
  now: Date = new Date()
): ParsedRange {
  const key: RangeKey = isRangeKey(param) ? param : DEFAULT_RANGE;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const end = utcDay(y, m, d + 1);

  switch (key) {
    case "7d":
    case "30d": {
      const days = key === "7d" ? 7 : 30;
      return {
        key,
        bucket: "day",
        current: { start: utcDay(y, m, d + 1 - days), end },
        previous: {
          start: utcDay(y, m, d + 1 - 2 * days),
          end: utcDay(y, m, d + 1 - days),
        },
      };
    }
    case "12m":
      return {
        key,
        bucket: "month",
        current: { start: utcDay(y, m - 11, 1), end: utcDay(y, m + 1, 1) },
        previous: { start: utcDay(y, m - 23, 1), end: utcDay(y, m - 11, 1) },
      };
    case "all":
      return {
        key,
        bucket: "month",
        current: { start: null, end },
        previous: null,
      };
  }
}

// ─── Scope & window helpers ───

/** Which courses a metric covers: all of an instructor's, or a single one. */
export type AnalyticsScope = { instructorId: number } | { courseId: number };

const INCLUDED_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

/** Restricts `courses` to the scope's published and archived courses. */
function inScope(scope: AnalyticsScope) {
  return and(
    inArray(courses.status, INCLUDED_STATUSES),
    "instructorId" in scope
      ? eq(courses.instructorId, scope.instructorId)
      : eq(courses.id, scope.courseId)
  );
}

function inWindow(at: SQLWrapper, window: TimeWindow): SQL {
  return window.start === null
    ? sql`${at} < ${window.end}`
    : sql`(${at} >= ${window.start} and ${at} < ${window.end})`;
}

/** sum(value) over rows whose timestamp falls in the window; null without a window. */
function sumIn(value: SQLWrapper, at: SQLWrapper, window: TimeWindow | null) {
  if (!window) return sql<null>`null`;
  return sql<number>`coalesce(sum(case when ${inWindow(at, window)} then ${value} else 0 end), 0)`;
}

// ─── Metrics ───

/** A windowed metric compared with the previous period of the same length. */
export interface ComparedMetric {
  current: number;
  /** null for all-time, which has no previous period. */
  previous: number | null;
  /** (current − previous) / previous; null when there's no previous value or it is 0. */
  change: number | null;
}

function compare(current: number, previous: number | null): ComparedMetric {
  return {
    current,
    previous,
    change: previous ? (current - previous) / previous : null,
  };
}

/** Sum of purchase amounts (integer cents) by purchase date. */
function getRevenue(scope: AnalyticsScope, range: ParsedRange): ComparedMetric {
  const row = db
    .select({
      current: sumIn(purchases.amountPaid, purchases.createdAt, range.current),
      previous: sumIn(
        purchases.amountPaid,
        purchases.createdAt,
        range.previous
      ),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(inScope(scope))
    .get();
  return compare(row?.current ?? 0, row?.previous ?? null);
}

/** Enrollments by enrolment date, including coupon redemptions and free courses. */
function getEnrollments(
  scope: AnalyticsScope,
  range: ParsedRange
): ComparedMetric {
  const one = sql`1`;
  const row = db
    .select({
      current: sumIn(one, enrollments.enrolledAt, range.current),
      previous: sumIn(one, enrollments.enrolledAt, range.previous),
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(inScope(scope))
    .get();
  return compare(row?.current ?? 0, row?.previous ?? null);
}

/** count(distinct userId) over rows whose timestamp falls in the window. */
function distinctIn(
  userId: SQLWrapper,
  at: SQLWrapper,
  window: TimeWindow | null
) {
  if (!window) return sql<null>`null`;
  return sql<number>`count(distinct case when ${inWindow(at, window)} then ${userId} end)`;
}

/**
 * Distinct students who, in the window, completed a lesson, watched video or
 * attempted a quiz on the scope's lessons.
 */
function getActiveStudents(
  scope: AnalyticsScope,
  range: ParsedRange
): ComparedMetric {
  const completions = db
    .select({
      userId: sql<number>`${lessonProgress.userId}`.as("user_id"),
      at: sql<string>`${lessonProgress.completedAt}`.as("at"),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(
      and(
        inScope(scope),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    );

  const watches = db
    .select({
      userId: sql<number>`${videoWatchEvents.userId}`.as("user_id"),
      at: sql<string>`${videoWatchEvents.createdAt}`.as("at"),
    })
    .from(videoWatchEvents)
    .innerJoin(lessons, eq(videoWatchEvents.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(inScope(scope));

  const attempts = db
    .select({
      userId: sql<number>`${quizAttempts.userId}`.as("user_id"),
      at: sql<string>`${quizAttempts.attemptedAt}`.as("at"),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(inScope(scope));

  const activity = completions
    .unionAll(watches)
    .unionAll(attempts)
    .as("activity");

  const row = db
    .select({
      current: distinctIn(activity.userId, activity.at, range.current),
      previous: distinctIn(activity.userId, activity.at, range.previous),
    })
    .from(activity)
    .get();
  return compare(row?.current ?? 0, row?.previous ?? null);
}

/** Completed and enrolled student counts; `rate` is null with no enrollments. */
export interface CompletionRate {
  completed: number;
  enrolled: number;
  rate: number | null;
}

/**
 * All-time completion per course in scope. A student has completed a course
 * when they have a completed progress row for every *current* lesson in it;
 * `enrollments.completedAt` is deliberately not used. One query.
 */
function getCompletionByCourse(scope: AnalyticsScope) {
  const lessonCounts = db
    .select({
      courseId: modules.courseId,
      total: sql<number>`count(*)`.as("total"),
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .groupBy(modules.courseId)
    .as("lesson_counts");

  const completedCounts = db
    .select({
      userId: lessonProgress.userId,
      courseId: modules.courseId,
      done: sql<number>`count(distinct ${lessonProgress.lessonId})`.as("done"),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(lessonProgress.status, LessonProgressStatus.Completed))
    .groupBy(lessonProgress.userId, modules.courseId)
    .as("completed_counts");

  return db
    .select({
      courseId: enrollments.courseId,
      enrolled: sql<number>`count(*)`,
      completed: sql<number>`coalesce(sum(case when ${lessonCounts.total} > 0 and ${completedCounts.done} = ${lessonCounts.total} then 1 else 0 end), 0)`,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .leftJoin(lessonCounts, eq(lessonCounts.courseId, enrollments.courseId))
    .leftJoin(
      completedCounts,
      and(
        eq(completedCounts.userId, enrollments.userId),
        eq(completedCounts.courseId, enrollments.courseId)
      )
    )
    .where(inScope(scope))
    .groupBy(enrollments.courseId)
    .all();
}

function toCompletionRate(completed: number, enrolled: number): CompletionRate {
  return { completed, enrolled, rate: enrolled ? completed / enrolled : null };
}

/** Pooled across courses: total completed students / total enrolled students. */
function getCompletionRate(scope: AnalyticsScope): CompletionRate {
  let completed = 0;
  let enrolled = 0;
  for (const row of getCompletionByCourse(scope)) {
    completed += row.completed;
    enrolled += row.enrolled;
  }
  return toCompletionRate(completed, enrolled);
}

// ─── Public API ───

export interface HeadlineMetrics {
  /** Integer cents (USD). */
  revenue: ComparedMetric;
  enrollments: ComparedMetric;
  activeStudents: ComparedMetric;
  /** All-time, pooled across courses; not affected by the range. */
  completion: CompletionRate;
}

export function getInstructorOverview(
  instructorId: number,
  range: ParsedRange
): HeadlineMetrics {
  const scope: AnalyticsScope = { instructorId };
  return {
    revenue: getRevenue(scope, range),
    enrollments: getEnrollments(scope, range),
    activeStudents: getActiveStudents(scope, range),
    completion: getCompletionRate(scope),
  };
}
