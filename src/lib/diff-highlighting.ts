import { setCustomExtension } from "@/vendor/pierre-diffs/dist/utils/getFiletypeFromFileName";

/** Maps CUDA source files to Pierre's built-in C++ grammar in every rendering context. */
export function configureDiffHighlighting(): void {
  setCustomExtension("cu", "cpp");
  setCustomExtension("cuh", "cpp");
}
