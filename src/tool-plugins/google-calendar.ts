/**
 * Google Calendar Tool Plugin
 * 
 * Uses Google Calendar API v3 with OAuth2 token.
 * Actions: list_events, create_event, get_event, delete_event
 */

import { ToolPlugin, ToolResult, SafetyTier } from './types';

const GCAL_API = 'https://www.googleapis.com/calendar/v3';

export const googleCalendarPlugin: ToolPlugin = {
  name: 'google_calendar',
  displayName: 'Google Calendar',
  description: 'Events, scheduling, and reminders',
  category: 'Scheduling',
  icon: '📅',
  
  credentials: [
    {
      key: 'access_token',
      label: 'Google OAuth Access Token',
      type: 'bearer_token',
      required: true,
      hint: 'OAuth2 access token with calendar scope. Same flow as Gmail if using Google Cloud Console.',
      placeholder: 'ya29.a0AfH6SM...',
    },
  ],
  
  actions: [
    {
      name: 'list_events',
      description: 'List upcoming calendar events',
      safety: SafetyTier.READ,
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Number of days ahead to look', default: 7 },
          limit: { type: 'number', description: 'Max events to return', default: 10 },
          calendar_id: { type: 'string', description: 'Calendar ID (default: primary)', default: 'primary' },
        },
      },
    },
    {
      name: 'get_event',
      description: 'Get details of a specific event',
      safety: SafetyTier.READ,
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'Event ID' },
          calendar_id: { type: 'string', description: 'Calendar ID', default: 'primary' },
        },
        required: ['event_id'],
      },
    },
    {
      name: 'create_event',
      description: 'Create a new calendar event',
      safety: SafetyTier.WRITE,
      rateLimit: 10,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title/summary' },
          start: { type: 'string', description: 'Start time (ISO 8601, e.g., 2026-02-24T09:00:00-07:00)' },
          end: { type: 'string', description: 'End time (ISO 8601)' },
          description: { type: 'string', description: 'Event description/notes' },
          location: { type: 'string', description: 'Event location' },
          attendees: { type: 'string', description: 'Comma-separated email addresses' },
          calendar_id: { type: 'string', description: 'Calendar ID', default: 'primary' },
        },
        required: ['title', 'start', 'end'],
      },
    },
    {
      name: 'delete_event',
      description: 'Delete a calendar event',
      safety: SafetyTier.DELETE,
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'Event ID to delete' },
          calendar_id: { type: 'string', description: 'Calendar ID', default: 'primary' },
        },
        required: ['event_id'],
      },
    },
  ],

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
      const res = await fetch(`${GCAL_API}/calendars/primary`, {
        headers: { Authorization: `Bearer ${(this as any)._token}` },
      });
      if (!res.ok) {
        return { success: false, output: `Calendar auth failed: ${res.status}` };
      }
      const cal = await res.json() as any;
      return {
        success: true,
        output: `Connected to calendar: ${cal.summary} (${cal.timeZone})`,
        data: cal,
      };
    } catch (err: any) {
      return { success: false, output: `Connection error: ${err.message}`, error: err.message };
    }
  },
  
  async execute(action: string, params: Record<string, any>): Promise<ToolResult> {
    const token = (this as any)._token;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const calId = params.calendar_id || 'primary';
    
    switch (action) {
      case 'list_events': {
        const days = params.days || 7;
        const limit = params.limit || 10;
        const now = new Date();
        const future = new Date(now.getTime() + days * 86400000);
        
        const url = `${GCAL_API}/calendars/${encodeURIComponent(calId)}/events?` +
          `timeMin=${now.toISOString()}&timeMax=${future.toISOString()}&maxResults=${limit}` +
          `&singleEvents=true&orderBy=startTime`;
        
        const res = await fetch(url, { headers });
        if (!res.ok) return { success: false, output: `Failed to list events: ${res.status}` };
        const data = await res.json() as any;
        
        const events = (data.items || []).map((e: any) => ({
          id: e.id,
          title: e.summary || '(no title)',
          start: e.start?.dateTime || e.start?.date || '',
          end: e.end?.dateTime || e.end?.date || '',
          location: e.location || '',
          description: e.description ? e.description.substring(0, 100) : '',
        }));
        
        if (!events.length) {
          return { success: true, output: `No events in the next ${days} days`, data: [] };
        }
        
        const output = events.map((e: any, i: number) => {
          const start = new Date(e.start);
          const timeStr = e.start.includes('T')
            ? start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
          return `${i + 1}. ${timeStr} — ${e.title}${e.location ? ' @ ' + e.location : ''}`;
        }).join('\n');
        
        return { success: true, output: `${events.length} events (next ${days} days):\n\n${output}`, data: events };
      }
      
      case 'get_event': {
        const res = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(params.event_id)}`, { headers });
        if (!res.ok) return { success: false, output: `Failed: ${res.status}` };
        const e = await res.json() as any;
        
        const output = [
          `Title: ${e.summary || '(no title)'}`,
          `Start: ${e.start?.dateTime || e.start?.date}`,
          `End: ${e.end?.dateTime || e.end?.date}`,
          e.location ? `Location: ${e.location}` : '',
          e.description ? `Description: ${e.description}` : '',
          e.attendees?.length ? `Attendees: ${e.attendees.map((a: any) => `${a.email} (${a.responseStatus})`).join(', ')}` : '',
        ].filter(Boolean).join('\n');
        
        return { success: true, output, data: e };
      }
      
      case 'create_event': {
        const event: any = {
          summary: params.title,
          start: { dateTime: params.start },
          end: { dateTime: params.end },
        };
        if (params.description) event.description = params.description;
        if (params.location) event.location = params.location;
        if (params.attendees) {
          event.attendees = params.attendees.split(',').map((e: string) => ({ email: e.trim() }));
        }
        
        const res = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(calId)}/events`, {
          method: 'POST',
          headers,
          body: JSON.stringify(event),
        });
        
        if (!res.ok) {
          const err = await res.text();
          return { success: false, output: `Failed to create event: ${res.status}`, error: err };
        }
        
        const created = await res.json() as any;
        return {
          success: true,
          output: `Event created: "${params.title}"\nWhen: ${params.start} → ${params.end}${params.location ? '\nWhere: ' + params.location : ''}\nLink: ${created.htmlLink || 'N/A'}`,
          data: created,
        };
      }
      
      case 'delete_event': {
        const res = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(params.event_id)}`, {
          method: 'DELETE',
          headers,
        });
        
        if (!res.ok && res.status !== 204) {
          return { success: false, output: `Failed to delete: ${res.status}` };
        }
        
        return { success: true, output: `Event ${params.event_id} deleted` };
      }
      
      default:
        return { success: false, output: `Unknown action: ${action}`, error: 'UNKNOWN_ACTION' };
    }
  },
} as ToolPlugin & { _token: string };
