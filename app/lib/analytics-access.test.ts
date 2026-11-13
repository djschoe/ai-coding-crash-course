import { describe, it, expect } from "vitest";
import { resolveAnalyticsInstructorId } from "./analytics-access";

describe("resolveAnalyticsInstructorId", () => {
  it("shows an admin the instructor named in the param", () => {
    expect(
      resolveAnalyticsInstructorId({ userId: 1, isAdmin: true }, "7")
    ).toBe(7);
  });

  it("ignores the param for an instructor, who always sees themselves", () => {
    expect(
      resolveAnalyticsInstructorId({ userId: 3, isAdmin: false }, "7")
    ).toBe(3);
  });

  it.each([null, "", "abc", "0", "-2", "1.5"])(
    "shows an admin their own analytics when the param is %j",
    (param) => {
      expect(
        resolveAnalyticsInstructorId({ userId: 1, isAdmin: true }, param)
      ).toBe(1);
    }
  );
});
