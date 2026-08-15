export const CALL_DIFF_FILE_LIMIT = 24;
export const CALL_DIFF_ANONYMOUS_FILE_LIMIT = 12;
export const CALL_DIFF_FILE_SIZE_LIMIT = 128_000;

const CALL_DIFF_SOURCE_PATH = /\.(?:bash|c|cc|cjs|cpp|cs|cts|cxx|ex|exs|go|h|hh|hs|hpp|java|js|jsx|kt|kts|lua|mjs|ml|mts|php|py|rb|rs|scala|sh|sol|swift|ts|tsx|zig)$/i;

/** Identifies the source extensions calldiff extracts through Tree-sitter. */
export function isCallDiffSourcePath(path: string): boolean {
  return CALL_DIFF_SOURCE_PATH.test(path);
}
