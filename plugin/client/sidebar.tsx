import { useCallback } from "react";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { OVERVIEW_SCREEN_ID } from "./helpers";

export function HerdrSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: OVERVIEW_SCREEN_ID }), [openScreen]);
  return (
    <SidebarRow
      icon="SquareTerminal"
      label="Herdr"
      active={currentScreen?.screenId === OVERVIEW_SCREEN_ID}
      onPress={open}
    />
  );
}
