/**
 * Scheduler Types — Local cron-like task scheduling.
 */

export type ScheduleAction =
  | { type: 'agent'; goal: string; config?: Record<string, any> }
  | { type: 'tool'; plugin: string; method: string; params?: Record<string, any> }
  | { type: 'webhook'; url: string; method?: string; headers?: Record<string, string>; body?: string }
  | { type: 'script'; command: string; cwd?: string; timeout_ms?: number };

export interface Schedule {
  id: string;
  name: string;
  cron: string;              // Standard cron expression (5 or 6 fields)
  action: ScheduleAction;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_result: string | null; // 'success' | 'error' | null
  last_error: string | null;
  run_count: number;
  max_retries: number;        // 0 = no retry
  timeout_ms: number;         // Default 30000
  notify: boolean;            // Push result to dashboard activity feed
}

export interface ScheduleCreateInput {
  name: string;
  cron: string;
  action: ScheduleAction;
  enabled?: boolean;
  max_retries?: number;
  timeout_ms?: number;
  notify?: boolean;
}

export interface ScheduleRunResult {
  schedule_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  result: 'success' | 'error';
  output: string;
  error: string | null;
}

export interface SchedulerStatus {
  running: boolean;
  schedule_count: number;
  active_count: number;
  next_runs: Array<{ id: string; name: string; next: string }>;
  total_runs: number;
}
