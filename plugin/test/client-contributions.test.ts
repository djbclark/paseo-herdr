import { describe, expect, it, vi } from "vitest";

// The screens pull in react-native, which can't load under Node; only the contribution ids matter here.
vi.mock("../client/overview", () => ({ HerdrOverviewScreen: () => null }));
vi.mock("../client/settings", () => ({ HerdrSettings: () => null }));
vi.mock("../client/sidebar", () => ({ HerdrSidebarItem: () => null }));
vi.mock("../client/decision-row", () => ({ DecisionRow: () => null }));
vi.mock("../client/home", () => ({ registerHerdrHome: () => () => {} }));

// Paseo's client loader (packages/app/src/plugins/evaluate.ts) rejects any id or renderer kind outside this pattern,
// and a rejection fails the whole plugin ("Invalid timeline renderer kind: herdr.decision").
const PASEO_ID = /^[a-z][a-z0-9-]*$/;

describe("client contributions", () => {
  it("uses only ids and timeline renderer kinds that Paseo's loader accepts", async () => {
    const ids: string[] = [];
    const record = (value: string) => { ids.push(value); return () => {}; };
    const client = new Proxy({}, {
      get: (_target, method: string) => (contribution: { id?: string; kind?: string }) =>
        record(method === "addTimelineRenderer" ? contribution.kind ?? "" : contribution.id ?? ""),
    });
    // A computed specifier: the server tsconfig that checks tests has no JSX; Vitest resolves the .tsx at run time.
    const entry = "../index.client.js";
    const { default: contribute } = await import(entry) as { default: (client: never) => () => void };
    const cleanup = contribute(client as never);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !PASEO_ID.test(id))).toEqual([]);
    cleanup();
  });
});
