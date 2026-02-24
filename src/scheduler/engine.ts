/**
 * Scheduler Engine — Local cron-based task execution.
 * 
 * Uses node-cron for scheduling. Schedules persisted to SQLite.
 * Actions: run agent goals, execute tools, call webhooks, run scripts.
 */

import * as cron from 'node-cron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { exec as execCb } from 'child_process';
import {
  Schedule, ScheduleCreateInput, ScheduleAction,
  ScheduleRunResult, SchedulerStatus,
} from './types';

// ---- State ----
const activeTasks = new Map<string, cron.ScheduledTask>();
let schedules: Schedule[] = [];
let schedulesFile = '';
let running = false;
let totalRuns = 0;

// Activity callback for dashboard feed
let onActivity: ((emoji: string, msg: string) => void) | null = null;

// Limits
const MAX_SCHEDULES = 50;
const MIN_CRON_INTERVAL_FIELDS = true; // Reject second-level crons
let allowScripts = false; // Must be explicitly enabled in config

// ---- Init ----

export function initScheduler(configDir: string, activityCb?: (emoji: string, msg: string) => void, opts?: { allowScripts?: boolean }): void {
  schedulesFile = path.join(configDir, 'schedules.json');
  onActivity = activityCb || null;
  allowScripts = opts?.allowScripts === true;
  loadSchedules();
  startAll();
  running = true;
  console.log(`[scheduler] Initialized with ${schedules.length} schedules (${schedules.filter(s => s.enabled).length} active)`);
}

export function shutdownScheduler(): void {
  for (const [id, task] of activeTasks) {
    task.stop();
  }
  activeTasks.clear();
  running = false;
}

// ---- Persistence ----

function loadSchedules(): void {
  try {
    if (fs.existsSync(schedulesFile)) {
      schedules = JSON.parse(fs.readFileSync(schedulesFile, 'utf-8'));
    }
  } catch (err) {
    console.error('[scheduler] Failed to load schedules:', (err as Error).message);
    schedules = [];
  }
}

function saveSchedules(): void {
  try {
    const dir = path.dirname(schedulesFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(schedulesFile, JSON.stringify(schedules, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[scheduler] Failed to save schedules:', (err as Error).message);
  }
}

// ---- CRUD ----

export function createSchedule(input: ScheduleCreateInput): Schedule {
  // H2-FIX: Max schedule count
  if (schedules.length >= MAX_SCHEDULES) {
    throw new Error(`Maximum ${MAX_SCHEDULES} schedules allowed`);
  }
  // Validate cron expression
  if (!cron.validate(input.cron)) {
    throw new Error(`Invalid cron expression: "${input.cron}"`);
  }
  // H2-FIX: Reject second-level crons (6 fields = fires every second)
  const fields = input.cron.trim().split(/\s+/);
  if (fields.length > 5) {
    throw new Error('Second-level cron expressions not allowed (max 5 fields, minimum interval 1 minute)');
  }
  // Validate action type
  validateAction(input.action);

  const now = new Date().toISOString();
  const schedule: Schedule = {
    id: crypto.randomBytes(8).toString('hex'),
    name: input.name.substring(0, 200),
    cron: input.cron,
    action: input.action,
    enabled: input.enabled !== false,
    created_at: now,
    updated_at: now,
    last_run_at: null,
    last_result: null,
    last_error: null,
    run_count: 0,
    max_retries: Math.min(input.max_retries ?? 0, 5),
    timeout_ms: Math.min(input.timeout_ms ?? 30000, 300000), // Max 5 min
    notify: input.notify !== false,
  };

  schedules.push(schedule);
  saveSchedules();

  if (schedule.enabled) {
    startOne(schedule);
  }

  return schedule;
}

export function getSchedule(id: string): Schedule | null {
  return schedules.find(s => s.id === id) || null;
}

export function listSchedules(): Schedule[] {
  return [...schedules];
}

export function updateSchedule(id: string, updates: Partial<ScheduleCreateInput>): Schedule | null {
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return null;

  const schedule = schedules[idx];

  if (updates.cron !== undefined) {
    if (!cron.validate(updates.cron)) throw new Error(`Invalid cron expression: "${updates.cron}"`);
    schedule.cron = updates.cron;
  }
  if (updates.name !== undefined) schedule.name = updates.name.substring(0, 200);
  if (updates.action !== undefined) {
    validateAction(updates.action);
    schedule.action = updates.action;
  }
  if (updates.enabled !== undefined) schedule.enabled = updates.enabled;
  if (updates.max_retries !== undefined) schedule.max_retries = Math.min(updates.max_retries, 5);
  if (updates.timeout_ms !== undefined) schedule.timeout_ms = Math.min(updates.timeout_ms, 300000);
  if (updates.notify !== undefined) schedule.notify = updates.notify;

  schedule.updated_at = new Date().toISOString();
  saveSchedules();

  // Restart the cron task
  stopOne(id);
  if (schedule.enabled) startOne(schedule);

  return schedule;
}

export function deleteSchedule(id: string): boolean {
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return false;

  stopOne(id);
  schedules.splice(idx, 1);
  saveSchedules();
  return true;
}

// ---- Cron Management ----

function startAll(): void {
  for (const schedule of schedules) {
    if (schedule.enabled) {
      startOne(schedule);
    }
  }
}

function startOne(schedule: Schedule): void {
  stopOne(schedule.id); // Ensure no duplicate

  const task = cron.schedule(schedule.cron, async () => {
    await executeSchedule(schedule);
  }, { scheduled: true });

  activeTasks.set(schedule.id, task);
}

function stopOne(id: string): void {
  const task = activeTasks.get(id);
  if (task) {
    task.stop();
    activeTasks.delete(id);
  }
}

// ---- Execution ----

async function executeSchedule(schedule: Schedule, attempt = 0): Promise<ScheduleRunResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  if (schedule.notify && onActivity) {
    onActivity('⏰', `Running: ${schedule.name}`);
  }

  let output = '';
  let error: string | null = null;
  let result: 'success' | 'error' = 'success';

  try {
    output = await executeAction(schedule.action, schedule.timeout_ms);
  } catch (err: any) {
    result = 'error';
    error = err.message || String(err);

    // L2-FIX: Retry with exponential backoff (no retry for scripts)
    if (attempt < schedule.max_retries && schedule.action.type !== 'script') {
      const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
      console.log(`[scheduler] ${schedule.name} failed (attempt ${attempt + 1}/${schedule.max_retries + 1}), retrying in ${backoffMs}ms...`);
      await new Promise(r => setTimeout(r, backoffMs));
      return executeSchedule(schedule, attempt + 1);
    }
  }

  const finishedAt = new Date().toISOString();
  const duration_ms = Date.now() - startMs;

  // Update schedule state
  schedule.last_run_at = finishedAt;
  schedule.last_result = result;
  schedule.last_error = error;
  schedule.run_count++;
  totalRuns++;
  saveSchedules();

  if (schedule.notify && onActivity) {
    const emoji = result === 'success' ? '✅' : '❌';
    const msg = result === 'success'
      ? `${schedule.name} completed (${duration_ms}ms)`
      : `${schedule.name} failed: ${error?.substring(0, 100)}`;
    onActivity(emoji, msg);
  }

  return { schedule_id: schedule.id, started_at: startedAt, finished_at: finishedAt, duration_ms, result, output: output.substring(0, 4096), error };
}

async function executeAction(action: ScheduleAction, timeout_ms: number): Promise<string> {
  switch (action.type) {
    case 'agent':
      return executeAgentAction(action);
    case 'tool':
      return executeToolAction(action);
    case 'webhook':
      return executeWebhookAction(action, timeout_ms);
    case 'script':
      return executeScriptAction(action, timeout_ms);
    default:
      throw new Error(`Unknown action type: ${(action as any).type}`);
  }
}

async function executeAgentAction(action: { type: 'agent'; goal: string; config?: Record<string, any> }): Promise<string> {
  try {
    const { runAgent } = require('../agent');
    const result = await runAgent(action.goal, action.config);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err: any) {
    throw new Error(`Agent execution failed: ${err.message}`);
  }
}

async function executeToolAction(action: { type: 'tool'; plugin: string; method: string; params?: Record<string, any> }): Promise<string> {
  try {
    const { toolRegistry } = require('../tool-plugins');
    const result = await toolRegistry.executeByFullName(action.plugin, action.params || {});
    return result.output || JSON.stringify(result);
  } catch (err: any) {
    throw new Error(`Tool execution failed: ${err.message}`);
  }
}

async function executeWebhookAction(action: { type: 'webhook'; url: string; method?: string; headers?: Record<string, string>; body?: string }, timeout_ms: number): Promise<string> {
  // Security: only allow http/https
  const urlLower = action.url.toLowerCase();
  if (!urlLower.startsWith('http://') && !urlLower.startsWith('https://')) {
    throw new Error('Webhook URL must be http:// or https://');
  }
  // M1-FIX: Block private/internal IPs
  try {
    const parsed = new URL(action.url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0'
        || host.startsWith('10.') || host.startsWith('192.168.')
        || host.startsWith('169.254.') || host.startsWith('172.16.') || host.startsWith('172.17.')
        || host.startsWith('172.18.') || host.startsWith('172.19.') || host.startsWith('172.2')
        || host.startsWith('172.30.') || host.startsWith('172.31.')
        || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new Error('Webhook to private/internal addresses is blocked');
    }
  } catch (e: any) {
    if (e.message.includes('blocked')) throw e;
    throw new Error('Invalid webhook URL');
  }

  const resp = await fetch(action.url, {
    method: action.method || 'POST',
    headers: action.headers || { 'Content-Type': 'application/json' },
    body: action.body || undefined,
    signal: AbortSignal.timeout(timeout_ms),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Webhook returned ${resp.status}: ${text.substring(0, 500)}`);
  return text.substring(0, 4096);
}

async function executeScriptAction(action: { type: 'script'; command: string; cwd?: string; timeout_ms?: number }, timeout_ms: number): Promise<string> {
  // H1-FIX: Scripts require explicit opt-in via config
  if (!allowScripts) {
    throw new Error('Script execution disabled. Set scheduler.allowScripts: true in config to enable.');
  }

  // M3-FIX: Validate cwd if provided
  if (action.cwd) {
    const resolvedCwd = path.resolve(action.cwd);
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (!homeDir) throw new Error('Cannot determine home directory for cwd validation');
    if (!resolvedCwd.startsWith(homeDir)) {
      throw new Error('Script cwd must be within home directory');
    }
    if (!fs.existsSync(resolvedCwd)) {
      throw new Error(`Script cwd does not exist: ${action.cwd}`);
    }
  }

  // L1-FIX: Audit log
  console.log(`[scheduler:audit] SCRIPT EXEC: "${action.command}" cwd=${action.cwd || 'default'} at ${new Date().toISOString()}`);

  return new Promise((resolve, reject) => {
    execCb(action.command, {
      cwd: action.cwd,
      timeout: action.timeout_ms || timeout_ms,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      // L3-FIX: Strip all ANSI escape sequences
      const clean = (s: string) => s.replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b[\x40-\x5f]/g, '').substring(0, 4096);
      if (err) return reject(new Error(`Script failed: ${err.message}\n${clean(stderr)}`));
      resolve(clean(stdout));
    });
  });
}

// ---- Validation ----

function validateAction(action: ScheduleAction): void {
  if (!action || !action.type) throw new Error('Action must have a type');

  switch (action.type) {
    case 'agent':
      if (!action.goal || typeof action.goal !== 'string') throw new Error('Agent action requires a goal string');
      if (action.goal.length > 2000) throw new Error('Agent goal too long (max 2000)');
      break;
    case 'tool':
      if (!action.plugin || !action.method) throw new Error('Tool action requires plugin and method');
      break;
    case 'webhook':
      if (!action.url) throw new Error('Webhook action requires a URL');
      break;
    case 'script':
      if (!action.command) throw new Error('Script action requires a command');
      if (action.command.length > 1000) throw new Error('Script command too long (max 1000)');
      break;
    default:
      throw new Error(`Unknown action type: ${(action as any).type}`);
  }
}

// ---- Manual Run ----

export async function runScheduleNow(id: string): Promise<ScheduleRunResult> {
  const schedule = schedules.find(s => s.id === id);
  if (!schedule) throw new Error('Schedule not found');
  return executeSchedule(schedule);
}

// ---- Status ----

export function getSchedulerStatus(): SchedulerStatus {
  return {
    running,
    schedule_count: schedules.length,
    active_count: activeTasks.size,
    next_runs: schedules
      .filter(s => s.enabled)
      .map(s => ({ id: s.id, name: s.name, next: getNextRun(s.cron) }))
      .slice(0, 10),
    total_runs: totalRuns,
  };
}

function getNextRun(cronExpr: string): string {
  // Simple approximation — node-cron doesn't expose next run time directly
  // Return "scheduled" as placeholder; dashboard will show cron expression
  return cronExpr;
}
