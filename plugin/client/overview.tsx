import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { usePaseo, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  herdrOverviewRpc,
  herdrWorkspaceCreateRpc,
  type OverviewAgent,
  type OverviewTab,
  type OverviewWorkspace,
  type HerdrTarget,
  type HerdrConnection,
  type RecentChat,
} from "../shared/rpc.js";
import {
  agentLabel,
  attentionLabel,
  describeTarget,
  errorMessage,
  OVERVIEW_QUERY_KEY,
  OVERVIEW_REFETCH_MS,
  timeAgo,
  statusLabel,
  statusTone,
  validateFolder,
} from "./helpers.js";
import { agentPlace, cleanTitle } from "../shared/labels.js";
import { createHerdrChat } from "./actions.js";

type Theme = PluginScreenProps["theme"];
type Navigation = PluginScreenProps["navigation"];

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(() => {
    const c = theme.colors;
    const pad = compact ? 12 : 20;
    return {
      root: { padding: pad, gap: 16 },
      screen: { flex: 1, backgroundColor: c.surface0 },
      card: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: pad,
        gap: 8,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      title: { color: c.foreground, fontSize: 16, fontWeight: "600" as const },
      text: { color: c.foreground },
      muted: { color: c.foregroundMuted },
      danger: { color: c.statusDanger },
      button: {
        backgroundColor: c.accent,
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
      },
      buttonDisabled: {
        backgroundColor: c.accent,
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        opacity: 0.5,
      },
      buttonText: { color: c.accentForeground },
      secondary: {
        backgroundColor: c.surface2,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
      },
      input: {
        backgroundColor: c.surface2,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        color: c.foreground,
        minWidth: compact ? 0 : 240,
        alignSelf: "stretch" as const,
      },
      indent: { paddingLeft: compact ? 8 : 16, gap: 6 },
    };
  }, [theme, compact]);
}
type Styles = ReturnType<typeof useStyles>;

function Button({
  label,
  onPress,
  styles,
  disabled,
  secondary,
}: {
  label: string;
  onPress(): void;
  styles: Styles;
  disabled?: boolean;
  secondary?: boolean;
}) {
  const box = secondary ? styles.secondary : disabled ? styles.buttonDisabled : styles.button;
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={box}>
      <Text style={secondary ? styles.text : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function StatusBadge({ status, theme, styles }: { status: OverviewAgent["status"]; theme: Theme; styles: Styles }) {
  const c = theme.colors;
  const tone = statusTone(status);
  const color =
    tone === "success" ? c.statusSuccess : tone === "warning" ? c.statusWarning : tone === "accent" ? c.accent : c.foregroundMuted;
  const dot = useMemo(
    () => ({ width: 8, height: 8, borderRadius: 4, backgroundColor: color }),
    [color],
  );
  return (
    <View style={styles.row}>
      <View style={dot} />
      <Text style={styles.muted}>{statusLabel(status)}</Text>
    </View>
  );
}

function AgentRow({
  agent,
  theme,
  styles,
  navigation,
}: {
  agent: OverviewAgent;
  theme: Theme;
  styles: Styles;
  navigation: Navigation;
}) {
  const toast = useToast();
  const paseo = usePaseo();
  const [showCommand, setShowCommand] = useState(false);
  const { paseoAgentId, attach, cwd } = agent;
  const label = agentLabel(agent);
  const open = useCallback(() => {
    if (paseoAgentId && navigation) navigation.openAgent({ agentId: paseoAgentId });
  }, [paseoAgentId, navigation]);
  const folder = useMutation({
    mutationFn: async () => {
      if (!cwd) throw new Error("This agent has no folder path");
      return (await paseo.workspaces.open(cwd)).id;
    },
    onSuccess: (workspaceId) => navigation?.openWorkspace({ workspaceId }),
  });
  // A Paseo terminal running `herdr agent attach` (no shell) in the Paseo workspace for the agent's folder.
  const terminal = useMutation({
    mutationFn: async () => {
      if (!attach || !cwd) throw new Error("This agent can't be opened in a terminal");
      const workspace = await paseo.workspaces.open(cwd);
      await workspace.terminals.create({ name: `Herdr: ${label}`, command: attach.command, args: attach.args });
      return workspace.id;
    },
    onSuccess: (workspaceId) => navigation?.openWorkspace({ workspaceId }),
  });
  const openTerminal = useCallback(() => {
    if (!terminal.isPending) terminal.mutate();
  }, [terminal]);
  const toggleCommand = useCallback(() => setShowCommand((value) => !value), []);
  const copy = useCallback(async () => {
    try {
      await copyText(agent.attachCommand);
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the text and use Copy.");
    }
  }, [agent.attachCommand, toast]);
  const place = agentPlace(agent.harness ?? agent.kind, agent.paneId);
  const details = [place, cwd].filter(Boolean).join(" · ");
  const canOpenTerminal = Boolean(attach && cwd && navigation);
  return (
    <View style={styles.indent}>
      <View style={styles.row}>
        <Text style={styles.text} numberOfLines={1}>{label}</Text>
        <StatusBadge status={agent.status} theme={theme} styles={styles} />
      </View>
      {details ? <Text style={styles.muted} numberOfLines={1}>{details}</Text> : null}
      {!paseoAgentId ? (
        <Text style={styles.muted}>
          {agent.provider
            ? `To chat here, open the folder, tap ⋯ → Import session, and pick “${label}” (${place}).`
            : "No Paseo provider handles this agent kind."}
        </Text>
      ) : !navigation ? (
        <Text style={styles.muted}>Chat linked (open it from the Paseo sidebar)</Text>
      ) : null}
      <View style={styles.row}>
        {paseoAgentId && navigation ? <Button label="Open chat" onPress={open} styles={styles} /> : null}
        {!paseoAgentId && agent.provider && cwd && navigation ? (
          <Button label={folder.isPending ? "Opening…" : "Open folder to import"} secondary disabled={folder.isPending} onPress={() => folder.mutate()} styles={styles} />
        ) : null}
        {canOpenTerminal ? (
          <Button label={terminal.isPending ? "Opening…" : "Open terminal"} secondary disabled={terminal.isPending} onPress={openTerminal} styles={styles} />
        ) : null}
        {!paseoAgentId ? (
          <Button label={showCommand ? "Hide command" : "Command"} secondary onPress={toggleCommand} styles={styles} />
        ) : null}
      </View>
      {terminal.error ? <Text style={styles.muted}>Could not open a terminal: {errorMessage(terminal.error)}</Text> : null}
      {folder.error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(folder.error)}</Text> : null}
      {showCommand ? (
        <View style={styles.row}>
          <Text selectable style={styles.muted}>
            {agent.attachCommand}
          </Text>
          <Button label="Copy" secondary onPress={copy} styles={styles} />
        </View>
      ) : null}
    </View>
  );
}

function TabBlock({
  tab,
  theme,
  styles,
  navigation,
}: {
  tab: OverviewTab;
  theme: Theme;
  styles: Styles;
  navigation: Navigation;
}) {
  return (
    <View style={styles.indent}>
      <View style={styles.row}>
        <Text style={styles.text}>
          Tab {tab.number}: {tab.label}
        </Text>
        <StatusBadge status={tab.status} theme={theme} styles={styles} />
      </View>
      {tab.agents.length === 0 ? <Text style={styles.muted}>No agents</Text> : null}
      {tab.agents.map((agent) => (
        <AgentRow key={agent.terminalId} agent={agent} theme={theme} styles={styles} navigation={navigation} />
      ))}
    </View>
  );
}

function NewAgentButton({
  cwd,
  styles,
  navigation,
  onCreated,
}: {
  cwd: string;
  styles: Styles;
  navigation: Navigation;
  onCreated(): void;
}) {
  const paseo = usePaseo();
  const mutation = useMutation({
    mutationFn: async () => {
      return createHerdrChat(paseo, cwd);
    },
    onSuccess: (agentId) => {
      onCreated();
      navigation?.openAgent({ agentId });
    },
  });
  const { isPending, error, mutate } = mutation;
  const start = useCallback(() => {
    if (!isPending) mutate();
  }, [isPending, mutate]);
  return (
    <View style={styles.row}>
      <Button label={isPending ? "Starting…" : "New agent"} disabled={isPending || !cwd.trim() || !navigation} onPress={start} styles={styles} />
      {error ? (
        <Text accessibilityRole="alert" style={styles.danger}>
          {errorMessage(error)}
        </Text>
      ) : null}
    </View>
  );
}

function NewChatForm({ styles, theme, navigation, onCreated }: { styles: Styles; theme: Theme; navigation: Navigation; onCreated(): void }) {
  const [cwd, setCwd] = useState("");
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Start a chat</Text>
      <TextInput
        accessibilityLabel="New chat folder path"
        placeholder="Folder path"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={cwd}
        onChangeText={setCwd}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <NewAgentButton cwd={cwd} styles={styles} navigation={navigation} onCreated={onCreated} />
    </View>
  );
}

function WorkspaceCard({
  workspace,
  ompEnabled,
  theme,
  styles,
  navigation,
  onCreated,
}: {
  workspace: OverviewWorkspace;
  ompEnabled: boolean;
  theme: Theme;
  styles: Styles;
  navigation: Navigation;
  onCreated(): void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.title}>{workspace.label}</Text>
        <StatusBadge status={workspace.status} theme={theme} styles={styles} />
      </View>
      {workspace.cwd ? (
        <Text selectable style={styles.muted}>
          {workspace.cwd}
        </Text>
      ) : null}
      {workspace.tabs.length === 0 ? <Text style={styles.muted}>No tabs</Text> : null}
      {workspace.tabs.map((tab) => (
        <TabBlock key={tab.tabId} tab={tab} theme={theme} styles={styles} navigation={navigation} />
      ))}
      {ompEnabled && workspace.cwd ? (
        <NewAgentButton cwd={workspace.cwd} styles={styles} navigation={navigation} onCreated={onCreated} />
      ) : null}
    </View>
  );
}

function NewWorkspaceForm({ styles, theme, onCreated }: { styles: Styles; theme: Theme; onCreated(): void }) {
  const create = useRpc(herdrWorkspaceCreateRpc);
  const [cwd, setCwd] = useState("");
  const [label, setLabel] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => create({ cwd: cwd.trim(), label: label.trim() || undefined }),
    onSuccess: () => {
      setCwd("");
      setLabel("");
      onCreated();
    },
  });
  const { isPending, error, mutate } = mutation;
  const submit = useCallback(() => {
    if (isPending) return;
    const invalid = validateFolder(cwd);
    setLocalError(invalid);
    if (!invalid) mutate();
  }, [isPending, cwd, mutate]);
  const shown = localError ?? (error ? errorMessage(error) : null);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>New workspace</Text>
      <TextInput
        accessibilityLabel="Folder path"
        placeholder="Folder path"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={cwd}
        onChangeText={setCwd}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!isPending}
        style={styles.input}
      />
      <TextInput
        accessibilityLabel="Label"
        placeholder="Label (optional)"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={label}
        onChangeText={setLabel}
        editable={!isPending}
        style={styles.input}
      />
      <View style={styles.row}>
        <Button label={isPending ? "Creating…" : "Create workspace"} disabled={isPending} onPress={submit} styles={styles} />
      </View>
      {shown ? (
        <Text accessibilityRole="alert" style={styles.danger}>
          {shown}
        </Text>
      ) : null}
    </View>
  );
}

function ChatRow({ chat, target, connection, styles, navigation }: { chat: RecentChat; target: HerdrTarget; connection: HerdrConnection; styles: Styles; navigation: Navigation }) {
  const open = useCallback(() => navigation?.openAgent({ agentId: chat.paseoAgentId }), [navigation, chat.paseoAgentId]);
  const attention = attentionLabel(chat.attention);
  const where = chat.pane
    ? `pane ${chat.pane.paneId} · ${statusLabel(chat.pane.status)}`
    : chat.herdrSession !== target.herdrSession
      ? `Herdr session ${chat.herdrSession ?? "default"}`
      : connection.status === "unavailable" ? "live status unavailable" : "not running in Herdr";
  const meta = [chat.harness, timeAgo(chat.lastActivityAt), where].filter(Boolean).join(" · ");
  const body = (
    <View>
      <View style={styles.row}>
        <Text style={styles.text} numberOfLines={1}>{cleanTitle(chat.title) ?? "Untitled chat"}</Text>
        {attention ? <Text style={chat.attention === "error" ? styles.danger : styles.muted}>{attention}</Text> : null}
      </View>
      <Text style={styles.muted} numberOfLines={1}>{chat.cwd}</Text>
      <Text style={styles.muted} numberOfLines={1}>{meta}</Text>
    </View>
  );
  return navigation ? (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open chat ${cleanTitle(chat.title) ?? "Untitled chat"} in ${chat.cwd}`} onPress={open} style={styles.indent}>
      {body}
    </Pressable>
  ) : (
    <View style={styles.indent}>{body}</View>
  );
}

function RecentChats({ chats, target, connection, error, styles, navigation }: { chats: readonly RecentChat[]; target: HerdrTarget; connection: HerdrConnection; error: string | null; styles: Styles; navigation: Navigation }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Recent chats</Text>
      {error ? <Text accessibilityRole="alert" style={styles.danger}>Could not load recent chats: {error}</Text> : null}
      {chats.length === 0 && !error ? (
        <Text style={styles.muted}>No Herdr chats in Paseo yet. Start a chat in a folder, or open a folder below to import a running agent.</Text>
      ) : null}
      {chats.map((chat) => (
        <ChatRow key={chat.paseoAgentId} chat={chat} target={target} connection={connection} styles={styles} navigation={navigation} />
      ))}
      {!navigation && chats.length > 0 ? <Text style={styles.muted}>Open these chats from the Paseo sidebar.</Text> : null}
    </View>
  );
}

export function HerdrOverviewScreen({ theme, layout, navigation }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const fetchOverview = useRpc(herdrOverviewRpc);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: OVERVIEW_QUERY_KEY,
    queryFn: () => fetchOverview({}),
    refetchInterval: OVERVIEW_REFETCH_MS,
  });
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
  }, [queryClient]);
  const data = query.data;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.root}>
      <View style={styles.row}>
        <Text style={styles.title}>Herdr</Text>
        <Button label={query.isFetching ? "Refreshing…" : "Refresh"} secondary onPress={refresh} styles={styles} />
      </View>
      {query.error ? (
        <Text accessibilityRole="alert" style={styles.danger}>
          {errorMessage(query.error)}
        </Text>
      ) : null}
      {!data && !query.error ? <Text style={styles.muted}>Loading…</Text> : null}
      {data ? (
        <>
          {data.connection.status !== "connected" ? (
            <Text accessibilityRole="alert" style={styles.danger}>
              Herdr unavailable: {data.connection.error}
            </Text>
          ) : null}
          <RecentChats chats={data.chats} target={data.target} connection={data.connection} error={data.chatError} styles={styles} navigation={navigation} />
          {data.connection.status === "connected" && data.ompEnabled && navigation ? (
            <NewChatForm styles={styles} theme={theme} navigation={navigation} onCreated={refresh} />
          ) : null}
          <Text style={styles.title}>Herdr workspaces</Text>
          {data.connection.status === "connected" && data.workspaces.length === 0 ? (
            <Text style={styles.muted}>No Herdr workspaces yet.</Text>
          ) : null}
          {data.workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.workspaceId}
              workspace={workspace}
              ompEnabled={data.ompEnabled}
              theme={theme}
              styles={styles}
              navigation={navigation}
              onCreated={refresh}
            />
          ))}
          {data.connection.status === "connected" ? (
            <NewWorkspaceForm styles={styles} theme={theme} onCreated={refresh} />
          ) : null}
          <View style={styles.card}>
            <Text style={styles.title}>Connection</Text>
            {describeTarget(data.target).map((line) => (
              <Text key={line} selectable style={styles.muted}>
                {line}
              </Text>
            ))}
            {data.connection.status === "connected" ? (
              <Text style={styles.text}>
                Connected, Herdr {data.connection.version}
                {data.connection.autoStarted ? " (auto-started by Paseo)" : ""}
              </Text>
            ) : null}
            {!data.ompEnabled ? (
              <Text style={styles.muted}>OMP agents are turned off in Herdr settings, so New agent is hidden.</Text>
            ) : null}
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}
