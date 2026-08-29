import { useCallback, useEffect, useState } from "react";
import { sendMessage } from "../../infrastructure/messaging/extensionMessenger";
import type { NudgeVaultText } from "../../infrastructure/backend/nudgeVaultApi";
import type { ProducerTag } from "../../domain/rooms/producerTag";

// v4.1 Task 9: the shared "pick a nudge to send" source - every dropdown that lets a user choose
// one of their own saved nudges (written or audio) to send somewhere reads from this one hook
// instead of each re-implementing the same NUDGE_VAULT_TEXT_LIST + PRODUCER_TAG_LIST_MINE
// merge-and-sort. StudyRoomFooter.tsx (Task 7) inlined this exact merge before this hook existed -
// it's refactored in this same task to call this hook instead (see that file's own comment).
// FriendsBox.tsx (this task) is the second consumer.
//
// Deliberately NOT what NudgeVaultBox.tsx (also this task) uses for its own two lists - that box
// needs the written/audio halves kept SEPARATE (each with its own independent Delete action
// against its own backend), not merged into one picker-shaped array, so it fetches
// NUDGE_VAULT_TEXT_LIST/PRODUCER_TAG_LIST_MINE directly rather than through this hook.
export type VaultNudgeItem =
  | { kind: "written"; id: string; body: string; createdAt: number }
  | { kind: "audio"; id: string; durationMs: number; createdAt: number };

interface UseNudgeVaultItemsResult {
  items: VaultNudgeItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useNudgeVaultItems(): UseNudgeVaultItemsResult {
  const [items, setItems] = useState<VaultNudgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Both reads go through sendMessage()/messageRouter.ts - nudgeVaultApi.ts's and
  // producerTagApi.ts's own header comments both document "never imported directly by a sidepanel
  // component," so this follows that existing convention exactly (same as StudyRoomFooter.tsx's
  // pre-refactor inline version).
  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      sendMessage<{ ok: boolean; texts?: NudgeVaultText[]; error?: string }>({
        type: "NUDGE_VAULT_TEXT_LIST",
      }),
      sendMessage<{ ok: boolean; tags?: ProducerTag[]; error?: string }>({
        type: "PRODUCER_TAG_LIST_MINE",
      }),
    ])
      .then(([textsRes, tagsRes]) => {
        if (!textsRes.ok || !tagsRes.ok) {
          setError(textsRes.error ?? tagsRes.error ?? "Could not load your Nudge Vault.");
          return;
        }
        const written: VaultNudgeItem[] = (textsRes.texts ?? []).map((t) => ({
          kind: "written",
          id: t.id,
          body: t.body,
          createdAt: t.createdAt,
        }));
        const audio: VaultNudgeItem[] = (tagsRes.tags ?? []).map((t) => ({
          kind: "audio",
          id: t.id,
          durationMs: t.durationMs,
          createdAt: new Date(t.createdAt).getTime(),
        }));
        setItems([...written, ...audio].sort((a, b) => b.createdAt - a.createdAt));
      })
      .catch((err) => {
        console.error("Failed to load Nudge Vault items", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { items, loading, error, refresh };
}
