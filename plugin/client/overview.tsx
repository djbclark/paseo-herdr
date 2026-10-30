import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { usePaseo, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Modal, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  herdrAgentRestartRpc,
  herdrChatReadyRpc,
  herdrFoldersSuggestRpc,
  herdrOverviewRpc,
  herdrWorkspaceCreateRpc,
  type OverviewAgent,
  type OverviewWorkspace,
} from "../shared/rpc.js";
import {
  agentLabel,
  archiveDuplicatesLabel,
  archiveFailureMessage,
  companionBanner,
  describeTarget,
  duplicateArchiveSkippedMessage,
  duplicateChatsToArchive,
  errorMessage,
  freshDuplicatesToArchive,
  OVERVIEW_QUERY_KEY,
  OVERVIEW_REFETCH_MS,
  statusLabel,
  statusTone,
  validateFolder,
} from "./helpers.js";
import { agentPlace } from "../shared/labels.js";
import { bindHerdrChat, createHerdrChat } from "./actions.js";
import { FolderField } from "./folder-field.js";

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
      list: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        marginTop: 4,
        maxHeight: compact ? 220 : 280,
        overflow: "hidden" as const,
      },
      option: { paddingHorizontal: 10, paddingVertical: compact ? 10 : 6, borderTopColor: c.border, borderTopWidth: 1 },
      optionLine: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8 },
      indent: { paddingLeft: compact ? 8 : 16, gap: 6 },
      warning: { color: c.statusWarning },
      agent: { gap: 6, paddingVertical: 6, borderTopColor: c.border, borderTopWidth: 1 },
      agentLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      agentMain: { flex: 1, gap: 2 },
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

/** Restart confirmation: the only destructive step, so it says exactly what happens. */
function RestartSheet({ agent, label, open, onOpenChange, onRestarted, styles }: {
  agent: OverviewAgent; label: string; open: boolean; onOpenChange(open: boolean): void; onRestarted(): void | Promise<void>; styles: Styles;
}) {
  const restart = useRpc(herdrAgentRestartRpc);
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => restart({ terminalId: agent.terminalId, paneId: agent.paneId }),
    onSuccess: () => {
      toast.show("Restarted; input is enabled", { variant: "success" });
      onOpenChange(false);
      void onRestarted();
    },
  });
  const { isPending, error, mutate } = mutation;
  const confirm = useCallback(() => {
    if (!isPending) mutate();
  }, [isPending, mutate]);
  const cancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Modal title={`Restart ${label}?`} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={styles.text}>
          {agent.harness ?? "The agent"} quits and resumes this same conversation in the same Herdr pane, which takes a few seconds. It then loads the input companion, so you can type here.
        </Text>
        <Text style={styles.muted}>Anything typed in its terminal but not sent is lost.</Text>
        <View style={styles.row}>
          <Button label={isPending ? "Restarting…" : "Restart"} disabled={isPending} onPress={confirm} styles={styles} />
          <Button label="Cancel" secondary disabled={isPending} onPress={cancel} styles={styles} />
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(error)}</Text> : null}
      </Modal.Content>
    </Modal>
  );
}

/** Less common actions for one agent. */
function MoreSheet({ agent, label, open, onOpenChange, onRestart, navigation, styles }: {
  agent: OverviewAgent; label: string; open: boolean; onOpenChange(open: boolean): void; onRestart(): void; navigation: Navigation; styles: Styles;
}) {
  const toast = useToast();
  const paseo = usePaseo();
  const { attach, cwd } = agent;
  // A Paseo terminal running `herdr agent attach` (no shell) in the Paseo workspace for the agent's folder.
  const terminal = useMutation({
    mutationFn: async () => {
      if (!attach || !cwd) throw new Error("This agent can't be opened in a terminal");
      const workspace = await paseo.workspaces.open(cwd);
      await workspace.terminals.create({ name: `Herdr: ${label}`, command: attach.command, args: attach.args });
      return workspace.id;
    },
    onSuccess: (workspaceId) => {
      onOpenChange(false);
      navigation?.openWorkspace({ workspaceId });
    },
  });
  const copy = useCallback(async () => {
    try {
      await copyText(agent.attachCommand);
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the text and use Copy.");
    }
  }, [agent.attachCommand, toast]);
  const restart = useCallback(() => {
    onOpenChange(false);
    onRestart();
  }, [onOpenChange, onRestart]);
  return (
    <Modal title={label} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={styles.muted}>{[agentPlace(agent.harness ?? agent.kind, agent.paneId), cwd].filter(Boolean).join(" · ")}</Text>
        {attach && cwd && navigation ? (
          <Button label={terminal.isPending ? "Opening…" : "Open in terminal"} secondary disabled={terminal.isPending} onPress={() => terminal.mutate()} styles={styles} />
        ) : null}
        {agent.canRestart ? <Button label="Restart agent" secondary onPress={restart} styles={styles} /> : null}
        <Text style={styles.muted}>Attach from any terminal on this computer:</Text>
        <View style={styles.row}>
          <Text selectable style={styles.text}>{agent.attachCommand}</Text>
          <Button label="Copy" secondary onPress={copy} styles={styles} />
        </View>
        {terminal.error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(terminal.error)}</Text> : null}
      </Modal.Content>
    </Modal>
  );
}

/** One live Herdr agent. Tapping it opens its Paseo chat. */
function AgentRow({ agent, theme, styles, navigation, onChanged }: {
  agent: OverviewAgent; theme: Theme; styles: Styles; navigation: Navigation; onChanged(): void;
}) {
  const toast = useToast();
  const paseo = usePaseo();
  const [more, setMore] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const { paseoAgentId, cwd } = agent;
  const label = agentLabel(agent);
  const place = agentPlace(agent.harness ?? agent.kind, agent.paneId);
  const readOnly = agent.inputReady === false;
  const idle = agent.status === "idle" || agent.status === "done";
  const ready = useRpc(herdrChatReadyRpc);
  const fetchOverview = useRpc(herdrOverviewRpc);
  // Not linked yet: create a chat bound to this running agent (no new process) and open it.
  const link = useMutation({
    mutationFn: () => bindHerdrChat(paseo, ready, agent, label),
    onSuccess: (agentId) => {
      onChanged();
      navigation?.openAgent({ agentId });
    },
  });
  // Fallback if binding fails: Paseo's own Import session lists this agent under the same name.
  const folder = useMutation({
    mutationFn: async () => {
      if (!cwd) throw new Error("This agent has no folder path");
      return (await paseo.workspaces.open(cwd)).id;
    },
    onSuccess: (workspaceId) => {
      toast.show(`In ⋯ → Import session, pick “${label}” (${place})`, { variant: "info" });
      navigation?.openWorkspace({ workspaceId });
    },
  });
  const busy = link.isPending || folder.isPending;
  const open = useCallback(() => {
    if (paseoAgentId) navigation?.openAgent({ agentId: paseoAgentId });
    else if (!busy) link.mutate();
  }, [paseoAgentId, navigation, busy, link]);
  // After a restart the old chat stays read-only (it was frozen), so open a fresh chat on the same
  // conversation and archive the old one; archived chats can be restored from Paseo's archive.
  const restarted = useCallback(async () => {
    onChanged();
    if (!paseoAgentId || !navigation) return;
    try {
      const fresh = await bindHerdrChat(paseo, ready, agent, label);
      await paseo.agents.ref(paseoAgentId).archive().catch(() => undefined);
      navigation.openAgent({ agentId: fresh });
    } catch (error) {
      toast.error(`Restarted, but couldn't reopen the chat: ${errorMessage(error)}`);
    }
  }, [onChanged, paseoAgentId, navigation, paseo, ready, agent, label, toast]);
  // Extra chats bound to this terminal make "tap an agent" ambiguous; the row's own chat is never archived.
  const duplicates = duplicateChatsToArchive(agent);
  const archiveDuplicates = useMutation({
    // The row is up to one refetch old: archive only what a fresh overview still lists as duplicates of the same owner.
    mutationFn: async () => {
      const plan = freshDuplicatesToArchive(agent, (await fetchOverview({})).workspaces);
      if (plan.skip) return { skip: plan.skip, failure: null };
      const results = await Promise.allSettled(plan.archive.map((id) => paseo.agents.ref(id).archive()));
      return { skip: null, failure: archiveFailureMessage(results) };
    },
    onSuccess: ({ skip, failure }) => {
      onChanged();
      if (skip) toast.show(duplicateArchiveSkippedMessage(skip), { variant: "info" });
      else if (failure) toast.error(failure);
    },
    onError: (error) => toast.error(`Couldn't check the chats before archiving: ${errorMessage(error)}`),
  });
  const canOpen = Boolean(navigation && (paseoAgentId || (agent.provider && cwd)));
  return (
    <View style={styles.agent}>
      <View style={styles.agentLine}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open chat ${label}`}
          disabled={!canOpen || busy}
          onPress={open}
          style={styles.agentMain}
        >
          <View style={styles.row}>
            <Text style={styles.text} numberOfLines={1}>{label}</Text>
            <StatusBadge status={agent.status} theme={theme} styles={styles} />
          </View>
          <Text style={styles.muted} numberOfLines={1}>{[place, cwd].filter(Boolean).join(" · ")}</Text>
          {!agent.provider ? <Text style={styles.muted}>No Paseo provider handles this agent kind.</Text> : null}
          {agent.provider && !paseoAgentId ? (
            <Text style={styles.muted}>{link.isPending ? "Opening a chat…" : "No chat yet: tap to open one."}</Text>
          ) : null}
        </Pressable>
        <Button label="⋯" secondary onPress={() => setMore(true)} styles={styles} />
      </View>
      {readOnly ? (
        <View style={styles.row}>
          <Text style={styles.warning}>Read-only: it started before the input companion was installed.</Text>
          {agent.canRestart && idle ? <Button label="Restart to enable input" onPress={() => setRestarting(true)} styles={styles} /> : null}
          {agent.canRestart && !idle ? <Text style={styles.muted}>Restart is available once it's idle.</Text> : null}
        </View>
      ) : null}
      {duplicates.length > 0 ? (
        <View style={styles.row}>
          <Text style={styles.muted}>More than one chat is bound to this agent.</Text>
          <Button label={archiveDuplicatesLabel(duplicates.length)} secondary disabled={archiveDuplicates.isPending} onPress={() => archiveDuplicates.mutate()} styles={styles} />
        </View>
      ) : null}
      {link.error ? (
        <View style={styles.row}>
          <Text accessibilityRole="alert" style={styles.danger}>Couldn't open a chat: {errorMessage(link.error)}</Text>
          {cwd && navigation ? <Button label="Import it instead" secondary disabled={busy} onPress={() => folder.mutate()} styles={styles} /> : null}
        </View>
      ) : null}
      {folder.error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(folder.error)}</Text> : null}
      <MoreSheet agent={agent} label={label} open={more} onOpenChange={setMore} onRestart={() => setRestarting(true)} navigation={navigation} styles={styles} />
      <RestartSheet agent={agent} label={label} open={restarting} onOpenChange={setRestarting} onRestarted={restarted} styles={styles} />
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
  const suggest = useRpc(herdrFoldersSuggestRpc);
  const mutation = useMutation({
    mutationFn: async () => {
      return createHerdrChat(paseo, cwd, async (folder) => (await suggest({ query: folder })).resolved);
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
      <FolderField
        accessibilityLabel="New chat folder path"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={cwd}
        onChangeText={setCwd}
        styles={styles}
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
  onChanged,
}: {
  workspace: OverviewWorkspace;
  ompEnabled: boolean;
  theme: Theme;
  styles: Styles;
  navigation: Navigation;
  onChanged(): void;
}) {
  const agents = workspace.tabs.flatMap((tab) => tab.agents);
  return (
    <View style={styles.card}>
      <Text style={styles.title} numberOfLines={1}>{workspace.label}</Text>
      {workspace.cwd ? <Text selectable style={styles.muted} numberOfLines={1}>{workspace.cwd}</Text> : null}
      {agents.length === 0 ? <Text style={styles.muted}>No agents running.</Text> : null}
      {agents.map((agent) => (
        <AgentRow key={agent.terminalId} agent={agent} theme={theme} styles={styles} navigation={navigation} onChanged={onChanged} />
      ))}
      {ompEnabled && workspace.cwd ? (
        <NewAgentButton cwd={workspace.cwd} styles={styles} navigation={navigation} onCreated={onChanged} />
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
      <FolderField
        accessibilityLabel="Folder path"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={cwd}
        onChangeText={setCwd}
        editable={!isPending}
        onSubmitEditing={submit}
        styles={styles}
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
  const companionNotice = data ? companionBanner(data.companion, data.ompEnabled) : null;

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
          {companionNotice ? <Text accessibilityRole="alert" style={styles.warning}>{companionNotice}</Text> : null}
          {data.connection.status !== "connected" ? (
            <Text accessibilityRole="alert" style={styles.danger}>
              Herdr unavailable: {data.connection.error}
            </Text>
          ) : null}
          {data.chatError ? (
            <Text style={styles.warning}>Couldn't check which agents already have a Paseo chat: {data.chatError}</Text>
          ) : null}
          {data.connection.status === "connected" && data.workspaces.length === 0 ? (
            <Text style={styles.muted}>No Herdr workspaces yet. Start a chat in a folder below.</Text>
          ) : null}
          {data.workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.workspaceId}
              workspace={workspace}
              ompEnabled={data.ompEnabled}
              theme={theme}
              styles={styles}
              navigation={navigation}
              onChanged={refresh}
            />
          ))}
          {data.connection.status === "connected" && data.ompEnabled && navigation ? (
            <NewChatForm styles={styles} theme={theme} navigation={navigation} onCreated={refresh} />
          ) : null}
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
