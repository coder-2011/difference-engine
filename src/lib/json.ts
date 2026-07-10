export type JsonRecord = Record<string, unknown>;

/** Returns true only for non-array objects. */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
