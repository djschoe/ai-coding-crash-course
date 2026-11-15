import { Link, data, useSearchParams } from "react-router";
import { BarChart3, Plus, Users } from "lucide-react";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructorOrAdmin } from "~/lib/access.server";
import { resolveAnalyticsInstructorId } from "~/lib/analytics-access";
import { getUserById } from "~/services/userService";
import { UserRole } from "~/db/schema";
import { getCoursesByInstructor } from "~/services/courseService";
import {
  getCourseSummaries,
  getInstructorOverview,
  getRevenueByCountry,
  getRevenueSeries,
  instructorScope,
  parseRange,
} from "~/services/analyticsService";
import {
  AnalyticsError,
  CountryRevenueTable,
  CourseSummaryTable,
  HeadlineCards,
  RangeSelector,
  RevenueChart,
} from "~/components/analytics";
import { Button } from "~/components/ui/button";

// ─── Instructor Analytics Overview ───
// The instructor's home page: headline metrics across all of their published
// and archived courses, a revenue chart, a per-course summary and revenue by
// country, filtered by the `range` search param. Admins can view any
// instructor's overview, read-only, with `instructorId`.

export function meta() {
  return [{ title: "Analytics — Cadence" }];
}

export async function loader({ request, url }: Route.LoaderArgs) {
  const viewer = await requireInstructorOrAdmin(request);
  const range = parseRange(url.searchParams.get("range"));
  const empty = {
    viewingName: null as string | null,
    range: range.key,
    metrics: null,
    report: null,
  };

  const userId = resolveAnalyticsInstructorId(
    viewer.userId,
    viewer.isAdmin,
    url.searchParams.get("instructorId")
  );
  // Admins have no analytics of their own: they pick an instructor first.
  if (userId === null) {
    return { ...empty, needsInstructor: true, hasCourses: false };
  }

  let viewingName: string | null = null;
  if (viewer.isAdmin) {
    const target = getUserById(userId);
    if (target?.role !== UserRole.Instructor) {
      throw data("Instructor not found.", { status: 404 });
    }
    viewingName = target.name;
  }

  const hasCourses = getCoursesByInstructor(userId).length > 0;
  if (!hasCourses) {
    return { ...empty, viewingName, needsInstructor: false, hasCourses };
  }

  return {
    needsInstructor: false,
    hasCourses,
    viewingName,
    range: range.key,
    metrics: getInstructorOverview(userId, range),
    report: {
      revenueSeries: getRevenueSeries(instructorScope(userId), range),
      courseSummaries: getCourseSummaries(userId, range),
      countries: getRevenueByCountry(userId, range),
    },
  };
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const { needsInstructor, hasCourses, viewingName, range, metrics, report } =
    loaderData;
  const [searchParams] = useSearchParams();

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            {needsInstructor
              ? "Instructor analytics across published and archived courses"
              : viewingName
                ? `Viewing ${viewingName}'s published and archived courses (read-only)`
                : "How your published and archived courses are performing"}
          </p>
        </div>
        {hasCourses && (
          <RangeSelector selected={range} searchParams={searchParams} />
        )}
      </div>

      {metrics && report ? (
        <div className="space-y-4 sm:space-y-6">
          <HeadlineCards metrics={metrics} />
          <RevenueChart series={report.revenueSeries} range={range} />
          <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <CourseSummaryTable rows={report.courseSummaries} range={range} />
            </div>
            <div className="min-w-0">
              <CountryRevenueTable rows={report.countries} range={range} />
            </div>
          </div>
        </div>
      ) : needsInstructor ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Users className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">Choose an instructor</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick an instructor from Manage Users and choose "View analytics" to
            see their courses' performance.
          </p>
          <Link to="/admin/users" className="mt-4">
            <Button>
              <Users className="mr-2 size-4" />
              Manage Users
            </Button>
          </Link>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <BarChart3 className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No courses yet</h2>
          {viewingName ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {viewingName} hasn't published any courses yet.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Create a course to start seeing revenue, enrollments and
                progress.
              </p>
              <Link to="/instructor/new" className="mt-4">
                <Button>
                  <Plus className="mr-2 size-4" />
                  Create Course
                </Button>
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <AnalyticsError
      error={error}
      fallbackMessage="An unexpected error occurred while loading your analytics."
      backTo="/courses"
      backLabel="Browse Courses"
    />
  );
}
