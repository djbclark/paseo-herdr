import type { HarnessAdapter } from "../types.js";
import { readOmpTranscript, ompTranscriptUpdatedAt } from "./transcript.js";

export const ompAdapter: HarnessAdapter = {
  id: "omp",
  label: "OMP",
  resolveTranscript: (ref) => ref?.kind === "path" ? ref.value : null,
  readTranscript: readOmpTranscript,
  transcriptUpdatedAt: ompTranscriptUpdatedAt,
};
