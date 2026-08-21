export interface Task {
  id: string;
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
