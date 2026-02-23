/**
 * Tool Plugin System — Type Definitions
 * 
 * Each tool plugin declares what credentials it needs, what actions it can perform,
 * and how to execute them. The LLM never sees raw credentials — it calls tools by
 * name and the executor reads credentials from the vault internally.
 */

/** Safety tier for actions — determines confirmation requirements */
export enum SafetyTier {
  READ = 'read',           // Auto-approve (list inbox, check calendar)
  WRITE = 'write',         // Configurable (send email, create event)
  DELETE = 'delete',       // Always confirm
  FINANCIAL = 'financial', // Always confirm + PIN
  ADMIN = 'admin',         // Blocked by default
}

/** JSON Schema subset for tool parameters */
export interface ParameterSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description?: string;
    default?: any;
    enum?: string[];
  }>;
  required?: string[];
}

/** A single action a tool can perform */
export interface ToolAction {
  name: string;              // 'send_email', 'list_inbox'
  description: string;       // For LLM tool calling schema
  parameters: ParameterSchema;
  safety: SafetyTier;
  rateLimit?: number;        // Max calls per minute (0 = unlimited)
}

/** Credential requirement spec */
export interface CredentialSpec {
  key: string;               // 'api_key', 'client_id', 'oauth_json'
  label: string;             // 'Gmail API Key' (shown in dashboard)
  type: 'api_key' | 'oauth_token' | 'bearer_token' | 'username_password' | 'json_blob';
  required: boolean;
  hint?: string;             // Help text
  placeholder?: string;      // Input placeholder
}

/** Result of a tool execution */
export interface ToolResult {
  success: boolean;
  output: string;            // Human-readable summary (for LLM observation)
  data?: any;                // Structured data (for programmatic use)
  error?: string;            // Error message if !success
}

/** The main tool plugin interface */
export interface ToolPlugin {
  /** Unique identifier (lowercase, underscores) */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** Short description */
  description: string;

  /** Category for grouping */
  category: string;

  /** Emoji icon */
  icon: string;

  /** What credentials this tool needs */
  credentials: CredentialSpec[];

  /** Available actions */
  actions: ToolAction[];

  /**
   * Initialize the plugin with credentials from the vault.
   * Called once when the plugin is loaded or credentials change.
   * Return false if credentials are invalid.
   */
  init(credentials: Record<string, string>): Promise<boolean>;

  /**
   * Quick health check — can this tool currently function?
   */
  healthCheck(): Promise<boolean>;

  /**
   * Execute an action with the given parameters.
   * Credentials are already loaded via init().
   */
  execute(action: string, params: Record<string, any>): Promise<ToolResult>;

  /**
   * Test the stored credentials by making a lightweight API call.
   * Returns a human-readable status message.
   */
  testCredentials(): Promise<ToolResult>;
}

/**
 * OpenAI-compatible tool schema (for LLM tool calling).
 * Generated from ToolPlugin + ToolAction definitions.
 */
export interface LLMToolSchema {
  type: 'function';
  function: {
    name: string;              // '{plugin}_{action}'
    description: string;
    parameters: ParameterSchema;
  };
}
