/**
 * myBuhdi-Node — Main App Controller
 */
(function() {
  'use strict';

  // ---- State ----
  const state = {
    connected: false,
    status: null,
    currentView: 'chat',
    chatMessages: [],
    streaming: null,
    credentials: {},
    activeChatId: null,    // Current chat session ID
    chats: [],             // Chat list
  };

  // ---- DOM refs ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ---- Navigation (top bar only now — sidebar is chat history) ----
  function bindNav() {
    $$('.top-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }
  bindNav();

  function switchView(view) {
    state.currentView = view;
    $$('.top-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));

    // Show sidebar only on chat view
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.style.display = (view === 'chat') ? 'flex' : 'none';

    if (view === 'dashboard') loadDashboard();
    if (view === 'jobs') loadJobs();
    if (view === 'tools') loadTools();
    if (view === 'memory') loadMemoryView();
    if (view === 'docs') loadDocs();
    if (view === 'editor') loadEditor();
    if (view === 'settings') loadSettings();
  }

  // ---- Chat History Sidebar ----
  async function loadChatList() {
    try {
      const result = await buhdiAPI.chatsList();
      state.chats = result.data || [];
      renderChatList();
    } catch { state.chats = []; renderChatList(); }
  }

  function renderChatList() {
    const list = document.getElementById('chat-list');
    if (!list) return;

    if (state.chats.length === 0) {
      list.innerHTML = `
        <div class="chat-list-empty">
          <div class="chat-list-empty-icon">💬</div>
          <div class="chat-list-empty-text">No chats yet</div>
          <button class="chat-list-start" id="chat-list-start-inner">Start a new chat →</button>
        </div>`;
      document.getElementById('chat-list-start-inner')?.addEventListener('click', createNewChat);
      return;
    }

    list.innerHTML = state.chats.map(c => `
      <div class="chat-card ${c.id === state.activeChatId ? 'active' : ''}" data-chat-id="${escapeHtml(c.id)}">
        <div class="chat-card-actions">
          <button class="chat-card-action-btn" data-action="delete-chat" data-chat-id="${escapeHtml(c.id)}" title="Delete">🗑</button>
        </div>
        <div class="chat-card-title" data-chat-id="${escapeHtml(c.id)}">${escapeHtml(c.title)}</div>
        <div class="chat-card-preview">${escapeHtml(c.last_message || '')}</div>
        <div class="chat-card-meta">
          <span>${c.message_count || 0} msgs</span>
          <span>${timeAgo(c.updated_at)}</span>
        </div>
      </div>
    `).join('');

    // Click to open chat
    list.querySelectorAll('.chat-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="delete-chat"]')) return;
        if (e.target.classList.contains('chat-card-title') && e.target.contentEditable === 'true') return;
        const id = card.dataset.chatId;
        openChat(id);
      });
    });

    // Click title to edit
    list.querySelectorAll('.chat-card-title').forEach(title => {
      title.addEventListener('dblclick', () => {
        title.contentEditable = 'true';
        title.focus();
        // Select all text
        const range = document.createRange();
        range.selectNodeContents(title);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      });
      title.addEventListener('blur', async () => {
        title.contentEditable = 'false';
        const id = title.dataset.chatId;
        const newTitle = title.textContent.trim();
        if (newTitle && id) {
          try { await buhdiAPI.chatUpdate(id, { title: newTitle }); } catch {}
        }
      });
      title.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
      });
    });

    // Delete buttons
    list.querySelectorAll('[data-action="delete-chat"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.chatId;
        if (!confirm('Delete this chat?')) return;
        try {
          await buhdiAPI.chatDelete(id);
          if (state.activeChatId === id) {
            state.activeChatId = null;
            document.getElementById('chat-messages').innerHTML = '';
          }
          loadChatList();
        } catch (err) { alert('Delete failed: ' + err.message); }
      });
    });
  }

  async function createNewChat() {
    try {
      const result = await buhdiAPI.chatCreate();
      const chat = result.data;
      state.activeChatId = chat.id;
      await loadChatList();
      openChat(chat.id);
      switchView('chat');
    } catch (err) { alert('Failed to create chat: ' + err.message); }
  }

  async function openChat(id) {
    state.activeChatId = id;
    renderChatList(); // Update active highlight

    // Load messages
    const messagesEl = document.getElementById('chat-messages');
    if (!messagesEl) return;
    messagesEl.innerHTML = '';

    try {
      const result = await buhdiAPI.chatMessages(id);
      const messages = result.data || [];
      for (const msg of messages) {
        addChatMessage(msg.role, msg.content, false); // false = don't persist again
      }
    } catch {}
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // Sidebar buttons
  document.getElementById('sidebar-new-chat')?.addEventListener('click', createNewChat);
  document.getElementById('chat-list-start')?.addEventListener('click', createNewChat);
  document.getElementById('sidebar-collapse')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('collapsed');
  });

  // ---- Status Updates ----
  function updateStatus(data) {
    state.status = data;
    const dot = $('.status-dot');
    const text = $('#status-text');
    const badge = $('#header-status');

    if (data.state === 'connected') {
      dot.className = 'status-dot online';
      text.textContent = 'Online';
      badge.textContent = `● Connected as ${data.nodeName || 'Node'}`;
      badge.className = 'header-badge online';
      state.connected = true;
    } else if (data.state === 'disconnected') {
      dot.className = 'status-dot offline';
      text.textContent = 'Offline';
      badge.textContent = '○ Disconnected';
      badge.className = 'header-badge offline';
      state.connected = false;
    } else {
      dot.className = 'status-dot syncing';
      text.textContent = data.state || 'Connecting';
      badge.textContent = data.state || 'Connecting...';
      badge.className = 'header-badge';
    }

    // Update sidebar info
    if (data.nodeName) $('#sidebar-node-name').textContent = data.nodeName;
    if (data.version) $('#sidebar-node-version').textContent = 'v' + data.version;
  }

  // ---- Chat ----
  const chatMessages = $('#chat-messages');
  const chatForm = $('#chat-form');
  const chatInput = $('#chat-input');
  const chatTyping = $('#chat-typing');

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;

    // Auto-create chat if none active
    if (!state.activeChatId) {
      try {
        const result = await buhdiAPI.chatCreate();
        state.activeChatId = result.data.id;
        loadChatList();
      } catch {}
    }

    addChatMessage('user', text);
    chatInput.value = '';
    chatInput.style.height = 'auto';

    // Check for agent commands
    if (text.startsWith('/agent ')) {
      const goal = text.slice(7).trim();
      if (goal && window.buhdiWS.ws?.readyState === WebSocket.OPEN) {
        addChatMessage('system', `🤖 Agent task: "${goal}"`);
        window.buhdiWS.send('agent.run', { goal });
        showTyping(true);
        return;
      }
    }

    // Build recent history for context (last 10 messages)
    const history = state.chatMessages.slice(-10).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    if (window.buhdiWS.ws?.readyState === WebSocket.OPEN) {
      window.buhdiWS.send('chat.send', { message: text, history });
    } else {
      window.buhdiAPI.chatSend(text).catch(err => {
        addChatMessage('system', `Failed to send: ${err.message}`);
      });
    }
    showTyping(true);
  });

  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.dispatchEvent(new Event('submit'));
    }
  });

  // ---- File Handling (drag-drop, paste, upload) ----
  const ALLOWED_EXTS = ['.jpg','.jpeg','.png','.gif','.webp','.pdf','.doc','.docx','.xls','.xlsx','.txt','.csv','.md'];
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  let pendingFile = null;

  const dropZone = $('#chat-drop-zone');
  const fileInput = $('#chat-file-input');
  const attachBtn = $('#chat-attach-btn');
  const pendingFileEl = $('#chat-pending-file');
  const pendingNameEl = $('#chat-pending-name');
  const pendingClearBtn = $('#chat-pending-clear');

  function handleFileSelect(file) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      alert('File type not allowed. Allowed: ' + ALLOWED_EXTS.join(', '));
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert('File too large. Max 10MB.');
      return;
    }
    pendingFile = file;
    const icon = file.type.startsWith('image/') ? '🖼️' : '📎';
    pendingNameEl.textContent = icon + ' ' + file.name;
    pendingFileEl.style.display = 'flex';
  }

  function clearPendingFile() {
    pendingFile = null;
    pendingFileEl.style.display = 'none';
    pendingNameEl.textContent = '';
    fileInput.value = '';
  }

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
  });
  pendingClearBtn.addEventListener('click', clearPendingFile);

  // Drag and drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  });

  // Paste files (images, etc)
  chatInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file') {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) handleFileSelect(file);
        return;
      }
    }
  });

  // ---- Voice Input (Speech Recognition) ----
  const micBtn = $('#chat-mic-btn');
  let listening = false;
  let recognition = null;
  let silenceTimer = null;

  function startListening() {
    const W = window;
    const SpeechRecognitionCtor = W.SpeechRecognition || W.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      alert('Speech recognition not supported in this browser.');
      return;
    }

    recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += t;
        } else {
          interim = t;
        }
      }
      chatInput.value = finalTranscript + interim;
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';

      // Auto-send after 2s of silence
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (finalTranscript.trim()) {
          recognition.stop();
          chatInput.value = finalTranscript.trim();
          chatForm.dispatchEvent(new Event('submit'));
          finalTranscript = '';
        }
      }, 2000);
    };

    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove('listening');
      chatInput.placeholder = 'Type a message...';
    };

    recognition.onerror = (event) => {
      console.warn('[Voice] Recognition error:', event?.error);
      listening = false;
      micBtn.classList.remove('listening');
      chatInput.placeholder = 'Type a message...';
    };

    recognition.start();
    listening = true;
    micBtn.classList.add('listening');
    chatInput.placeholder = 'Listening...';
  }

  function stopListening() {
    if (recognition) {
      recognition.stop();
      recognition = null;
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    listening = false;
    micBtn.classList.remove('listening');
    chatInput.placeholder = 'Type a message...';
  }

  micBtn.addEventListener('click', () => {
    if (listening) {
      stopListening();
    } else {
      startListening();
    }
  });

  function addChatMessage(role, content, persist = true, modelInfo = null) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isUser = role === 'user';
    const avatar = isUser ? '👤' : '🐻';
    const name = isUser ? 'You' : 'Buhdi';

    const msgEl = document.createElement('div');
    msgEl.className = `msg ${isUser ? 'msg-user' : 'msg-ai'}`;
    const rendered = isUser ? escapeHtml(content) : window.renderMarkdown(content);

    msgEl.innerHTML = `
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-body">
        <div class="msg-name">${name} <span class="msg-time">${time}</span></div>
        <div class="msg-content">${rendered}</div>
      </div>
    `;

    // Add model info as a separate DOM element (not injected into content)
    if (modelInfo) {
      const metaEl = document.createElement('small');
      metaEl.style.cssText = 'color:var(--text-muted);display:block;margin-top:4px;';
      metaEl.textContent = 'via ' + modelInfo;
      msgEl.querySelector('.msg-content').appendChild(metaEl);
    }

    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    state.chatMessages.push({ role, content, time });

    // Persist to backend
    if (persist && state.activeChatId) {
      buhdiAPI.chatAddMessage(state.activeChatId, { role, content, ts: new Date().toISOString() }).catch(() => {});
    }

    return msgEl;
  }

  function updateStreamingMessage(token) {
    let msgEl = document.getElementById('streaming-msg');
    if (!msgEl) {
      showTyping(false);
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      msgEl = document.createElement('div');
      msgEl.className = 'msg msg-ai';
      msgEl.id = 'streaming-msg';
      msgEl.innerHTML = `
        <div class="msg-avatar">🐻</div>
        <div class="msg-body">
          <div class="msg-name">Buhdi <span class="msg-time">${time}</span></div>
          <div class="msg-content"></div>
        </div>
      `;
      chatMessages.appendChild(msgEl);
      state.streaming = '';
    }
    state.streaming += token;
    msgEl.querySelector('.msg-content').innerHTML = window.renderMarkdown(state.streaming);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function finalizeStream(fullText) {
    const msgEl = document.getElementById('streaming-msg');
    if (msgEl) {
      msgEl.id = '';
      msgEl.querySelector('.msg-content').innerHTML = window.renderMarkdown(fullText || state.streaming);
    }
    const content = fullText || state.streaming || '';
    state.streaming = null;
    showTyping(false);
    state.chatMessages.push({ role: 'assistant', content });

    // Persist assistant message
    if (state.activeChatId && content) {
      buhdiAPI.chatAddMessage(state.activeChatId, { role: 'assistant', content, ts: new Date().toISOString() }).catch(() => {});
      loadChatList(); // Refresh sidebar (title may have auto-updated)
    }
  }

  function showTyping(show) {
    chatTyping.classList.toggle('hidden', !show);
    if (show) chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  // M3/M4-FIX: Shorthand for escaping server-provided strings in templates
  const esc = escapeHtml;

  // ---- Dashboard ----
  async function loadDashboard() {
    try {
      const data = await window.buhdiAPI.status();
      $('#dash-connection').textContent = data.state === 'connected' ? '● Online' : '○ Offline';
      $('#dash-connection').style.color = data.state === 'connected' ? 'var(--success)' : 'var(--error)';
      $('#dash-uptime').textContent = data.uptime ? `Uptime: ${formatDuration(data.uptime)}` : '—';

      if (data.memory) {
        $('#dash-memory').textContent = data.memory.entityCount || '—';
        $('#dash-memory-sub').textContent = `entities · ${data.memory.mode || 'cloud'}`;
      }
      if (data.tasks) {
        $('#dash-tasks').textContent = data.tasks.completed || 0;
        $('#dash-tasks-sub').textContent = `completed · ${data.tasks.pending || 0} pending`;
      }
      if (data.system) {
        $('#dash-system').textContent = `${data.system.os} | ${data.system.cpu} | ${data.system.ram}`;
      }
      if (data.tools) {
        const toolsEl = $('#dash-tools');
        toolsEl.innerHTML = data.tools.map(t =>
          `<span class="tool-badge ${t.available ? 'available' : 'missing'}">${t.available ? '✅' : '❌'} ${esc(t.name)}</span>`
        ).join('');
      }

      // LLM status
      try {
        const llm = await window.buhdiAPI.llmStatus();
        const llmEl = $('#dash-llm');
        if (llmEl && llm.providers) {
          llmEl.innerHTML = llm.providers.map(p => {
            const status = p.available ? '●' : '○';
            const color = p.available ? 'var(--success)' : 'var(--text-muted)';
            const latency = p.lastLatencyMs ? `${p.lastLatencyMs}ms` : '—';
            return `<div class="activity-item">
              <span style="color:${color}">${status}</span>
              <span>${esc(p.name)} (${esc(p.model)})</span>
              <span class="activity-time">${latency}</span>
              ${p.error ? `<span style="color:var(--error);font-size:11px">${esc(p.error).substring(0, 60)}</span>` : ''}
            </div>`;
          }).join('');
          if (llm.stats) {
            llmEl.innerHTML += `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">
              Requests: ${llm.stats.totalRequests || 0} · Fallbacks: ${llm.stats.totalFallbacks || 0} · Strategy: ${esc(llm.stats.strategy || 'none')}
            </div>`;
          }
        }
      } catch {}
      if (data.activity?.length) {
        $('#dash-activity').innerHTML = data.activity.map(a => `
          <div class="activity-item">
            <span class="activity-time">${esc(a.time)}</span>
            <span class="activity-icon">${esc(a.icon) || '•'}</span>
            <span class="activity-text">${esc(a.text)}</span>
          </div>
        `).join('');
      }
    } catch (err) {
      console.error('Dashboard load error:', err);
    }
  }

  // ---- Jobs & Schedules ----
  async function loadSchedules() {
    try {
      const result = await buhdiAPI.schedulesList();
      const items = result.data || [];
      const list = document.getElementById('schedules-list');
      if (!list) return;

      // Status badge
      try {
        const status = await buhdiAPI.schedulerStatus();
        const badge = document.getElementById('scheduler-status-badge');
        if (badge) badge.textContent = `${status.active_count} active / ${status.schedule_count} total`;
      } catch {}

      if (items.length === 0) {
        list.innerHTML = '<div class="activity-empty">No schedules yet.</div>';
        return;
      }

      list.innerHTML = items.map(s => `
        <div class="schedule-card" data-id="${s.id}">
          <div class="sched-status">${s.enabled ? '🟢' : '⚪'}</div>
          <div class="sched-info">
            <span class="sched-name">${escapeHtml(s.name)}</span>
            <span class="sched-cron">${escapeHtml(s.cron)}</span>
            <div class="sched-meta">
              ${s.action.type} · Runs: ${s.run_count} · Last: ${s.last_result ? (s.last_result === 'success' ? '✅' : '❌') : '—'}
              ${s.last_run_at ? ' · ' + new Date(s.last_run_at).toLocaleString() : ''}
            </div>
          </div>
          <div class="sched-actions">
            <button data-action="run" data-sched-id="${escapeHtml(s.id)}">▶ Run</button>
            <button data-action="toggle" data-sched-id="${escapeHtml(s.id)}" data-enabled="${!s.enabled}">${s.enabled ? '⏸ Pause' : '▶ Enable'}</button>
            <button data-action="delete" data-sched-id="${escapeHtml(s.id)}">🗑️</button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.warn('Failed to load schedules:', err);
    }
  }

  // M2-FIX: Event delegation for schedule actions (no inline onclick)
  document.getElementById('schedules-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.schedId;
    if (!id) return;

    try {
      if (action === 'run') {
        await buhdiAPI.scheduleRun(id);
        setTimeout(loadSchedules, 1000);
      } else if (action === 'toggle') {
        const enabled = btn.dataset.enabled === 'true';
        await buhdiAPI.scheduleUpdate(id, { enabled });
        loadSchedules();
      } else if (action === 'delete') {
        if (!confirm('Delete this schedule?')) return;
        await buhdiAPI.scheduleDelete(id);
        loadSchedules();
      }
    } catch (err) { alert(`${action} failed: ` + err.message); }
  });

  // Toggle add form
  document.getElementById('schedule-add-toggle')?.addEventListener('click', () => {
    const form = document.getElementById('schedule-add-form');
    if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });

  // Create schedule
  document.getElementById('schedule-create-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('sched-name')?.value?.trim();
    const cronExpr = document.getElementById('sched-cron')?.value?.trim();
    const actionType = document.getElementById('sched-action-type')?.value;
    const actionValue = document.getElementById('sched-action-value')?.value?.trim();

    if (!name || !cronExpr || !actionValue) return alert('Fill in all fields');

    let action;
    switch (actionType) {
      case 'agent': action = { type: 'agent', goal: actionValue }; break;
      case 'tool': action = { type: 'tool', plugin: actionValue, method: 'execute' }; break;
      case 'webhook': action = { type: 'webhook', url: actionValue }; break;
      case 'script': action = { type: 'script', command: actionValue }; break;
      default: return alert('Unknown action type');
    }

    try {
      await buhdiAPI.scheduleCreate({ name, cron: cronExpr, action });
      document.getElementById('sched-name').value = '';
      document.getElementById('sched-cron').value = '';
      document.getElementById('sched-action-value').value = '';
      document.getElementById('schedule-add-form').style.display = 'none';
      loadSchedules();
    } catch (err) {
      alert('Create failed: ' + err.message);
    }
  });

  async function loadJobs() {
    await loadSchedules();
    try {
      const data = await window.buhdiAPI.tasks();
      const runningEl = $('#jobs-running');
      const completedEl = $('#jobs-completed');

      runningEl.innerHTML = data.running?.length
        ? data.running.map(j => `
          <div class="job-card">
            <div><div class="job-name">⚡ ${esc(j.name)}</div><div class="job-meta">Started: ${esc(j.startedAt) || '—'}</div></div>
            <div class="job-status" style="color: var(--warning)">Running</div>
          </div>`).join('')
        : '<div class="activity-empty">No running tasks</div>';

      completedEl.innerHTML = data.completed?.length
        ? data.completed.map(j => `
          <div class="job-card">
            <div><div class="job-name">${j.success ? '✅' : '❌'} ${esc(j.name)}</div><div class="job-meta">${esc(j.completedAt) || '—'} · ${esc(j.duration) || '—'}</div></div>
            <div class="job-status" style="color: ${j.success ? 'var(--success)' : 'var(--error)'}">${j.success ? 'Done' : 'Failed'}</div>
          </div>`).join('')
        : '<div class="activity-empty">No completed tasks</div>';
    } catch (err) {
      console.error('Jobs load error:', err);
    }
  }

  // ---- Tools Showcase ----
  const TOOL_CATALOG = {
    'Development': {
      icon: '💻',
      tools: [
        { name: 'git', desc: 'Version control and code management', node: true },
        { name: 'npm', desc: 'Package management and builds', node: true },
        { name: 'vercel', desc: 'Web deployment and hosting', node: true },
        { name: 'docker', desc: 'Container management', node: true },
        { name: 'api_tester', desc: 'Test and monitor API endpoints', node: true },
        { name: 'aws_cli', desc: 'Amazon Web Services management', node: true },
        { name: 'database_cli', desc: 'PostgreSQL, MySQL, MongoDB management', node: true },
      ]
    },
    'Communication': {
      icon: '📧',
      tools: [
        { name: 'gmail', desc: 'Email management and automation', credType: 'api_key', credLabel: 'Gmail API Key', credHint: 'OAuth client credentials or API key from Google Cloud Console' },
        { name: 'outlook', desc: 'Email and calendar management', credType: 'api_key', credLabel: 'Microsoft App Secret', credHint: 'Azure AD app registration client secret' },
        { name: 'zoom', desc: 'Video conferencing management', credType: 'api_key', credLabel: 'Zoom JWT Token', credHint: 'Server-to-Server OAuth app credentials' },
        { name: 'ringcentral', desc: 'Business phone and messaging', credType: 'api_key' },
        { name: 'sms_campaigns', desc: 'Text message marketing', credType: 'api_key' },
      ]
    },
    'Marketing': {
      icon: '📣',
      tools: [
        { name: 'content_scheduler', desc: 'Plan and schedule social media posts' },
        { name: 'mailchimp', desc: 'Email campaigns and automation', credType: 'api_key', credLabel: 'Mailchimp API Key', credHint: 'Found in Account → Extras → API Keys' },
        { name: 'seo_analyzer', desc: 'Website optimization and keyword research' },
        { name: 'google_ads', desc: 'Search and display advertising', credType: 'api_key' },
        { name: 'meta_ads', desc: 'Facebook and Instagram advertising', credType: 'api_key' },
        { name: 'instagram', desc: 'Post content, stories, manage engagement', credType: 'api_key' },
        { name: 'facebook', desc: 'Page management, posting, and ads', credType: 'api_key' },
        { name: 'linkedin', desc: 'Professional networking and recruiting', credType: 'api_key' },
        { name: 'twitter_x', desc: 'Posting, engagement, and monitoring', credType: 'api_key', credLabel: 'X/Twitter Bearer Token' },
        { name: 'tiktok', desc: 'Short video content creation and posting', credType: 'api_key' },
        { name: 'sendgrid_email', desc: 'Transactional and marketing email', credType: 'api_key', credLabel: 'SendGrid API Key' },
      ]
    },
    'Sales & CRM': {
      icon: '🤝',
      tools: [
        { name: 'hubspot', desc: 'Marketing, sales, and service hub', credType: 'api_key', credLabel: 'HubSpot Private App Token' },
        { name: 'salesforce', desc: 'Manage leads, contacts, and opportunities', credType: 'api_key' },
        { name: 'pipedrive', desc: 'Sales pipeline management', credType: 'api_key' },
        { name: 'zoho_crm', desc: 'Customer relationship management', credType: 'api_key' },
        { name: 'lead_followup', desc: 'Automated lead tracking and reminders' },
        { name: 'proposal_generator', desc: 'Create professional proposals and quotes' },
      ]
    },
    'Scheduling': {
      icon: '📅',
      tools: [
        { name: 'google_calendar', desc: 'Events, scheduling, and reminders', credType: 'api_key' },
        { name: 'calendly', desc: 'Appointment booking', credType: 'api_key', credLabel: 'Calendly API Key' },
        { name: 'acuity', desc: 'Client booking and payments', credType: 'api_key' },
        { name: 'meeting_prep', desc: 'Agendas, reminders, and meeting notes' },
      ]
    },
    'Customer Service': {
      icon: '🎧',
      tools: [
        { name: 'zendesk', desc: 'Help desk and ticket management', credType: 'api_key', credLabel: 'Zendesk API Token' },
        { name: 'freshdesk', desc: 'Customer support platform', credType: 'api_key' },
        { name: 'intercom', desc: 'Live chat and customer messaging', credType: 'api_key' },
        { name: 'review_monitor', desc: 'Track and respond to Google, Yelp reviews' },
        { name: 'feedback_collector', desc: 'Surveys and NPS tracking' },
      ]
    },
    'Operations': {
      icon: '⚙️',
      tools: [
        { name: 'project_management', desc: 'Tasks, timelines, and collaboration' },
        { name: 'asana', desc: 'Project and task management', credType: 'api_key', credLabel: 'Asana Personal Access Token' },
        { name: 'trello', desc: 'Kanban boards and workflows', credType: 'api_key', credLabel: 'Trello API Key + Token' },
        { name: 'document_generator', desc: 'Contracts, proposals, and reports' },
        { name: 'inventory_manager', desc: 'Stock tracking and alerts' },
        { name: 'shipstation', desc: 'Shipping and order management', credType: 'api_key' },
      ]
    },
    'Accounting & Finance': {
      icon: '💰',
      tools: [
        { name: 'quickbooks', desc: 'Invoicing, expenses, and financial reports', credType: 'api_key' },
        { name: 'stripe_payments', desc: 'Payment processing and subscriptions', credType: 'api_key', credLabel: 'Stripe Secret Key', credHint: 'Starts with sk_live_ or sk_test_' },
        { name: 'square', desc: 'Point of sale and payments', credType: 'api_key' },
        { name: 'expense_tracker', desc: 'Receipt scanning and categorization' },
        { name: 'payroll', desc: 'Employee payment management' },
        { name: 'quicken', desc: 'Personal and small business finance' },
        { name: 'tax_prep', desc: 'Organize documents and estimate payments' },
      ]
    },
    'Research & Intelligence': {
      icon: '🔍',
      tools: [
        { name: 'web_search', desc: 'Research any topic instantly' },
        { name: 'web_scraper', desc: 'Extract data from websites' },
        { name: 'competitor_analysis', desc: 'Monitor competitors pricing and strategy' },
        { name: 'market_research', desc: 'Industry trends and data collection' },
        { name: 'price_monitor', desc: 'Track competitor and market pricing' },
      ]
    },
    'Design & Creative': {
      icon: '🎨',
      tools: [
        { name: 'canva', desc: 'Graphic design and templates', credType: 'api_key' },
        { name: 'image_generator', desc: 'Create visuals from descriptions' },
        { name: 'presentation_builder', desc: 'Create pitch decks and slides' },
        { name: 'brand_assets', desc: 'Logos, colors, fonts management' },
      ]
    },
    'HR & Hiring': {
      icon: '👥',
      tools: [
        { name: 'resume_screener', desc: 'Filter and rank applicants' },
        { name: 'job_poster', desc: 'Post to Indeed, LinkedIn, and job boards' },
        { name: 'onboarding', desc: 'Document generation and checklists' },
        { name: 'time_tracker', desc: 'Employee hours and attendance' },
      ]
    },
  };

  // Flatten catalog for lookups
  function getCatalogTool(toolName) {
    for (const cat of Object.values(TOOL_CATALOG)) {
      const t = cat.tools.find(t => t.name === toolName);
      if (t) return t;
    }
    return null;
  }

  async function loadTools() {
    try {
      const nodeData = await window.buhdiAPI.tools();
      const localTools = {};
      (nodeData.tools || []).forEach(t => { localTools[t.name] = t; });

      // Try to load credential status
      try {
        const credData = await window.buhdiAPI.credentials();
        state.credentials = credData.credentials || {};
      } catch (e) {
        // Credentials API may not exist yet
        state.credentials = {};
      }

      let totalTools = 0, nodeTools = 0, cloudTools = 0, activeTools = 0, configuredTools = 0;
      for (const cat of Object.values(TOOL_CATALOG)) {
        for (const t of cat.tools) {
          totalTools++;
          if (t.node) nodeTools++; else cloudTools++;
          if (localTools[t.name]?.available) activeTools++;
          if (state.credentials[t.name]) configuredTools++;
        }
      }

      $('#tools-summary').innerHTML = `
        <div class="tools-stat"><strong>${totalTools}</strong> Total Tools</div>
        <div class="tools-stat"><strong>${activeTools}</strong> Active on Node</div>
        <div class="tools-stat"><strong>${configuredTools}</strong> Configured</div>
        <div class="tools-stat"><strong>${cloudTools}</strong> Cloud Tools</div>
      `;
      $('#tools-count').textContent = `${totalTools} tools · ${configuredTools} configured`;

      const showcase = $('#tools-showcase');
      showcase.innerHTML = Object.entries(TOOL_CATALOG).map(([catName, cat]) => {
        const toolCards = cat.tools.map(t => {
          const local = localTools[t.name];
          const cred = state.credentials[t.name];
          const isNode = !!t.node;
          const isActive = local?.available;
          const isConfigured = !!cred;

          let statusText, statusClass;
          if (isConfigured) {
            statusText = '● Configured';
            statusClass = 'configured';
          } else if (isActive) {
            statusText = '● Active on this machine';
            statusClass = 'active';
          } else if (isNode) {
            statusText = 'Not installed';
            statusClass = 'unavailable';
          } else {
            statusText = 'Available via cloud';
            statusClass = 'available';
          }

          const displayName = t.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          const canConfigure = !!t.credType;
          const credBadge = isConfigured
            ? `<div class="tool-card-cred has-cred">🔒 ${cred.storageMode === 'blind_custodian' ? 'Portable' : 'Local'}</div>`
            : canConfigure
              ? `<div class="tool-card-cred">Click to configure credentials</div>`
              : '';

          return `
            <div class="tool-card" data-tool="${esc(t.name)}" ${canConfigure ? 'data-configurable="true"' : ''}>
              <div class="tool-card-icon ${isNode ? 'node-tool' : 'cloud-tool'}">
                ${isNode ? '🖥️' : '☁️'}
              </div>
              <div class="tool-card-info">
                <div class="tool-card-name">
                  ${esc(displayName)}
                  <span class="tool-type-tag ${isNode ? 'node' : 'cloud'}">${isNode ? 'NODE' : 'CLOUD'}</span>
                </div>
                <div class="tool-card-desc">${esc(t.desc)}</div>
                <div class="tool-card-status ${statusClass}">${esc(statusText)}${local?.version ? ' · v' + esc(local.version) : ''}</div>
                ${credBadge}
              </div>
            </div>
          `;
        }).join('');

        return `
          <div class="tools-category">
            <div class="tools-category-header">
              <span>${cat.icon}</span>
              <span class="tools-category-name">${catName}</span>
              <span class="tools-category-count">${cat.tools.length} tools</span>
            </div>
            <div class="tools-grid">${toolCards}</div>
          </div>
        `;
      }).join('');

      // Bind click handlers for configurable tools
      showcase.querySelectorAll('.tool-card[data-configurable]').forEach(card => {
        card.addEventListener('click', () => openCredentialModal(card.dataset.tool));
      });

    } catch (err) {
      console.error('Tools load error:', err);
      $('#tools-showcase').innerHTML = '<div class="activity-empty">Failed to load tools</div>';
    }
  }

  // ============================================
  // CREDENTIAL MODAL
  // ============================================
  const credModal = $('#cred-modal');
  const credModalBody = $('#cred-modal-body');
  const credModalTitle = $('#cred-modal-title');
  const credModalClose = $('#cred-modal-close');

  // Close handlers
  credModalClose.addEventListener('click', closeCredentialModal);
  $('.modal-backdrop').addEventListener('click', closeCredentialModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !credModal.classList.contains('hidden')) closeCredentialModal();
  });

  function closeCredentialModal() {
    credModal.classList.add('hidden');
  }

  function openCredentialModal(toolName) {
    const tool = getCatalogTool(toolName);
    if (!tool) return;

    const displayName = toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    credModalTitle.textContent = `Configure ${displayName}`;

    const cred = state.credentials[toolName];

    if (cred) {
      // Already configured — show status + update/remove
      renderConfiguredState(toolName, tool, cred);
    } else {
      // Not configured — show mode picker then form
      renderSetupFlow(toolName, tool);
    }

    credModal.classList.remove('hidden');
  }

  function renderConfiguredState(toolName, tool, cred) {
    const displayName = toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const modeLabel = cred.storageMode === 'blind_custodian' ? '🔐 Blind Custodian · Portable' : '🔒 Local Only';
    const lastUsed = cred.lastUsedAt ? new Date(cred.lastUsedAt).toLocaleDateString() : 'Never';
    const addedAt = cred.addedAt ? new Date(cred.addedAt).toLocaleDateString() : '—';

    credModalBody.innerHTML = `
      <div class="cred-configured">
        <div class="cred-configured-row">
          <span class="cred-configured-label">Status</span>
          <span class="cred-configured-value" style="color: var(--success)">✅ Active</span>
        </div>
        <div class="cred-configured-row">
          <span class="cred-configured-label">Storage</span>
          <span class="cred-configured-value">${modeLabel}</span>
        </div>
        <div class="cred-configured-row">
          <span class="cred-configured-label">Added</span>
          <span class="cred-configured-value">${addedAt}</span>
        </div>
        <div class="cred-configured-row">
          <span class="cred-configured-label">Last Used</span>
          <span class="cred-configured-value">${lastUsed}</span>
        </div>
      </div>
      <div id="cred-modal-status"></div>
      <div class="cred-actions">
        <button class="btn-outline" id="cred-test-btn">Test Connection</button>
        <button class="btn-outline" id="cred-update-btn">Update Key</button>
        <button class="btn-danger" id="cred-remove-btn">Remove</button>
      </div>
    `;

    // Test
    $('#cred-test-btn').addEventListener('click', async () => {
      const statusEl = $('#cred-modal-status');
      statusEl.innerHTML = '<div class="cred-status" style="color: var(--text-muted)">Testing...</div>';
      try {
        const res = await window.buhdiAPI.credentialTest(toolName);
        statusEl.innerHTML = `<div class="cred-status success">✅ ${res.details || 'Connection successful'}</div>`;
      } catch (err) {
        statusEl.innerHTML = `<div class="cred-status error">❌ ${err.message || 'Connection failed'}</div>`;
      }
    });

    // Update — re-render setup flow
    $('#cred-update-btn').addEventListener('click', () => {
      renderCredentialForm(toolName, tool, 'local_only');
    });

    // Remove
    $('#cred-remove-btn').addEventListener('click', async () => {
      if (!confirm(`Remove ${displayName} credentials? This cannot be undone.`)) return;
      try {
        await window.buhdiAPI.credentialDelete(toolName);
        delete state.credentials[toolName];
        closeCredentialModal();
        loadTools(); // Refresh
      } catch (err) {
        $('#cred-modal-status').innerHTML = `<div class="cred-status error">❌ ${err.message}</div>`;
      }
    });
  }

  function renderSetupFlow(toolName, tool) {
    credModalBody.innerHTML = `
      <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 16px;">
        How should Buhdi store your credentials?
      </p>
      <div class="cred-mode-picker">
        <div class="cred-mode-option selected" data-mode="local_only">
          <div class="cred-mode-title">🔒 Local Only</div>
          <div class="cred-mode-desc">
            Encrypted on this machine only. Instant setup, maximum privacy.<br>
            <span style="color: var(--warning)">⚠️ If this device is lost, you'll need to re-enter credentials.</span>
          </div>
        </div>
        <div class="cred-mode-option" data-mode="blind_custodian">
          <div class="cred-mode-title">
            🔐 Blind Custodian
            <span class="cred-mode-badge">COMING SOON</span>
          </div>
          <div class="cred-mode-desc">
            End-to-end encrypted, fully portable. Install a new node anywhere and pick up where you left off.
            We hold the box — only you have the key.
          </div>
        </div>
      </div>
      <div id="cred-form-area"></div>
    `;

    // Mode selection
    let selectedMode = 'local_only';
    credModalBody.querySelectorAll('.cred-mode-option').forEach(opt => {
      opt.addEventListener('click', () => {
        if (opt.dataset.mode === 'blind_custodian') return; // Not yet implemented
        selectedMode = opt.dataset.mode;
        credModalBody.querySelectorAll('.cred-mode-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
      });
    });

    // Render form immediately (Local Only is default)
    renderCredentialForm(toolName, tool, selectedMode);
  }

  function renderCredentialForm(toolName, tool, mode) {
    const formArea = $('#cred-form-area') || credModalBody;
    const label = tool.credLabel || 'API Key';
    const hint = tool.credHint || `Enter your ${label} for ${toolName.replace(/_/g, ' ')}`;

    const formHtml = `
      <div class="cred-form-group">
        <label>${label}</label>
        <div class="cred-input-row">
          <input type="password" class="cred-input" id="cred-key-input" placeholder="${label}" autocomplete="new-password" data-1p-ignore data-lpignore="true">
          <button class="btn-sm" id="cred-toggle-vis" title="Show/hide">👁️</button>
        </div>
        <div class="cred-hint">${hint}</div>
      </div>
      <div id="cred-form-status"></div>
      <div class="cred-actions">
        <button class="btn-outline" id="cred-cancel-btn">Cancel</button>
        <button class="btn-primary" id="cred-save-btn">Save & Test</button>
      </div>
    `;

    if ($('#cred-form-area')) {
      $('#cred-form-area').innerHTML = formHtml;
    } else {
      credModalBody.innerHTML = formHtml;
    }

    // Toggle visibility
    $('#cred-toggle-vis').addEventListener('click', () => {
      const input = $('#cred-key-input');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    // Cancel
    $('#cred-cancel-btn').addEventListener('click', closeCredentialModal);

    // Save
    $('#cred-save-btn').addEventListener('click', async () => {
      const key = $('#cred-key-input').value.trim();
      if (!key) {
        $('#cred-form-status').innerHTML = '<div class="cred-status error">Please enter a credential</div>';
        return;
      }

      const statusEl = $('#cred-form-status');
      statusEl.innerHTML = '<div class="cred-status" style="color: var(--text-muted)">Saving & testing...</div>';

      try {
        const res = await window.buhdiAPI.credentialSave(toolName, {
          credential: key,
          storageMode: mode,
          toolType: tool.credType || 'api_key',
        });

        state.credentials[toolName] = {
          storageMode: mode,
          configured: true,
          addedAt: new Date().toISOString(),
        };

        statusEl.innerHTML = `<div class="cred-status success">✅ ${res.details || 'Saved successfully!'}</div>`;

        // Auto-close after 1.5s and refresh
        setTimeout(() => {
          closeCredentialModal();
          loadTools();
        }, 1500);
      } catch (err) {
        statusEl.innerHTML = `<div class="cred-status error">❌ ${err.message || 'Failed to save'}</div>`;
      }
    });

    // Focus the input
    setTimeout(() => $('#cred-key-input')?.focus(), 100);
  }

  // ---- Memory ----
  async function loadMemoryView() {
    try {
      const status = await buhdiAPI.memoryStatus();
      const badge = document.getElementById('memory-status-badge');
      if (badge) {
        const state = status.state || 'uninitialized';
        const stateEmoji = { standalone: '🟢', dormant: '🟢', active: '🔴', recovering: '🟡' }[state] || '⚪';
        badge.textContent = `${stateEmoji} ${state}`;
        badge.className = 'header-badge';
      }

      // Cloud memory indicator
      const cloudBadge = document.getElementById('cloud-memory-badge');
      if (cloudBadge && status.cloud) {
        if (status.cloud.connected && status.cloud.sync_enabled) {
          const syncAge = status.cloud.last_sync ? Math.round((Date.now() - status.cloud.last_sync) / 60000) : null;
          const syncText = syncAge !== null ? `synced ${syncAge}m ago` : 'cached';
          cloudBadge.innerHTML = `☁️ <span style="color:#22c55e">Connected</span> to ${status.cloud.cloud_url || 'mybuhdi.com'} (${syncText})`;
          cloudBadge.style.display = '';
        } else if (status.cloud.connected) {
          cloudBadge.innerHTML = `☁️ <span style="color:#F59E0B">Key set</span> — sync disabled`;
          cloudBadge.style.display = '';
        } else {
          cloudBadge.innerHTML = `☁️ <span style="color:#6b7280">Not connected</span> — <a href="#" onclick="switchView('settings');return false" style="color:#F59E0B">Connect memory</a>`;
          cloudBadge.style.display = '';
        }
      }

      // Stats
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      set('mem-entities', status.entity_count ?? 0);
      set('mem-facts', status.fact_count ?? 0);
      set('mem-relationships', status.relationship_count ?? 0);
      set('mem-insights', status.insight_count ?? 0);
      set('mem-embeddings', status.embedding_count ?? 0);
      const sizeKB = status.db_size_bytes ? (status.db_size_bytes / 1024).toFixed(1) + ' KB' : '0 KB';
      set('mem-db-size', status.db_size_bytes > 1048576 ? (status.db_size_bytes / 1048576).toFixed(1) + ' MB' : sizeKB);

      // Load entities
      await loadMemoryEntities();
    } catch (err) {
      const badge = document.getElementById('memory-status-badge');
      if (badge) { badge.textContent = '⚪ Not initialized'; badge.className = 'header-badge'; }
    }
  }

  async function loadMemoryEntities(query) {
    try {
      const result = await buhdiAPI.memoryEntities(query, 50);
      const list = document.getElementById('memory-entities-list');
      if (!list) return;

      const entities = result.data || [];
      if (entities.length === 0) {
        list.innerHTML = '<div class="activity-empty">No entities yet. Store something via the API or chat.</div>';
        return;
      }

      list.innerHTML = entities.map(e => `
        <div class="entity-card" data-id="${e.id}">
          <span class="entity-name">${escapeHtml(e.name)}</span>
          <span class="entity-type">${escapeHtml(e.type || 'unknown')}</span>
          ${e.description ? `<div class="entity-desc">${escapeHtml(e.description)}</div>` : ''}
          <div class="entity-facts">Updated: ${new Date(e.updated_at).toLocaleDateString()}</div>
        </div>
      `).join('');

      // Click to expand entity
      list.querySelectorAll('.entity-card').forEach(card => {
        card.addEventListener('click', async () => {
          const id = card.dataset.id;
          try {
            const result = await buhdiAPI.memoryEntity(id);
            const entity = result.data;
            const facts = (entity.facts || []).map(f => `  • ${f.key}: ${f.value}`).join('\n');
            const rels = (entity.relationships || []).map(r =>
              `  • ${r.source_name || r.source_entity_id} → ${r.relationship_type} → ${r.target_name || r.target_entity_id}`
            ).join('\n');
            alert(`${entity.name} (${entity.type || 'unknown'})\n${entity.description || ''}\n\nFacts:\n${facts || '  (none)'}\n\nRelationships:\n${rels || '  (none)'}`);
          } catch (err) {
            alert('Error loading entity: ' + err.message);
          }
        });
      });
    } catch (err) {
      console.warn('Failed to load entities:', err);
    }
  }

  // Memory search
  document.getElementById('memory-search-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('memory-search-input');
    const query = input?.value?.trim();
    if (!query) return;

    const resultsDiv = document.getElementById('memory-search-results');
    if (!resultsDiv) return;
    resultsDiv.innerHTML = '<div class="activity-empty">Searching...</div>';

    try {
      const result = await buhdiAPI.memorySearch(query);
      const items = result.data || [];
      if (items.length === 0) {
        resultsDiv.innerHTML = '<div class="activity-empty">No results found.</div>';
        return;
      }
      resultsDiv.innerHTML = items.map(r => `
        <div class="search-result">
          <span class="result-score">${(r.score * 100).toFixed(0)}%</span>
          <span class="result-type">${r.type}</span>
          ${r.entity_name ? `<span class="result-entity">${escapeHtml(r.entity_name)}</span>` : ''}
          <div class="result-text">${escapeHtml(r.text)}</div>
        </div>
      `).join('');
    } catch (err) {
      resultsDiv.innerHTML = `<div class="activity-empty">Search error: ${escapeHtml(err.message)}</div>`;
    }
  });

  // Enter key for search
  document.getElementById('memory-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('memory-search-btn')?.click();
  });

  // Reindex button
  document.getElementById('memory-reindex-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('memory-reindex-btn');
    if (btn) btn.textContent = 'Reindexing...';
    try {
      const result = await buhdiAPI.memoryReindex();
      const data = result.data || result;
      alert(`Reindex complete: ${data.embedded} embeddings created (${data.errors} errors)`);
      await loadMemoryView();
    } catch (err) {
      alert('Reindex error: ' + err.message);
    } finally {
      if (btn) btn.textContent = 'Reindex';
    }
  });

  // Add entity button
  document.getElementById('entity-add-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('entity-name')?.value?.trim();
    const type = document.getElementById('entity-type')?.value;
    const description = document.getElementById('entity-description')?.value?.trim();
    if (!name) return alert('Name is required');

    try {
      await buhdiAPI.memoryCreateEntity({ name, type, description: description || undefined });
      document.getElementById('entity-name').value = '';
      document.getElementById('entity-description').value = '';
      await loadMemoryView();
    } catch (err) {
      alert('Error creating entity: ' + err.message);
    }
  });

  // ---- Docs ----
  const DOCS = {
    overview: `<h2>Overview</h2>
<p>Buhdi Node is a local AI assistant that runs on your hardware. It connects to your local LLM (Ollama), manages credentials securely, executes tools, and works while you sleep.</p>
<h3>Architecture</h3>
<p>The node runs as a background process on your machine, exposing a dashboard at <code>localhost:9847</code>. It consists of:</p>
<ul>
<li><strong>LLM Router</strong> — Routes between local (Ollama) and cloud AI providers</li>
<li><strong>Tool Plugins</strong> — Gmail, Stripe, Calendar with encrypted credential vault</li>
<li><strong>Agent Loop</strong> — ReAct pattern: Plan → Act → Observe → Reflect</li>
<li><strong>Local Memory</strong> — SQLite graph + vector embeddings for semantic search</li>
<li><strong>Scheduler</strong> — Cron-based task automation</li>
<li><strong>Credential Vault</strong> — AES-256-GCM encrypted, machine-bound keys</li>
</ul>
<h3>Modes</h3>
<ul>
<li><strong>Local Only</strong> — Everything on your machine. No cloud. Full privacy.</li>
<li><strong>Hybrid</strong> — Local AI + cloud sync via mybuhdi.com for mobile access and better models.</li>
<li><strong>Cloud + Local Arms</strong> — mybuhdi.com as brain, node as executor for local tools.</li>
</ul>`,

    config: `<h2>Configuration</h2>
<p>Config lives at <code>~/.buhdi-node/config.json</code></p>
<h3>Basic Config</h3>
<pre><code>{
  "version": 2,
  "healthPort": 9847,
  "logLevel": "info",
  "trustLevel": "approve_new"
}</code></pre>
<h3>Key Options</h3>
<ul>
<li><code>healthPort</code> — Dashboard & API port (default: 9847)</li>
<li><code>logLevel</code> — debug, info, warn, error</li>
<li><code>trustLevel</code> — approve_each, approve_new, peacock</li>
<li><code>scheduler.allowScripts</code> — Enable shell command execution (default: false)</li>
</ul>
<h3>Environment Variables</h3>
<ul>
<li><code>BUHDI_NODE_KEY</code> — API key (alternative to CLI arg)</li>
<li><code>BUHDI_NODE_CONFIG_DIR</code> — Custom config directory</li>
</ul>`,

    providers: `<h2>AI Providers</h2>
<p>Buhdi Node supports multiple AI providers simultaneously with smart routing.</p>
<h3>Adding Providers</h3>
<p>In <code>config.json</code>, add entries to the <code>llm.providers</code> array:</p>
<pre><code>{
  "llm": {
    "strategy": "local_first",
    "providers": [
      {
        "name": "ollama",
        "type": "ollama",
        "endpoint": "http://localhost:11434",
        "model": "llama3.1:8b",
        "priority": 1,
        "enabled": true
      },
      {
        "name": "openai",
        "type": "openai-compat",
        "endpoint": "https://api.openai.com/v1",
        "model": "gpt-4o",
        "apiKey": "sk-...",
        "priority": 2,
        "enabled": true
      },
      {
        "name": "anthropic",
        "type": "openai-compat",
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-sonnet-4-20250514",
        "apiKey": "sk-ant-...",
        "priority": 3,
        "enabled": true
      }
    ]
  }
}</code></pre>
<h3>Routing Strategies</h3>
<ul>
<li><code>local_first</code> — Try Ollama, fall back to cloud</li>
<li><code>cloud_first</code> — Try cloud, fall back to local</li>
<li><code>local_only</code> — Never use cloud providers</li>
<li><code>cloud_only</code> — Never use local providers</li>
<li><code>cost_optimized</code> — Prefer cheapest available provider</li>
</ul>
<h3>OAuth Tokens</h3>
<p>For providers that use OAuth (like mybuhdi.com proxy), store tokens in the credential vault via the Tools tab. API keys in config are for direct provider access.</p>`,

    memory: `<h2>Local Memory</h2>
<p>SQLite database with optional vector embeddings for semantic search.</p>
<h3>How It Works</h3>
<ul>
<li><strong>Entities</strong> — People, places, things, ideas with structured facts</li>
<li><strong>Facts</strong> — Key-value pairs attached to entities</li>
<li><strong>Relationships</strong> — Links between entities</li>
<li><strong>Insights</strong> — Learnings and observations</li>
<li><strong>Embeddings</strong> — Vector representations for semantic search (any local LLM server)</li>
</ul>
<h3>Embedding Setup</h3>
<p>The node auto-detects local AI servers for embeddings. Supported:</p>
<ul>
<li><strong>Ollama</strong> — Auto-detected on port 11434</li>
<li><strong>LM Studio</strong> — Auto-detected on port 1234</li>
<li><strong>LocalAI / llama.cpp</strong> — Auto-detected on port 8080</li>
<li><strong>Any OpenAI-compatible server</strong> — Configure manually</li>
</ul>
<pre><code>// config.json — custom embedding endpoint
{
  "memory": {
    "embedding": {
      "provider": "openai-compat",
      "endpoint": "http://localhost:1234",
      "model": "text-embedding-nomic-embed-text-v1.5"
    }
  }
}</code></pre>
<p>Without any embedding server, search falls back to text matching (still works, just not semantic).</p>
<h3>Storage</h3>
<p>Database: <code>~/.buhdi-node/memory.db</code> (SQLite WAL mode)</p>
<p>Typical size: ~50-100KB per 1,000 entities with facts.</p>`,

    tools: `<h2>Tool Plugins</h2>
<p>64 tools across 11 categories. Tools with credential requirements can be configured from the Tools tab.</p>
<h3>Built-in Plugins</h3>
<ul>
<li><strong>Gmail</strong> — Read, search, send emails</li>
<li><strong>Stripe</strong> — Query customers, invoices, balances</li>
<li><strong>Google Calendar</strong> — List, create, update events</li>
</ul>
<h3>Credentials</h3>
<p>Credentials are stored in the local vault (<code>~/.buhdi-node/credentials.enc.json</code>), encrypted with AES-256-GCM using a machine-derived key. The LLM never sees raw credentials — tools read from the vault internally.</p>
<h3>Safety Tiers</h3>
<ul>
<li><strong>READ</strong> — Auto-approved (fetch emails, list events)</li>
<li><strong>WRITE</strong> — Configurable (send email, create event)</li>
<li><strong>DELETE</strong> — Requires confirmation</li>
<li><strong>FINANCIAL</strong> — Requires confirmation + PIN</li>
<li><strong>ADMIN</strong> — Blocked by default</li>
</ul>`,

    scheduler: `<h2>Scheduler</h2>
<p>Cron-based task automation. Create schedules from the Jobs tab or API.</p>
<h3>Action Types</h3>
<ul>
<li><strong>Agent</strong> — Run an AI agent with a goal</li>
<li><strong>Tool</strong> — Execute a tool plugin directly</li>
<li><strong>Webhook</strong> — Call an HTTP endpoint</li>
<li><strong>Script</strong> — Run a shell command (requires <code>scheduler.allowScripts: true</code>)</li>
</ul>
<h3>Cron Syntax</h3>
<pre><code>┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-7)
│ │ │ │ │
* * * * *

Examples:
*/30 * * * *    Every 30 minutes
0 9 * * 1-5    9 AM weekdays
0 */2 * * *    Every 2 hours</code></pre>
<h3>Limits</h3>
<ul>
<li>Max 50 schedules</li>
<li>Minimum interval: 1 minute (no second-level crons)</li>
<li>Max timeout: 5 minutes per execution</li>
<li>Retries: max 5, with exponential backoff</li>
</ul>`,

    security: `<h2>Security</h2>
<h3>Credential Vault</h3>
<p>AES-256-GCM encryption with PBKDF2 key derivation from machine identity (hostname + username). Machine secret auto-generated at <code>~/.buhdi/machine-secret</code> with 0600 permissions.</p>
<h3>Dashboard Auth</h3>
<p>All API endpoints require a Bearer token. The token is auto-generated and shown on startup.</p>
<h3>LLM Safety</h3>
<ul>
<li>Tool calls validated against provided schemas</li>
<li>Max 5 tool calls per turn</li>
<li>Tool output sanitized and truncated (4KB max)</li>
<li>Client history filtered (user/assistant roles only)</li>
<li>Credential patterns auto-redacted from outputs</li>
</ul>
<h3>Network</h3>
<ul>
<li>SSRF protection on webhooks (private IPs blocked)</li>
<li>Ollama URL restricted to localhost</li>
<li>CORS restricted to same-origin</li>
</ul>`,

    api: `<h2>API Reference</h2>
<p>All endpoints require <code>Authorization: Bearer &lt;token&gt;</code> header.</p>
<h3>System</h3>
<pre><code>GET  /api/health         Health check
GET  /api/status          Node status
GET  /api/wizard/status   First-run detection</code></pre>
<h3>Chat</h3>
<pre><code>GET  /api/chats           List sessions
POST /api/chats           Create session
GET  /api/chats/:id/messages  Get messages
POST /api/chats/:id/messages  Add message
PUT  /api/chats/:id       Update (rename)
DEL  /api/chats/:id       Delete session
POST /api/llm/chat        Send message to LLM</code></pre>
<h3>Memory</h3>
<pre><code>GET  /api/memory/status   Stats
GET  /api/memory/entities List/search
POST /api/memory/entities Create entity
GET  /api/memory/search?q=... Semantic search
GET  /api/memory/context?q=... Context search</code></pre>
<h3>Scheduler</h3>
<pre><code>GET  /api/schedules       List all
POST /api/schedules       Create
PUT  /api/schedules/:id   Update
DEL  /api/schedules/:id   Delete
POST /api/schedules/:id/run  Manual trigger</code></pre>
<h3>Credentials</h3>
<pre><code>GET  /api/credentials       List configured
POST /api/credentials/:tool Save credential
DEL  /api/credentials/:tool Remove</code></pre>`,
  };

  function loadDocs(section) {
    const content = document.getElementById('docs-content');
    if (!content) return;
    const doc = section || 'overview';
    content.innerHTML = DOCS[doc] || '<p>Section not found.</p>';

    $$('.docs-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.doc === doc));
  }

  // Docs nav
  document.querySelector('.docs-nav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.docs-nav-btn');
    if (btn) loadDocs(btn.dataset.doc);
  });

  // ---- Editor ----
  let currentFile = null;
  let originalContent = '';

  async function loadEditor() {
    try {
      const data = await window.buhdiAPI.files();
      const filesEl = $('#editor-files');
      if (data.files?.length) {
        filesEl.innerHTML = data.files.map(f =>
          `<div class="file-item" data-file="${f.name}">${f.name}</div>`
        ).join('');
        filesEl.querySelectorAll('.file-item').forEach(item => {
          item.addEventListener('click', () => openFile(item.dataset.file));
        });
      } else {
        filesEl.innerHTML = '<div class="activity-empty">No config files</div>';
      }
    } catch (err) {
      console.error('Editor load error:', err);
    }
  }

  async function openFile(name) {
    try {
      const data = await window.buhdiAPI.fileRead(name);
      currentFile = name;
      originalContent = data.content || '';
      $$('.file-item').forEach(f => f.classList.toggle('active', f.dataset.file === name));
      $('#editor-empty').classList.add('hidden');
      $('#editor-content').classList.remove('hidden');
      $('#editor-actions').classList.remove('hidden');
      $('#editor-content').value = originalContent;
      $('#editor-status').textContent = '';
    } catch (err) {
      console.error('File open error:', err);
    }
  }

  $('#editor-save')?.addEventListener('click', async () => {
    if (!currentFile) return;
    try {
      await window.buhdiAPI.fileSave(currentFile, $('#editor-content').value);
      originalContent = $('#editor-content').value;
      $('#editor-status').textContent = 'Saved ✓';
      setTimeout(() => { $('#editor-status').textContent = ''; }, 2000);
    } catch (err) {
      $('#editor-status').textContent = `Error: ${err.message}`;
    }
  });

  // ---- Settings ----
  async function loadSettings() {
    // Load node info
    try {
      const data = await window.buhdiAPI.status();
      if (data.config) {
        $('#settings-apikey').textContent = data.config.apiKeyMasked || '●●●●●●●●●●';
        $('#settings-port').textContent = data.config.healthPort || '—';
      }
      $('#settings-nodename').textContent = data.nodeName || '—';
      $('#settings-version').textContent = data.version || '—';
      $('#settings-platform').textContent = data.system?.os || '—';
    } catch {}

    // Load providers
    await loadProviders();
  }

  async function loadProviders() {
    try {
      const result = await buhdiAPI.providersList();
      const providers = result.data || [];
      const strategy = result.strategy || 'local_first';
      const list = document.getElementById('provider-list');

      // Set strategy dropdown
      const stratSelect = document.getElementById('routing-strategy');
      if (stratSelect) stratSelect.value = strategy;

      if (!list) return;
      if (providers.length === 0) {
        list.innerHTML = '<div class="activity-empty">No providers configured. Add one to start chatting.</div>';
        return;
      }

      list.innerHTML = providers.map(p => `
        <div class="provider-card" data-name="${escapeHtml(p.name)}">
          <div class="prov-status">${p.enabled ? (p.type === 'ollama' ? '🦙' : '☁️') : '⚪'}</div>
          <div class="prov-info">
            <div class="prov-name">${escapeHtml(p.name)}</div>
            <div class="prov-model">${escapeHtml(p.model)}</div>
            <div class="prov-detail">${escapeHtml(p.endpoint)} · Priority ${p.priority} · ${p.hasToken ? '🔑 Token set' : '🔓 No token'} · ${escapeHtml(p.authType || 'bearer')}</div>
          </div>
          <div class="prov-actions">
            <button data-action="test-prov" data-prov-name="${escapeHtml(p.name)}">🧪 Test</button>
            <button data-action="edit-prov" data-prov-name="${escapeHtml(p.name)}">✏️</button>
            <button data-action="delete-prov" data-prov-name="${escapeHtml(p.name)}">🗑️</button>
          </div>
        </div>
      `).join('');

      // Event delegation for provider actions (clone to remove old listeners)
      const newList = list.cloneNode(true);
      list.parentNode.replaceChild(newList, list);
      newList.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const name = btn.dataset.provName;

        if (action === 'delete-prov') {
          if (!confirm(`Delete provider "${name}"?`)) return;
          try { await buhdiAPI.providerDelete(name); loadProviders(); } catch (err) { alert(err.message); }
        } else if (action === 'edit-prov') {
          // Pre-fill form with provider data
          const prov = providers.find(p => p.name === name);
          if (prov) {
            document.getElementById('prov-name').value = prov.name;
            document.getElementById('prov-type').value = prov.type || 'openai-compat';
            document.getElementById('prov-endpoint').value = prov.endpoint;
            document.getElementById('prov-model').value = prov.model;
            document.getElementById('prov-token').value = '';
            document.getElementById('prov-token').placeholder = prov.hasToken ? '(token set — leave blank to keep)' : 'Enter token';
            document.getElementById('prov-auth-type').value = prov.authType || 'bearer';
            document.getElementById('prov-priority').value = prov.priority || 1;
            document.getElementById('prov-context').value = prov.maxContext || 8192;
            document.getElementById('provider-form').style.display = 'block';
          }
        } else if (action === 'test-prov') {
          const prov = providers.find(p => p.name === name);
          if (!prov) return;
          btn.textContent = '⏳';
          try {
            const result = await buhdiAPI.providerTest({
              type: prov.type, endpoint: prov.endpoint, model: prov.model,
              authType: prov.authType
              // Token comes from server-side config
            });
            btn.textContent = result.ok ? '✅' : '❌';
            setTimeout(() => { btn.textContent = '🧪 Test'; }, 3000);
          } catch { btn.textContent = '❌'; setTimeout(() => { btn.textContent = '🧪 Test'; }, 3000); }
        }
      });
    } catch (err) {
      console.warn('Failed to load providers:', err);
    }
  }

  // Provider form controls
  document.getElementById('provider-add-btn')?.addEventListener('click', () => {
    // Reset form
    ['prov-name', 'prov-endpoint', 'prov-model', 'prov-token'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('prov-token').placeholder = 'sk-... or Bearer token';
    document.getElementById('prov-type').value = 'openai-compat';
    document.getElementById('prov-auth-type').value = 'bearer';
    document.getElementById('prov-priority').value = '1';
    document.getElementById('prov-context').value = '8192';
    document.getElementById('provider-form').style.display = 'block';
    document.getElementById('prov-test-result').style.display = 'none';
  });

  document.getElementById('prov-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('provider-form').style.display = 'none';
  });

  // Provider type change — auto-fill smart defaults
  document.getElementById('prov-type')?.addEventListener('change', (e) => {
    const type = e.target.value;
    const endpoint = document.getElementById('prov-endpoint');
    const model = document.getElementById('prov-model');
    const authField = document.getElementById('prov-auth-type')?.closest('.form-field');
    const name = document.getElementById('prov-name');
    
    if (type === 'anthropic') {
      if (!endpoint.value) endpoint.value = 'https://api.anthropic.com';
      if (!model.value) model.value = 'claude-sonnet-4-20250514';
      if (!name.value) name.value = 'Anthropic';
      // Hide auth header dropdown — Anthropic auto-detects OAuth vs API key
      if (authField) authField.style.display = 'none';
      document.getElementById('prov-token').placeholder = 'sk-ant-... (API key or OAuth token)';
    } else if (type === 'ollama') {
      if (!endpoint.value) endpoint.value = 'http://localhost:11434';
      if (!name.value) name.value = 'Ollama';
      if (authField) authField.style.display = 'none';
    } else {
      if (authField) authField.style.display = '';
      document.getElementById('prov-token').placeholder = 'sk-... or Bearer token';
    }
  });

  // Custom header toggle
  document.getElementById('prov-auth-type')?.addEventListener('change', (e) => {
    const row = document.getElementById('prov-custom-header-row');
    if (row) row.style.display = e.target.value === 'custom' ? 'flex' : 'none';
  });

  // Test provider
  document.getElementById('prov-test-btn')?.addEventListener('click', async () => {
    const resultDiv = document.getElementById('prov-test-result');
    resultDiv.style.display = 'block';
    resultDiv.className = 'provider-test-result';
    resultDiv.textContent = '⏳ Testing connection...';

    try {
      const result = await buhdiAPI.providerTest({
        type: document.getElementById('prov-type').value,
        endpoint: document.getElementById('prov-endpoint').value,
        model: document.getElementById('prov-model').value,
        token: document.getElementById('prov-token').value,
        authType: document.getElementById('prov-auth-type').value,
        customHeader: document.getElementById('prov-custom-header')?.value,
      });

      if (result.ok) {
        resultDiv.className = 'provider-test-result success';
        resultDiv.textContent = `✅ Connected! Response: "${result.response}"`;
      } else {
        resultDiv.className = 'provider-test-result error';
        resultDiv.textContent = `❌ ${result.error}`;
      }
    } catch (err) {
      resultDiv.className = 'provider-test-result error';
      resultDiv.textContent = `❌ ${err.message}`;
    }
  });

  // Save provider
  document.getElementById('prov-save-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('prov-name').value.trim();
    const endpoint = document.getElementById('prov-endpoint').value.trim();
    const model = document.getElementById('prov-model').value.trim();
    if (!name || !endpoint || !model) return alert('Name, endpoint, and model are required');

    try {
      await buhdiAPI.providerSave({
        name,
        type: document.getElementById('prov-type').value,
        endpoint,
        model,
        token: document.getElementById('prov-token').value || undefined,
        authType: document.getElementById('prov-auth-type').value,
        customHeader: document.getElementById('prov-custom-header')?.value,
        priority: parseInt(document.getElementById('prov-priority').value) || 1,
        maxContext: parseInt(document.getElementById('prov-context').value) || 8192,
      });
      document.getElementById('provider-form').style.display = 'none';
      loadProviders();
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  });

  // Save routing strategy
  document.getElementById('strategy-save-btn')?.addEventListener('click', async () => {
    const strategy = document.getElementById('routing-strategy').value;
    try {
      await buhdiAPI.providerStrategy(strategy);
      alert('Strategy saved!');
    } catch (err) { alert('Failed: ' + err.message); }
  });

  // ---- Utilities ----
  function formatDuration(seconds) {
    if (!seconds) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // ---- WebSocket Events ----
  const ws = window.buhdiWS;

  ws.on('connected', () => {
    updateStatus({ state: 'connected', nodeName: state.status?.nodeName || 'Node' });
  });
  ws.on('disconnected', () => {
    updateStatus({ state: 'disconnected' });
  });
  ws.on('status.update', (data) => updateStatus(data));
  ws.on('chat.stream', (data) => updateStreamingMessage(data.token));
  ws.on('chat.stream.end', (data) => finalizeStream(data.full_text));
  ws.on('chat.message', (data) => {
    if (data.role !== 'user') {
      showTyping(false);
      let content = data.content;
      if (data.toolsUsed?.length) {
        content += `\n\n*Tools used: ${data.toolsUsed.join(', ')}*`;
      }
      const modelInfo = (data.provider && data.model) ? `${esc(data.provider)}/${esc(data.model)}` : null;
      addChatMessage(data.role, content, data.ts, true, modelInfo);
    }
  });

  ws.on('chat.tool_executing', (data) => {
    showTyping(false);
    addChatMessage('system', `🔧 Executing tool: ${data.tool}...`);
  });

  ws.on('chat.tool_result', (data) => {
    const icon = data.success ? '✅' : '❌';
    addChatMessage('system', `${icon} ${data.tool}: ${data.output}`);
  });

  // Agent events
  ws.on('agent.step', (data) => {
    const step = data.step;
    let msg = `**Step ${step.index + 1}** — `;
    if (step.thought) msg += `💭 ${step.thought}\n`;
    if (step.action) msg += `🔧 → ${step.action}`;
    if (step.observation) msg += `\n📋 ${step.observation}`;
    addChatMessage('system', msg);
  });

  ws.on('agent.tool_call', (data) => {
    showTyping(false);
    addChatMessage('system', `🔧 Agent calling: ${data.tool}`);
    showTyping(true);
  });

  ws.on('agent.complete', (data) => {
    showTyping(false);
    const icon = data.status === 'completed' ? '✅' : data.status === 'cancelled' ? '🚫' : '❌';
    let msg = data.result || `Agent ${data.status}`;
    msg += `\n\n*${icon} ${data.steps} steps · ${Math.round(data.durationMs / 1000)}s`;
    if (data.toolsUsed?.length) msg += ` · Tools: ${data.toolsUsed.join(', ')}`;
    msg += '*';
    addChatMessage('assistant', msg);
  });

  ws.on('agent.error', (data) => {
    showTyping(false);
    addChatMessage('system', `❌ Agent error: ${data.error}`);
  });

  // ---- Init ----
  // ---- Wizard ----
  async function checkWizard() {
    try {
      const wizard = await buhdiAPI.wizardStatus();
      if (!wizard.first_run && wizard.config.exists) return false; // Not first run

      const overlay = document.getElementById('wizard-overlay');
      if (!overlay) return false;
      overlay.style.display = 'flex';

      // Show detections
      const detectDiv = document.getElementById('wizard-detections');
      if (detectDiv) {
        const items = [];
        items.push(detectItem('💻', `System: ${escapeHtml(wizard.system.os)} (${wizard.system.ram_gb}GB RAM)`, 'ok', 'Detected'));
        items.push(detectItem(
          '🤖', 'Ollama (Local AI)',
          wizard.ollama.detected ? 'ok' : 'missing',
          wizard.ollama.detected ? `${wizard.ollama.models.length} models` : 'Not found'
        ));
        if (wizard.ollama.detected) {
          items.push(detectItem(
            '💬', `Chat Model: ${escapeHtml(wizard.ollama.recommended_model || 'none')}`,
            wizard.ollama.recommended_model ? 'ok' : 'warn',
            wizard.ollama.recommended_model ? 'Ready' : 'Pull a model'
          ));
          items.push(detectItem(
            '🧠', 'Embedding Model',
            wizard.ollama.has_embedding_model ? 'ok' : 'warn',
            wizard.ollama.has_embedding_model ? 'Ready' : 'Optional'
          ));
        }
        items.push(detectItem(
          '☁️', 'mybuhdi.com Pairing',
          wizard.config.has_api_key ? 'ok' : 'warn',
          wizard.config.has_api_key ? 'Connected' : 'Optional'
        ));
        detectDiv.innerHTML = items.join('');
      }

      // After short delay, show recommendations
      setTimeout(() => {
        document.getElementById('wizard-step-detect').style.display = 'none';
        const recStep = document.getElementById('wizard-step-recommendations');
        recStep.style.display = 'block';

        const recDiv = document.getElementById('wizard-recommendations');
        if (recDiv && wizard.recommendations) {
          recDiv.innerHTML = wizard.recommendations.map(r =>
            `<div class="rec-item">${escapeHtml(r)}</div>`
          ).join('');
        }

        // Show auto-config button if applicable
        if (wizard.first_run && wizard.ollama.detected) {
          document.getElementById('wizard-auto-config').style.display = 'inline-block';
        }
      }, 2000);

      // Auto-config button
      document.getElementById('wizard-auto-config')?.addEventListener('click', async () => {
        try {
          const result = await buhdiAPI.wizardAutoConfig();
          document.getElementById('wizard-step-recommendations').style.display = 'none';
          const doneStep = document.getElementById('wizard-step-done');
          doneStep.style.display = 'block';
          document.getElementById('wizard-done-summary').innerHTML =
            result.actions.map(a => `<div class="rec-item">✅ ${escapeHtml(a)}</div>`).join('');
        } catch (err) {
          alert('Auto-config failed: ' + err.message);
        }
      });

      // Skip / finish buttons
      document.getElementById('wizard-skip')?.addEventListener('click', () => { overlay.style.display = 'none'; });
      document.getElementById('wizard-finish')?.addEventListener('click', () => { overlay.style.display = 'none'; location.reload(); });

      return true;
    } catch {
      return false;
    }
  }

  function detectItem(icon, label, status, statusText) {
    return `<div class="detect-item">
      <span class="detect-icon">${icon}</span>
      <span class="detect-label">${label}</span>
      <span class="detect-status ${status}">${statusText}</span>
    </div>`;
  }

  async function init() {
    // Check for first-run wizard
    await checkWizard();

    ws.connect();

    // Load chat history sidebar
    await loadChatList();

    // If no active chat, create one
    if (!state.activeChatId && state.chats.length > 0) {
      openChat(state.chats[0].id);
    }

    try {
      const data = await window.buhdiAPI.status();
      updateStatus(data);
      if (!state.activeChatId) {
        addChatMessage('assistant',
          `Hey! I'm online and ready. Connected as **${data.nodeName || 'myBuhdi-Node'}**.\n\nWhat can I help you with?`,
          false
        );
      }
    } catch (err) {
      updateStatus({ state: 'disconnected' });
      addChatMessage('system', 'Could not connect to Buhdi Node. Is it running?', false);
    }
  }

  init();
})();
