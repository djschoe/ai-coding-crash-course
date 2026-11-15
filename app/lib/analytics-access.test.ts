import { describe, it, expect } from "vitest";
import { resolveAnalyticsInstructorId } from "./analytics-access";

describe("resolveAnalyticsInstructorId", () => {
  it("shows an admin the instructor named in the param", () => {
    expect(resolveAnalyticsInstructorId(1, true, "7")).toBe(7);
  });

  it("ignores the param for an instructor, who always sees themselves", () => {
    expect(resolveAnalyticsInstructorId(3, false, "7")).toBe(3);
    expect(resolveAnalyticsInstructorId(3, false, null)).toBe(3);
  });

  it.each([null, "", "abc", "0", "-2", "1.5"])(
    "has no instructor for an admin when the param is %j",
    (param) => {
      expect(resolveAnalyticsInstructorId(1, true, param)).toBeNull();
    }
  );
});
