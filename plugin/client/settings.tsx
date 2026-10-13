import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { herdrTargetRpc } from "../shared/rpc.js";
import { herdrSettings } from "../shared/settings.js";
import { describeTarget, errorMessage, OVERVIEW_QUERY_KEY, TARGET_QUERY_KEY } from "./helpers.js";

type Ready = Extract<SettingsState<typeof herdrSettings.schema>, { status: "ready" }>;

function EffectiveTarget({ theme, version }: { theme: PluginSurfaceProps["theme"]; version: string }) {
  const fetchTarget = useRpc(herdrTargetRpc);
  const query = useQuery({ queryKey: [...TARGET_QUERY_KEY, version], queryFn: () => fetchTarget({}) });
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const fg = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const danger = useMemo(() => ({ color: theme.colors.statusDanger }), [theme]);
  return (
    <SettingsSection title="Effective target">
      <SettingsCard>
        <SettingsRow label="Herdr target">
          {query.data ? (
            <>
              {describeTarget(query.data.target).map((line) => (
                <Text key={line} selectable style={fg}>
                  {line}
                </Text>
              ))}
              {query.data.target.autoStartDisabledReason ? (
                <Text style={muted}>
                  Auto-start disabled: {query.data.target.autoStartDisabledReason}
                </Text>
              ) : null}
            </>
          ) : query.error ? (
            <Text accessibilityRole="alert" style={danger}>
              {errorMessage(query.error)}
            </Text>
          ) : (
            <Text style={muted}>Loading…</Text>
          )}
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function HerdrSettingsForm({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => ({
    session: settings.values.herdrSession,
    socket: settings.values.herdrSocketPath,
    revision: settings.revision,
  }));
  // Bumped after each save so the target query refetches.
  const [saves, setSaves] = useState(0);
  const danger = useMemo(() => ({ color: theme.colors.statusDanger }), [theme]);

  const afterSave = useCallback(() => {
    setSaves((n) => n + 1);
    void queryClient.invalidateQueries({ queryKey: TARGET_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
  }, [queryClient]);

  const toggleOmp = useCallback(
    async (enableOmp: boolean) => {
      if (await settings.save({ ...settings.values, enableOmp }, settings.revision)) afterSave();
    },
    [settings, afterSave],
  );
  const changeSession = useCallback(
    (session: string) => setDraft((d) => ({ ...d, session })),
    [],
  );
  const changeSocket = useCallback((socket: string) => setDraft((d) => ({ ...d, socket })), []);
  const save = useCallback(async () => {
    const values = {
      ...settings.values,
      herdrSession: draft.session.trim(),
      herdrSocketPath: draft.socket.trim(),
    };
    if (await settings.save(values, settings.revision)) afterSave();
  }, [settings, draft, afterSave]);

  return (
    <>
      <SettingsSection title="Herdr">
        <SettingsCard>
          <SettingsSwitch
            label="Enable OMP agents"
            hint="Off: no new OMP discovery, import or launch. Open chats keep working."
            value={settings.values.enableOmp}
            disabled={settings.saving}
            onValueChange={toggleOmp}
          />
          <SettingsInput
            label="Herdr session"
            hint="Named Herdr session; empty uses the default session."
            initialValue={draft.session}
            placeholder="default"
            disabled={settings.saving}
            onChangeText={changeSession}
          />
          <SettingsInput
            label="Herdr socket path"
            hint="Overrides the session when set."
            initialValue={draft.socket}
            placeholder="auto"
            disabled={settings.saving}
            onChangeText={changeSocket}
          />
          <SettingsAction
            label="Connection"
            actionLabel={settings.saving ? "Saving…" : "Save"}
            disabled={settings.saving}
            onPress={save}
          />
        </SettingsCard>
        {settings.saveError ? (
          <Text accessibilityRole="alert" style={danger}>
            {settings.saveError}
          </Text>
        ) : null}
      </SettingsSection>
      <EffectiveTarget theme={theme} version={String(saves)} />
    </>
  );
}

export function HerdrSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(herdrSettings);
  const fg = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={fg}>Loading settings…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Herdr">
        <Text style={fg}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  return <HerdrSettingsForm settings={settings} theme={theme} />;
}
