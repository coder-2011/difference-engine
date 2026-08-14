export const CALL_DIFF_FILE_LIMIT = 24;
export const CALL_DIFF_ANONYMOUS_FILE_LIMIT = 12;
export const CALL_DIFF_FILE_SIZE_LIMIT = 128_000;

const CALL_DIFF_SOURCE_PATH = /(?:^|\/)(?:BUILD(?:\.bazel)?|Gemfile|Rakefile|WORKSPACE(?:\.bazel)?|[^/]+\.(?:bash|bzl|c|cc|cjs|cpp|cs|cts|cxx|ex|exs|go|h|hh|hpp|java|js|jsx|lua|mjs|mts|php|phtml|proto|py|pyi|pyw|ql|r|rake|rb|rs|sc|scala|sh|star|swift|ts|tsx|zsh))$/i;
const TYPESCRIPT_CALL_DIFF_SOURCE_PATH = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i;

/** Identifies GitHub code-navigation languages, with TSX retained as its own source mode. */
export function isCallDiffSourcePath(path: string): boolean {
  return CALL_DIFF_SOURCE_PATH.test(path);
}

/** Keeps JavaScript and TypeScript on the existing high-fidelity TypeScript AST path. */
export function isTypeScriptCallDiffSourcePath(path: string): boolean {
  return TYPESCRIPT_CALL_DIFF_SOURCE_PATH.test(path);
}
