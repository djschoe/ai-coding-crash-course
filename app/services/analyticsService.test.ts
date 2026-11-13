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
import { parseRange, getInstructorOverview } from "./analyticsService";

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
});
