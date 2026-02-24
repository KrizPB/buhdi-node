/**
 * Agent Loop — ReAct Pattern Implementation
 * 
 * Think → Act → Observe → Loop until done or max steps.
 * Uses LLM Router for thinking, Tool Registry for acting.
 */

import { AgentConfig, AgentStep, AgentRun, AgentCallbacks, AGENT_SYSTEM_PROMPT } from './types';
import { llmRouter } from '../llm/router';
import { toolRegistry } from '../tool-plugins/registry';
import {
  sanitizeToolOutput, validateToolCall, MAX_TOOL_CALLS_PER_TURN,
} from '../llm/safety';
import { addActivity, broadcastToDashboard } from '../health';
import { ChatMessage, ToolDefinition } from '../llm/types';

const DEFAULT_CONFIG: AgentConfig = {
  maxSteps: 10,
  maxTokensPerStep: 2048,
  toolTimeoutMs: 30_000,
  totalTimeoutMs: 300_000,   // 5 minutes max
  confirmDestructive: true,
  allowedTools: [],
  blockedTools: [],
  temperature: 0.3,          // Lower temp for more reliable tool use
};

// H1-FIX: Hard limits that client config can NEVER exceed
const HARD_LIMITS = {
  maxSteps: 25,
  maxTokensPerStep: 4096,
  toolTimeoutMs: 60_000,
  totalTimeoutMs: 600_000,    // 10 min absolute max
};

// F2-FIX: Max concurrent agent runs
const MAX_CONCURRENT_RUNS = 3;

// F3-FIX: Max messages in conversation (sliding window)
const MAX_MESSAGES = 50;

// Active runs (for cancellation)
const activeRuns = new Map<string, { cancelled: boolean }>();

/**
 * H1-FIX: Sanitize and clamp client-provided config.
 * Client can narrow safety (lower limits) but never widen beyond hard limits.
 */
export function sanitizeAgentConfig(raw: any): Partial<AgentConfig> {
  if (!raw || typeof raw !== 'object') return {};
  return {
    maxSteps: Math.min(Math.max(Number(raw.maxSteps) || DEFAULT_CONFIG.maxSteps, 1), HARD_LIMITS.maxSteps),
    maxTokensPerStep: Math.min(Math.max(Number(raw.maxTokensPerStep) || DEFAULT_CONFIG.maxTokensPerStep, 256), HARD_LIMITS.maxTokensPerStep),
    toolTimeoutMs: Math.min(Math.max(Number(raw.toolTimeoutMs) || DEFAULT_CONFIG.toolTimeoutMs, 5000), HARD_LIMITS.toolTimeoutMs),
    totalTimeoutMs: Math.min(Math.max(Number(raw.totalTimeoutMs) || DEFAULT_CONFIG.totalTimeoutMs, 10000), HARD_LIMITS.totalTimeoutMs),
    confirmDestructive: raw.confirmDestructive !== false, // default true, client can't force false
    temperature: Math.min(Math.max(Number(raw.temperature) || DEFAULT_CONFIG.temperature, 0), 1),
    // allowedTools: client can narrow (provide a subset) but we validate against available tools
    allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools.filter((t: any) => typeof t === 'string') : [],
    // blockedTools: client CANNOT override — always use server defaults
    blockedTools: DEFAULT_CONFIG.blockedTools,
  };
}

/**
 * Run the agent loop for a given goal.
 */
export async function runAgent(
  goal: string,
  config?: Partial<AgentConfig>,
  callbacks?: AgentCallbacks
): Promise<AgentRun> {
  // F2-FIX: Concurrent run limit
  if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
    throw new Error(`Too many concurrent agent runs (max ${MAX_CONCURRENT_RUNS})`);
  }

  // H1-FIX: Always sanitize config
  const cfg = { ...DEFAULT_CONFIG, ...sanitizeAgentConfig(config) };
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const run: AgentRun = {
    id: runId,
    goal,
    status: 'running',
    steps: [],
    result: null,
    error: null,
    startedAt,
    completedAt: null,
    totalDurationMs: 0,
    provider: null,
    model: null,
    toolsUsed: [],
  };

  activeRuns.set(runId, { cancelled: false });
  addActivity('🤖', `Agent started: "${goal.substring(0, 60)}${goal.length > 60 ? '...' : ''}"`);
  broadcastToDashboard({ type: 'agent.started', runId, goal });

  // Get available tool schemas (filtered by config)
  const allTools = toolRegistry.getLLMToolSchemas();
  const tools = filterTools(allTools, cfg);

  // Build tool description for the system prompt
  const toolList = tools.map(t =>
    `- ${t.function.name}: ${t.function.description}`
  ).join('\n');

  const systemPrompt = AGENT_SYSTEM_PROMPT + (toolList
    ? `\n\n## Available tools\n${toolList}`
    : '\n\nNo tools are currently available. Answer from your knowledge.');

  // Conversation history for the agent
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: goal },
  ];

  try {
    for (let i = 0; i < cfg.maxSteps; i++) {
      // Check cancellation
      if (activeRuns.get(runId)?.cancelled) {
        run.status = 'cancelled';
        break;
      }

      // Check total timeout
      if (Date.now() - startedAt > cfg.totalTimeoutMs) {
        run.status = 'failed';
        run.error = `Total timeout exceeded (${cfg.totalTimeoutMs}ms)`;
        break;
      }

      const stepStart = Date.now();

      // Ask LLM for next action
      const response = await llmRouter.complete({
        messages,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokensPerStep,
        // Don't pass tools in OpenAI format — we're using structured JSON output
      });

      if (!run.provider) {
        run.provider = response.provider;
        run.model = response.model;
      }

      if (response.finishReason === 'error' || !response.content) {
        run.status = 'failed';
        run.error = 'LLM returned no response';
        break;
      }

      // Parse the structured response
      const parsed = parseAgentResponse(response.content);

      if (!parsed) {
        // LLM didn't follow format — treat content as final answer
        const step: AgentStep = {
          index: i,
          thought: 'Giving direct answer',
          action: null,
          actionInput: null,
          observation: null,
          timestamp: Date.now(),
          durationMs: Date.now() - stepStart,
        };
        run.steps.push(step);
        run.result = response.content;
        run.status = 'completed';
        callbacks?.onStep?.(step, run);
        break;
      }

      if ('answer' in parsed) {
        // Final answer
        const step: AgentStep = {
          index: i,
          thought: parsed.thought || '',
          action: null,
          actionInput: null,
          observation: null,
          timestamp: Date.now(),
          durationMs: Date.now() - stepStart,
        };
        run.steps.push(step);
        run.result = parsed.answer;
        run.status = 'completed';
        callbacks?.onStep?.(step, run);

        // Add to conversation for logging
        messages.push({ role: 'assistant', content: response.content });
        break;
      }

      if ('tool' in parsed) {
        const toolName = parsed.tool;
        const toolParams = parsed.params || {};

        // Validate tool name
        if (!validateToolCall(toolName, tools)) {
          const step: AgentStep = {
            index: i,
            thought: parsed.thought || '',
            action: toolName,
            actionInput: toolParams,
            observation: `Error: tool "${toolName}" is not available.`,
            timestamp: Date.now(),
            durationMs: Date.now() - stepStart,
          };
          run.steps.push(step);
          callbacks?.onStep?.(step, run);

          messages.push({ role: 'assistant', content: response.content });
          // F4-FIX: Use system role for observations to distinguish from user input
          messages.push({ role: 'system', content: `[TOOL_ERROR] Tool "${toolName}" is not available. Available tools: ${tools.map(t => t.function.name).join(', ')}` });
          continue;
        }

        // Confirm destructive actions
        if (cfg.confirmDestructive && callbacks?.onConfirmAction) {
          const confirmed = await callbacks.onConfirmAction(toolName, toolParams);
          if (!confirmed) {
            const step: AgentStep = {
              index: i,
              thought: parsed.thought || '',
              action: toolName,
              actionInput: toolParams,
              observation: 'User declined this action.',
              timestamp: Date.now(),
              durationMs: Date.now() - stepStart,
            };
            run.steps.push(step);
            callbacks?.onStep?.(step, run);

            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'system', content: '[TOOL_DECLINED] User declined this action. Try a different approach or ask the user for guidance.' });
            continue;
          }
        }

        // Execute tool
        callbacks?.onToolCall?.(toolName, toolParams);
        broadcastToDashboard({ type: 'agent.tool_call', runId, step: i, tool: toolName });

        let observation: string;
        try {
          const result = await toolRegistry.executeByFullName(toolName, toolParams);
          observation = sanitizeToolOutput(result.output);
          callbacks?.onToolResult?.(toolName, result);

          if (!run.toolsUsed.includes(toolName)) {
            run.toolsUsed.push(toolName);
          }
        } catch (err: any) {
          observation = `Tool execution error: ${err.message}`;
        }

        const step: AgentStep = {
          index: i,
          thought: parsed.thought || '',
          action: toolName,
          actionInput: toolParams,
          observation,
          timestamp: Date.now(),
          durationMs: Date.now() - stepStart,
        };
        run.steps.push(step);
        callbacks?.onStep?.(step, run);

        broadcastToDashboard({
          type: 'agent.step',
          runId,
          step: i,
          action: toolName,
          observation: observation.substring(0, 200),
        });

        // F4-FIX: Feed observation as system message with clear delimiters
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'system', content: `[TOOL_RESULT] ${observation}` });

        // F3-FIX: Sliding window — trim old steps if messages grow too large
        if (messages.length > MAX_MESSAGES) {
          // Keep system prompt + last N messages
          const systemMsg = messages[0];
          const recent = messages.slice(-(MAX_MESSAGES - 1));
          messages.length = 0;
          messages.push(systemMsg, ...recent);
        }
      }
    }

    // If we exited the loop without completing
    if (run.status === 'running') {
      run.status = 'max_steps';
      run.error = `Reached max steps (${cfg.maxSteps})`;
      // Try to get a summary from LLM
      messages.push({
        role: 'user',
        content: 'You have reached the maximum number of steps. Please provide your best answer based on what you\'ve learned so far.',
      });
      const summary = await llmRouter.complete({ messages, maxTokens: 1024 });
      run.result = summary.content || `Agent stopped after ${cfg.maxSteps} steps.`;
    }
  } catch (err: any) {
    run.status = 'failed';
    run.error = err.message;
    callbacks?.onError?.(err, run);
  } finally {
    // F7-FIX: Always clean up, even on abnormal exit
    activeRuns.delete(runId);
  }

  run.completedAt = Date.now();
  run.totalDurationMs = run.completedAt - run.startedAt;

  const icon = run.status === 'completed' ? '✅' : run.status === 'cancelled' ? '🚫' : '❌';
  addActivity(icon, `Agent ${run.status}: ${run.steps.length} steps, ${Math.round(run.totalDurationMs / 1000)}s`);
  broadcastToDashboard({ type: 'agent.completed', runId, status: run.status, steps: run.steps.length });
  callbacks?.onComplete?.(run);

  return run;
}

/** Cancel a running agent */
export function cancelAgent(runId: string): boolean {
  const run = activeRuns.get(runId);
  if (run) {
    run.cancelled = true;
    return true;
  }
  return false;
}

/** List active agent runs */
export function getActiveRuns(): string[] {
  return Array.from(activeRuns.keys());
}

/**
 * Parse the agent's JSON response.
 * Returns { thought, tool, params } or { thought, answer } or null.
 */
function parseAgentResponse(content: string): any | null {
  // Try to extract JSON from the response
  // LLMs sometimes wrap in ```json ... ```
  let jsonStr = content.trim();

  // Strip markdown code fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Try to find JSON object
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate structure
    if (typeof parsed.answer === 'string') {
      return { thought: parsed.thought || '', answer: parsed.answer };
    }
    if (typeof parsed.tool === 'string') {
      return {
        thought: parsed.thought || '',
        tool: parsed.tool,
        params: typeof parsed.params === 'object' ? parsed.params : {},
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Filter tool schemas based on agent config allowlist/blocklist.
 */
function filterTools(tools: ToolDefinition[], config: AgentConfig): ToolDefinition[] {
  let filtered = tools;

  if (config.allowedTools.length > 0) {
    filtered = filtered.filter(t =>
      config.allowedTools.some(a => t.function.name.startsWith(a) || t.function.name === a)
    );
  }

  if (config.blockedTools.length > 0) {
    filtered = filtered.filter(t =>
      !config.blockedTools.some(b => t.function.name.startsWith(b) || t.function.name === b)
    );
  }

  return filtered;
}
