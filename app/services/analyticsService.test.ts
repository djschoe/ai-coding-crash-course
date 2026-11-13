import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  parseRange,
  getInstructorOverview,
  getRevenueSeries,
  getCourseSummaries,
  getRevenueByCountry,
  getCourseAnalytics,
} from "./analyticsService";

const NOW = new Date("2026-03-15T10:30:00.000Z");
// 30d around NOW: current [2026-02-14, 2026-03-16), previous [2026-01-15, 2026-02-14)
const THIRTY_DAYS = () => parseRange("30d", NOW);

let emailCounter = 0;

function createStudent(name = "Student") {
  emailCounter += 1;
  return testDb
    .insert(schema.users)
    .values({
      name,
      email: `student${emailCounter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function createInstructor(name = "Other Instructor") {
  emailCounter += 1;
  return testDb
    .insert(schema.users)
    .values({
      name,
      email: `instructor${emailCounter}@example.com`,
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
}

let slugCounter = 0;

function createCourse(
  overrides: Partial<typeof schema.courses.$inferInsert> = {}
) {
  slugCounter += 1;
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${slugCounter}`,
      slug: `course-${slugCounter}`,
      description: "A course",
      salesCopy: "Sales copy.",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
      ...overrides,
    })
    .returning()
    .get();
}

function purchase(
  userId: number,
  courseId: number,
  amountPaid: number,
  createdAt: string,
  country: string | null = null
) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, createdAt, country })
    .returning()
    .get();
}

function enroll(userId: number, courseId: number, enrolledAt: string) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt })
    .returning()
    .get();
}

/** Adds a lesson to the course, in a module created on first use. */
function addLesson(courseId: number, title = "Lesson") {
  const module =
    testDb
      .select()
      .from(schema.modules)
      .where(eq(schema.modules.courseId, courseId))
      .get() ??
    testDb
      .insert(schema.modules)
      .values({ courseId, title: "Module", position: 1 })
      .returning()
      .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: module.id, title, position: 1 })
    .returning()
    .get();
}

function completeLesson(userId: number, lessonId: number, completedAt: string) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt,
    })
    .run();
}

function watchVideo(userId: number, lessonId: number, createdAt: string) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId,
      lessonId,
      eventType: "play",
      positionSeconds: 0,
      createdAt,
    })
    .run();
}

function attemptQuiz(userId: number, lessonId: number, attemptedAt: string) {
  const quiz = testDb
    .insert(schema.quizzes)
    .values({ lessonId, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get();
  testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId: quiz.id, score: 1, passed: true, attemptedAt })
    .run();
}

describe("analyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("parseRange", () => {
    it("defaults to 30 days when no range is given", () => {
      const range = parseRange(null, NOW);

      expect(range.key).toBe("30d");
      expect(range.bucket).toBe("day");
      expect(range.current).toEqual({
        start: "2026-02-14T00:00:00.000Z",
        end: "2026-03-16T00:00:00.000Z",
      });
      expect(range.previous).toEqual({
        start: "2026-01-15T00:00:00.000Z",
        end: "2026-02-14T00:00:00.000Z",
      });
    });

    it("falls back to 30 days for an invalid range", () => {
      expect(parseRange("90d", NOW).key).toBe("30d");
      expect(parseRange("", NOW).key).toBe("30d");
    });

    it("covers today and the six days before it for 7d", () => {
      const range = parseRange("7d", NOW);

      expect(range.bucket).toBe("day");
      expect(range.current).toEqual({
        start: "2026-03-09T00:00:00.000Z",
        end: "2026-03-16T00:00:00.000Z",
      });
      expect(range.previous).toEqual({
        start: "2026-03-02T00:00:00.000Z",
        end: "2026-03-09T00:00:00.000Z",
      });
    });

    it("covers this month and the eleven before it for 12m", () => {
      const range = parseRange("12m", NOW);

      expect(range.bucket).toBe("month");
      expect(range.current).toEqual({
        start: "2025-04-01T00:00:00.000Z",
        end: "2026-04-01T00:00:00.000Z",
      });
      expect(range.previous).toEqual({
        start: "2024-04-01T00:00:00.000Z",
        end: "2025-04-01T00:00:00.000Z",
      });
    });

    it("has no start and no previous window for all-time", () => {
      const range = parseRange("all", NOW);

      expect(range.bucket).toBe("month");
      expect(range.current).toEqual({
        start: null,
        end: "2026-03-16T00:00:00.000Z",
      });
      expect(range.previous).toBeNull();
    });
  });

  describe("getInstructorOverview — revenue", () => {
    it("sums purchase amounts in the current and previous windows", () => {
      const student = createStudent();
      const course = base.course;
      purchase(student.id, course.id, 3000, "2026-02-14T00:00:00.000Z");
      purchase(student.id, course.id, 5000, "2026-03-15T23:59:59.000Z");
      purchase(student.id, course.id, 4000, "2026-02-13T23:59:59.000Z");
      purchase(student.id, course.id, 9999, "2026-01-01T00:00:00.000Z");
      purchase(student.id, course.id, 7777, "2026-03-16T00:00:00.000Z");

      const { revenue } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(revenue).toEqual({ current: 8000, previous: 4000, change: 1 });
    });

    it("has no change when the previous period had no revenue", () => {
      const student = createStudent();
      purchase(student.id, base.course.id, 3000, "2026-03-01T00:00:00.000Z");

      const { revenue } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(revenue).toEqual({ current: 3000, previous: 0, change: null });
    });

    it("has no previous period for all-time", () => {
      const student = createStudent();
      purchase(student.id, base.course.id, 3000, "2020-01-01T00:00:00.000Z");
      purchase(student.id, base.course.id, 2000, "2026-03-01T00:00:00.000Z");

      const { revenue } = getInstructorOverview(
        base.instructor.id,
        parseRange("all", NOW)
      );

      expect(revenue).toEqual({ current: 5000, previous: null, change: null });
    });

    it("counts a team purchase at its full amount on its purchase date", () => {
      const buyer = createStudent("Team Buyer");
      const team = testDb
        .insert(schema.teams)
        .values({ createdAt: "2026-03-01T00:00:00.000Z" })
        .returning()
        .get();
      const teamPurchase = purchase(
        buyer.id,
        base.course.id,
        25000,
        "2026-03-01T00:00:00.000Z"
      );
      for (let i = 0; i < 5; i++) {
        testDb
          .insert(schema.coupons)
          .values({
            teamId: team.id,
            courseId: base.course.id,
            code: `TEAM-${i}`,
            purchaseId: teamPurchase.id,
          })
          .run();
      }

      const { revenue } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(revenue.current).toBe(25000);
    });

    it("excludes drafts and other instructors' courses, includes archived", () => {
      const student = createStudent();
      const draft = createCourse({ status: schema.CourseStatus.Draft });
      const archived = createCourse({ status: schema.CourseStatus.Archived });
      const other = createCourse({ instructorId: createInstructor().id });
      const at = "2026-03-01T00:00:00.000Z";
      purchase(student.id, base.course.id, 1000, at);
      purchase(student.id, archived.id, 200, at);
      purchase(student.id, draft.id, 30, at);
      purchase(student.id, other.id, 4, at);

      const { revenue } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(revenue.current).toBe(1200);
    });
  });

  describe("getInstructorOverview — new enrollments", () => {
    it("counts paid, coupon and free enrollments by enrolment date", () => {
      const paid = createStudent();
      const viaCoupon = createStudent();
      const onFree = createStudent();
      const earlier = createStudent();
      const freeCourse = createCourse({ price: 0 });
      const at = "2026-03-01T00:00:00.000Z";

      purchase(paid.id, base.course.id, 5000, at);
      enroll(paid.id, base.course.id, at);

      const team = testDb
        .insert(schema.teams)
        .values({ createdAt: at })
        .returning()
        .get();
      const teamPurchase = purchase(paid.id, base.course.id, 10000, at);
      enroll(viaCoupon.id, base.course.id, "2026-03-05T00:00:00.000Z");
      testDb
        .insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: base.course.id,
          code: "TEAM-1",
          purchaseId: teamPurchase.id,
          redeemedByUserId: viaCoupon.id,
          redeemedAt: "2026-03-05T00:00:00.000Z",
        })
        .run();

      enroll(onFree.id, freeCourse.id, "2026-03-10T00:00:00.000Z");
      enroll(earlier.id, base.course.id, "2026-02-01T00:00:00.000Z");

      const { enrollments } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(enrollments).toEqual({ current: 3, previous: 1, change: 2 });
    });

    it("excludes drafts and other instructors' courses, includes archived", () => {
      const at = "2026-03-01T00:00:00.000Z";
      const draft = createCourse({ status: schema.CourseStatus.Draft });
      const archived = createCourse({ status: schema.CourseStatus.Archived });
      const other = createCourse({ instructorId: createInstructor().id });
      enroll(createStudent().id, base.course.id, at);
      enroll(createStudent().id, archived.id, at);
      enroll(createStudent().id, draft.id, at);
      enroll(createStudent().id, other.id, at);

      const { enrollments } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(enrollments.current).toBe(2);
    });
  });

  describe("getInstructorOverview — active students", () => {
    it("counts each student once across completions, video and quizzes", () => {
      const lesson = addLesson(base.course.id);
      const allThree = createStudent();
      const videoOnly = createStudent();
      const quizOnly = createStudent();
      const lastPeriod = createStudent();
      const inProgress = createStudent();
      const at = "2026-03-01T00:00:00.000Z";

      completeLesson(allThree.id, lesson.id, at);
      watchVideo(allThree.id, lesson.id, at);
      attemptQuiz(allThree.id, lesson.id, at);
      watchVideo(videoOnly.id, lesson.id, at);
      watchVideo(videoOnly.id, lesson.id, "2026-03-02T00:00:00.000Z");
      attemptQuiz(quizOnly.id, lesson.id, at);
      completeLesson(lastPeriod.id, lesson.id, "2026-02-01T00:00:00.000Z");
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId: inProgress.id,
          lessonId: lesson.id,
          status: schema.LessonProgressStatus.InProgress,
        })
        .run();

      const { activeStudents } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(activeStudents).toEqual({ current: 3, previous: 1, change: 2 });
    });

    it("excludes drafts and other instructors' courses, includes archived", () => {
      const at = "2026-03-01T00:00:00.000Z";
      const draft = addLesson(
        createCourse({ status: schema.CourseStatus.Draft }).id
      );
      const archived = addLesson(
        createCourse({ status: schema.CourseStatus.Archived }).id
      );
      const other = addLesson(
        createCourse({ instructorId: createInstructor().id }).id
      );
      watchVideo(createStudent().id, archived.id, at);
      watchVideo(createStudent().id, draft.id, at);
      watchVideo(createStudent().id, other.id, at);

      const { activeStudents } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(activeStudents.current).toBe(1);
    });
  });

  describe("getInstructorOverview — completion rate", () => {
    const longAgo = "2025-01-01T00:00:00.000Z";

    /** Enrolls a student and completes the given lessons. */
    function studentWith(courseId: number, completed: { id: number }[]) {
      const student = createStudent();
      enroll(student.id, courseId, longAgo);
      for (const lesson of completed) {
        completeLesson(student.id, lesson.id, longAgo);
      }
      return student;
    }

    it("pools completed students over enrolled students, all-time", () => {
      const l1 = addLesson(base.course.id);
      const l2 = addLesson(base.course.id);
      studentWith(base.course.id, [l1, l2]);
      studentWith(base.course.id, [l1, l2]);
      studentWith(base.course.id, [l1]);
      studentWith(base.course.id, []);
      const other = createCourse();
      const o1 = addLesson(other.id);
      studentWith(other.id, [o1]);
      studentWith(other.id, []);

      const { completion } = getInstructorOverview(
        base.instructor.id,
        parseRange("7d", NOW)
      );

      expect(completion).toEqual({ completed: 3, enrolled: 6, rate: 0.5 });
    });

    it("measures against current lessons, so adding a lesson lowers it", () => {
      const l1 = addLesson(base.course.id);
      studentWith(base.course.id, [l1]);
      studentWith(base.course.id, [l1]);
      studentWith(base.course.id, []);
      addLesson(base.course.id, "New lesson");

      const { completion } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(completion).toEqual({ completed: 0, enrolled: 3, rate: 0 });
    });

    it("ignores the enrollment completedAt flag and non-enrolled progress", () => {
      const l1 = addLesson(base.course.id);
      const flagged = createStudent();
      testDb
        .insert(schema.enrollments)
        .values({
          userId: flagged.id,
          courseId: base.course.id,
          enrolledAt: longAgo,
          completedAt: longAgo,
        })
        .run();
      completeLesson(createStudent().id, l1.id, longAgo);

      const { completion } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(completion).toEqual({ completed: 0, enrolled: 1, rate: 0 });
    });

    it("excludes drafts and other instructors' courses, includes archived", () => {
      const archived = createCourse({ status: schema.CourseStatus.Archived });
      const draft = createCourse({ status: schema.CourseStatus.Draft });
      const other = createCourse({ instructorId: createInstructor().id });
      for (const course of [archived, draft, other]) {
        studentWith(course.id, [addLesson(course.id)]);
      }

      const { completion } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(completion).toEqual({ completed: 1, enrolled: 1, rate: 1 });
    });

    it("has no rate when nobody is enrolled", () => {
      const { completion } = getInstructorOverview(
        base.instructor.id,
        THIRTY_DAYS()
      );

      expect(completion).toEqual({ completed: 0, enrolled: 0, rate: null });
    });
  });

  describe("getRevenueSeries", () => {
    it("buckets 7d by UTC day and fills days without sales with zero", () => {
      const student = createStudent();
      purchase(student.id, base.course.id, 1000, "2026-03-09T00:00:00.000Z");
      purchase(student.id, base.course.id, 500, "2026-03-11T23:59:59.000Z");
      purchase(student.id, base.course.id, 250, "2026-03-11T08:00:00.000Z");
      purchase(student.id, base.course.id, 9999, "2026-03-08T23:59:59.000Z");

      const series = getRevenueSeries(
        { instructorId: base.instructor.id },
        parseRange("7d", NOW)
      );

      expect(series).toEqual([
        { bucketStart: "2026-03-09", revenueCents: 1000 },
        { bucketStart: "2026-03-10", revenueCents: 0 },
        { bucketStart: "2026-03-11", revenueCents: 750 },
        { bucketStart: "2026-03-12", revenueCents: 0 },
        { bucketStart: "2026-03-13", revenueCents: 0 },
        { bucketStart: "2026-03-14", revenueCents: 0 },
        { bucketStart: "2026-03-15", revenueCents: 0 },
      ]);
    });

    it("buckets 12m by UTC month, zero-filled across all twelve months", () => {
      const student = createStudent();
      purchase(student.id, base.course.id, 1000, "2025-04-01T00:00:00.000Z");
      purchase(student.id, base.course.id, 300, "2026-03-31T23:59:59.000Z");
      purchase(student.id, base.course.id, 200, "2026-03-01T00:00:00.000Z");
      purchase(student.id, base.course.id, 9999, "2025-03-31T23:59:59.000Z");

      const series = getRevenueSeries(
        { instructorId: base.instructor.id },
        parseRange("12m", NOW)
      );

      expect(series.map((b) => b.bucketStart)).toEqual([
        "2025-04-01",
        "2025-05-01",
        "2025-06-01",
        "2025-07-01",
        "2025-08-01",
        "2025-09-01",
        "2025-10-01",
        "2025-11-01",
        "2025-12-01",
        "2026-01-01",
        "2026-02-01",
        "2026-03-01",
      ]);
      expect(series[0].revenueCents).toBe(1000);
      expect(series[11].revenueCents).toBe(500);
      expect(series.slice(1, 11).every((b) => b.revenueCents === 0)).toBe(true);
    });

    it("runs all-time monthly buckets from the first sale's month to now", () => {
      const student = createStudent();
      purchase(student.id, base.course.id, 1000, "2025-12-20T00:00:00.000Z");
      purchase(student.id, base.course.id, 400, "2026-03-02T00:00:00.000Z");

      const series = getRevenueSeries(
        { instructorId: base.instructor.id },
        parseRange("all", NOW)
      );

      expect(series).toEqual([
        { bucketStart: "2025-12-01", revenueCents: 1000 },
        { bucketStart: "2026-01-01", revenueCents: 0 },
        { bucketStart: "2026-02-01", revenueCents: 0 },
        { bucketStart: "2026-03-01", revenueCents: 400 },
      ]);
    });

    it("has no buckets all-time when there have been no sales", () => {
      const series = getRevenueSeries(
        { instructorId: base.instructor.id },
        parseRange("all", NOW)
      );

      expect(series).toEqual([]);
    });

    it("scopes to a single course", () => {
      const student = createStudent();
      const other = createCourse();
      purchase(student.id, base.course.id, 1000, "2026-03-15T00:00:00.000Z");
      purchase(student.id, other.id, 50, "2026-03-15T00:00:00.000Z");

      const series = getRevenueSeries(
        { courseId: other.id },
        parseRange("7d", NOW)
      );

      expect(series.at(-1)).toEqual({
        bucketStart: "2026-03-15",
        revenueCents: 50,
      });
      expect(series.reduce((sum, b) => sum + b.revenueCents, 0)).toBe(50);
    });
  });

  describe("getCourseSummaries", () => {
    function rate(userId: number, courseId: number, rating: number) {
      testDb
        .insert(schema.courseRatings)
        .values({ userId, courseId, rating })
        .run();
    }

    it("summarises each course's range revenue and enrollments, all-time completion and rating", () => {
      const [ann, bob, cat] = [
        createStudent(),
        createStudent(),
        createStudent(),
      ];
      const course = base.course;
      const lesson1 = addLesson(course.id);
      const lesson2 = addLesson(course.id);
      const inRange = "2026-03-01T00:00:00.000Z";
      const beforeRange = "2025-06-01T00:00:00.000Z";

      purchase(ann.id, course.id, 4000, inRange);
      purchase(bob.id, course.id, 2500, inRange);
      purchase(cat.id, course.id, 9999, beforeRange);
      enroll(ann.id, course.id, inRange);
      enroll(bob.id, course.id, inRange);
      enroll(cat.id, course.id, beforeRange);
      // Cat finished every lesson long ago; Ann finished one of two.
      completeLesson(cat.id, lesson1.id, beforeRange);
      completeLesson(cat.id, lesson2.id, beforeRange);
      completeLesson(ann.id, lesson1.id, inRange);
      rate(ann.id, course.id, 5);
      rate(bob.id, course.id, 4);
      rate(cat.id, course.id, 2);

      const summaries = getCourseSummaries(base.instructor.id, THIRTY_DAYS());

      expect(summaries).toEqual([
        {
          courseId: course.id,
          title: course.title,
          status: schema.CourseStatus.Published,
          revenue: 6500,
          enrollments: 2,
          completion: { completed: 1, enrolled: 3, rate: 1 / 3 },
          rating: { average: 11 / 3, count: 3 },
        },
      ]);
    });

    it("lists archived and empty courses with zeros, but not drafts or other instructors' courses", () => {
      const archived = createCourse({
        title: "Archived Course",
        status: schema.CourseStatus.Archived,
      });
      createCourse({
        title: "Draft Course",
        status: schema.CourseStatus.Draft,
      });
      createCourse({ title: "Theirs", instructorId: createInstructor().id });
      const student = createStudent();
      purchase(student.id, archived.id, 1200, "2026-03-01T00:00:00.000Z");

      const summaries = getCourseSummaries(base.instructor.id, THIRTY_DAYS());

      expect(summaries).toEqual([
        {
          courseId: archived.id,
          title: "Archived Course",
          status: schema.CourseStatus.Archived,
          revenue: 1200,
          enrollments: 0,
          completion: { completed: 0, enrolled: 0, rate: null },
          rating: { average: null, count: 0 },
        },
        {
          courseId: base.course.id,
          title: base.course.title,
          status: schema.CourseStatus.Published,
          revenue: 0,
          enrollments: 0,
          completion: { completed: 0, enrolled: 0, rate: null },
          rating: { average: null, count: 0 },
        },
      ]);
    });
  });

  describe("getRevenueByCountry", () => {
    it("totals range revenue per country with its PPP tier, a missing country as Tier 1", () => {
      const student = createStudent();
      const course = base.course;
      const at = "2026-03-01T00:00:00.000Z";
      purchase(student.id, course.id, 5000, at, "US");
      purchase(student.id, course.id, 2000, at, "US");
      purchase(student.id, course.id, 1500, at, "IN");
      purchase(student.id, course.id, 3500, at, "BR");
      purchase(student.id, course.id, 600, at, "NG");
      purchase(student.id, course.id, 800, at, null);
      purchase(student.id, course.id, 9999, "2025-01-01T00:00:00.000Z", "IN");

      const rows = getRevenueByCountry(base.instructor.id, THIRTY_DAYS());

      expect(rows).toEqual([
        { country: "US", tier: 1, revenueCents: 7000 },
        { country: "BR", tier: 2, revenueCents: 3500 },
        { country: "IN", tier: 3, revenueCents: 1500 },
        { country: null, tier: 1, revenueCents: 800 },
        { country: "NG", tier: 4, revenueCents: 600 },
      ]);
    });

    it("excludes drafts and other instructors' courses", () => {
      const student = createStudent();
      const draft = createCourse({ status: schema.CourseStatus.Draft });
      const other = createCourse({ instructorId: createInstructor().id });
      const at = "2026-03-01T00:00:00.000Z";
      purchase(student.id, base.course.id, 100, at, "GB");
      purchase(student.id, draft.id, 200, at, "GB");
      purchase(student.id, other.id, 300, at, "MX");

      const rows = getRevenueByCountry(base.instructor.id, THIRTY_DAYS());

      expect(rows).toEqual([{ country: "GB", tier: 1, revenueCents: 100 }]);
    });
  });

  describe("getCourseAnalytics", () => {
    it("scopes the headline cards to one course, leaving out the instructor's other courses", () => {
      const [ann, bob, cat] = [
        createStudent(),
        createStudent(),
        createStudent(),
      ];
      const course = base.course;
      const sibling = createCourse();
      const lesson = addLesson(course.id);
      const siblingLesson = addLesson(sibling.id);
      const current = "2026-03-01T00:00:00.000Z";
      const previous = "2026-02-01T00:00:00.000Z";

      purchase(ann.id, course.id, 4000, current);
      purchase(bob.id, course.id, 2000, previous);
      purchase(cat.id, sibling.id, 9999, current);
      enroll(ann.id, course.id, current);
      enroll(bob.id, course.id, previous);
      enroll(cat.id, sibling.id, current);
      completeLesson(ann.id, lesson.id, current);
      watchVideo(bob.id, lesson.id, previous);
      completeLesson(cat.id, siblingLesson.id, current);

      const metrics = getCourseAnalytics(course.id, THIRTY_DAYS());

      expect(metrics).toEqual({
        revenue: { current: 4000, previous: 2000, change: 1 },
        enrollments: { current: 1, previous: 1, change: 0 },
        activeStudents: { current: 1, previous: 1, change: 0 },
        completion: { completed: 1, enrolled: 2, rate: 0.5 },
      });
    });

    it("reports zeros and no revenue buckets for a course with no sales", () => {
      const quiet = createCourse();
      const student = createStudent();
      purchase(student.id, base.course.id, 5000, "2026-03-01T00:00:00.000Z");

      expect(getCourseAnalytics(quiet.id, THIRTY_DAYS())).toEqual({
        revenue: { current: 0, previous: 0, change: null },
        enrollments: { current: 0, previous: 0, change: null },
        activeStudents: { current: 0, previous: 0, change: null },
        completion: { completed: 0, enrolled: 0, rate: null },
      });
      expect(
        getRevenueSeries({ courseId: quiet.id }, parseRange("all", NOW))
      ).toEqual([]);
    });

    it("charts only the course's own revenue", () => {
      const sibling = createCourse();
      const student = createStudent();
      purchase(student.id, base.course.id, 1500, "2026-01-10T00:00:00.000Z");
      purchase(student.id, sibling.id, 9999, "2026-02-10T00:00:00.000Z");

      const series = getRevenueSeries(
        { courseId: base.course.id },
        parseRange("all", NOW)
      );

      expect(series).toEqual([
        { bucketStart: "2026-01-01", revenueCents: 1500 },
        { bucketStart: "2026-02-01", revenueCents: 0 },
        { bucketStart: "2026-03-01", revenueCents: 0 },
      ]);
    });
  });
});
