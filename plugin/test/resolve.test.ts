import { describe, expect, it } from "vitest";
import { adapterAcceptsKind, createResolver } from "../server/harness/resolve.js";
import { makeFakeAdapter } from "./fake-harness.js";

describe("createResolver", () => {
  it("prefers the adapter that specifically claims the kind over the fallback", () => {
    const specific = makeFakeAdapter(undefined, { id: "fake", nativeKinds: ["fake"] });
    const generic = makeFakeAdapter(undefined, { id: "generic", nativeKinds: "any" });
    const resolver = createResolver([generic, specific]);
    expect(resolver.select("fake")).toBe(specific);
    expect(resolver.select("other")).toBe(generic);
  });

  it.each([null, undefined, "unknown-tui", ""])("routes kind %j to the fallback", (kind) => {
    const generic = makeFakeAdapter(undefined, { id: "generic", nativeKinds: "any" });
    const resolver = createResolver([generic]);
    expect(resolver.select(kind)).toBe(generic);
  });

  it("returns null when nothing matches and there is no fallback", () => {
    const resolver = createResolver([makeFakeAdapter(undefined, { nativeKinds: ["fake"] })]);
    expect(resolver.select("claude")).toBeNull();
    expect(resolver.select(null)).toBeNull();
  });

  it("throws on two fallback adapters", () => {
    const first = makeFakeAdapter(undefined, { id: "g1", nativeKinds: "any" });
    const second = makeFakeAdapter(undefined, { id: "g2", nativeKinds: "any" });
    expect(() => createResolver([first, second])).toThrow(/fallback/);
  });

  it("throws on overlapping specific kinds", () => {
    const first = makeFakeAdapter(undefined, { id: "a", nativeKinds: ["claude", "fake"] });
    const second = makeFakeAdapter(undefined, { id: "b", nativeKinds: ["fake"] });
    expect(() => createResolver([first, second])).toThrow(/claim Herdr agent kind "fake"/);
  });

  it("finds adapters by persistence id", () => {
    const adapter = makeFakeAdapter(undefined, { id: "fake" });
    const resolver = createResolver([adapter]);
    expect(resolver.byId("fake")).toBe(adapter);
    expect(resolver.byId("missing")).toBeUndefined();
  });
});

describe("adapterAcceptsKind", () => {
  it("a fallback adapter accepts every existing binding, whatever the pane was later detected as", () => {
    const generic = makeFakeAdapter(undefined, { nativeKinds: "any" });
    expect(adapterAcceptsKind(generic, "fake")).toBe(true);
    expect(adapterAcceptsKind(generic, "unknown-tui")).toBe(true);
    expect(adapterAcceptsKind(generic, null)).toBe(true);
  });

  it("a specific adapter accepts only its own kinds", () => {
    const specific = makeFakeAdapter(undefined, { nativeKinds: ["fake"] });
    expect(adapterAcceptsKind(specific, "fake")).toBe(true);
    expect(adapterAcceptsKind(specific, "other")).toBe(false);
    expect(adapterAcceptsKind(specific, null)).toBe(false);
    expect(adapterAcceptsKind(undefined, "fake")).toBe(false);
  });
});
