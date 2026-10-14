import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { herdrFoldersSuggestRpc } from "../shared/rpc.js";
import { FOLDER_SOURCE_LABELS, FOLDER_SUGGEST_DEBOUNCE_MS, folderFieldValue, folderSuggestKey } from "./helpers.js";

/** Subset of the overview's styles the field needs (kept structural so overview.tsx owns the theme). */
export interface FolderFieldStyles {
  input: object;
  text: object;
  muted: object;
  list: object;
  option: object;
  optionLine: object;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** A folder TextInput with daemon-side suggestions: filters as you type, fills the field when one is picked. */
export function FolderField({ value, onChangeText, accessibilityLabel, placeholderTextColor, editable, onSubmitEditing, styles }: {
  value: string;
  onChangeText(value: string): void;
  accessibilityLabel: string;
  placeholderTextColor: string;
  editable?: boolean;
  onSubmitEditing?(): void;
  styles: FolderFieldStyles;
}) {
  const suggest = useRpc(herdrFoldersSuggestRpc);
  const [focused, setFocused] = useState(false);
  const query = useDebounced(value, FOLDER_SUGGEST_DEBOUNCE_MS);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); }, []);
  const { data } = useQuery({
    queryKey: folderSuggestKey(query),
    queryFn: () => suggest({ query }),
    enabled: focused && editable !== false,
    staleTime: 5000,
    placeholderData: (previous) => previous,
  });
  const onFocus = useCallback(() => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    setFocused(true);
  }, []);
  // On web, blur fires before the row's press; rows use onPressIn and the blur hides after a short delay.
  const onBlur = useCallback(() => {
    blurTimer.current = setTimeout(() => setFocused(false), 200);
  }, []);
  const inputRef = useRef<TextInput>(null);
  // Fill the field, then return focus to it once the press's own blur has run, so the list refreshes to the
  // picked folder's children and the user can keep drilling down.
  const pick = useCallback((path: string) => {
    onChangeText(folderFieldValue(path));
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [onChangeText]);
  const folders = focused && editable !== false ? (data?.folders ?? []) : [];
  return (
    <View>
      <TextInput
        ref={inputRef}
        accessibilityLabel={accessibilityLabel}
        placeholder="Folder path"
        placeholderTextColor={placeholderTextColor}
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
        onSubmitEditing={onSubmitEditing}
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
        style={styles.input}
      />
      {folders.length > 0 ? (
        <View style={styles.list} accessibilityRole="list">
          {folders.map((folder) => {
            const source = FOLDER_SOURCE_LABELS[folder.source];
            return (
              <Pressable
                key={folder.path}
                accessibilityRole="button"
                accessibilityLabel={`Use folder ${folder.path}`}
                onPressIn={() => pick(folder.path)}
                style={styles.option}
              >
                <View style={styles.optionLine}>
                  <Text style={styles.text} numberOfLines={1}>{folder.path}</Text>
                  {source ? <Text style={styles.muted}>{source}</Text> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
