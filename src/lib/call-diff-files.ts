export const CALL_DIFF_FILE_LIMIT = 24;
export const CALL_DIFF_ANONYMOUS_FILE_LIMIT = 12;
export const CALL_DIFF_FILE_SIZE_LIMIT = 128_000;

/** Identifies source files that TypeScript can parse without adding a language runtime. */
export function isCallDiffSourcePath(path: string): boolean {
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(path);
}
