import type { HarnessAdapter } from "./types.js";
import { ompAdapter } from "./omp/adapter.js";

export const harnesses: readonly HarnessAdapter[] = [ompAdapter];
