#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');

// Load .env file from the same directory (existing process.env values take priority)
(function loadDotEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (key && !(key in process.env)) process.env[key] = val;
  }
})();

const CONFIG = {
  host: '127.0.0.1',
  port: 8787,
  aiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com',
  aiModel: 'gpt-5.5',
  apiKey: process.env.OPENAI_API_KEY || '',
  // auth: leave username/password empty to disable login requirement entirely.
  auth: {
    username: process.env.CC_MD_MINDMAP_USER || '',
    password: process.env.CC_MD_MINDMAP_PASSWORD || '',
    tokenTtlMs: 7 * 24 * 3600 * 1000,
  },
};

const HOST = CONFIG.host;
const PORT = Number(CONFIG.port);
const AI_BASE_URL = CONFIG.aiBaseUrl.replace(/\/+$/, '');
const AI_MODEL = CONFIG.aiModel;
const API_KEY = CONFIG.apiKey || process.env.OPENAI_API_KEY || '';
const HTML_FILE = path.join(__dirname, 'md-mindmap.html');
const ROOT_DIR = path.resolve(__dirname);
const AI_REQUEST_LOG_FILE = path.join(__dirname, 'ai-requests.log');
const MAX_FILE_READ = 120000;
const UPSTREAM_TIMEOUT_MS = 45000;
const MAX_TOOL_ROUNDS = 10;
const MAX_LOG_STRING = 20000;

// ── Auth ─────────────────────────────────────────────────────────────────────
const AUTH_ENABLED = !!(CONFIG.auth && CONFIG.auth.username && CONFIG.auth.password);
const sessions = new Map(); // token → { username, expires }

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now > s.expires) sessions.delete(token);
  }
}

function validateRequest(req) {
  if (!AUTH_ENABLED) return { ok: true };
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false };
  const s = sessions.get(token);
  if (!s) return { ok: false };
  if (Date.now() > s.expires) { sessions.delete(token); return { ok: false }; }
  s.expires = Date.now() + (CONFIG.auth.tokenTtlMs || 7 * 24 * 3600 * 1000);
  return { ok: true, username: s.username };
}

function handleAuthCheck(req, res) {
  if (!AUTH_ENABLED) {
    send(res, 200, { authEnabled: false, authenticated: true, username: null });
    return;
  }
  const result = validateRequest(req);
  send(res, 200, { authEnabled: true, authenticated: result.ok, username: result.ok ? result.username : null });
}

async function handleLogin(req, res) {
  if (!AUTH_ENABLED) {
    send(res, 200, { ok: true, token: '', username: '' });
    return;
  }
  let body;
  try { body = await readJson(req); } catch { send(res, 400, { error: 'Invalid JSON.' }); return; }
  const { username, password } = body;
  if (!username || !password || username !== CONFIG.auth.username || password !== CONFIG.auth.password) {
    send(res, 401, { error: '用户名或密码错误。' });
    return;
  }
  cleanExpiredSessions();
  const token = generateToken();
  sessions.set(token, { username, expires: Date.now() + (CONFIG.auth.tokenTtlMs || 7 * 24 * 3600 * 1000) });
  send(res, 200, { ok: true, token, username });
}

function handleLogout(req, res) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token) sessions.delete(token);
  send(res, 200, { ok: true });
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function redactAiPayloadForLog(value) {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) return `[image-data-url length=${value.length}]`;
    return value.length > MAX_LOG_STRING ? `${value.slice(0, MAX_LOG_STRING)}...[truncated ${value.length - MAX_LOG_STRING} chars]` : value;
  }
  if (Array.isArray(value)) return value.map(redactAiPayloadForLog);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'image_url' && typeof item === 'string' && item.startsWith('data:image/')) {
        out[key] = `[image-data-url length=${item.length}]`;
      } else if (key === 'dataUrl' && typeof item === 'string') {
        out[key] = `[data-url length=${item.length}]`;
      } else {
        out[key] = redactAiPayloadForLog(item);
      }
    }
    return out;
  }
  return value;
}

function logAiRequest(payload, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    target: `${AI_BASE_URL}/v1/responses`,
    model: payload && payload.model,
    ...meta,
    payload: redactAiPayloadForLog(payload),
  };
  fs.appendFile(AI_REQUEST_LOG_FILE, JSON.stringify(entry) + '\n', err => {
    if (err) console.warn('write ai request log failed', err.message || err);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 30_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function extractResponsesText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
}

function normalizeSlash(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isMarkdownPath(filePath) {
  return /\.(md|markdown)$/i.test(filePath || '');
}

function walkMarkdownFiles(dir = ROOT_DIR, prefix = '') {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.idea') continue;
    const abs = path.join(dir, entry.name);
    const rel = normalizeSlash(path.join(prefix, entry.name));
    if (entry.isDirectory()) {
      out.push(...walkMarkdownFiles(abs, rel));
    } else if (entry.isFile() && isMarkdownPath(entry.name)) {
      out.push({ path: rel, module: rel.includes('/') ? rel.split('/')[0] : '', source: 'disk', abs });
    }
  }
  return out;
}

function getAllKnowledgeFiles(context = {}) {
  const browserFiles = Array.isArray(context.files) ? context.files : [];
  const fromBrowser = browserFiles
    .filter(file => file && isMarkdownPath(file.path))
    .map(file => {
      const filePath = normalizeSlash(file.path);
      return {
        path: filePath,
        module: normalizeSlash(file.module || '').replace(/\/$/, '') || (filePath.includes('/') ? filePath.split('/')[0] : ''),
        source: 'browser',
        content: String(file.content || ''),
      };
    });
  const browserPaths = new Set(fromBrowser.map(file => file.path));
  const fromDisk = walkMarkdownFiles().filter(file => !browserPaths.has(file.path));
  return [...fromBrowser, ...fromDisk].sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
}

function assertInsideRoot(absPath) {
  const resolved = path.resolve(absPath);
  if (resolved !== ROOT_DIR && !resolved.startsWith(ROOT_DIR + path.sep)) {
    throw new Error('File is outside knowledge root.');
  }
  return resolved;
}

function readKnowledgeFile(file) {
  if (!file) return '';
  if (file.source === 'browser') return String(file.content || '');
  return fs.readFileSync(assertInsideRoot(file.abs), 'utf8');
}

function isCurrentFileScopedQuestion(message) {
  return /当前|这份|这个文件|本文档|本文件|选中|当前节点|current file|selected/i.test(String(message || ''));
}

function normalizeToolArgsForScope(name, args = {}, context = {}) {
  if (name !== 'list_files' && name !== 'search_keyword' && name !== 'find_file') return args;
  const next = { ...args };
  if (isCurrentFileScopedQuestion(context.userQuestion)) return next;
  const moduleName = normalizeSlash(next.module || '').toLowerCase().replace(/\/+$/, '');
  const currentFile = normalizeSlash(context.currentFile || '').toLowerCase();
  const currentDir = currentFile.includes('/') ? currentFile.slice(0, currentFile.lastIndexOf('/')) : '';
  if (moduleName && (moduleName === currentFile || moduleName === currentDir)) {
    next.module = '';
  }
  return next;
}

function findKnowledgeFile(filePath, context = {}) {
  const target = normalizeSlash(filePath).toLowerCase();
  if (!target) return null;
  const files = getAllKnowledgeFiles(context);
  return files.find(file => file.path.toLowerCase() === target)
    || files.find(file => file.path.toLowerCase().endsWith('/' + target))
    || files.find(file => path.basename(file.path).toLowerCase() === target);
}

function lineRange(content, startLine, endLine) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const start = Math.max(1, Number(startLine) || 1);
  const end = Math.min(lines.length, Math.max(start, Number(endLine) || start));
  return lines.slice(start - 1, end).map((line, idx) => `${start + idx}: ${line}`).join('\n');
}

function executeKnowledgeTool(name, args = {}, context = {}) {
  args = normalizeToolArgsForScope(name, args, context);
  if (name === 'list_modules') {
    const parent = normalizeSlash(args.parent || '').replace(/\/+$/, '');
    const parentLower = parent.toLowerCase();
    const files = getAllKnowledgeFiles(context);
    const dirs = new Set();
    let hasRootFile = false;
    for (const file of files) {
      const segs = file.path.split('/');
      if (segs.length <= 1) {
        if (!parent) hasRootFile = true;
        continue;
      }
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join('/');
        const dirLower = dir.toLowerCase();
        if (!parent) {
          dirs.add(dir);
        } else if (dirLower !== parentLower && dirLower.startsWith(parentLower + '/')) {
          dirs.add(dir);
        }
      }
    }
    const all = [...dirs].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    if (!parent && hasRootFile) all.unshift('(root)');
    const total = all.length;
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const requestedLimit = Math.floor(Number(args.limit) || 0);
    const limit = requestedLimit > 0 ? Math.min(requestedLimit, 200) : Math.min(total, 50);
    const modules = all.slice(offset, offset + limit);
    return {
      parent: parent || '',
      modules,
      offset,
      limit,
      total,
      count: modules.length,
      hasMore: offset + modules.length < total,
      nextOffset: offset + modules.length < total ? offset + modules.length : null,
    };
  }

  if (name === 'list_files') {
    const moduleName = normalizeSlash(args.module || '').toLowerCase();
    const all = getAllKnowledgeFiles(context)
      .filter(file => !moduleName || file.module.toLowerCase() === moduleName || file.path.toLowerCase().startsWith(moduleName + '/'))
      .map(file => ({ path: file.path, module: file.module, source: file.source }));
    const total = all.length;
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const requestedLimit = Math.floor(Number(args.limit) || 0);
    const limit = requestedLimit > 0 ? Math.min(requestedLimit, 200) : Math.min(total, 50);
    const files = all.slice(offset, offset + limit);
    return {
      module: args.module || '',
      files,
      offset,
      limit,
      total,
      count: files.length,
      hasMore: offset + files.length < total,
      nextOffset: offset + files.length < total ? offset + files.length : null,
    };
  }

  if (name === 'search_keyword') {
    const keyword = String(args.keyword || '').trim();
    const moduleName = normalizeSlash(args.module || '').toLowerCase();
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
    if (!keyword) return { error: 'keyword is required' };
    const needle = keyword.toLowerCase();
    const matches = [];
    for (const file of getAllKnowledgeFiles(context)) {
      if (moduleName && file.module.toLowerCase() !== moduleName && !file.path.toLowerCase().startsWith(moduleName + '/')) continue;
      const lines = readKnowledgeFile(file).replace(/\r\n?/g, '\n').split('\n');
      for (let idx = 0; idx < lines.length && matches.length < limit; idx++) {
        const line = lines[idx];
        if (line.toLowerCase().includes(needle)) {
          matches.push({ path: file.path, module: file.module, source: file.source, line: idx + 1, text: line.trim().slice(0, 300) });
        }
      }
      if (matches.length >= limit) break;
    }
    return { matches, count: matches.length };
  }

  if (name === 'read_file') {
    const file = findKnowledgeFile(args.path, context);
    if (!file) return { error: `file not found: ${args.path || ''}` };
    const content = readKnowledgeFile(file);
    return { path: file.path, module: file.module, source: file.source, content: content.slice(0, MAX_FILE_READ), truncated: content.length > MAX_FILE_READ };
  }

  if (name === 'read_file_lines') {
    const file = findKnowledgeFile(args.path, context);
    if (!file) return { error: `file not found: ${args.path || ''}` };
    return {
      path: file.path,
      module: file.module,
      source: file.source,
      startLine: Number(args.startLine) || 1,
      endLine: Number(args.endLine) || Number(args.startLine) || 1,
      content: lineRange(readKnowledgeFile(file), args.startLine, args.endLine),
    };
  }

  if (name === 'find_file') {
    const moduleName = normalizeSlash(args.module || '').toLowerCase();
    const keyword = String(args.keyword || '').trim().toLowerCase();
    const all = getAllKnowledgeFiles(context)
      .filter(file => !moduleName || file.module.toLowerCase() === moduleName || file.path.toLowerCase().startsWith(moduleName + '/'))
      .filter(file => !keyword || file.path.toLowerCase().includes(keyword))
      .map(file => ({ path: file.path, module: file.module, source: file.source }));
    const total = all.length;
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const requestedLimit = Math.floor(Number(args.limit) || 0);
    const limit = requestedLimit > 0 ? Math.min(requestedLimit, 200) : Math.min(total, 50);
    const files = all.slice(offset, offset + limit);
    return {
      module: args.module || '',
      keyword: args.keyword || '',
      files,
      offset,
      limit,
      total,
      count: files.length,
      hasMore: offset + files.length < total,
      nextOffset: offset + files.length < total ? offset + files.length : null,
    };
  }

  return { error: `unknown tool: ${name}` };
}

function parseAndNormalizeToolArgs(call, context) {
  let args;
  try { args = call.arguments ? JSON.parse(call.arguments) : {}; }
  catch (err) { args = { _parseError: err.message, raw: call.arguments }; }
  return normalizeToolArgsForScope(call.name, args, context);
}

const KNOWLEDGE_TOOLS = [
  {
    type: 'function',
    name: 'list_modules',
    description: 'List directories in the knowledge base with pagination. Recursive: returns every nested directory under `parent` (or under the root when parent=""). Use `offset` and `limit` to page through results; the response includes `total`, `hasMore`, and `nextOffset` to drive subsequent calls.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        parent: { type: 'string', description: 'Parent directory path relative to knowledge root (e.g. "module-a/sub"). Use empty string to start from the root.' },
        offset: { type: 'number', description: 'Zero-based index of the first directory to return. Use 0 for the first page.' },
        limit: { type: 'number', description: 'Maximum directories to return in this page (1-200). Pass 0 to use the default page size of 50.' },
      },
      required: ['parent', 'offset', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_files',
    description: 'List knowledge files with pagination, optionally restricted to one module/directory (matches files directly inside it or under any sub-path). Use `offset` and `limit` to page; response includes `total`, `hasMore`, and `nextOffset`.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Optional module/directory path (e.g. "module-a" or "module-a/sub"). Empty string lists every file.' },
        offset: { type: 'number', description: 'Zero-based index of the first file to return. Use 0 for the first page.' },
        limit: { type: 'number', description: 'Maximum files to return in this page (1-200). Pass 0 to use the default page size of 50.' },
      },
      required: ['module', 'offset', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'search_keyword',
    description: 'Search knowledge content by keyword, optionally under one module.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        module: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['keyword', 'module', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'read_file',
    description: 'Read the full content of one knowledge file.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path or filename.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'read_file_lines',
    description: 'Read a line range from one knowledge file.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
      },
      required: ['path', 'startLine', 'endLine'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'find_file',
    description: 'Find files by filename keyword, optionally restricted to a module, with pagination. Use `offset` and `limit` to page; response includes `total`, `hasMore`, and `nextOffset`.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Optional module/directory path. Empty string searches every file.' },
        keyword: { type: 'string', description: 'Filename keyword (case-insensitive). Empty string returns all files in the module.' },
        offset: { type: 'number', description: 'Zero-based index of the first file to return. Use 0 for the first page.' },
        limit: { type: 'number', description: 'Maximum files to return in this page (1-200). Pass 0 to use the default page size of 50.' },
      },
      required: ['module', 'keyword', 'offset', 'limit'],
      additionalProperties: false,
    },
  },
];

function normalizeChatHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .map(item => ({
      role: item.role,
      content: String(item.content || '').trim().slice(0, 6000),
    }))
    .filter(item => item.content)
    .slice(-24);
}

function buildInput(message, context = {}, images = [], history = []) {
  const historyText = normalizeChatHistory(history)
    .map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`)
    .join('\n\n');
  const fileIndex = getAllKnowledgeFiles(context)
    .slice(0, 200)
    .map(file => `- [${file.source}] ${file.path}`)
    .join('\n');
  const prompt = [
    'You are a knowledge-base assistant.',
    'Answer in Chinese unless the user asks otherwise. Keep answers concise, concrete, and actionable.',
    'Use the provided tools whenever file/module facts are needed. Do not invent file content.',
    'Available tools: list modules, list files, keyword search, read full file, read file line range, find file under module.',
    'Search scope rule: default to the whole knowledge base. Do not assume the user is asking about any currently open file.',
    'Only restrict tools to the current file/module when the user explicitly says 当前文件, 这份文档, 本文件, 选中节点, or otherwise clearly limits the question.',
    'When using list_files, search_keyword, or find_file for a general question, pass module="" to search globally.',
    'Tool-use depth rule: keyword search results are only candidates. Do not answer process/definition questions from search snippets alone.',
    'After search_keyword or find_file finds likely files, call read_file_lines or read_file on the most relevant files before giving the final answer.',
    'When explaining a term or workflow, gather enough surrounding context from the source file(s) to support the conclusion.',
    '\nPrevious conversation:',
    historyText || 'none',
    '\nKnown file index:',
    fileIndex || 'none',
    '\nUser question:',
    message || '',
  ].join('\n');
  const content = [{ type: 'input_text', text: prompt }];
  for (const image of Array.isArray(images) ? images : []) {
    if (image && image.dataUrl) content.push({ type: 'input_image', image_url: image.dataUrl });
  }
  return [{ role: 'user', content }];
}

function getFunctionCalls(data) {
  return (data.output || []).filter(item => item.type === 'function_call' && item.name);
}

function hasOnlyDiscoveryToolCalls(toolCalls) {
  if (!toolCalls.length) return false;
  const discovery = new Set(['list_modules', 'list_files', 'search_keyword', 'find_file']);
  return toolCalls.every(call => discovery.has(call.name));
}

function buildRequireSourceReadPrompt() {
  return {
    role: 'user',
    content: [{
      type: 'input_text',
      text: [
        '你目前只做了目录/关键词/文件名检索，还没有读取具体文件内容。',
        '请继续调用 read_file_lines 或 read_file 读取最相关文件的上下文，再基于源码内容回答。',
        '不要只基于 search_keyword 的单行摘要下结论。',
      ].join('\n'),
    }],
  };
}

function buildFinalAnswerPrompt(reason) {
  return {
    role: 'user',
    content: [{
      type: 'input_text',
      text: [
        '请停止调用工具，并基于上面已经查询到的工具结果直接回答用户原问题。',
        '如果已查询信息不足，请明确说明缺口，并给出基于现有信息的最佳结论。',
        reason ? `停止原因：${reason}` : '',
      ].filter(Boolean).join('\n'),
    }],
  };
}

async function createFinalAnswer(conversation, reason) {
  return await createResponse({
    model: AI_MODEL,
    reasoning: { effort: 'medium' },
    store: false,
    input: [...conversation, buildFinalAnswerPrompt(reason)],
  });
}

async function createFinalAnswerStream(conversation, reason, handlers = {}) {
  return await createResponseStream({
    model: AI_MODEL,
    reasoning: { effort: 'medium' },
    store: false,
    input: [...conversation, buildFinalAnswerPrompt(reason)],
  }, handlers);
}

async function createResponse(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  logAiRequest(payload, { stream: false });
  const upstream = await fetch(`${AI_BASE_URL}/v1/responses`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  }).finally(() => clearTimeout(timer));

  const text = await upstream.text();
  if (!upstream.ok) {
    const err = new Error(text.slice(0, 1000));
    err.status = upstream.status;
    throw err;
  }

  try { return JSON.parse(text); }
  catch {
    const err = new Error('Upstream returned non-JSON response.');
    err.status = 502;
    throw err;
  }
}

async function createResponseStream(payload, handlers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const streamPayload = { ...payload, stream: true };
    logAiRequest(streamPayload, { stream: true });
    const upstream = await fetch(`${AI_BASE_URL}/v1/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(streamPayload),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      const err = new Error(text.slice(0, 1000));
      err.status = upstream.status;
      throw err;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let completed = null;

    function handleFrame(frame) {
      const lines = String(frame || '').split(/\r?\n/);
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      const raw = dataLines.join('\n').trim();
      if (!raw || raw === '[DONE]') return;

      let data;
      try { data = JSON.parse(raw); }
      catch { return; }

      if (data.type === 'response.output_text.delta' && typeof data.delta === 'string') {
        handlers.onText?.(data.delta);
      } else if (data.type === 'response.completed' && data.response) {
        completed = data.response;
      } else if (data.type === 'response.output_item.done' && data.item && data.item.type === 'function_call') {
        handlers.onFunctionCall?.(data.item);
      }
    }

    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) handleFrame(frame);
    }
    if (buffer.trim()) handleFrame(buffer);
    if (!completed) {
      const err = new Error('Upstream stream ended without a completed response.');
      err.status = 502;
      throw err;
    }
    return completed;
  } finally {
    clearTimeout(timer);
  }
}

async function handleAiChat(req, res) {
  if (!API_KEY) {
    send(res, 500, { error: 'Missing CONFIG.apiKey in ai-proxy.js or OPENAI_API_KEY environment variable.' });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    send(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const context = { ...(body.context || {}), userQuestion: body.message || '' };
  const basePayload = {
    model: AI_MODEL,
    reasoning: { effort: 'medium' },
    tools: KNOWLEDGE_TOOLS,
    store: false,
  };

  const conversation = buildInput(body.message, context, body.images, body.history);
  const toolCalls = [];

  try {
    let response = await createResponse({
      ...basePayload,
      input: conversation,
    });

    let stoppedByLimit = false;
    let requestedSourceRead = false;
    for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
      const calls = getFunctionCalls(response);
      if (!calls.length) {
        if (!requestedSourceRead && hasOnlyDiscoveryToolCalls(toolCalls)) {
          requestedSourceRead = true;
          conversation.push(buildRequireSourceReadPrompt());
          response = await createResponse({
            ...basePayload,
            input: conversation,
          });
          continue;
        }
        break;
      }

      conversation.push(...calls.map(call => ({
        type: 'function_call',
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments || '{}',
      })));

      const toolOutputs = calls.map(call => {
        const args = parseAndNormalizeToolArgs(call, context);
        const result = executeKnowledgeTool(call.name, args, context);
        const outputText = JSON.stringify(result);
        toolCalls.push({
          name: call.name,
          call_id: call.call_id,
          arguments: JSON.stringify(args),
          output: outputText,
        });
        return {
          type: 'function_call_output',
          call_id: call.call_id,
          output: outputText,
        };
      });
      conversation.push(...toolOutputs);

      if (i === MAX_TOOL_ROUNDS - 1) {
        stoppedByLimit = true;
        break;
      }

      response = await createResponse({
        ...basePayload,
        input: conversation,
      });
    }

    if (stoppedByLimit) {
      response = await createFinalAnswer(conversation, `工具调用达到 ${MAX_TOOL_ROUNDS} 轮上限`);
    }

    send(res, 200, { reply: extractResponsesText(response), tools: toolCalls, raw: response });
  } catch (err) {
    if (toolCalls.length) {
      try {
        const response = await createFinalAnswer(conversation, `工具调用失败：${err && err.message ? err.message : String(err)}`);
        send(res, 200, {
          reply: extractResponsesText(response),
          tools: toolCalls,
          warning: err && err.message ? err.message : String(err),
          raw: response,
        });
        return;
      } catch (fallbackErr) {
        send(res, fallbackErr.status || 500, { error: fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr), tools: toolCalls });
        return;
      }
    }
    send(res, err.status || 500, { error: err && err.message ? err.message : String(err), tools: toolCalls });
  }
}

async function handleAiChatStream(req, res) {
  if (!API_KEY) {
    send(res, 500, { error: 'Missing CONFIG.apiKey in ai-proxy.js or OPENAI_API_KEY environment variable.' });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    send(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  writeSse(res, 'status', { status: 'thinking' });

  const context = { ...(body.context || {}), userQuestion: body.message || '' };
  const basePayload = {
    model: AI_MODEL,
    reasoning: { effort: 'medium' },
    tools: KNOWLEDGE_TOOLS,
    store: false,
  };

  const conversation = buildInput(body.message, context, body.images, body.history);
  const toolCalls = [];

  async function streamFinalAnswer(reason) {
    await createFinalAnswerStream(conversation, reason, {
      onText: delta => writeSse(res, 'text', { delta }),
    });
    writeSse(res, 'done', { tools: toolCalls, warning: reason });
    res.end();
  }

  try {
    let requestedSourceRead = false;
    for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
      const streamedCalls = [];
      let roundText = '';
      const response = await createResponseStream({
        ...basePayload,
        input: conversation,
      }, {
        onText: delta => { roundText += delta; },
        onFunctionCall: call => streamedCalls.push(call),
      });

      const calls = streamedCalls.length ? streamedCalls : getFunctionCalls(response);
      if (!calls.length) {
        if (!requestedSourceRead && hasOnlyDiscoveryToolCalls(toolCalls)) {
          requestedSourceRead = true;
          conversation.push(buildRequireSourceReadPrompt());
          continue;
        }
        if (roundText) writeSse(res, 'text', { delta: roundText });
        writeSse(res, 'done', { tools: toolCalls });
        res.end();
        return;
      }

      conversation.push(...calls.map(call => ({
        type: 'function_call',
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments || '{}',
      })));

      const toolOutputs = calls.map(call => {
        const args = parseAndNormalizeToolArgs(call, context);
        const result = executeKnowledgeTool(call.name, args, context);
        const outputText = JSON.stringify(result);
        const normalized = {
          name: call.name,
          call_id: call.call_id,
          arguments: JSON.stringify(args),
          output: outputText,
        };
        toolCalls.push(normalized);
        writeSse(res, 'tool', normalized);
        return {
          type: 'function_call_output',
          call_id: call.call_id,
          output: outputText,
        };
      });
      conversation.push(...toolOutputs);
    }

    await streamFinalAnswer(`工具调用达到 ${MAX_TOOL_ROUNDS} 轮上限`);
  } catch (err) {
    if (toolCalls.length) {
      try {
        await streamFinalAnswer(`工具调用失败：${err && err.message ? err.message : String(err)}`);
        return;
      } catch (fallbackErr) {
        writeSse(res, 'error', {
          error: fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr),
          tools: toolCalls,
        });
        res.end();
        return;
      }
    }
    writeSse(res, 'error', { error: err && err.message ? err.message : String(err) });
    res.end();
  }
}

process.on('uncaughtException', err => {
  console.error(err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', err => {
  console.error(err && err.stack ? err.stack : err);
});

// Move a file or directory to the system trash / recycle bin.
// Returns a Promise that resolves on success and rejects with an Error on failure.
function moveToTrash(targetPath) {
  return new Promise((resolve, reject) => {
    const abs = path.resolve(targetPath);
    if (!fs.existsSync(abs)) return reject(new Error('路径不存在: ' + abs));
    const platform = os.platform();
    if (platform === 'darwin') {
      // Use AppleScript to ask Finder to trash the item — preserves undo in Finder.
      execFile('osascript', ['-e', `tell application "Finder" to delete POSIX file "${abs}"`],
        (err) => err ? reject(new Error(err.message)) : resolve());
    } else if (platform === 'win32') {
      const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${abs}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
      execFile('powershell', ['-NoProfile', '-Command', ps],
        (err) => err ? reject(new Error(err.message)) : resolve());
    } else {
      // Linux: XDG trash spec — move to ~/.local/share/Trash/files/
      const trashFiles = path.join(os.homedir(), '.local', 'share', 'Trash', 'files');
      const trashInfo  = path.join(os.homedir(), '.local', 'share', 'Trash', 'info');
      try {
        fs.mkdirSync(trashFiles, { recursive: true });
        fs.mkdirSync(trashInfo,  { recursive: true });
        const base = path.basename(abs);
        const dest = path.join(trashFiles, base);
        fs.renameSync(abs, dest);
        const infoContent = `[Trash Info]\nPath=${abs}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`;
        fs.writeFileSync(path.join(trashInfo, base + '.trashinfo'), infoContent);
        resolve();
      } catch (e) { reject(e); }
    }
  });
}

async function handleTrash(req, res) {
  if (!checkAuth(req, res)) return;
  const body = await readBody(req);
  let payload;
  try { payload = JSON.parse(body); } catch { return send(res, 400, 'invalid JSON'); }
  const { path: targetPath } = payload;
  if (!targetPath || typeof targetPath !== 'string') return send(res, 400, 'path required');
  // Security: only allow paths inside the server's working directory.
  const abs = path.resolve(targetPath);
  const cwd = path.resolve(process.cwd());
  if (!abs.startsWith(cwd + path.sep) && abs !== cwd) {
    return send(res, 403, '路径超出工作目录范围');
  }
  try {
    await moveToTrash(abs);
    send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
  } catch (err) {
    send(res, 500, JSON.stringify({ ok: false, error: err.message }), { 'Content-Type': 'application/json' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/auth/check') {
      handleAuthCheck(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      await handleLogin(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      handleLogout(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/ai-chat') {
      await handleAiChat(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/ai-chat-stream') {
      await handleAiChatStream(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/trash') {
      await handleTrash(req, res);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/md-mindmap.html')) {
      fs.createReadStream(HTML_FILE)
        .on('error', () => send(res, 404, 'md-mindmap.html not found'))
        .once('open', () => {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
        })
        .pipe(res);
      return;
    }
    send(res, 404, 'Not found');
  } catch (err) {
    send(res, 500, { error: err && err.message ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MD MindMap running at http://${HOST}:${PORT}/`);
  console.log(`AI proxy target: ${AI_BASE_URL}/v1/responses (${AI_MODEL})`);
});
