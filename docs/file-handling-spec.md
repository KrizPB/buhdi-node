# File Handling Spec — Buhdi Node Chat

## Flow

```
User attaches file (drag-drop / paste / upload icon)
        ↓
   What type?
   ├── Image (.jpg/.png/.gif/.webp)
   │     → Send as base64 to LLM with vision
   │     → If LLM has no vision → try next provider in router
   │     → If none have vision → "Vision not available" message to user
   │
   ├── Document (.pdf/.doc/.docx)  
   │     → Extract text locally (pdf-parse / mammoth)
   │     → Inject extracted text into prompt as context
   │     → Send to any LLM (no vision needed)
   │
   ├── Spreadsheet (.xls/.xlsx/.csv)
   │     → Parse locally (xlsx / csv-parse)
   │     → Convert to markdown table or summary
   │     → Inject into prompt
   │
   └── Text (.txt/.md)
        → Read raw text
        → Inject into prompt
```

## LLM Vision Detection

Don't pre-check. Let the model handle it:
- Most modern models (GPT-4o, Claude, Gemini, Llava, etc.) support vision
- If a model can't process an image, it says so naturally
- LLM Router can tag providers with `supportsVision: true` in config
- Router prefers vision-capable provider when message has image attachment
- If no vision provider available, tell user before sending (save the API call)

## Provider Config Extension

```json
{
  "llm": {
    "providers": [
      {
        "name": "ollama-llava",
        "type": "ollama",
        "model": "llava",
        "capabilities": ["vision", "text"]
      },
      {
        "name": "mybuhdi-cloud",
        "type": "openai-compat",
        "capabilities": ["vision", "text", "tools"]
      }
    ]
  }
}
```

Router logic: if message has image attachment → filter providers to those with "vision" capability → use strategy (local_first, etc.) among those.

## Dependencies Needed

- `pdf-parse` — PDF text extraction (lightweight, no native deps)
- `mammoth` — .docx to text/HTML
- `xlsx` — Excel/CSV parsing
- `sharp` — Image resizing before sending to LLM (optional, for large images)

## Submit Handler Changes (app.js)

```js
// In chatForm submit handler:
if (pendingFile) {
  const formData = new FormData();
  formData.append('file', pendingFile);
  formData.append('message', text);
  
  // POST to node's own endpoint (not cloud)
  const result = await fetch('/dashboard/api/chat/upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: formData,
  });
  // Node extracts/processes file, sends to LLM with context
  clearPendingFile();
} else {
  // Normal text-only send (existing flow)
}
```

## Node-Side Endpoint

`POST /dashboard/api/chat/upload`
- Receives multipart form (file + message)
- Detects file type
- Images → base64 encode, attach to LLM message as image_url
- Documents → extract text, prepend to user message
- Routes to appropriate LLM provider
- Returns AI response

## Priority
P1 — Core feature for Nana use case (pill bottle photos, document questions)
Estimate: 4-6h including dependencies + testing
