import { setCustomExtension } from "@pierre/diffs";

const CUDA_LANGUAGES = new Set(["cu", "cuh", "cuda", "cuda-c++", "cuda-cpp"]);

/** Maps CUDA source files to Pierre's built-in C++ grammar in every rendering context. */
export function configureDiffHighlighting(): void {
  setCustomExtension("cu", "cpp");
  setCustomExtension("cuh", "cpp");
}

/** Returns a Shiki language Pierre can actually load, mapping CUDA names onto C++. */
export function highlighterLanguage(language: string): string {
  return CUDA_LANGUAGES.has(language.toLowerCase()) ? "cpp" : language;
}
