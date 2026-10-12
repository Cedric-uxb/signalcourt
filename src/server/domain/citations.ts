export function validateCitations(
  citations: string[],
  evidenceIds: Set<string>,
): string[] {
  return citations.filter((id) => !evidenceIds.has(id));
}
