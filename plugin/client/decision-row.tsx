import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { describeDecision, type DecisionRowData } from "../shared/decision.js";

/** Timeline row for a decided approval or question: what was decided, where, and what the card asked. */
export function DecisionRow({ item, theme }: PluginTimelineItemProps<DecisionRowData>) {
  const c = theme.colors;
  const data = item.data;
  return (
    <View style={{ paddingVertical: 6, paddingHorizontal: 12, gap: 2, borderLeftWidth: 2, borderLeftColor: c.border }}>
      <Text style={{ color: c.foreground, fontSize: 13 }}>{describeDecision(data)}</Text>
      <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12 }}>{data.title}</Text>
    </View>
  );
}
