// ─── Analytics Service ───
// Instructor analytics: headline metrics over a time range. Every metric is
// computed with a fixed number of aggregate queries, never one per course or
// per lesson. Only published and archived courses are included.

import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { db } from "~/db";
import { getTierForCountry, type PppTier } from "~/lib/ppp";
import {
  courseRatings,
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
export type AnalyticsScope =
  | { kind: "instructor"; instructorId: number }
  | { kind: "course"; courseId: number };

export function instructorScope(instructorId: number): AnalyticsScope {
  return { kind: "instructor", instructorId };
}

export function courseScope(courseId: number): AnalyticsScope {
  return { kind: "course", courseId };
}

const INCLUDED_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

/** Restricts `courses` to the scope's published and archived courses. */
function inScope(scope: AnalyticsScope) {
  return and(
    inArray(courses.status, INCLUDED_STATUSES),
    scope.kind === "instructor"
      ? eq(courses.instructorId, scope.instructorId)
      : eq(courses.id, scope.courseId)
  );
}

/**
 * The scope's lessons (lessons → modules → courses), with their course-order
 * positions, as a subquery to join activity rows against.
 */
function scopedLessons(scope: AnalyticsScope) {
  return db
    .select({
      lessonId: sql<number>`${lessons.id}`.as("scoped_lesson_id"),
      lessonTitle: sql<string>`${lessons.title}`.as("scoped_lesson_title"),
      lessonPosition: sql<number>`${lessons.position}`.as(
        "scoped_lesson_position"
      ),
      modulePosition: sql<number>`${modules.position}`.as(
        "scoped_module_position"
      ),
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(inScope(scope))
    .as("scoped_lessons");
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
  const inScopeLessons = scopedLessons(scope);

  const completions = db
    .select({
      userId: sql<number>`${lessonProgress.userId}`.as("user_id"),
      at: sql<string>`${lessonProgress.completedAt}`.as("at"),
    })
    .from(lessonProgress)
    .innerJoin(
      inScopeLessons,
      eq(inScopeLessons.lessonId, lessonProgress.lessonId)
    )
    .where(eq(lessonProgress.status, LessonProgressStatus.Completed));

  const watches = db
    .select({
      userId: sql<number>`${videoWatchEvents.userId}`.as("user_id"),
      at: sql<string>`${videoWatchEvents.createdAt}`.as("at"),
    })
    .from(videoWatchEvents)
    .innerJoin(
      inScopeLessons,
      eq(inScopeLessons.lessonId, videoWatchEvents.lessonId)
    );

  const attempts = db
    .select({
      userId: sql<number>`${quizAttempts.userId}`.as("user_id"),
      at: sql<string>`${quizAttempts.attemptedAt}`.as("at"),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .innerJoin(inScopeLessons, eq(inScopeLessons.lessonId, quizzes.lessonId));

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

function getHeadlineMetrics(
  scope: AnalyticsScope,
  range: ParsedRange
): HeadlineMetrics {
  return {
    revenue: getRevenue(scope, range),
    enrollments: getEnrollments(scope, range),
    activeStudents: getActiveStudents(scope, range),
    completion: getCompletionRate(scope),
  };
}

export function getInstructorOverview(
  instructorId: number,
  range: ParsedRange
): HeadlineMetrics {
  return getHeadlineMetrics(instructorScope(instructorId), range);
}

/**
 * The overview's headline cards scoped to one course. Drafts are excluded
 * like everywhere else, so a draft course reports zeros.
 */
export function getCourseAnalytics(
  courseId: number,
  range: ParsedRange
): HeadlineMetrics {
  return getHeadlineMetrics(courseScope(courseId), range);
}

// ─── Revenue series ───

export interface RevenueBucket {
  /** UTC date of the bucket's first day, "YYYY-MM-DD" (day 01 for months). */
  bucketStart: string;
  /** Integer cents (USD). */
  revenueCents: number;
}

/** The UTC day or month starts in [start, end), as "YYYY-MM-DD". */
function bucketStarts(
  bucket: ParsedRange["bucket"],
  start: string,
  end: string
): string[] {
  const starts: string[] = [];
  const at = new Date(start);
  if (bucket === "month") at.setUTCDate(1);
  while (at.toISOString() < end) {
    starts.push(at.toISOString().slice(0, 10));
    if (bucket === "day") at.setUTCDate(at.getUTCDate() + 1);
    else at.setUTCMonth(at.getUTCMonth() + 1);
  }
  return starts;
}

/**
 * Revenue per UTC day (7d, 30d) or month (12m, all) across the current
 * window, with empty buckets filled with zero. All-time runs from the month
 * of the first sale, so it is empty when there are no sales. One query.
 */
export function getRevenueSeries(
  scope: AnalyticsScope,
  range: ParsedRange
): RevenueBucket[] {
  // "YYYY-MM-DD" for days; "YYYY-MM" || "-01" for months.
  const bucketStart =
    range.bucket === "day"
      ? sql<string>`substr(${purchases.createdAt}, 1, 10)`
      : sql<string>`substr(${purchases.createdAt}, 1, 7) || '-01'`;
  const rows = db
    .select({
      bucketStart,
      revenueCents: sql<number>`sum(${purchases.amountPaid})`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(inScope(scope), inWindow(purchases.createdAt, range.current)))
    .groupBy(bucketStart)
    .all();

  const revenueByBucket = new Map(
    rows.map((row) => [row.bucketStart, row.revenueCents])
  );
  // All-time starts at the first sale's bucket; with no sales there are none.
  const start =
    range.current.start ?? rows.map((row) => row.bucketStart).sort()[0] ?? null;
  if (start === null) return [];

  return bucketStarts(range.bucket, start, range.current.end).map((at) => ({
    bucketStart: at,
    revenueCents: revenueByBucket.get(at) ?? 0,
  }));
}

// ─── Course summaries ───

export interface CourseSummary {
  courseId: number;
  title: string;
  status: CourseStatus;
  /** Integer cents (USD) in the range. */
  revenue: number;
  /** New enrollments in the range. */
  enrollments: number;
  /** All-time, same definition as the completion card. */
  completion: CompletionRate;
  /** All-time; `average` is null with no ratings. */
  rating: { average: number | null; count: number };
}

/**
 * One row per published or archived course of the instructor, ordered by
 * title. Two queries: the per-course totals and the completion counts.
 */
export function getCourseSummaries(
  instructorId: number,
  range: ParsedRange
): CourseSummary[] {
  const scope = instructorScope(instructorId);

  const revenue = db
    .select({
      courseId: purchases.courseId,
      total: sql<number>`sum(${purchases.amountPaid})`.as("revenue_total"),
    })
    .from(purchases)
    .where(inWindow(purchases.createdAt, range.current))
    .groupBy(purchases.courseId)
    .as("revenue");

  const enrolled = db
    .select({
      courseId: enrollments.courseId,
      total: sql<number>`count(*)`.as("enrollment_total"),
    })
    .from(enrollments)
    .where(inWindow(enrollments.enrolledAt, range.current))
    .groupBy(enrollments.courseId)
    .as("enrolled");

  const ratings = db
    .select({
      courseId: courseRatings.courseId,
      average: sql<number>`avg(${courseRatings.rating})`.as("rating_average"),
      count: sql<number>`count(*)`.as("rating_count"),
    })
    .from(courseRatings)
    .groupBy(courseRatings.courseId)
    .as("ratings");

  const rows = db
    .select({
      courseId: courses.id,
      title: courses.title,
      status: courses.status,
      revenue: sql<number>`coalesce(${revenue.total}, 0)`,
      enrollments: sql<number>`coalesce(${enrolled.total}, 0)`,
      ratingAverage: sql<number | null>`${ratings.average}`,
      ratingCount: sql<number>`coalesce(${ratings.count}, 0)`,
    })
    .from(courses)
    .leftJoin(revenue, eq(revenue.courseId, courses.id))
    .leftJoin(enrolled, eq(enrolled.courseId, courses.id))
    .leftJoin(ratings, eq(ratings.courseId, courses.id))
    .where(inScope(scope))
    .orderBy(courses.title)
    .all();

  const completionByCourse = new Map(
    getCompletionByCourse(scope).map((row) => [row.courseId, row])
  );

  return rows.map((row) => {
    const completion = completionByCourse.get(row.courseId);
    return {
      courseId: row.courseId,
      title: row.title,
      status: row.status,
      revenue: row.revenue,
      enrollments: row.enrollments,
      completion: toCompletionRate(
        completion?.completed ?? 0,
        completion?.enrolled ?? 0
      ),
      rating: { average: row.ratingAverage, count: row.ratingCount },
    };
  });
}

// ─── Revenue by country ───

export interface CountryRevenue {
  /** ISO-2 code; null when the purchase recorded no country. */
  country: string | null;
  /** PPP tier from the PPP mapping; a missing country is Tier 1. */
  tier: PppTier;
  /** Integer cents (USD) in the range. */
  revenueCents: number;
}

/** Range revenue per purchase country, highest first. One query. */
export function getRevenueByCountry(
  instructorId: number,
  range: ParsedRange
): CountryRevenue[] {
  const revenueCents = sql<number>`sum(${purchases.amountPaid})`;
  const rows = db
    .select({ country: purchases.country, revenueCents })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        inScope(instructorScope(instructorId)),
        inWindow(purchases.createdAt, range.current)
      )
    )
    .groupBy(purchases.country)
    .orderBy(sql`${revenueCents} desc`, purchases.country)
    .all();

  return rows.map((row) => ({
    country: row.country,
    tier: getTierForCountry(row.country),
    revenueCents: row.revenueCents,
  }));
}

// ─── Lesson funnel ───

export interface FunnelStep {
  lessonId: number;
  title: string;
  /** Currently enrolled students who have completed this lesson. */
  completed: number;
  /** All currently enrolled students. */
  enrolled: number;
}

export interface LessonFunnel {
  /** Currently enrolled students (all time). */
  enrolled: number;
  /** Current lessons in module, then lesson, position order. */
  lessons: FunnelStep[];
  /**
   * The lesson with the largest drop in completions from the lesson before
   * it; the earliest wins ties. null when no lesson drops.
   */
  largestDropLessonId: number | null;
}

/**
 * All-time lesson drop-off for one course. Draft courses report no
 * enrollments. Two queries: the enrolled total and the per-lesson counts.
 */
export function getLessonFunnel(courseId: number): LessonFunnel {
  const scope = courseScope(courseId);

  const enrolledRow = db
    .select({ total: sql<number>`count(*)` })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(inScope(scope))
    .get();
  const enrolled = enrolledRow?.total ?? 0;

  // Completions by currently enrolled students only.
  const completions = db
    .select({
      lessonId: lessonProgress.lessonId,
      total: sql<number>`count(distinct ${lessonProgress.userId})`.as(
        "completion_total"
      ),
    })
    .from(lessonProgress)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, lessonProgress.userId),
        eq(enrollments.courseId, courseId)
      )
    )
    .where(eq(lessonProgress.status, LessonProgressStatus.Completed))
    .groupBy(lessonProgress.lessonId)
    .as("completions");

  const rows = db
    .select({
      lessonId: lessons.id,
      title: lessons.title,
      completed: sql<number>`coalesce(${completions.total}, 0)`,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .leftJoin(completions, eq(completions.lessonId, lessons.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, lessons.position, lessons.id)
    .all();

  // Drafts are out of scope, so they report no completions either.
  const steps = rows.map((row) => ({
    lessonId: row.lessonId,
    title: row.title,
    completed: enrolled ? row.completed : 0,
    enrolled,
  }));

  let largestDropLessonId: number | null = null;
  let largestDrop = 0;
  for (let i = 1; i < steps.length; i++) {
    const drop = steps[i - 1].completed - steps[i].completed;
    if (drop > largestDrop) {
      largestDrop = drop;
      largestDropLessonId = steps[i].lessonId;
    }
  }

  return { enrolled, lessons: steps, largestDropLessonId };
}

// ─── Quiz pass rates ───

export interface QuizPassRate {
  quizId: number;
  title: string;
  lessonTitle: string;
  attempts: number;
  /** Distinct students who attempted the quiz. */
  students: number;
  /** Distinct students with at least one passing attempt. */
  passed: number;
  /** passed / students, so each student counts once; null with no attempts. */
  passRate: number | null;
}

/**
 * All-time stats for each quiz in a published or archived course,
 * in module, then lesson, position order. One query.
 */
export function getQuizPassRates(courseId: number): QuizPassRate[] {
  const inScopeLessons = scopedLessons(courseScope(courseId));
  const rows = db
    .select({
      quizId: quizzes.id,
      title: quizzes.title,
      lessonTitle: inScopeLessons.lessonTitle,
      attempts: sql<number>`count(${quizAttempts.id})`,
      students: sql<number>`count(distinct ${quizAttempts.userId})`,
      passed: sql<number>`count(distinct case when ${quizAttempts.passed} then ${quizAttempts.userId} end)`,
    })
    .from(quizzes)
    .innerJoin(inScopeLessons, eq(inScopeLessons.lessonId, quizzes.lessonId))
    .leftJoin(quizAttempts, eq(quizAttempts.quizId, quizzes.id))
    .groupBy(quizzes.id)
    .orderBy(
      sql`${inScopeLessons.modulePosition}`,
      sql`${inScopeLessons.lessonPosition}`,
      quizzes.id
    )
    .all();

  return rows.map((row) => ({
    ...row,
    passRate: row.students ? row.passed / row.students : null,
  }));
}

// ─── Rating breakdown ───

export interface RatingBreakdown {
  total: number;
  /** null with no ratings. */
  average: number | null;
  /** 5★ down to 1★; star values nobody gave have count 0. */
  counts: { stars: 1 | 2 | 3 | 4 | 5; count: number }[];
}

const STAR_VALUES = [5, 4, 3, 2, 1] as const;

/**
 * All-time count of each star rating for one course. Draft courses report no
 * ratings. One query.
 */
export function getRatingBreakdown(courseId: number): RatingBreakdown {
  const rows = db
    .select({
      rating: courseRatings.rating,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .innerJoin(courses, eq(courseRatings.courseId, courses.id))
    .where(inScope(courseScope(courseId)))
    .groupBy(courseRatings.rating)
    .all();

  const byStars = new Map(rows.map((row) => [row.rating, row.count]));
  const counts = STAR_VALUES.map((stars) => ({
    stars,
    count: byStars.get(stars) ?? 0,
  }));
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  const sumOfStars = counts.reduce((sum, c) => sum + c.stars * c.count, 0);
  return { total, average: total ? sumOfStars / total : null, counts };
}
