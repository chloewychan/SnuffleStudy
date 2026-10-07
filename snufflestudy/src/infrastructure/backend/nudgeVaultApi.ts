import { supabase } from "./supabaseClient";
import { requireUserId } from "./authHelpers";

// The written half of the Nudge Vault (the nudge_vault_texts table). The audio half reuses
// producer_tags directly - see producerTagApi.ts's listMine()/softDelete() - so no parallel
// "vault audio" API lives here.
//
// Every function below is a plain CRUD-shaped read/write with no DOM/live-callback coupling of
// its own, so - mirroring producerTagApi.ts/nudgeApi.ts's own convention - these are called ONLY
// from src/background/messageRouter.ts (NUDGE_VAULT_TEXT_CREATE/LIST/DELETE - see
// src/shared/messages.ts), never imported directly by any sidepanel component.

export interface NudgeVaultText {
  id: string;
  body: string;
  createdAt: number;
}

interface NudgeVaultTextRow {
  id: string;
  body: string;
  created_at: string;
}

function toNudgeVaultText(row: NudgeVaultTextRow): NudgeVaultText {
  return { id: row.id, body: row.body, createdAt: new Date(row.created_at).getTime() };
}

export async function createVaultText(body: string): Promise<NudgeVaultText> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from("nudge_vault_texts")
    .insert({ user_id: userId, body })
    .select()
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not save this nudge.");
  return toNudgeVaultText(data);
}

// RLS ("owner can manage their own vault texts") already scopes this to the caller's own rows,
// so no explicit .eq("user_id", ...) is needed here. Unlike producerTagApi.ts's listMine() - whose
// table has a separate "recipient can also read" policy branch to guard against - this table's
// FOR ALL policy has no such branch: a vault text is never shared, only ever copied into a nudges
// row at send time.
export async function listMyVaultTexts(): Promise<NudgeVaultText[]> {
  await requireUserId();
  const { data, error } = await supabase
    .from("nudge_vault_texts")
    .select()
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(toNudgeVaultText);
}

export async function deleteVaultText(id: string): Promise<void> {
  const { error, data } = await supabase.from("nudge_vault_texts").delete().eq("id", id).select();
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("That nudge is already gone.");
}
