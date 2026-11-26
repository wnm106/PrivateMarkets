/**
 * What the assistant is told about fields the person is not cleared to see.
 * Their values are already left out of every tool result by the database; this
 * makes the assistant say they are restricted instead of reporting them as
 * missing, and stops it trying to work them out from other fields.
 */
export function restrictedFieldsBlock(codes: readonly string[]): string {
  if (!codes.length) return '';
  return `\n\n## Restricted fields\nThis person is not cleared to see these fields: ${codes.join(', ')}. Their values are left out of every tool result. When asked about one, say it is restricted for them and that an administrator can grant access; never say it is blank or missing, and never estimate or work out its value from other fields.`;
}
