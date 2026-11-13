import {
  Link,
  data,
  isRouteErrorResponse,
  useSearchParams,
} from "react-router";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import type { Route } from "./+types/instructor.$courseId.analytics";
import { requireInstructorOrAdmin } from "~/lib/access.server";
import { getCourseById } from "~/services/courseService";
import {
  getCourseAnalytics,
  getRevenueSeries,
  parseRange,
} from "~/services/analyticsService";
import { CourseStatus } from "~/db/schema";
import {
  HeadlineCards,
  RangeSelector,
  RevenueChart,
} from "~/components/analytics";
import { Button } from "~/components/ui/button";

// ─── Course Analytics ───
// One course's headline metrics and revenue chart, filtered by the `range`
// search param. Like the roster, only the course's instructor or an admin can
// open it.

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course.title ?? "Course";
  return [{ title: `Analytics: ${title} — Cadence` }];
}

export async function loader({ params, request, url }: Route.LoaderArgs) {
  const viewer = await requireInstructorOrAdmin(request);

  const courseId = parseInt(params.courseId, 10);
  if (isNaN(courseId)) {
    throw data("Invalid course ID.", { status: 400 });
  }

  const course = getCourseById(courseId);
  if (!course) {
    throw data("Course not found.", { status: 404 });
  }

  if (course.instructorId !== viewer.userId && !viewer.isAdmin) {
    throw data("You can only view analytics for your own courses.", {
      status: 403,
    });
  }

  const range = parseRange(url.searchParams.get("range"));

  return {
    course: { id: course.id, title: course.title, status: course.status },
    // Admins viewing someone else's course go back to that instructor's overview.
    instructorId:
      course.instructorId === viewer.userId ? null : course.instructorId,
    range: range.key,
    metrics: getCourseAnalytics(courseId, range),
    revenueSeries: getRevenueSeries({ courseId }, range),
  };
}

export default function CourseAnalytics({ loaderData }: Route.ComponentProps) {
  const { course, instructorId, range, metrics, revenueSeries } = loaderData;
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
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading course analytics.";

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
    } else if (error.status === 404) {
      title = "Course not found";
      message =
        typeof error.data === "string"
          ? error.data
          : "The course you're looking for doesn't exist.";
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
        <Link to="/instructor/analytics">
          <Button>Back to Analytics</Button>
        </Link>
      </div>
    </div>
  );
}
