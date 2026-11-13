import {
  Link,
  data,
  isRouteErrorResponse,
  useSearchParams,
} from "react-router";
import { AlertTriangle, BarChart3, Plus } from "lucide-react";
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
  parseRange,
} from "~/services/analyticsService";
import {
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
  const userId = resolveAnalyticsInstructorId(
    viewer,
    url.searchParams.get("instructorId")
  );
  const viewing = userId === viewer.userId ? null : getUserById(userId);
  if (viewing === undefined || viewing?.role === UserRole.Student) {
    throw data("Instructor not found.", { status: 404 });
  }
  const viewingName = viewing?.name ?? null;
  const range = parseRange(url.searchParams.get("range"));

  const hasCourses = getCoursesByInstructor(userId).length > 0;
  if (!hasCourses) {
    return {
      hasCourses,
      viewingName,
      range: range.key,
      metrics: null,
      report: null,
    };
  }

  return {
    hasCourses,
    viewingName,
    range: range.key,
    metrics: getInstructorOverview(userId, range),
    report: {
      revenueSeries: getRevenueSeries({ instructorId: userId }, range),
      courseSummaries: getCourseSummaries(userId, range),
      countries: getRevenueByCountry(userId, range),
    },
  };
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const { hasCourses, viewingName, range, metrics, report } = loaderData;
  const [searchParams] = useSearchParams();

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            {viewingName
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
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Not allowed";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have access to this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/courses">
          <Button>Browse Courses</Button>
        </Link>
      </div>
    </div>
  );
}
