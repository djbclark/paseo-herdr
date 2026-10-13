/**
 * One way to name an agent everywhere it appears (Herdr overview, Paseo's Import session sheet), so a
 * row in one can be matched to the other.
 */

/** Terminal titles carry the harness prompt glyph ("π > Fix tests"); drop it. */
export function cleanTitle(title: string | null | undefined): string | undefined {
  const cleaned = title?.replace(/^\S{1,2}\s*>\s*/, "").trim();
  return cleaned || undefined;
}

/** "OMP · pane w2:p1": the harness and the Herdr pane, which identify an agent unambiguously. */
export function agentPlace(harnessLabel: string | null | undefined, paneId: string): string {
  return `${harnessLabel ? `${harnessLabel} · ` : ""}pane ${paneId}`;
}
