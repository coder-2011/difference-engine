import { setCustomExtension } from "@pierre/diffs";

/** Maps CUDA source files to Pierre's built-in C++ grammar in every rendering context. */
export function configureDiffHighlighting(): void {
  setCustomExtension("cu", "cpp");
  setCustomExtension("cuh", "cpp");
}
