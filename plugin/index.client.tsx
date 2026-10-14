import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HerdrOverviewScreen } from "./client/overview";
import { HerdrSettings } from "./client/settings";
import { HerdrSidebarItem } from "./client/sidebar";
import { OVERVIEW_SCREEN_ID } from "./client/helpers";
import { registerHerdrHome } from "./client/home";
import { DecisionRow } from "./client/decision-row";
import { DECISION_ROW_KIND, DECISION_ROW_VERSION, DecisionRowSchema } from "./shared/decision";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSidebarHeaderItem({ id: "herdr-agents", title: "Herdr", Component: HerdrSidebarItem }),
    client.addScreen({ id: OVERVIEW_SCREEN_ID, title: "Herdr", Component: HerdrOverviewScreen }),
    client.addSettingsScreen({
      id: "herdr",
      title: "Herdr",
      icon: "SquareTerminal",
      Component: HerdrSettings,
    }),
    client.addCommandCenterItem({
      id: "open-herdr",
      title: "Open Herdr home",
      icon: "House",
      keywords: ["herdr", "home", "agents", "omp", "chats", "workspaces", "panes"],
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: OVERVIEW_SCREEN_ID }),
    }),
    registerHerdrHome(client),
    client.addTimelineRenderer({ kind: DECISION_ROW_KIND, version: DECISION_ROW_VERSION, schema: DecisionRowSchema, Component: DecisionRow }),
    client.addCommandCenterItem({
      id: "herdr-settings",
      title: "Herdr settings",
      icon: "Settings",
      keywords: ["herdr", "socket", "session"],
      context: "global",
      onSelect: ({ openSettings }) => openSettings("herdr"),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
