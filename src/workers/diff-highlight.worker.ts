/// <reference lib="webworker" />

import { configureDiffHighlighting } from "@/lib/diff-highlighting";
import "@pierre/diffs/worker/worker.js";

configureDiffHighlighting();
