export interface Task {
  id: string;
  // QA-discovered bug (v3.2): tasks used to have no account scoping at all - every task was
  // visible regardless of which account (if any) was signed in, and account deletion never
  // touched them since they live in local IndexedDB, not Supabase, so nothing server-side could
  // reach them anyway. null means "created while signed out" - its own persistent scope, not a
  // placeholder for "unscoped."
  userId: string | null;
  title: string;
  createdAt: number;
  completedAt?: number;
  breakdown: TaskBreakdownItem[];
}

export interface TaskBreakdownItem {
  id: string;
  description: string; // e.g. "Chapter 6 of STAT231"
  completedAt?: number;
}
