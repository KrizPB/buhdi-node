/**
 * Gmail Tool Plugin
 * 
 * Uses Gmail API v1 with OAuth2 or API key.
 * Actions: list_inbox, read_email, send_email, search
 */

import { ToolPlugin, ToolResult, SafetyTier } from './types';

// Gmail API base
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const gmailPlugin: ToolPlugin = {
  name: 'gmail',
  displayName: 'Gmail',
  description: 'Email management and automation via Gmail API',
  category: 'Communication',
  icon: '📧',
  
  credentials: [
    {
      key: 'access_token',
      label: 'Gmail OAuth Access Token',
      type: 'bearer_token',
      required: true,
      hint: 'OAuth2 access token from Google Cloud Console. Requires gmail.readonly and gmail.send scopes.',
      placeholder: 'ya29.a0AfH6SM...',
    },
  ],
  
  actions: [
    {
      name: 'list_inbox',
      description: 'List recent emails from inbox',
      safety: SafetyTier.READ,
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of emails to return', default: 10 },
          unread_only: { type: 'boolean', description: 'Only show unread emails', default: false },
        },
      },
    },
    {
      name: 'read_email',
      description: 'Read the full content of a specific email by ID',
      safety: SafetyTier.READ,
      parameters: {
        type: 'object',
        properties: {
          email_id: { type: 'string', description: 'Gmail message ID' },
        },
        required: ['email_id'],
      },
    },
    {
      name: 'search',
      description: 'Search emails using Gmail search syntax',
      safety: SafetyTier.READ,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query (e.g., "from:bob subject:invoice")' },
          limit: { type: 'number', description: 'Max results', default: 10 },
        },
        required: ['query'],
      },
    },
    {
      name: 'send_email',
      description: 'Send an email',
      safety: SafetyTier.WRITE,
      rateLimit: 10,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject' },
          body: { type: 'string', description: 'Email body (plain text)' },
          cc: { type: 'string', description: 'CC recipients (comma-separated)' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  ],

  // Internal state
  _token: '' as any,
  
  async init(credentials: Record<string, string>): Promise<boolean> {
    const token = credentials.access_token;
    if (!token) return false;
    (this as any)._token = token;
    return true;
  },
  
  async healthCheck(): Promise<boolean> {
    return !!(this as any)._token;
  },
  
  async testCredentials(): Promise<ToolResult> {
    try {
      const res = await fetch(`${GMAIL_API}/profile`, {
        headers: { Authorization: `Bearer ${(this as any)._token}` },
      });
      if (!res.ok) {
        const err = await res.text();
        return { success: false, output: `Gmail auth failed: ${res.status}`, error: err };
      }
      const profile = await res.json() as any;
      return {
        success: true,
        output: `Connected as ${profile.emailAddress} (${profile.messagesTotal} messages)`,
        data: profile,
      };
    } catch (err: any) {
      return { success: false, output: `Connection error: ${err.message}`, error: err.message };
    }
  },
  
  async execute(action: string, params: Record<string, any>): Promise<ToolResult> {
    const token = (this as any)._token;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    
    switch (action) {
      case 'list_inbox': {
        const limit = params.limit || 10;
        const q = params.unread_only ? 'is:unread' : '';
        const url = `${GMAIL_API}/messages?maxResults=${limit}${q ? '&q=' + encodeURIComponent(q) : ''}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return { success: false, output: `Failed to list inbox: ${res.status}` };
        const data = await res.json() as any;
        
        if (!data.messages?.length) {
          return { success: true, output: 'Inbox is empty', data: [] };
        }
        
        // Fetch headers for each message
        const summaries = await Promise.all(
          data.messages.slice(0, limit).map(async (m: any) => {
            const msgRes = await fetch(`${GMAIL_API}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers });
            if (!msgRes.ok) return { id: m.id, subject: '(failed to load)', from: '', date: '' };
            const msg = await msgRes.json() as any;
            const getHeader = (name: string) => msg.payload?.headers?.find((h: any) => h.name === name)?.value || '';
            return {
              id: m.id,
              from: getHeader('From'),
              subject: getHeader('Subject'),
              date: getHeader('Date'),
              snippet: msg.snippet || '',
            };
          })
        );
        
        const output = summaries.map((s: any, i: number) =>
          `${i + 1}. [${s.id}] From: ${s.from}\n   Subject: ${s.subject}\n   ${s.snippet}`
        ).join('\n\n');
        
        return { success: true, output: `${summaries.length} emails:\n\n${output}`, data: summaries };
      }
      
      case 'read_email': {
        const res = await fetch(`${GMAIL_API}/messages/${params.email_id}?format=full`, { headers });
        if (!res.ok) return { success: false, output: `Failed to read email: ${res.status}` };
        const msg = await res.json() as any;
        
        const getHeader = (name: string) => msg.payload?.headers?.find((h: any) => h.name === name)?.value || '';
        
        // Extract body
        let body = '';
        if (msg.payload?.body?.data) {
          body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf8');
        } else if (msg.payload?.parts) {
          const textPart = msg.payload.parts.find((p: any) => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64url').toString('utf8');
          }
        }
        
        const output = `From: ${getHeader('From')}\nTo: ${getHeader('To')}\nSubject: ${getHeader('Subject')}\nDate: ${getHeader('Date')}\n\n${body}`;
        return { success: true, output, data: { id: msg.id, headers: msg.payload?.headers, body } };
      }
      
      case 'search': {
        const limit = params.limit || 10;
        const url = `${GMAIL_API}/messages?maxResults=${limit}&q=${encodeURIComponent(params.query)}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return { success: false, output: `Search failed: ${res.status}` };
        const data = await res.json() as any;
        
        if (!data.messages?.length) {
          return { success: true, output: `No results for: ${params.query}`, data: [] };
        }
        
        return {
          success: true,
          output: `Found ${data.resultSizeEstimate || data.messages.length} results for "${params.query}". Message IDs: ${data.messages.map((m: any) => m.id).join(', ')}`,
          data: data.messages,
        };
      }
      
      case 'send_email': {
        // H3-FIX: Sanitize headers to prevent injection
        const sanitize = (s: string) => s.replace(/[\r\n]/g, '');
        const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRe.test(params.to)) {
          return { success: false, output: 'Invalid email address format', error: 'INVALID_EMAIL' };
        }
        if (params.cc && !params.cc.split(',').every((e: string) => emailRe.test(e.trim()))) {
          return { success: false, output: 'Invalid CC email address format', error: 'INVALID_EMAIL' };
        }

        // Build RFC 2822 message
        const lines = [
          `To: ${sanitize(params.to)}`,
          `Subject: ${sanitize(params.subject)}`,
          params.cc ? `Cc: ${sanitize(params.cc)}` : '',
          'Content-Type: text/plain; charset=utf-8',
          '',
          params.body,
        ].filter(Boolean).join('\r\n');
        
        const raw = Buffer.from(lines).toString('base64url');
        const res = await fetch(`${GMAIL_API}/messages/send`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ raw }),
        });
        
        if (!res.ok) {
          const err = await res.text();
          return { success: false, output: `Failed to send: ${res.status}`, error: err };
        }
        
        const sent = await res.json() as any;
        return {
          success: true,
          output: `Email sent to ${params.to}: "${params.subject}" (ID: ${sent.id})`,
          data: sent,
        };
      }
      
      default:
        return { success: false, output: `Unknown action: ${action}`, error: 'UNKNOWN_ACTION' };
    }
  },
} as ToolPlugin & { _token: string };
