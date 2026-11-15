// ─── Analytics Access ───
// Which instructor's analytics a viewer sees.
//
// Uses positional parameters (project convention).

/**
 * Instructors always see themselves, whatever the param. Admins see the
 * instructor named by a valid `instructorId` param, or nobody (null) without
 * one — they have no analytics of their own.
 */
export function resolveAnalyticsInstructorId(
  viewerId: number,
  isAdmin: boolean,
  instructorIdParam: string | null
): number | null {
  if (!isAdmin) return viewerId;
  if (!instructorIdParam || !/^\d+$/.test(instructorIdParam)) return null;
  const id = Number(instructorIdParam);
  return id > 0 ? id : null;
}
