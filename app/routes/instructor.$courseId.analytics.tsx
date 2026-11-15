import { Link, data, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import type { Route } from "./+types/instructor.$courseId.analytics";
import { requireStaff, requireUserId } from "~/lib/access.server";
import { getCourseById } from "~/services/courseService";
import {
  courseScope,
  getCourseAnalytics,
  getLessonFunnel,
  getQuizPassRates,
  getRatingBreakdown,
  getRevenueSeries,
  parseRange,
} from "~/services/analyticsService";
import { CourseStatus } from "~/db/schema";
import {
  AnalyticsError,
  HeadlineCards,
  LessonFunnelSection,
  LowDataHint,
  QuizPassRatesSection,
  RangeSelector,
  RatingBreakdownSection,
  RevenueChart,
} from "~/components/analytics";

// ─── Course Analytics ───
// One course's headline metrics and revenue chart, filtered by the `range`
// search param, then its all-time lesson funnel, ratings and quiz pass rates.
// Like the roster, only the course's instructor or an admin can open it.

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course.title ?? "Course";
  return [{ title: `Analytics: ${title} — Cadence` }];
}

export async function loader({ params, request, url }: Route.LoaderArgs) {
  await requireUserId(request);

  const courseId = parseInt(params.courseId, 10);
  if (isNaN(courseId)) {
    throw data("Invalid course ID.", { status: 400 });
  }

  const course = getCourseById(courseId);
  if (!course) {
    throw data("Course not found.", { status: 404 });
  }

  // The course's own instructor or an admin; 403 for everyone else.
  const access = await requireStaff(request, courseId);

  const range = parseRange(url.searchParams.get("range"));

  return {
    course: { id: course.id, title: course.title, status: course.status },
    // Admins viewing someone else's course go back to that instructor's overview.
    instructorId: access.isOwningInstructor ? null : course.instructorId,
    range: range.key,
    metrics: getCourseAnalytics(courseId, range),
    revenueSeries: getRevenueSeries(courseScope(courseId), range),
    // All time; these ignore the range.
    funnel: getLessonFunnel(courseId),
    ratings: getRatingBreakdown(courseId),
    quizzes: getQuizPassRates(courseId),
  };
}

export default function CourseAnalytics({ loaderData }: Route.ComponentProps) {
  const {
    course,
    instructorId,
    range,
    metrics,
    revenueSeries,
    funnel,
    ratings,
    quizzes,
  } = loaderData;
  const [searchParams] = useSearchParams();
  const overview = new URLSearchParams({ range });
  if (instructorId !== null) overview.set("instructorId", String(instructorId));

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
      <nav className="mb-4 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
        <Link
          to={`/instructor/analytics?${overview}`}
          className="hover:text-foreground"
        >
          Analytics
        </Link>
        <span>/</span>
        <span className="text-foreground">{course.title}</span>
      </nav>

      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold break-words sm:text-3xl">
            {course.title}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {course.status === CourseStatus.Draft
              ? "This course is a draft, so it isn't included in analytics yet."
              : "How this course is performing"}
          </p>
          <Link
            to={`/instructor/${course.id}`}
            className="mt-2 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="mr-1 size-4" />
            Back to course editor
          </Link>
        </div>
        <RangeSelector selected={range} searchParams={searchParams} />
      </div>

      <div className="space-y-4 sm:space-y-6">
        <HeadlineCards metrics={metrics} />
        <RevenueChart series={revenueSeries} range={range} />
        <LowDataHint enrolled={funnel.enrolled} />
        <LessonFunnelSection funnel={funnel} />
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
          <RatingBreakdownSection breakdown={ratings} />
          <QuizPassRatesSection quizzes={quizzes} />
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <AnalyticsError
      error={error}
      fallbackMessage="An unexpected error occurred while loading course analytics."
      notFoundTitle="Course not found"
      backTo="/instructor/analytics"
      backLabel="Back to Analytics"
    />
  );
}
