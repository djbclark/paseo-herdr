import type { HarnessAdapter } from "./types.js";
import { ompAdapter } from "./omp/adapter.js";

export { createResolver, adapterAcceptsKind, type AdapterResolver } from "./resolve.js";

export const harnesses: readonly HarnessAdapter[] = [ompAdapter];

export const harnessById: Readonly<Record<string, HarnessAdapter>> = Object.fromEntries(
  harnesses.map((adapter) => [adapter.id, adapter]),
);

export function getHarness(id: string): HarnessAdapter | undefined {
  return harnessById[id];
}
