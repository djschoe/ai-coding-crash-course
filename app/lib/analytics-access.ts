// ─── Analytics Access ───
// Which instructor's analytics a viewer sees.

/**
 * Admins may view any instructor via the `instructorId` param; without a valid
 * id they see themselves. Instructors always see themselves, whatever the param.
 */
export function resolveAnalyticsInstructorId(
  viewer: { userId: number; isAdmin: boolean },
  instructorIdParam: string | null
): number {
  if (!viewer.isAdmin || !instructorIdParam) return viewer.userId;
  if (!/^\d+$/.test(instructorIdParam)) return viewer.userId;
  const id = Number(instructorIdParam);
  return id > 0 ? id : viewer.userId;
}
