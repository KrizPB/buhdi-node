/**
 * REST API client for Buhdi Node dashboard.
 */
window.buhdiAPI = {
  // Extract auth token from URL query params
  _token: new URLSearchParams(location.search).get('token') || '',

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this._token) h['Authorization'] = `Bearer ${this._token}`;
    return h;
  },

  async get(path) {
    const res = await fetch(path, { headers: this._headers() });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },

  async put(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },

  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },

  // Convenience methods
  status()       { return this.get('/api/status'); },
  tasks()        { return this.get('/api/tasks'); },
  tools()        { return this.get('/api/tools'); },
  logs()         { return this.get('/api/logs'); },
  config()       { return this.get('/api/config'); },
  files()        { return this.get('/api/files'); },
  fileRead(name) { return this.get(`/api/files/${encodeURIComponent(name)}`); },
  fileSave(name, content) { return this.put(`/api/files/${encodeURIComponent(name)}`, { content }); },
  chatSend(message) { return this.post('/api/chat/send', { message }); },

  // LLM
  llmStatus()    { return this.get('/api/llm/status'); },

  // Credential vault
  credentials()  { return this.get('/api/credentials'); },
  credentialSave(tool, data) { return this.post(`/api/credentials/${encodeURIComponent(tool)}`, data); },
  credentialTest(tool) { return this.post(`/api/credentials/${encodeURIComponent(tool)}/test`, {}); },
  async credentialDelete(tool) {
    const res = await fetch(`/api/credentials/${encodeURIComponent(tool)}`, {
      method: 'DELETE',
      headers: this._headers(),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },

  // Memory
  memoryStatus()    { return this.get('/api/memory/status'); },
  memoryEntities(q, limit = 50) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    params.set('limit', String(limit));
    return this.get(`/api/memory/entities?${params}`);
  },
  memoryEntity(id)  { return this.get(`/api/memory/entities/${id}`); },
  memoryCreateEntity(data) { return this.post('/api/memory/entities', data); },
  memoryCreateFact(data)   { return this.post('/api/memory/facts', data); },
  memorySearch(q, limit = 10) {
    return this.get(`/api/memory/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  },
  memoryContext(q, limit = 5) {
    return this.get(`/api/memory/context?q=${encodeURIComponent(q)}&limit=${limit}`);
  },
  memoryReindex()   { return this.post('/api/memory/reindex', {}); },
  // Providers
  providersList()     { return this.get('/api/providers'); },
  providerSave(data)  { return this.post('/api/providers', data); },
  providerTest(data)  { return this.post('/api/providers/test', data); },
  providerStrategy(strategy) { return this.post('/api/providers/strategy', { strategy }); },
  async providerDelete(name) {
    const res = await fetch(`/api/providers/${encodeURIComponent(name)}`, { method: 'DELETE', headers: this._headers() });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  // Chat sessions
  chatsList()        { return this.get('/api/chats'); },
  chatCreate(title)  { return this.post('/api/chats', { title }); },
  chatMessages(id)   { return this.get(`/api/chats/${id}/messages`); },
  chatAddMessage(id, msg) { return this.post(`/api/chats/${id}/messages`, msg); },
  chatUpdate(id, data)    { return this.put(`/api/chats/${id}`, data); },
  async chatDelete(id) {
    const res = await fetch(`/api/chats/${id}`, { method: 'DELETE', headers: this._headers() });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  // Custom tools
  customTools()        { return this.get('/api/custom-tools'); },
  customToolSave(data) { return this.post('/api/custom-tools', data); },
  async customToolDelete(name) {
    const res = await fetch(`/api/custom-tools/${encodeURIComponent(name)}`, { method: 'DELETE', headers: this._headers() });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  // Wizard
  wizardStatus()     { return this.get('/api/wizard/status'); },
  wizardAutoConfig() { return this.post('/api/wizard/auto-config', {}); },

  // Scheduler
  schedulerStatus()    { return this.get('/api/scheduler/status'); },
  schedulesList()      { return this.get('/api/schedules'); },
  scheduleCreate(data) { return this.post('/api/schedules', data); },
  scheduleUpdate(id, data) { return this.put(`/api/schedules/${id}`, data); },
  scheduleRun(id)      { return this.post(`/api/schedules/${id}/run`, {}); },
  async scheduleDelete(id) {
    const res = await fetch(`/api/schedules/${id}`, { method: 'DELETE', headers: this._headers() });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },

  async memoryDeleteEntity(id) {
    const res = await fetch(`/api/memory/entities/${id}`, {
      method: 'DELETE',
      headers: this._headers(),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
};
