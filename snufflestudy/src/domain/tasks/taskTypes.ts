export interface Task {
  id: string;
  // null means "created while signed out" - its own persistent scope, not a placeholder for
  // "unscoped." Tasks live in local IndexedDB, not Supabase, so account deletion never touches
  // them.
  userId: string | null;
  title: string;
  createdAt: number;
  completedAt?: number;
}
