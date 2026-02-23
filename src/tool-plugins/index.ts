/**
 * Tool Plugin System — Entry Point
 * 
 * Registers all built-in plugins and initializes the registry.
 */

export { ToolPlugin, ToolResult, ToolAction, SafetyTier, LLMToolSchema } from './types';
export { toolRegistry, ToolPluginRegistry } from './registry';

import { toolRegistry } from './registry';
import { gmailPlugin } from './gmail';
import { stripePlugin } from './stripe';
import { googleCalendarPlugin } from './google-calendar';

/** Register all built-in tool plugins */
export function registerBuiltinPlugins(): void {
  toolRegistry.register(gmailPlugin);
  toolRegistry.register(stripePlugin);
  toolRegistry.register(googleCalendarPlugin);
}

/** Initialize all plugins that have stored credentials */
export async function initToolPlugins(): Promise<void> {
  registerBuiltinPlugins();
  await toolRegistry.initAll();
  
  const status = toolRegistry.getStatus();
  const ready = status.filter(s => s.ready).length;
  const configured = status.filter(s => s.configured).length;
  console.log(`🔧 Tool plugins: ${status.length} registered, ${configured} configured, ${ready} ready`);
}
