export type JsonValue = boolean | JsonRecord | JsonValue[] | null | number | string;

export interface JsonRecord {
  [key: string]: JsonValue | undefined;
}

/** Returns true only for string values. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Returns true only for number values. */
export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Returns true only for integer number values. */
export function isInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value);
}

/** Returns true only for non-array objects. */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
