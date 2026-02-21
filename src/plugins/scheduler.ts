/**
 * Plugin scheduler — cron and interval-based plugin execution
 */

import cron from 'node-cron';

interface ScheduledTask {
  pluginName: string;
  schedule: string;
  task: cron.ScheduledTask | ReturnType<typeof setInterval>;
  type: 'cron' | 'interval';
}

const tasks = new Map<string, ScheduledTask>();

/**
 * Parse schedule string. Supports:
 * - Cron: "* * * * *" (5 or 6 fields)
 * - Interval: "every 5m", "every 30s", "every 1h"
 */
function parseInterval(schedule: string): number | null {
  const match = schedule.match(/^every\s+(\d+)\s*(s|m|h)$/i);
  if (!match) return null;
  const val = parseInt(match[1], 10);
  switch (match[2].toLowerCase()) {
    case 's': return val * 1000;
    case 'm': return val * 60000;
    case 'h': return val * 3600000;
    default: return null;
  }
}

export function schedulePlugin(pluginName: string, schedule: string, callback: () => void): boolean {
  // Stop existing schedule if any
  unschedulePlugin(pluginName);

  const intervalMs = parseInterval(schedule);
  if (intervalMs) {
    // HIGH: Enforce minimum interval of 60 seconds to prevent resource exhaustion
    if (intervalMs < 60000) {
      console.warn(`⚠️  Plugin ${pluginName} schedule interval too short (${intervalMs}ms), enforcing 60s minimum`);
      return false;
    }
    const handle = setInterval(callback, intervalMs);
    tasks.set(pluginName, { pluginName, schedule, task: handle, type: 'interval' });
    return true;
  }

  if (cron.validate(schedule)) {
    const task = cron.schedule(schedule, callback);
    tasks.set(pluginName, { pluginName, schedule, task, type: 'cron' });
    return true;
  }

  return false;
}

export function unschedulePlugin(pluginName: string): void {
  const existing = tasks.get(pluginName);
  if (!existing) return;

  if (existing.type === 'cron') {
    (existing.task as cron.ScheduledTask).stop();
  } else {
    clearInterval(existing.task as ReturnType<typeof setInterval>);
  }
  tasks.delete(pluginName);
}

export function unscheduleAll(): void {
  for (const name of tasks.keys()) {
    unschedulePlugin(name);
  }
}

export function getScheduledPlugins(): string[] {
  return Array.from(tasks.keys());
}
