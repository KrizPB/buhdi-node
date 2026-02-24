/**
 * Chat Persistence — Store and manage chat sessions locally.
 * 
 * Each chat has a title, message history, and metadata.
 * Persisted to a JSON file in the config directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: string;
  toolsUsed?: string[];
  provider?: string;
  model?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
  model?: string;           // Override model for this chat
  provider?: string;        // Override provider for this chat
}

interface ChatStore {
  sessions: ChatSession[];
}

let chatsFile = '';
let store: ChatStore = { sessions: [] };

export function initChats(configDir: string): void {
  chatsFile = path.join(configDir, 'chats.json');
  loadStore();
}

function loadStore(): void {
  try {
    if (fs.existsSync(chatsFile)) {
      store = JSON.parse(fs.readFileSync(chatsFile, 'utf-8'));
      if (!store.sessions) store.sessions = [];
    }
  } catch {
    store = { sessions: [] };
  }
}

function saveStore(): void {
  try {
    const dir = path.dirname(chatsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(chatsFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[chats] Failed to save:', (err as Error).message);
  }
}

// ---- CRUD ----

const MAX_CHATS = 500;

export function createChat(title?: string): ChatSession {
  if (store.sessions.length >= MAX_CHATS) {
    throw new Error(`Maximum ${MAX_CHATS} chats reached. Delete old chats to create new ones.`);
  }
  const now = new Date().toISOString();
  const session: ChatSession = {
    id: crypto.randomBytes(8).toString('hex'),
    title: title || 'New Chat',
    created_at: now,
    updated_at: now,
    messages: [],
  };
  store.sessions.unshift(session); // Newest first
  saveStore();
  return session;
}

export function listChats(): Omit<ChatSession, 'messages'>[] {
  return store.sessions.map(s => ({
    id: s.id,
    title: s.title,
    created_at: s.created_at,
    updated_at: s.updated_at,
    model: s.model,
    provider: s.provider,
    message_count: s.messages.length,
    last_message: s.messages.length > 0
      ? s.messages[s.messages.length - 1].content.substring(0, 100)
      : null,
  })) as any;
}

export function getChat(id: string): ChatSession | null {
  return store.sessions.find(s => s.id === id) || null;
}

export function updateChat(id: string, updates: { title?: string; model?: string; provider?: string }): ChatSession | null {
  const session = store.sessions.find(s => s.id === id);
  if (!session) return null;

  if (updates.title !== undefined) session.title = updates.title.substring(0, 200);
  if (updates.model !== undefined) session.model = updates.model;
  if (updates.provider !== undefined) session.provider = updates.provider;
  session.updated_at = new Date().toISOString();
  saveStore();
  return session;
}

export function deleteChat(id: string): boolean {
  const idx = store.sessions.findIndex(s => s.id === id);
  if (idx === -1) return false;
  store.sessions.splice(idx, 1);
  saveStore();
  return true;
}

export function addMessage(chatId: string, msg: ChatMessage): boolean {
  const session = store.sessions.find(s => s.id === chatId);
  if (!session) return false;
  session.messages.push(msg);
  session.updated_at = new Date().toISOString();
  // Auto-title from first user message
  if (session.title === 'New Chat' && msg.role === 'user') {
    session.title = msg.content.substring(0, 60) + (msg.content.length > 60 ? '...' : '');
  }
  saveStore();
  return true;
}

export function getChatMessages(chatId: string, limit = 100): ChatMessage[] {
  const session = store.sessions.find(s => s.id === chatId);
  if (!session) return [];
  return session.messages.slice(-limit);
}
