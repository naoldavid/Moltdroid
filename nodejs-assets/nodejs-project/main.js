'use strict';

/**
 * MoltDroid Agent v2.3 — Autonomous Android Agent
 *
 * Tier-2 additions:
 *   ① Cron jobs    — persistent scheduled tasks, /cron commands
 *   ② Sub-agents   — <action:spawn_subagent> for parallel background work
 *   ③ Webhooks     — POST /hooks/wake and /hooks/agent on port 18789
 *   ④ /btw         — ephemeral side question without touching history
 *   ⑤ Auto-compact — silently compact when history approaches limit
 *
 * Tier-3 additions:
 *   ⑥ /search      — text search across all workspace files
 *   ⑦ Canvas       — push HTML to in-app WebView via IPC
 *   ⑧ Notifications— <action:notify> sends Android push notification
 */

const fs        = require('fs');
const path      = require('path');
const http      = require('http');
const https     = require('https');
const rn        = require('rn-bridge');
const AdmZip    = (() => { try { return require('adm-zip'); } catch { return null; } })();

// ── State ──────────────────────────────────────────────────────────────────────

let cfg = {
  filesDir: null,
  ai: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: '' },
  telegram: null,
};
let server         = null;
let telegramBot    = null;
let running        = false;
let startTime      = Date.now();
let healthTimer    = null;
let heartbeatTimer = null;
let cronTimer      = null;
let lastActivity   = Date.now();

const chatHistories = {};
const MAX_HISTORY   = 30;
const AUTO_COMPACT_AT = 24; // compact when history reaches this length

const tasks      = {};
let   taskCounter = 0;
const cronJobs   = {};
let   cronCounter = 0;
const hatchState = {};

// ── Native bridge (Python / SQLite via RN IPC) ──────────────────────────────
const pendingNative = {};

function callNative(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = `nr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    pendingNative[requestId] = { resolve, reject };
    rn.channel.send(JSON.stringify({ type, payload, requestId }));
    setTimeout(() => {
      if (pendingNative[requestId]) {
        delete pendingNative[requestId];
        reject(new Error(`${type} timed out`));
      }
    }, 60000);
  });
}

const PORT = 18789;

// ── Logging ────────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  rn.channel.send(JSON.stringify({ type: 'log', payload: line }));
}

function send(type, payload, requestId) {
  rn.channel.send(JSON.stringify(requestId ? { type, payload, requestId } : { type, payload }));
}

// ── File system ────────────────────────────────────────────────────────────────

function resolveDir(sub) {
  if (!cfg.filesDir) throw new Error('Agent not initialized');
  const base = path.resolve(cfg.filesDir);
  const dir  = sub ? path.resolve(path.join(base, sub)) : base;
  if (!dir.startsWith(base)) throw new Error('Path traversal blocked');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function agentDir()  { return resolveDir('agent'); }
function memoryDir() { return resolveDir('agent/memory'); }

function writeAgentFile(name, content) {
  const p = path.join(agentDir(), name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function readAgentFile(name, fallback = '') {
  const p = path.join(agentDir(), name);
  if (!fs.existsSync(p)) return fallback;
  return fs.readFileSync(p, 'utf8');
}

function agentFileExists(name) {
  return fs.existsSync(path.join(agentDir(), name));
}

function writeDataFile(name, content, subdir = 'data') {
  const file = path.join(resolveDir(subdir), name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function readDataFile(name, subdir = 'data') {
  const file = path.join(resolveDir(subdir), name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function listDataFiles(subdir = 'data') {
  try { return fs.readdirSync(resolveDir(subdir)); } catch { return []; }
}

function countFiles(sub) {
  try { return fs.readdirSync(resolveDir(sub)).length; } catch { return 0; }
}

// ── Skill download ─────────────────────────────────────────────────────────────

const CLAWHUB_API = 'https://wry-manatee-359.convex.site/api';

function fetchBuffer(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'MoltDroid/1.0', ...extraHeaders } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function downloadSkillFromClawhub(slug) {
  // Normalise: accept full clawhub.ai URLs like https://clawhub.ai/author/skill-name
  if (slug.includes('clawhub.ai/')) {
    // Keep the last path segment only (e.g. "word-docx" from "/ivangdavila/word-docx")
    const pathPart = slug.split('clawhub.ai/').pop().split('?')[0];
    slug = pathPart.split('/').pop();
    log(`⚡ Extracted slug from URL: "${slug}" (from path: ${pathPart})`);
  }

  // 1. Optional metadata
  let displayName = slug;
  let summary = '';
  try {
    const metaBuf = await fetchBuffer(`${CLAWHUB_API}/skill?slug=${encodeURIComponent(slug)}`);
    const info = JSON.parse(metaBuf.toString('utf8'));
    if (info.skill) {
      displayName = info.skill.displayName || slug;
      summary = info.skill.summary || '';
    }
  } catch (e) { log(`⚡ ClawHub metadata unavailable (continuing): ${e.message}`); }

  // 2. Download archive
  const zipBuf = await fetchBuffer(`${CLAWHUB_API}/download?slug=${encodeURIComponent(slug)}`);
  log(`⚡ Downloaded ${zipBuf.length} bytes for skill "${slug}"`);

  // 3. Parse — ZIP first, fall back to raw markdown
  let content = null;

  if (AdmZip && zipBuf.length > 4) {
    try {
      const zip = new AdmZip(zipBuf);
      const entries = zip.getEntries();
      log(`⚡ ZIP entries: ${entries.map(e => e.entryName).join(', ')}`);
      const entry =
        zip.getEntry('SKILL.md') ||
        zip.getEntry('skill.md') ||
        entries.find(e => e.entryName.toLowerCase().endsWith('/skill.md')) ||
        entries.find(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.md'));
      if (entry) {
        content = zip.readAsText(entry);
        log(`⚡ Extracted from ZIP: ${entry.entryName} (${content.length} chars)`);
      }
    } catch (e) {
      log(`⚡ ZIP parse failed (${e.message}), trying raw text`);
    }
  }

  // If ZIP didn't work, try treating response as raw markdown
  if (!content) {
    const raw = zipBuf.toString('utf8').trim();
    if (raw.startsWith('<!') || raw.startsWith('<html')) {
      throw new Error(`ClawHub returned an HTML page instead of a skill file. Check the slug: "${slug}"`);
    }
    if (raw.length < 20) {
      throw new Error(`ClawHub returned an empty response for slug: "${slug}"`);
    }
    content = raw;
    log(`⚡ Using raw response as markdown (${content.length} chars)`);
  }

  // 4. Save to skills/<slug>.md
  writeDataFile(`${slug}.md`, content, 'skills');
  send('filesChanged', { subdir: 'skills' });
  log(`⚡ Skill installed: ${displayName} (${slug})`);
  refreshSkillCommands().catch(() => {});
  return { slug, displayName, summary };
}

async function downloadSkillFromUrl(url, name) {
  const buf = await fetchBuffer(url);
  const content = buf.toString('utf8');
  const slug = name || url.split('/').pop().replace(/\.(md|txt)$/, '') || 'skill';
  writeDataFile(`${slug}.md`, content, 'skills');
  send('filesChanged', { subdir: 'skills' });
  log(`⚡ Skill installed from URL: ${slug}`);
  refreshSkillCommands().catch(() => {});
  return { slug };
}

// ── Skill command registration ──────────────────────────────────────────────────

function extractSkillCommands(content) {
  const commands = [];
  const seen = new Set();
  const lines = content.split('\n');
  let inCommandSection = false;

  for (const line of lines) {
    // Enter command section
    if (/^#{1,3}\s*(commands?|slash commands?|telegram commands?|bot commands?)/i.test(line)) {
      inCommandSection = true;
      continue;
    }
    // Leave command section on new heading
    if (/^#{1,3}\s/.test(line) && inCommandSection) {
      inCommandSection = false;
    }

    // Match patterns like: `/cmd` - Description  or  - /cmd: Description
    const m = line.match(/[`*\-\s]*\/([a-z][a-z0-9_]{0,31})[`*\s]*[-–:]\s*(.+)/i);
    if (m && (inCommandSection || line.trim().startsWith('/'))) {
      const cmd  = m[1].toLowerCase();
      const desc = m[2].trim().replace(/[*`_]/g, '').slice(0, 256);
      if (!seen.has(cmd)) { seen.add(cmd); commands.push({ command: cmd, description: desc }); }
    }
  }
  return commands;
}

const BASE_COMMANDS = [
  { command: 'help',      description: 'Show available commands' },
  { command: 'status',    description: 'Agent status & uptime' },
  { command: 'tokens',    description: 'Show token usage & context remaining' },
  { command: 'search',    description: 'Search workspace files' },
  { command: 'files',     description: 'List files' },
  { command: 'skills',    description: 'List installed skills' },
  { command: 'skill',     description: 'Install or run a skill' },
  { command: 'tasks',     description: 'List background tasks' },
  { command: 'cron',      description: 'Manage scheduled jobs' },
  { command: 'memory',    description: 'Show long-term memory' },
  { command: 'remember',  description: 'Save a fact to long-term memory' },
  { command: 'compact',   description: 'Summarise conversation history' },
  { command: 'clear',     description: 'Clear conversation history' },
  { command: 'model',     description: 'Switch AI model' },
  { command: 'hatch',     description: 'Set up user profile' },
  { command: 'btw',       description: 'One-off question without history' },
  { command: 'newskill',  description: 'Create a custom JS skill' },
  { command: 'context',   description: 'Inspect loaded context' },
];

async function refreshSkillCommands() {
  if (!telegramBot) return;
  const reserved = new Set(BASE_COMMANDS.map(c => c.command));
  const skillCmds = [];
  const mdSkills = listDataFiles('skills').filter(f => f.endsWith('.md'));
  for (const f of mdSkills) {
    try {
      const content = readDataFile(f, 'skills');
      if (!content) continue;
      for (const cmd of extractSkillCommands(content)) {
        if (!reserved.has(cmd.command)) { reserved.add(cmd.command); skillCmds.push(cmd); }
      }
    } catch {}
  }
  const all = [...BASE_COMMANDS, ...skillCmds].slice(0, 100);
  try {
    await telegramBot.setMyCommands(all);
    if (skillCmds.length) log(`📋 Registered ${all.length} commands (${skillCmds.length} from skills)`);
  } catch (e) { log(`⚠ setMyCommands failed: ${e.message}`); }
}

// ── Daily memory log ───────────────────────────────────────────────────────────

function todayKey() { return new Date().toISOString().slice(0, 10); }
function yesterdayKey() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function appendDailyLog(entry) {
  const file = `memory/${todayKey()}.md`;
  const existing = readAgentFile(file, `# Log — ${todayKey()}\n\n`);
  writeAgentFile(file, existing + `\n### ${new Date().toLocaleTimeString()}\n${entry}\n`);
}

function readDailyLog(key) { return readAgentFile(`memory/${key}.md`, ''); }

// ── Default workspace files ────────────────────────────────────────────────────

const SOUL_DEFAULT = `# Agent Soul

## Persona
I am MoltDroid — an autonomous AI agent running natively on Android via embedded Node.js.
I live permanently on the device: always on, always listening.

## Communication Style
- Direct and precise — I tell you what I did, not what I'll try to do
- Concise by default, detailed when complexity warrants it
- I am an agent, not a chatbot

## Operating Principles
- Always use action blocks for real operations — never pretend
- Proactively suggest what can be automated
- Ask one focused question when uncertain
`;

const AGENTS_DEFAULT = `# Agent Rules

## Memory Guidelines
- Save important facts via <action:remember>
- Keep context.md focused: archive stale entries

## Task Priorities
1. Respond to the user's immediate request
2. Execute with action blocks (not words)
3. Report clearly what was done
4. Proactively suggest automation when patterns emerge

## Boundaries
- Ask before making irreversible changes
- Never hallucinate file contents — use read_file first
`;

const HEARTBEAT_DEFAULT = `# Heartbeat Tasks

This file defines what I do autonomously every 30 minutes.

## Active Tasks
- If user inactive > 2 hours, append a brief status to data/daily-log.md
- If pending tasks exist, attempt the oldest one

## Notes
- Reply HEARTBEAT_OK if nothing needed
- Use action blocks for all operations
- Prefix QUIET to skip Telegram notification
`;

const BOOT_DEFAULT = `# Boot Sequence

Runs every time the agent starts. Keep this concise.

## On Start
- Append a startup entry to data/boot-log.md with current time and model
`;

function ensureWorkspaceFiles() {
  if (!agentFileExists('SOUL.md'))         writeAgentFile('SOUL.md',         SOUL_DEFAULT);
  if (!agentFileExists('AGENTS.md'))       writeAgentFile('AGENTS.md',       AGENTS_DEFAULT);
  if (!agentFileExists('context.md'))      writeAgentFile('context.md',      '# Agent Notes\n\n_No notes yet._\n');
  if (!agentFileExists('memory.md'))       writeAgentFile('memory.md',       '# Long-Term Memory\n\n_No memories yet._\n');
  if (!agentFileExists('HEARTBEAT.md'))    writeAgentFile('HEARTBEAT.md',    HEARTBEAT_DEFAULT);
  if (!agentFileExists('BOOT.md'))         writeAgentFile('BOOT.md',         BOOT_DEFAULT);
  try { memoryDir(); } catch {}
}

function getUserProfile() { return readAgentFile('user-profile.md', ''); }

// ── System prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const soul    = readAgentFile('SOUL.md', '');
  const agents  = readAgentFile('AGENTS.md', '');
  const profile = getUserProfile();
  const memory  = readAgentFile('memory.md', '');
  const ctx     = readAgentFile('context.md', '');
  const today   = readDailyLog(todayKey());
  const yest    = readDailyLog(yesterdayKey());
  const jsSkills = listDataFiles('skills').filter(f => f.endsWith('.js'));
  const mdSkills = listDataFiles('skills').filter(f => f.endsWith('.md'));
  const skills   = [...jsSkills, ...mdSkills].map(f => f.replace(/\.(js|md)$/, '')).join(', ') || 'none';

  const parts = [
    `You are MoltDroid, an autonomous AI agent running on Android.`,
    `Date: ${new Date().toDateString()} | Uptime: ${uptimeStr()}`,
    `AI: ${providerLabel()} | Skills: ${skills}`,
    ``,
  ];

  if (soul.trim())    parts.push(soul.trim(), ``);
  if (agents.trim())  parts.push(agents.trim(), ``);
  if (profile.trim()) parts.push(`## User Profile\n${profile.trim()}`, ``);
  else                parts.push(`## User Profile\nNo profile yet. On first contact, briefly greet the user, ask their name, and save it with <action:remember>Name: ...</action>. Then ask what they need help with. Keep it short — one message.`, ``);
  if (memory.trim() && !memory.includes('_No memories yet._')) parts.push(`## Long-Term Memory\n${memory.trim().slice(0, 3000)}`, ``);
  if (ctx.trim() && !ctx.includes('_No notes yet._')) parts.push(`## Agent Notes\n${ctx.trim().slice(0, 1000)}`, ``);
  if (yest.trim())    parts.push(`## Yesterday's Log\n${yest.trim().slice(0, 1500)}`, ``);
  if (today.trim())   parts.push(`## Today's Log\n${today.trim().slice(0, 2000)}`, ``);

  // Built-in web search skill — always available
  parts.push(
    `## Built-in Skill: Web Search`,
    `You have native web search and fetch capabilities — no external service needed.`,
    `- <action:search query="your query"/> — searches DuckDuckGo, returns titles + snippets`,
    `- <action:fetch url="https://..."/> — fetches any URL, strips HTML, returns readable text`,
    `Workflow: search first to find relevant URLs, then fetch for full details.`,
    `Example:`,
    `<think>User wants current Bitcoin price. I'll search then fetch.</think>`,
    `<action:search query="Bitcoin price USD today"/>`,
    `After results, if I need more detail: <action:fetch url="https://coinmarketcap.com/currencies/bitcoin/"/>`,
    ``
  );

  // Inject installed MD skills as context
  if (mdSkills.length > 0) {
    parts.push(
      `## Installed Knowledge Skills`,
      `IMPORTANT: These skills are ALREADY ACTIVE — their instructions are loaded into your context right now.`,
      `You do NOT call or invoke them. Read their instructions and implement them using your action blocks.`,
      `If a skill says "create a file with format X", use <action:create_file> with that format.`,
      `If a skill says "fetch URL X", use <action:fetch url="X"/>.`,
      `After creating a file a user asked for, always send it with <action:send_file path="data/filename"/>.`,
      ``
    );
    for (const f of mdSkills) {
      try {
        const content = readDataFile(f, 'skills');
        if (content) parts.push(`### Skill: ${f.replace('.md', '')}\n${content.slice(0, 1500)}`);
      } catch {}
    }
    parts.push(``);
  }

  parts.push(
    `## Thinking`,
    `Before responding, think step by step inside <think>...</think> tags. These are private and never shown to the user.`,
    `Example: <think>The user wants X. I should do Y. Let me check Z first.</think>`,
    ``,
    `## Action Blocks — MANDATORY`,
    `You MUST use these XML blocks to perform real operations. The runtime executes them.`,
    `NEVER just describe what you would do — actually DO it using action blocks.`,
    ``,
    `**Web (you CAN browse the internet and search):**`,
    `<action:fetch url="https://example.com"/>`,
    `<action:search query="search terms"/>`,
    ``,
    `**File operations (use these whenever asked to create, save, or store anything):**`,
    `<action:create_file path="data/filename.txt">file content here</action>`,
    `<action:read_file path="data/filename.txt"/>`,
    `<action:list_files path="data"/>`,
    `<action:send_file path="data/filename.txt"/>  — sends the file to the user via Telegram`,
    ``,
    `**Skills:**`,
    `<action:create_skill name="skill_name">module.exports.run = async (args, ctx) => { return {}; };</action>`,
    `<action:download_skill slug="weather"/>`,
    ``,
    `**Memory & logging:**`,
    `<action:remember>important fact to persist</action>`,
    `<action:log>entry for today's log</action>`,
    ``,
    `**Code execution (use this to implement ANY skill that provides code or needs a library):**`,
    `<action:run_code>`,
    `const JSZip = require('jszip');`,
    `const zip = new JSZip();`,
    `zip.file('hello.txt', 'Hello world');`,
    `const buf = await zip.generateAsync({ type: 'nodebuffer' });`,
    `fs.writeFileSync(resolveDataPath('output.zip'), buf);`,
    `</action>`,
    `- run_code executes Node.js. Has access to: require(), fs, path, Buffer, fetch via fetchUrl().`,
    `- CRITICAL: ALWAYS use resolveDataPath('filename.ext') for file paths. NEVER use __dirname, __filename, process.mainModule, or any hardcoded path.`,
    `- To write a file: fs.writeFileSync(resolveDataPath('filename.ext'), content)`,
    `- To send it after: <action:send_file path="data/filename.ext"/>`,
    `- PRE-BUNDLED packages (ready to require): adm-zip, jszip, axios, cheerio, lodash, dayjs, yaml, uuid, marked, papaparse, mathjs, xml2js.`,
    `- NO npm install available on Android. Only use the pre-bundled packages above.`,
    ``,
    `**Python execution (for skills that provide Python code):**`,
    `<action:python>`,
    `import qrcode`,
    `img = qrcode.make("https://example.com")`,
    `img.save(DATA_DIR + "/qr.png")`,
    `print("saved qr.png")`,
    `</action>`,
    `- Python has access to: DATA_DIR (writable data path), standard library, plus: qrcode, Pillow, requests, numpy, pandas, openpyxl, pyyaml, beautifulsoup4, lxml`,
    `- Save files to DATA_DIR. Use print() for output.`,
    ``,
    `**SQLite database:**`,
    `<action:sqlite db="tasks.db">CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0)</action>`,
    `<action:sqlite db="tasks.db" mode="query">SELECT * FROM tasks WHERE done=0</action>`,
    `- db= sets the database filename (stored in app data). mode= is auto-detected (exec for writes, query for SELECT).`,
    `- For DOCX creation: use jszip (DOCX = ZIP containing XML files). Do NOT try to npm install.`,
    `- IMPORTANT: generate ONE run_code block, not multiple. One block is enough.`,
    ``,
    `**Advanced:**`,
    `<action:spawn_subagent task="description" label="label"/>`,
    `<action:canvas url="https://example.com"/>`,
    `<action:notify title="Alert" body="message"/>`,
    ``,
    `RULES:`,
    `- Asked to create a file → use <action:create_file> or run_code, then <action:send_file> to deliver it.`,
    `- Asked to create/save a file → use <action:create_file>. Always.`,
    `- Skill says "use library X" → try run_code with require('X'). If require fails → npm_install first.`,
    `- Skill says "call API Y" or "use curl" → use <action:fetch url="Y"/>. Do NOT use run_code for HTTP calls.`,
    `- Asked to open/visit a website → use <action:fetch url="...">.`,
    `- Always think before acting. Use <think> blocks to reason privately.`,
    ``,
    `## MANDATORY Web Search Rule`,
    `If the user asks you to search, look up, find, check, or get current info about ANYTHING → you MUST use <action:search> FIRST.`,
    `NEVER answer from training data when the user explicitly asks to search the web. Training knowledge is NOT a web search.`,
    `Correct flow: <action:search query="..."/> → read results → <action:fetch url="..."/> for details → answer from real results.`,
    `Wrong: using your knowledge to answer a web search request without executing any action blocks.`,
    ``,
    `## Image & Document Handling`,
    `When you receive an image or PDF:`,
    `1. <think> analyze what's in it privately </think>`,
    `2. Extract KEY information (names, numbers, dates, facts) — do NOT narrate every visual detail`,
    `3. If the info is important/reusable → save it: <action:remember>key facts from the image/doc</action>`,
    `4. Reply concisely: state what you found in 2-3 lines. Do not read out the document word-for-word.`,
    `Example: "Found invoice #1042 — total €340, due 2025-02-01. Saved to memory."`
  );

  return parts.join('\n');
}

// ── Action execution ───────────────────────────────────────────────────────────

function parseActions(text) {
  const actions = [];
  const selfClose = /<action:(\w+)([^>]*)\/>/g;
  let m;
  while ((m = selfClose.exec(text)) !== null)
    actions.push({ type: m[1], attrs: parseAttrs(m[2]), body: '', raw: m[0] });
  // Accept both </action> and </action:type> as closing tag
  const block = /<action:(\w+)([^>]*)>([\s\S]*?)<\/action(?::\w+)?>/g;
  while ((m = block.exec(text)) !== null)
    actions.push({ type: m[1], attrs: parseAttrs(m[2]), body: m[3].trim(), raw: m[0] });
  return actions;
}

function parseAttrs(attrStr) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

async function executeActions(actions, chatId) {
  const results = [];
  for (const action of actions) {
    try {
      switch (action.type) {
        case 'create_file': {
          const p = action.attrs.path || 'data/file.txt';
          const parts = p.split('/');
          writeDataFile(parts.slice(1).join('/') || parts[0], action.body, parts.length > 1 ? parts[0] : 'data');
          log(`📄 Created: ${p}`);
          send('filesChanged', { subdir: parts.length > 1 ? parts[0] : 'data' });
          results.push({ raw: action.raw, result: `✅ Created \`${p}\`` });
          break;
        }
        case 'read_file': {
          const p = action.attrs.path || '';
          const parts = p.split('/');
          const sub = parts.length > 1 ? parts[0] : 'data';
          const name = parts.slice(1).join('/') || parts[0];
          // Support reading agent files too
          let content = null;
          if (sub === 'agent') content = readAgentFile(parts.slice(1).join('/'), null);
          else content = readDataFile(name, sub);
          results.push({ raw: action.raw, result: content !== null
            ? `📄 \`${p}\`:\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``
            : `❌ File not found: ${p}` });
          break;
        }
        case 'list_files': {
          const sub = action.attrs.path || 'data';
          const files = listDataFiles(sub);
          results.push({ raw: action.raw, result: files.length
            ? `📁 \`${sub}/\`:\n${files.map(f => `  • ${f}`).join('\n')}`
            : `📁 \`${sub}/\` is empty` });
          break;
        }
        case 'create_skill': {
          const name = action.attrs.name;
          if (!name) { results.push({ raw: action.raw, result: '❌ Skill name required' }); break; }
          fs.writeFileSync(path.join(resolveDir('skills'), `${name}.js`), action.body, 'utf8');
          log(`⚡ Skill created: ${name}`);
          send('filesChanged', { subdir: 'skills' });
          results.push({ raw: action.raw, result: `✅ Skill \`${name}\` created` });
          break;
        }
        case 'download_skill': {
          try {
            const slug = action.attrs.slug;
            const url  = action.attrs.url;
            let info;
            if (slug) {
              info = await downloadSkillFromClawhub(slug);
              results.push({ raw: action.raw, result: `✅ Skill *${info.displayName}* installed from ClawHub\n_${info.summary || ''}_` });
            } else if (url) {
              info = await downloadSkillFromUrl(url, action.attrs.name);
              results.push({ raw: action.raw, result: `✅ Skill \`${info.slug}\` installed from URL` });
            } else {
              results.push({ raw: action.raw, result: `❌ download_skill requires slug= or url=` });
            }
          } catch (e) {
            results.push({ raw: action.raw, result: `❌ Skill download failed: ${e.message}` });
          }
          break;
        }
        case 'remember': {
          const existing = readAgentFile('memory.md', '# Long-Term Memory\n\n');
          writeAgentFile('memory.md', existing + `\n## ${new Date().toLocaleString()}\n${action.body}\n`);
          results.push({ raw: action.raw, result: `🧠 Remembered` });
          break;
        }
        case 'log': {
          appendDailyLog(action.body);
          results.push({ raw: action.raw, result: `📅 Logged` });
          break;
        }
        case 'spawn_subagent': {
          const task  = action.attrs.task || action.body;
          const label = action.attrs.label || '';
          const id    = await spawnSubagent(task, label, chatId);
          results.push({ raw: action.raw, result: `🤖 Subagent \`${id}\` spawned — will report back` });
          break;
        }
        case 'canvas': {
          if (action.attrs.clear === 'true' || action.attrs.clear === '1') {
            send('canvas', { clear: true });
            results.push({ raw: action.raw, result: `🖼 Canvas cleared` });
          } else if (action.attrs.url) {
            send('canvas', { url: action.attrs.url, title: action.attrs.title || '' });
            results.push({ raw: action.raw, result: `🖼 Canvas → \`${action.attrs.url}\`` });
          } else {
            send('canvas', { html: action.body, title: action.attrs.title || 'Canvas' });
            log(`🖼 Canvas: pushed ${action.body.length} chars`);
            results.push({ raw: action.raw, result: `🖼 Canvas updated (${action.body.length} bytes)` });
          }
          break;
        }
        case 'notify': {
          const title = action.attrs.title || 'MoltDroid';
          const body  = action.attrs.body  || action.body || '';
          send('device', { command: 'notify', title, body });
          log(`🔔 Notification: ${title}`);
          results.push({ raw: action.raw, result: `🔔 Notification sent: "${title}"` });
          break;
        }
        case 'run_code': {
          const code = action.body.trim();
          if (!code) { results.push({ raw: action.raw, result: '❌ run_code: no code provided' }); break; }
          try {
            log(`🔧 run_code (${code.length} chars)`);
            const output = [];
            const _log = (...a) => output.push(a.map(x => typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x)).join(' '));
            // Helpers available inside run_code
            const resolveDataPath = (name) => name ? path.join(resolveDir('data'), name) : resolveDir('data');
            // fetchUrl returns decoded text string (not raw Buffer) for easy use in run_code
            const fetchUrl = async (url) => (await fetchBuffer(url)).toString('utf8');
            // Execute as async function with useful globals injected
            const fn = new Function(
              'require','fs','path','Buffer','console',
              'resolveDataPath','writeDataFile','readDataFile','listDataFiles','fetchUrl','log',
              `return (async()=>{ ${code} })()`
            );
            const ret = await fn(
              require, fs, path, Buffer,
              { log: _log, error: _log, warn: _log, info: _log },
              resolveDataPath, writeDataFile, readDataFile, listDataFiles, fetchUrl, log
            );
            if (ret !== undefined && output.length === 0) {
              output.push(typeof ret === 'object' ? JSON.stringify(ret, null, 2) : String(ret));
            }
            const out = output.join('\n').trim().slice(0, 3000);
            log(`🔧 run_code done: ${out.slice(0, 80)}`);
            results.push({ raw: action.raw, result: `✅ Code ran:\n${out || '(no output)'}` });
            send('filesChanged', {}); // files may have been created
          } catch (e) {
            log(`🔧 run_code error: ${e.message}`);
            results.push({ raw: action.raw, result: `❌ run_code error: ${e.message}` });
          }
          break;
        }
        case 'npm_install': {
          // npm is not available in the embedded Android Node.js runtime.
          // Packages must be pre-bundled in the APK. Inform the agent what IS available.
          const pkg = (action.attrs.package || action.body || '').trim().replace(/[^a-zA-Z0-9@/._-]/g, '');
          results.push({
            raw: action.raw,
            result: `⚠️ npm is not available on Android. \`${pkg}\` cannot be installed at runtime.\n` +
              `Pre-bundled packages available: adm-zip, jszip, node-telegram-bot-api.\n` +
              `Use run_code with these packages instead. For DOCX creation use jszip or adm-zip.`,
          });
          break;
        }
        case 'send_file': {
          const filePath = (action.attrs.path || action.body || '').trim();
          if (!filePath) { results.push({ raw: action.raw, result: '❌ send_file requires path=' }); break; }
          if (!telegramBot || !chatId) { results.push({ raw: action.raw, result: '❌ Telegram not connected' }); break; }
          try {
            // Resolve path: support "data/x.txt", "agent/x.md", or bare filename in data/
            let absPath;
            const parts2 = filePath.split('/');
            const sub2   = parts2.length > 1 ? parts2[0] : 'data';
            const name2  = parts2.length > 1 ? parts2.slice(1).join('/') : filePath;
            absPath = path.join(resolveDir(sub2), name2);
            if (!fs.existsSync(absPath)) {
              // fallback: try data/
              absPath = path.join(resolveDir('data'), filePath);
            }
            if (!fs.existsSync(absPath)) throw new Error(`File not found: ${filePath}`);
            log(`📎 Sending file: ${absPath}`);
            await telegramBot.sendDocument(chatId, absPath, {}, { filename: path.basename(absPath) });
            results.push({ raw: action.raw, result: `📎 Sent file: \`${path.basename(absPath)}\`` });
          } catch (e) {
            results.push({ raw: action.raw, result: `❌ send_file failed: ${e.message}` });
          }
          break;
        }
        case 'fetch': {
          const url = action.attrs.url || action.body.trim();
          if (!url) { results.push({ raw: action.raw, result: '❌ fetch requires url=' }); break; }
          try {
            log(`🌐 Fetch: ${url}`);
            const buf = await fetchBuffer(url);
            let text = buf.toString('utf8');
            // Strip HTML tags and collapse whitespace
            text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
                       .replace(/<style[\s\S]*?<\/style>/gi, '')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
                       .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                       .replace(/\s{2,}/g, ' ').trim()
                       .slice(0, 3000);
            results.push({ raw: action.raw, result: `🌐 \`${url}\`:\n${text}` });
          } catch (e) {
            results.push({ raw: action.raw, result: `❌ Fetch failed: ${e.message}` });
          }
          break;
        }
        case 'search': {
          const query = action.attrs.query || action.body.trim();
          if (!query) { results.push({ raw: action.raw, result: '❌ search requires query=' }); break; }
          try {
            log(`🔍 Search: ${query}`);
            const enc = encodeURIComponent(query);
            const snippets = [];

            // ── Strategy 1: DuckDuckGo HTML endpoint (most reliable) ──
            try {
              const cheerio = require('cheerio');
              const buf = await fetchBuffer(
                `https://html.duckduckgo.com/html/?q=${enc}`,
                { 'User-Agent': 'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 Chrome/119 Mobile Safari/537.36' }
              );
              const $ = cheerio.load(buf.toString('utf8'));
              $('.result__body, .web-result').each((i, el) => {
                if (snippets.length >= 5) return;
                const title   = $(el).find('.result__title, .result__a').first().text().trim();
                const snippet = $(el).find('.result__snippet').first().text().trim();
                const url     = $(el).find('.result__url, .result__extras__url').first().text().trim();
                if (title) snippets.push(`**${title}**${url ? `\n${url}` : ''}\n${snippet || ''}`);
              });
            } catch {}

            // ── Strategy 2: DuckDuckGo Lite (regex fallback) ──
            if (!snippets.length) {
              try {
                const buf2 = await fetchBuffer(`https://lite.duckduckgo.com/lite/?q=${enc}`);
                const html2 = buf2.toString('utf8');
                // Try both old and new class names
                const titleRe = /<a[^>]+class="result-link"[^>]*>([\s\S]*?)<\/a>|<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
                const snipRe2 = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>|<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
                const titles = [...html2.matchAll(titleRe)].map(m => (m[1]||m[2]||'').replace(/<[^>]+>/g,'').trim()).filter(Boolean);
                const snips2 = [...html2.matchAll(snipRe2)].map(m => (m[1]||m[2]||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
                for (let i = 0; i < Math.min(5, titles.length); i++) {
                  if (titles[i]) snippets.push(`**${titles[i]}**\n${snips2[i] || ''}`);
                }
              } catch {}
            }

            // ── Strategy 3: DuckDuckGo Instant Answer API ──
            if (!snippets.length) {
              try {
                const ab = await fetchBuffer(`https://api.duckduckgo.com/?q=${enc}&format=json&no_html=1&skip_disambig=1`);
                const dd = JSON.parse(ab.toString('utf8'));
                if (dd.AbstractText) snippets.push(`**${dd.Heading || query}**\n${dd.AbstractText}`);
                (dd.RelatedTopics || []).slice(0, 4).forEach(t => { if (t.Text) snippets.push(t.Text); });
              } catch {}
            }

            const out = snippets.length
              ? `🔍 **${query}**\n\n${snippets.join('\n\n')}`
              : `🔍 No results found for: "${query}". Try rephrasing or use <action:fetch url="https://en.wikipedia.org/wiki/${enc}"/> for general topics.`;
            results.push({ raw: action.raw, result: out.slice(0, 3500) });
          } catch (e) {
            results.push({ raw: action.raw, result: `❌ Search failed: ${e.message}` });
          }
          break;
        }
        case 'python': {
          const code = action.body;
          if (!code) { results.push({ raw: action.raw, result: '❌ python: no code provided' }); break; }
          try {
            log(`🐍 python (${code.length} chars)`);
            const dataDir = resolveDir('data');
            const output = await callNative('runPython', { code, dataDir });
            send('filesChanged', {});
            results.push({ raw: action.raw, result: `✅ Python:\n${output.trim().slice(0, 2000) || '(no output)'}` });
          } catch (e) {
            results.push({ raw: action.raw, result: `❌ python error: ${e.message}` });
          }
          break;
        }

        case 'sqlite': {
          const sql = (action.attrs.sql || action.body || '').trim();
          const dbName = (action.attrs.db || 'agent.db').replace(/[^a-zA-Z0-9_.-]/g, '_');
          if (!sql) { results.push({ raw: action.raw, result: '❌ sqlite: no SQL provided' }); break; }
          const mode = action.attrs.mode || (sql.trim().toUpperCase().startsWith('SELECT') ? 'query' : 'exec');
          const dbPath = path.join(cfg.filesDir || resolveDir('db'), 'db', dbName);
          require('fs').mkdirSync(require('path').dirname(dbPath), { recursive: true });
          try {
            log(`🪶 sqlite ${mode}: ${sql.slice(0, 60)}`);
            const output = await callNative('runSQLite', { dbPath, sql, mode });
            results.push({ raw: action.raw, result: `✅ SQLite:\n${output}` });
          } catch (e) {
            results.push({ raw: action.raw, result: `❌ sqlite error: ${e.message}` });
          }
          break;
        }

        default:
          results.push({ raw: action.raw, result: `⚠️ Unknown action: ${action.type}` });
      }
    } catch (e) {
      results.push({ raw: action.raw, result: `❌ Action failed: ${e.message}` });
    }
  }
  return results;
}

function applyActionResults(text, results) {
  let out = text;
  for (const { raw, result } of results) out = out.replace(raw, result);
  return out.trim();
}

// Strip <think>...</think> blocks from user-visible output (log them internally)
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Strip any action blocks that weren't replaced (e.g. partial matches, unknown types)
function stripRemainingActions(text) {
  return text
    .replace(/<action:[^>]*\/>/g, '')
    .replace(/<action:[^>]*>[\s\S]*?<\/action>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function extractThinking(text) {
  const blocks = [];
  text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, t) => { blocks.push(t.trim()); return ''; });
  return blocks.join('\n---\n');
}

// ── Sub-agents ─────────────────────────────────────────────────────────────────

async function spawnSubagent(task, label, originChatId) {
  const id = `SA${(++taskCounter).toString().padStart(3, '0')}`;
  log(`🤖 Subagent ${id}: ${task.slice(0, 60)}`);

  // Fire and forget
  (async () => {
    try {
      const messages = [{ role: 'user', content: `SUBAGENT ${id}${label ? ` — ${label}` : ''}\nTask: ${task}\n\nExecute autonomously. Use action blocks. Be concise and report what you did.` }];
      const reply = await callAI(messages, false);
      const acts  = parseActions(reply);
      const res   = acts.length ? await executeActions(acts, originChatId) : [];
      const final = applyActionResults(stripThinking(reply), res);
      log(`🤖 Subagent ${id} complete`);
      if (telegramBot && cfg.telegram?.chatId)
        await sendTelegram(cfg.telegram.chatId, `🤖 *Subagent ${id}${label ? ` — ${label}` : ''}*\n\n${final.slice(0, 2000)}`);
    } catch (e) {
      log(`🤖 Subagent ${id} failed: ${e.message}`);
      if (telegramBot && cfg.telegram?.chatId)
        await sendTelegram(cfg.telegram.chatId, `🤖 *Subagent ${id} failed*: ${e.message}`);
    }
  })();

  return id;
}

// ── Cron system ────────────────────────────────────────────────────────────────

function parseCronExpr(schedule) {
  const s = schedule.trim().toLowerCase();

  // "every Xm / Xh / Xd"
  const every = s.match(/^every\s+(\d+)(m|h|d)$/);
  if (every) {
    const n  = parseInt(every[1]);
    const ms = every[2] === 'd' ? n * 86400000 : every[2] === 'h' ? n * 3600000 : n * 60000;
    return (now, lastRun) => !lastRun || (now - lastRun) >= ms;
  }

  // "daily HH:MM" or "daily 9am"
  const daily = s.match(/^daily\s+(\d+)(?::(\d+))?(am|pm)?$/);
  if (daily) {
    let hour = parseInt(daily[1]);
    const min = parseInt(daily[2] || '0');
    if (daily[3] === 'pm' && hour !== 12) hour += 12;
    if (daily[3] === 'am' && hour === 12)  hour  = 0;
    return (now) => {
      const d = new Date(now);
      return d.getHours() === hour && d.getMinutes() === min;
    };
  }

  // 5-field cron: "min hour dom mon dow"
  const parts = s.split(/\s+/);
  if (parts.length === 5) {
    const matchField = (field, val) => {
      if (field === '*') return true;
      if (field.startsWith('*/')) return val % parseInt(field.slice(2)) === 0;
      return field.split(',').map(Number).includes(val);
    };
    return (now) => {
      const d = new Date(now);
      return matchField(parts[0], d.getMinutes())  &&
             matchField(parts[1], d.getHours())    &&
             matchField(parts[2], d.getDate())     &&
             matchField(parts[3], d.getMonth() + 1) &&
             matchField(parts[4], d.getDay());
    };
  }

  return null;
}

function persistCron() {
  try { writeAgentFile('cron.json', JSON.stringify(cronJobs, null, 2)); } catch {}
}

function loadCron() {
  try {
    const saved = JSON.parse(readAgentFile('cron.json', '{}'));
    Object.assign(cronJobs, saved);
    cronCounter = Object.keys(cronJobs).length;
  } catch {}
}

function cronList() {
  const list = Object.values(cronJobs);
  if (!list.length) return 'No cron jobs yet.';
  return list.map(j =>
    `*${j.id}* ${j.enabled ? '✅' : '⏸'} \`${j.schedule}\` — ${j.name}\n  _${j.task.slice(0, 60)}_`
  ).join('\n\n');
}

async function checkCronJobs() {
  const now = Date.now();
  for (const job of Object.values(cronJobs)) {
    if (!job.enabled) continue;
    const checker = parseCronExpr(job.schedule);
    if (!checker || !checker(now, job.lastRun)) continue;

    job.lastRun = now;
    persistCron();
    log(`⏰ Cron "${job.name}": ${job.task.slice(0, 50)}`);

    try {
      const messages = [{ role: 'user', content: `CRON JOB: ${job.name}\nSchedule: ${job.schedule}\nTime: ${new Date().toLocaleString()}\n\n${job.task}\n\nExecute. Use action blocks.` }];
      const reply = await callAI(messages, false);
      const acts  = parseActions(reply);
      const res   = acts.length ? await executeActions(acts, job.chatId) : [];
      const final = applyActionResults(stripThinking(reply), res);

      if (job.chatId && telegramBot)
        await sendTelegram(job.chatId, `⏰ *Cron: ${job.name}*\n\n${final.slice(0, 2000)}`);
    } catch (e) {
      log(`⏰ Cron "${job.name}" failed: ${e.message}`);
    }
  }
}

function startCronRunner() {
  if (cronTimer) clearInterval(cronTimer);
  // Align to next full minute, then check every 60s
  const msToNext = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    checkCronJobs().catch(() => {});
    cronTimer = setInterval(() => checkCronJobs().catch(() => {}), 60000);
  }, msToNext);
}

function stopCronRunner() {
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
}

// ── Workspace search ───────────────────────────────────────────────────────────

function searchWorkspace(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const results = [];

  function scoreContent(fileLabel, content) {
    if (!content.trim()) return;
    const lower = content.toLowerCase();
    const score = terms.reduce((s, t) => s + (lower.split(t).length - 1), 0);
    if (!score) return;
    let snippet = '';
    for (const line of content.split('\n')) {
      if (terms.some(t => line.toLowerCase().includes(t))) { snippet = line.trim().slice(0, 200); break; }
    }
    results.push({ file: fileLabel, score, snippet: snippet || content.slice(0, 150) });
  }

  // Agent files
  for (const f of ['SOUL.md', 'AGENTS.md', 'context.md', 'user-profile.md', 'HEARTBEAT.md', 'BOOT.md'])
    try { scoreContent(`agent/${f}`, readAgentFile(f, '')); } catch {}

  // Memory logs (last 14 days)
  try {
    for (const f of fs.readdirSync(memoryDir()).filter(f => f.endsWith('.md')).slice(-14))
      try { scoreContent(`agent/memory/${f}`, readAgentFile(`memory/${f}`, '')); } catch {}
  } catch {}

  // Data files
  for (const f of listDataFiles('data').filter(f => /\.(md|txt|json|js)$/.test(f)))
    try { const c = readDataFile(f, 'data'); if (c) scoreContent(`data/${f}`, c); } catch {}

  return results.sort((a, b) => b.score - a.score).slice(0, 8);
}

// ── BOOT.md ritual ─────────────────────────────────────────────────────────────

async function runBootFile() {
  const bootMd = readAgentFile('BOOT.md', '').trim();
  if (!bootMd) return;
  const ai = cfg.ai || {};
  if (!ai.apiKey) {
    const acts = parseActions(bootMd);
    if (acts.length) { await executeActions(acts, null); log(`🚀 Boot: ${acts.length} actions (no AI)`); }
    return;
  }
  try {
    const messages = [{ role: 'user', content: `AGENT BOOT\nTime: ${new Date().toLocaleString()}\nModel: ${providerLabel()}\n\n${bootMd}\n\nExecute boot sequence with action blocks. Be brief.` }];
    const reply = await callAI(messages, false);
    const acts  = parseActions(reply);
    const res   = acts.length ? await executeActions(acts, null) : [];
    log(`🚀 Boot: ${applyActionResults(stripThinking(reply), res).slice(0, 80)}`);
  } catch (e) { log(`🚀 Boot error: ${e.message}`); }
}

// ── Task system ────────────────────────────────────────────────────────────────

function createTask(description, chatId) {
  const id = `T${String(++taskCounter).padStart(3, '0')}`;
  tasks[id] = { id, description, chatId, status: 'pending', created: ts(), updated: ts(), result: null };
  persistTasks();
  return id;
}

function updateTask(id, patch) {
  if (!tasks[id]) return;
  Object.assign(tasks[id], patch, { updated: ts() });
  persistTasks();
}

function abortTask(id) {
  if (!tasks[id]) return false;
  tasks[id].status = 'aborted';
  tasks[id].updated = ts();
  persistTasks();
  return true;
}

function persistTasks() { try { writeAgentFile('tasks.json', JSON.stringify(tasks, null, 2)); } catch {} }

function loadTasks() {
  try {
    const saved = JSON.parse(readAgentFile('tasks.json', '{}'));
    Object.assign(tasks, saved);
    taskCounter = Math.max(taskCounter, Object.keys(tasks).length);
  } catch {}
}

function taskList() {
  const list = Object.values(tasks).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 10);
  if (!list.length) return 'No tasks yet.';
  return list.map(t => `*${t.id}* [${t.status}] ${t.description.slice(0, 60)}`).join('\n');
}

async function runTask(taskId) {
  const task = tasks[taskId];
  if (!task) return;
  updateTask(taskId, { status: 'running' });
  log(`🔧 Task ${taskId}: ${task.description}`);
  try {
    const messages = [{ role: 'user', content: `TASK ${taskId}: ${task.description}\n\nExecute autonomously. Use action blocks. Report what you did.` }];
    const reply = await callAI(messages, false);
    const acts  = parseActions(reply);
    const res   = await executeActions(acts, task.chatId);
    const final = applyActionResults(stripThinking(reply), res);
    updateTask(taskId, { status: 'done', result: final.slice(0, 500) });
    if (telegramBot && cfg.telegram?.chatId)
      await sendTelegram(cfg.telegram.chatId, `✅ *Task ${taskId} complete*\n\n${final.slice(0, 3000)}`);
  } catch (e) {
    updateTask(taskId, { status: 'failed', result: e.message });
    if (telegramBot && cfg.telegram?.chatId)
      await sendTelegram(cfg.telegram.chatId, `❌ *Task ${taskId} failed*: ${e.message}`);
  }
}

// ── Heartbeat ──────────────────────────────────────────────────────────────────

function writeHealthFile() {
  const uptime   = Math.floor((Date.now() - startTime) / 1000);
  const inactive = Math.floor((Date.now() - lastActivity) / 1000);
  const beat = { ts: ts(), uptime, inactive,
    tasks: Object.values(tasks).filter(t => t.status === 'running').length,
    files: countFiles('data'), skills: countFiles('skills') };
  try { writeAgentFile('heartbeat.json', JSON.stringify(beat, null, 2)); } catch {}
  return beat;
}

async function runHeartbeatCycle() {
  const beat = writeHealthFile();
  log(`💓 Heartbeat | uptime:${beat.uptime}s | inactive:${beat.inactive}s | tasks:${beat.tasks}`);

  const ai = cfg.ai || {};
  if (!ai.apiKey) return;
  const heartbeatMd = readAgentFile('HEARTBEAT.md', '').trim();
  if (!heartbeatMd || !heartbeatMd.split('\n').some(l => l.startsWith('- '))) return;

  try {
    const inactive = Math.floor((Date.now() - lastActivity) / 1000);
    const messages = [{ role: 'user', content:
      `HEARTBEAT CYCLE\nTime: ${new Date().toLocaleString()}\nUptime: ${uptimeStr()}\n` +
      `User inactive: ${Math.floor(inactive / 60)} min\nPending tasks: ${Object.values(tasks).filter(t => t.status === 'pending').length}\n\n` +
      `${heartbeatMd}\n\nExecute due tasks. Reply HEARTBEAT_OK if nothing needed.` }];
    const reply = await callAI(messages, false);
    if (reply.trim() === 'HEARTBEAT_OK') { log(`💓 Heartbeat: idle`); return; }
    const acts  = parseActions(reply);
    const res   = acts.length ? await executeActions(acts, null) : [];
    const final = applyActionResults(stripThinking(reply), res);
    log(`💓 Heartbeat acted: ${final.slice(0, 100)}`);
    if (telegramBot && cfg.telegram?.chatId && !final.includes('QUIET') && acts.length > 0)
      await sendTelegram(cfg.telegram.chatId, `💓 *Heartbeat*\n\n${final.slice(0, 2000)}`);
  } catch (e) { log(`💓 Heartbeat error: ${e.message}`); }
}

function startHeartbeat() {
  if (healthTimer)    clearInterval(healthTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  healthTimer    = setInterval(writeHealthFile, 60 * 1000);
  heartbeatTimer = setInterval(() => runHeartbeatCycle().catch(e => log(`HB error: ${e.message}`)), 30 * 60 * 1000);
}

function stopHeartbeat() {
  if (healthTimer)    { clearInterval(healthTimer);    healthTimer    = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ── AI providers ───────────────────────────────────────────────────────────────

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      ...options,
      headers: { ...options.headers, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error(`Parse error: ${e.message} — ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', e => reject(new Error(`Network: ${e.message}`)));
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

// Convert a history message to provider-specific format, supporting image content.
// A message with an image has: { role, content: string, image: { base64, mime } }

function toClaudeMessages(messages) {
  return messages.map(m => {
    if (m.image) {
      const isPdf = m.image.mime === 'application/pdf';
      return {
        role: m.role,
        content: isPdf
          ? [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: m.image.base64 } },
              { type: 'text', text: m.content || 'Please analyze this document.' },
            ]
          : [
              { type: 'image', source: { type: 'base64', media_type: m.image.mime, data: m.image.base64 } },
              { type: 'text', text: m.content || 'What do you see in this image?' },
            ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAIMessages(messages, sys) {
  const out = [{ role: 'system', content: sys }];
  for (const m of messages) {
    if (m.image) {
      if (m.image.mime === 'application/pdf') {
        // OpenAI doesn't support inline PDF base64 — pass as text note
        out.push({ role: m.role, content: `[User sent a PDF. ${m.content || 'Please note the file cannot be read directly via this interface.'}]` });
      } else {
        out.push({
          role: m.role,
          content: [
            { type: 'image_url', image_url: { url: `data:${m.image.mime};base64,${m.image.base64}` } },
            { type: 'text', text: m.content || 'What do you see in this image?' },
          ],
        });
      }
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function toGeminiContents(messages) {
  return messages.map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (m.image) {
      const defaultPrompt = m.image.mime === 'application/pdf'
        ? 'Please analyze this document.'
        : 'What do you see in this image?';
      return {
        role,
        parts: [
          { inline_data: { mime_type: m.image.mime, data: m.image.base64 } },
          { text: m.content || defaultPrompt },
        ],
      };
    }
    return { role, parts: [{ text: m.content }] };
  });
}

async function callClaude(messages, sys, key, model) {
  const { body } = await httpsPost({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  }, JSON.stringify({ model, max_tokens: 8192, system: sys, messages: toClaudeMessages(messages) }));
  if (body.error) throw new Error(`Claude: ${body.error.message || body.error.type}`);
  return body.content[0].text;
}

async function callOpenAI(messages, sys, key, model) {
  const { body } = await httpsPost({
    hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
  }, JSON.stringify({ model, max_tokens: 8192, messages: toOpenAIMessages(messages, sys) }));
  if (body.error) throw new Error(`OpenAI: ${body.error.message}`);
  return body.choices[0].message.content;
}

async function callGemini(messages, sys, key, model) {
  const { body } = await httpsPost({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${model}:generateContent?key=${key}`, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({
    system_instruction: { parts: [{ text: sys }] },
    contents: toGeminiContents(messages),
    generationConfig: { maxOutputTokens: 8192 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  }));
  if (body.error) throw new Error(`Gemini: ${body.error.message}`);
  const candidate = body.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = candidate?.finishReason;
    // STOP with no text = safety block or empty model output — check promptFeedback
    const blockReason = body.promptFeedback?.blockReason;
    if (blockReason) throw new Error(`Gemini: content blocked (${blockReason})`);
    if (reason === 'STOP' || reason === 'MAX_TOKENS') {
      // Model chose to output nothing — return a soft fallback rather than crashing
      return "I couldn't generate a response for that. Could you rephrase or provide more context?";
    }
    throw new Error(`Gemini: empty response (finishReason: ${reason || 'unknown'})`);
  }
  return text;
}

// ── Telegram image download ─────────────────────────────────────────────────────

async function downloadTelegramFile(fileId, knownMime) {
  const token = cfg.telegram?.botToken;
  if (!token) throw new Error('No bot token');

  // 1. Get file path from Telegram
  const metaBuf = await fetchBuffer(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const meta = JSON.parse(metaBuf.toString('utf8'));
  if (!meta.ok) throw new Error(`getFile failed: ${meta.description}`);
  const filePath = meta.result.file_path;

  // 2. Download the file
  const buf = await fetchBuffer(`https://api.telegram.org/file/bot${token}/${filePath}`);

  // 3. Determine MIME type
  let mime = knownMime;
  if (!mime) {
    const ext = filePath.split('.').pop().toLowerCase();
    mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
         : ext === 'png'  ? 'image/png'
         : ext === 'webp' ? 'image/webp'
         : ext === 'gif'  ? 'image/gif'
         : ext === 'pdf'  ? 'application/pdf'
         : 'image/jpeg';
  }

  return { base64: buf.toString('base64'), mime };
}

// Backwards-compat alias
const downloadTelegramImage = (fileId) => downloadTelegramFile(fileId, null);

async function callAI(messages, useFullSystem = true) {
  const { provider, model, apiKey } = cfg.ai || {};
  const sys = useFullSystem ? buildSystemPrompt() : `You are MoltDroid, a helpful AI agent. Today: ${new Date().toDateString()}.`;
  log(`🧠 ${provider}/${model} (${messages.length} msgs)`);
  switch (provider) {
    case 'anthropic': return callClaude(messages, sys, apiKey, model);
    case 'openai':    return callOpenAI(messages, sys, apiKey, model);
    case 'google':    return callGemini(messages, sys, apiKey, model);
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}

// ── Model shortcuts ────────────────────────────────────────────────────────────

const MODEL_SHORTCUTS = {
  'haiku':           { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  'sonnet':          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'opus':            { provider: 'anthropic', model: 'claude-opus-4-6' },
  'gpt-4o-mini':     { provider: 'openai',    model: 'gpt-4o-mini' },
  'gpt-4o':          { provider: 'openai',    model: 'gpt-4o' },
  'gemini-flash':    { provider: 'google',    model: 'gemini-2.5-flash' },
  'gemini-2.5-flash':{ provider: 'google',    model: 'gemini-2.5-flash' },
  'gemini-pro':      { provider: 'google',    model: 'gemini-1.5-pro' },
  'gemini-1.5-flash':{ provider: 'google',    model: 'gemini-1.5-flash' },
};

function parseModelArg(arg) {
  arg = arg.trim().toLowerCase();
  if (MODEL_SHORTCUTS[arg]) return MODEL_SHORTCUTS[arg];
  if (arg.includes('/')) { const [p, ...r] = arg.split('/'); return { provider: p, model: r.join('/') }; }
  const found = Object.entries(MODEL_SHORTCUTS).find(([k]) => k.includes(arg) || arg.includes(k));
  return found ? found[1] : null;
}

// ── Conversation history ───────────────────────────────────────────────────────

function getHistory(chatId)       { if (!chatHistories[chatId]) chatHistories[chatId] = []; return chatHistories[chatId]; }
function appendHistory(chatId, role, content, image = null) {
  const h = getHistory(chatId);
  const entry = { role, content };
  if (image) entry.image = image;
  h.push(entry);
  while (h.length > MAX_HISTORY) h.shift();
  while (h.length > 0 && h[0].role !== 'user') h.shift();
}
function clearHistory(chatId) {
  chatHistories[chatId] = [];
  try { writeAgentFile(`session-${chatId}.jsonl`, ''); } catch {}
}
function saveHistory(chatId) {
  const h = chatHistories[chatId];
  if (!h?.length) return;
  try { writeAgentFile(`session-${chatId}.jsonl`, h.map(m => JSON.stringify(m)).join('\n')); } catch {}
}
function loadHistory(chatId) {
  try {
    const raw = readAgentFile(`session-${chatId}.jsonl`, '').trim();
    if (!raw) return;
    chatHistories[chatId] = raw.split('\n').map(l => JSON.parse(l)).filter(Boolean);
  } catch {}
}

// ── Compact ────────────────────────────────────────────────────────────────────

async function compactHistory(chatId, instructions = '') {
  const h = getHistory(chatId);
  if (h.length < 6) return 'Nothing to compact.';
  const keep  = 4;
  const toSum = h.slice(0, h.length - keep);
  const recent = h.slice(h.length - keep);
  const transcript = toSum.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  const prompt = instructions
    ? `Summarize this conversation. Focus on: ${instructions}\n\n${transcript}`
    : `Summarize this conversation concisely. Capture key facts, decisions, files created, and context.\n\n${transcript}`;
  const summary = await callAI([{ role: 'user', content: prompt }], false);
  chatHistories[chatId] = [
    { role: 'user',      content: `[Earlier conversation summary]\n${summary}` },
    { role: 'assistant', content: 'Understood. I have the summary of our earlier conversation.' },
    ...recent,
  ];
  saveHistory(chatId);
  return summary;
}

async function autoCompact(chatId) {
  const h = getHistory(chatId);
  if (h.length < AUTO_COMPACT_AT) return;
  log(`🗜 Auto-compacting history for ${chatId} (${h.length} msgs)`);
  try { await compactHistory(chatId); } catch {}
}

// ── Context report ─────────────────────────────────────────────────────────────

function buildContextReport() {
  const files = [
    { name: 'SOUL.md',         label: 'Soul/Persona' },
    { name: 'AGENTS.md',       label: 'Agent Rules' },
    { name: 'user-profile.md', label: 'User Profile' },
    { name: 'context.md',      label: 'Persistent Memory' },
    { name: 'HEARTBEAT.md',    label: 'Heartbeat Tasks' },
    { name: 'BOOT.md',         label: 'Boot Sequence' },
  ];
  const today = todayKey(), yest = yesterdayKey();
  let report = `🔍 *Context Inspector*\n\n`;
  for (const { name, label } of files) {
    const c = readAgentFile(name, '');
    report += `*${label}* (\`${name}\`): ${c.trim() ? `${c.trim().split('\n').length} lines` : '_empty_'}\n`;
  }
  const tl = readDailyLog(today), yl = readDailyLog(yest);
  report += `\n*Today's log*: ${tl ? `${tl.length} chars` : '_empty_'}\n`;
  report += `*Yesterday's log*: ${yl ? `${yl.length} chars` : '_empty_'}\n`;
  report += `\n*AI:* ${providerLabel()} | *History:* ${getHistory(cfg.telegram?.chatId || '0').length} msgs\n`;
  report += `*Skills:* ${listDataFiles('skills').filter(f => f.endsWith('.js')).length}\n`;
  report += `*Cron jobs:* ${Object.keys(cronJobs).length}\n`;
  report += `\nUse /read agent/SOUL.md to view any file.`;
  return report;
}

// ── Hatch system ───────────────────────────────────────────────────────────────

const HATCH_STEPS = [
  { key: 'name',    prompt: `👋 *Welcome! I'm MoltDroid — your autonomous Android AI agent.*\n\nBefore we start, let me learn about you.\n\n*What's your name?*` },
  { key: 'tone',    prompt: (name) => `Nice to meet you, *${name}*!\n\n*How would you like me to communicate?*\n\n1️⃣ Casual & friendly\n2️⃣ Professional & precise\n3️⃣ Technical & detailed` },
  { key: 'purpose', prompt: `*What do you primarily use me for?*\n_(automation, reminders, coding, research, etc.)_` },
  { key: 'extra',   prompt: `*Any special instructions?*\n_(e.g. "reply in German", "keep it short" — or "none")_` },
];
const TONE_MAP = { '1': 'casual and friendly', '2': 'professional and precise', '3': 'technical and detailed' };

function isHatching(chatId) { return hatchState[chatId] !== undefined; }

async function startHatch(chatId) {
  hatchState[chatId] = { step: 0, data: {} };
  await sendTelegram(chatId, HATCH_STEPS[0].prompt);
}

async function handleHatchInput(chatId, text) {
  const state = hatchState[chatId];
  const step  = HATCH_STEPS[state.step];
  state.data[step.key] = text.trim();
  state.step++;
  if (state.step < HATCH_STEPS.length) {
    const next   = HATCH_STEPS[state.step];
    const prompt = typeof next.prompt === 'function' ? next.prompt(state.data.name) : next.prompt;
    await sendTelegram(chatId, prompt);
  } else {
    const d = state.data;
    const tone = TONE_MAP[d.tone] || d.tone;
    writeAgentFile('user-profile.md', [
      `# User Profile`, ``,
      `**Name:** ${d.name}`,
      `**Communication style:** ${tone}`,
      `**Primary use:** ${d.purpose}`,
      `**Special instructions:** ${d.extra === 'none' ? 'None' : d.extra}`,
      ``, `_Profile created: ${new Date().toLocaleString()}_`,
    ].join('\n'));
    delete hatchState[chatId];
    log(`🐣 Hatch complete for ${chatId}`);
    await sendTelegram(chatId, `✅ *All set, ${d.name}!*\n\nProfile saved. Update anytime with /hatch.\nSend /help to see what I can do.`);
  }
}

// ── Telegram helpers ───────────────────────────────────────────────────────────

async function sendTelegram(chatId, text, extra = {}) {
  if (!telegramBot) return;
  try {
    for (let i = 0; i < text.length; i += 4000)
      await telegramBot.sendMessage(chatId, text.slice(i, i + 4000), { parse_mode: 'Markdown', ...extra });
  } catch {
    try { await telegramBot.sendMessage(chatId, text.replace(/[*_`\[\]()~>#+=|{}.!]/g, '\\$&').slice(0, 4000)); } catch {}
  }
}

function providerLabel() { const ai = cfg.ai || {}; return `${ai.provider}/${ai.model}`; }

function uptimeStr() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

// ── Telegram commands ──────────────────────────────────────────────────────────

const HELP_TEXT = `⬡ *MoltDroid v2.9*

*Agent*
/status · /restart · /hatch · /whoami

*AI*
/model [name] — switch model
/btw <question> — ephemeral question

*Tasks*
/tasks · /newtask <desc> · /abort <id>

*Cron*
/cron — list jobs
/cron add <schedule> | <task> — add job
/cron rm <id> — remove job
/cron pause <id> · /cron run <id>

*Files*
/files · /read <path> · /write <path> | <content>

*Skills*
/skills · /skill <name> · /newskill <name>

*Memory*
/memory · /remember <text> · /search <query>
/tokens — context usage · /compact [focus]
/context · /clear · /new

*Workspace*
/soul · /agents · /heartbeat · /pulse

*Canvas*
/canvas — show current canvas
/canvas clear — hide canvas

*Device*
/notify <title> | <message>

/help — this message`;

async function handleCommand(cmd, args, chatId) {
  lastActivity = Date.now();

  switch (cmd) {

    case '/start':
    case '/status': {
      const profile     = getUserProfile();
      const name        = profile.match(/\*\*Name:\*\* (.+)/)?.[1] || 'User';
      const activeTasks = Object.values(tasks).filter(t => t.status === 'running').length;
      const cronCount   = Object.values(cronJobs).filter(j => j.enabled).length;
      await sendTelegram(chatId,
        `🦞 *MoltDroid Online*\n\n` +
        `👤 ${name} | 🤖 ${providerLabel()}\n` +
        `⏱ ${uptimeStr()} | 📁 ${countFiles('data')} files · ⚡ ${countFiles('skills')} skills\n` +
        `🔧 ${activeTasks} running · ${Object.keys(tasks).length} tasks · ⏰ ${cronCount} crons\n\n` +
        `/help for commands`
      );
      break;
    }

    case '/help': await sendTelegram(chatId, HELP_TEXT); break;

    case '/restart':
      await sendTelegram(chatId, '🔄 Restarting...');
      stopHeartbeat(); stopCronRunner();
      if (telegramBot) { try { telegramBot.stopPolling(); } catch {} telegramBot = null; }
      if (server) { server.close(() => {}); server = null; }
      running = false; send('status', 'stopped');
      setTimeout(() => startGateway(), 1000);
      break;

    // ── Model ────────────────────────────────────────────────────────────────

    case '/model': {
      const arg = args.trim();
      if (!arg) {
        await sendTelegram(chatId,
          `🧠 *Current:* \`${providerLabel()}\`\n\n*Shortcuts:* ${Object.keys(MODEL_SHORTCUTS).join(' · ')}\n*Or:* provider/model-id`);
        break;
      }
      const parsed = parseModelArg(arg);
      if (!parsed) { await sendTelegram(chatId, `❌ Unknown model: \`${arg}\``); break; }
      const prev = providerLabel();
      cfg.ai = { ...cfg.ai, ...parsed };
      log(`🧠 Model: ${prev} → ${providerLabel()}`);
      await sendTelegram(chatId, `🧠 Switched to \`${providerLabel()}\``);
      break;
    }

    // ── /btw — ephemeral ──────────────────────────────────────────────────────

    case '/btw': {
      if (!args.trim()) { await sendTelegram(chatId, 'Usage: /btw your question'); break; }
      try {
        const ctx = getHistory(chatId).slice(-6);
        const reply = await callAI([...ctx, { role: 'user', content: `[Ephemeral — do not save to memory]: ${args.trim()}` }]);
        await sendTelegram(chatId, `💬 ${reply.slice(0, 2000)}`);
      } catch (e) { await sendTelegram(chatId, `❌ ${e.message}`); }
      break;
    }

    // ── Cron ──────────────────────────────────────────────────────────────────

    case '/cron': {
      const sub = args.trim().split(' ')[0];

      if (!sub) {
        await sendTelegram(chatId, `⏰ *Cron Jobs*\n\n${cronList()}\n\nAdd: /cron add every 1h | write a journal entry`);
        break;
      }

      if (sub === 'add') {
        const rest = args.trim().slice(4).trim();
        const sep  = rest.indexOf('|');
        if (sep === -1) { await sendTelegram(chatId, 'Usage: /cron add <schedule> | <task description>\n\nSchedules: `every 30m` · `every 2h` · `daily 9am` · `0 9 * * 1` (Mon 9am)'); break; }
        const schedule = rest.slice(0, sep).trim();
        const task     = rest.slice(sep + 1).trim();
        if (!parseCronExpr(schedule)) { await sendTelegram(chatId, `❌ Invalid schedule: \`${schedule}\`\nTry: every 1h · daily 8am · 0 9 * * *`); break; }
        const id = `C${String(++cronCounter).padStart(3, '0')}`;
        const name = task.slice(0, 40);
        cronJobs[id] = { id, name, schedule, task, chatId, enabled: true, lastRun: null, created: ts() };
        persistCron();
        await sendTelegram(chatId, `✅ *Cron ${id} created*\nSchedule: \`${schedule}\`\nTask: _${name}_`);
        break;
      }

      const id  = args.trim().split(' ')[1]?.toUpperCase();
      if (!id) { await sendTelegram(chatId, 'Usage: /cron rm|pause|run <ID>'); break; }

      if (sub === 'rm' || sub === 'remove') {
        if (!cronJobs[id]) { await sendTelegram(chatId, `❌ ${id} not found`); break; }
        delete cronJobs[id]; persistCron();
        await sendTelegram(chatId, `🗑 Cron ${id} removed`);
        break;
      }
      if (sub === 'pause' || sub === 'disable') {
        if (!cronJobs[id]) { await sendTelegram(chatId, `❌ ${id} not found`); break; }
        cronJobs[id].enabled = false; persistCron();
        await sendTelegram(chatId, `⏸ Cron ${id} paused`);
        break;
      }
      if (sub === 'resume' || sub === 'enable') {
        if (!cronJobs[id]) { await sendTelegram(chatId, `❌ ${id} not found`); break; }
        cronJobs[id].enabled = true; persistCron();
        await sendTelegram(chatId, `▶️ Cron ${id} resumed`);
        break;
      }
      if (sub === 'run') {
        if (!cronJobs[id]) { await sendTelegram(chatId, `❌ ${id} not found`); break; }
        await sendTelegram(chatId, `⏰ Running cron ${id} now...`);
        const job = cronJobs[id];
        job.lastRun = Date.now(); persistCron();
        try {
          const messages = [{ role: 'user', content: `CRON JOB: ${job.name}\n${job.task}\n\nExecute now.` }];
          const reply = await callAI(messages, false);
          const acts  = parseActions(reply);
          const res   = acts.length ? await executeActions(acts, chatId) : [];
          await sendTelegram(chatId, `✅ Cron ${id} done:\n${applyActionResults(stripThinking(reply), res).slice(0, 2000)}`);
        } catch (e) { await sendTelegram(chatId, `❌ Cron ${id} failed: ${e.message}`); }
        break;
      }

      await sendTelegram(chatId, 'Usage: /cron · /cron add · /cron rm · /cron pause · /cron run');
      break;
    }

    // ── Tasks ─────────────────────────────────────────────────────────────────

    case '/abort': {
      const id = args.trim().toUpperCase();
      if (!id) { await sendTelegram(chatId, 'Usage: /abort T001'); break; }
      await sendTelegram(chatId, abortTask(id) ? `⛔ Task ${id} aborted` : `❌ Task ${id} not found`);
      break;
    }
    case '/tasks': await sendTelegram(chatId, `📋 *Tasks*\n\n${taskList()}`); break;
    case '/newtask': {
      if (!args.trim()) { await sendTelegram(chatId, 'Usage: /newtask describe the task'); break; }
      const id = createTask(args.trim(), chatId);
      await sendTelegram(chatId, `🔧 *Task ${id}*\n_${args.trim().slice(0, 80)}_\n\nRunning...`);
      runTask(id).catch(e => log(`Task error: ${e.message}`));
      break;
    }

    // ── Files ─────────────────────────────────────────────────────────────────

    case '/files': {
      const data = listDataFiles('data'), skills = listDataFiles('skills');
      let msg = `📁 *Files*\n\n*data/* (${data.length})\n`;
      msg += data.length   ? data.map(f => `  📄 ${f}`).join('\n')   : '  _empty_';
      msg += `\n\n*skills/* (${skills.length})\n`;
      msg += skills.length ? skills.map(f => `  ⚡ ${f}`).join('\n') : '  _empty_';
      await sendTelegram(chatId, msg);
      break;
    }

    case '/read': {
      const fname = args.trim();
      if (!fname) { await sendTelegram(chatId, 'Usage: /read data/file.txt or /read agent/SOUL.md'); break; }
      if (fname.startsWith('agent/')) {
        const c = readAgentFile(fname.slice(6), null);
        await sendTelegram(chatId, c !== null ? `📄 *${fname}*\n\`\`\`\n${c.slice(0, 3500)}\n\`\`\`` : `❌ Not found: ${fname}`);
        break;
      }
      const parts = fname.includes('/') ? fname.split('/') : ['data', fname];
      const c = readDataFile(parts.slice(1).join('/'), parts[0]);
      await sendTelegram(chatId, c !== null ? `📄 *${fname}*\n\`\`\`\n${c.slice(0, 3500)}\n\`\`\`` : `❌ Not found: ${fname}`);
      break;
    }

    case '/write': {
      const sep = args.indexOf('|');
      if (sep === -1) { await sendTelegram(chatId, 'Usage: /write path | content'); break; }
      const fname = args.slice(0, sep).trim(), content = args.slice(sep + 1).trim();
      if (fname.startsWith('agent/')) { writeAgentFile(fname.slice(6), content); }
      else { const p = fname.includes('/') ? fname.split('/') : ['data', fname]; writeDataFile(p.slice(1).join('/'), content, p[0]); }
      log(`📄 Written: ${fname}`);
      await sendTelegram(chatId, `✅ Written: \`${fname}\` (${content.length} bytes)`);
      break;
    }

    // ── Skills ────────────────────────────────────────────────────────────────

    case '/skills': {
      const jsSkills2 = listDataFiles('skills').filter(f => f.endsWith('.js'));
      const mdSkills2 = listDataFiles('skills').filter(f => f.endsWith('.md'));
      let msg2 = `⚡ *Skills*\n`;
      if (jsSkills2.length) msg2 += `\n*Runnable (JS):*\n${jsSkills2.map(s => `  • ${s.replace('.js','')}`).join('\n')}\n`;
      if (mdSkills2.length) msg2 += `\n*Knowledge (ClawHub):*\n${mdSkills2.map(s => `  📖 ${s.replace('.md','')}`).join('\n')}\n`;
      if (!jsSkills2.length && !mdSkills2.length) msg2 = '⚡ No skills installed.\n\nInstall one: /skill install weather\nCreate one: /newskill my_skill';
      else msg2 += `\nInstall from ClawHub: /skill install <slug>`;
      await sendTelegram(chatId, msg2);
      break;
    }
    case '/skill': {
      const skillArgs = args.trim();
      // Detect install intent: "install <x>", a URL, or a plain slug (not an existing JS skill)
      const urlMatch = skillArgs.match(/https?:\/\/\S+/);
      const isInstall = skillArgs.startsWith('install ') || !!urlMatch;
      if (isInstall) {
        // Extract the actual target: URL from anywhere in args, or the word after "install"
        const target = urlMatch ? urlMatch[0] : skillArgs.slice(skillArgs.indexOf(' ') + 1).trim();
        await sendTelegram(chatId, `⏳ Downloading skill: \`${target}\`…`);
        try {
          if (target.includes('clawhub.ai/') || !target.startsWith('http')) {
            const info = await downloadSkillFromClawhub(target);
            const cmds = extractSkillCommands(readDataFile(`${info.slug}.md`, 'skills') || '');
            const cmdNote = cmds.length ? `\n📋 Registered ${cmds.length} command(s): ${cmds.map(c => `/${c.command}`).join(', ')}` : '';
            await sendTelegram(chatId, `✅ *${info.displayName}* installed!\n_${info.summary || ''}_${cmdNote}\nThe agent will use it in future responses.`);
          } else {
            const info = await downloadSkillFromUrl(target);
            await sendTelegram(chatId, `✅ Skill \`${info.slug}\` installed!\nThe agent will use it in future responses.`);
          }
        } catch (e) { await sendTelegram(chatId, `❌ Install failed: ${e.message}`); }
        break;
      }
      // /skill <name> — run a JS skill
      const name = skillArgs;
      if (!name) { await sendTelegram(chatId, 'Usage:\n• /skill install <clawhub-slug>\n• /skill install <url>\n• /skill <js-skill-name>'); break; }
      try {
        const p = path.join(resolveDir('skills'), `${name}.js`);
        if (!fs.existsSync(p)) throw new Error(`JS skill "${name}" not found`);
        delete require.cache[require.resolve(p)];
        const skill = require(p);
        if (typeof skill.run !== 'function') throw new Error('Skill must export run()');
        const result = await Promise.resolve(skill.run({}, { log, send, cfg, writeDataFile, readDataFile, listDataFiles }));
        await sendTelegram(chatId, `✅ Skill *${name}*:\n${JSON.stringify(result, null, 2).slice(0, 1000)}`);
      } catch (e) { await sendTelegram(chatId, `❌ Skill error: ${e.message}`); }
      break;
    }
    case '/newskill': {
      const name = args.trim();
      if (!name) { await sendTelegram(chatId, 'Usage: /newskill skill_name\nThen send JS code.'); break; }
      chatHistories[`__newskill_${chatId}`] = name;
      await sendTelegram(chatId, `⚡ Creating skill: *${name}*\n\nSend JS code:\n\`\`\`js\nmodule.exports.run = async (args, ctx) => {\n  return { done: true };\n};\n\`\`\``);
      break;
    }

    // ── Memory ────────────────────────────────────────────────────────────────

    case '/memory': {
      const mem = readAgentFile('memory.md', '_No memories yet._');
      await sendTelegram(chatId, `🧠 *Long-Term Memory*\n\n${mem.slice(0, 3500)}`);
      break;
    }
    case '/remember': {
      if (!args.trim()) { await sendTelegram(chatId, 'Usage: /remember something important'); break; }
      const existing = readAgentFile('memory.md', '# Long-Term Memory\n\n');
      writeAgentFile('memory.md', existing + `\n## ${new Date().toLocaleString()}\n${args.trim()}\n`);
      await sendTelegram(chatId, `🧠 Remembered: _${args.trim().slice(0, 100)}_`);
      break;
    }

    case '/search': {
      if (!args.trim()) { await sendTelegram(chatId, 'Usage: /search query terms'); break; }
      const results = searchWorkspace(args.trim());
      if (!results.length) { await sendTelegram(chatId, `🔍 No results for: _${args.trim()}_`); break; }
      let msg = `🔍 *Search: "${args.trim()}"*\n\n`;
      msg += results.map(r => `*${r.file}* (score: ${r.score})\n_${r.snippet}_`).join('\n\n');
      await sendTelegram(chatId, msg.slice(0, 3500));
      break;
    }

    case '/tokens': {
      const sys = buildSystemPrompt();
      const h   = getHistory(chatId);
      const histText = h.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const sysTokens  = Math.ceil(sys.length / 4);
      const histTokens = Math.ceil(histText.length / 4);
      const total = sysTokens + histTokens;
      const model = cfg.ai?.model || '';
      const contextWindow = model.includes('gemini') ? 1000000 : model.includes('gpt') ? 128000 : 200000;
      const pct  = Math.min(100, Math.round((total / contextWindow) * 100));
      const bars = Math.round(pct / 10);
      const bar  = '█'.repeat(bars) + '░'.repeat(10 - bars);
      let msg = `📊 *Token Usage*\n\n`;
      msg += `\`${bar}\` ${pct}%\n\n`;
      msg += `System prompt: ~${sysTokens.toLocaleString()} tokens\n`;
      msg += `Conversation: ~${histTokens.toLocaleString()} tokens (${h.length} msgs)\n`;
      msg += `Total: ~${total.toLocaleString()} / ${(contextWindow / 1000).toFixed(0)}k\n`;
      msg += `Remaining: ~${Math.max(0, contextWindow - total).toLocaleString()} tokens\n`;
      msg += `\nModel: \`${providerLabel()}\``;
      if (pct > 60) msg += `\n\n💡 Use /compact to free up context`;
      await sendTelegram(chatId, msg);
      break;
    }

    case '/compact': {
      const h = getHistory(chatId);
      if (h.length < 6) { await sendTelegram(chatId, `💬 Only ${h.length} messages — nothing to compact.`); break; }
      await sendTelegram(chatId, `🗜 Compacting ${h.length - 4} messages...`);
      try {
        const summary = await compactHistory(chatId, args.trim());
        await sendTelegram(chatId, `✅ *Compacted* → ${getHistory(chatId).length} messages\n\n*Summary:*\n${summary.slice(0, 1000)}`);
      } catch (e) { await sendTelegram(chatId, `❌ Compact failed: ${e.message}`); }
      break;
    }

    case '/context': await sendTelegram(chatId, buildContextReport()); break;

    case '/clear':
    case '/new': clearHistory(chatId); await sendTelegram(chatId, '🆕 Fresh session started.'); break;

    // ── Workspace editors ─────────────────────────────────────────────────────

    case '/soul': {
      if (args.trim()) { writeAgentFile('SOUL.md', args.trim()); await sendTelegram(chatId, `✅ SOUL.md updated`); }
      else { await sendTelegram(chatId, `🎭 *SOUL.md*\n\n${readAgentFile('SOUL.md', '_empty_').slice(0, 3500)}\n\nEdit: /soul <content>`); }
      break;
    }
    case '/agents': {
      if (args.trim()) { writeAgentFile('AGENTS.md', args.trim()); await sendTelegram(chatId, `✅ AGENTS.md updated`); }
      else { await sendTelegram(chatId, `📋 *AGENTS.md*\n\n${readAgentFile('AGENTS.md', '_empty_').slice(0, 3500)}\n\nEdit: /agents <content>`); }
      break;
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────────

    case '/heartbeat': {
      const hb = readAgentFile('HEARTBEAT.md', HEARTBEAT_DEFAULT);
      await sendTelegram(chatId, `💓 *Heartbeat* _(every 30 min)_\n\n${hb.slice(0, 3000)}\n\nEdit: /write agent/HEARTBEAT.md | tasks`);
      break;
    }
    case '/pulse':
      await sendTelegram(chatId, '💓 Running heartbeat...');
      runHeartbeatCycle()
        .then(() => sendTelegram(chatId, '✅ Done.'))
        .catch(e => sendTelegram(chatId, `❌ ${e.message}`));
      break;

    // ── Canvas ────────────────────────────────────────────────────────────────

    case '/canvas': {
      if (args.trim().toLowerCase() === 'clear') {
        send('canvas', { clear: true });
        await sendTelegram(chatId, '🖼 Canvas cleared');
      } else {
        await sendTelegram(chatId, '🖼 Use action blocks to push content:\n`<action:canvas title="My Page">HTML here</action>`\nor `<action:canvas url="https://..."/>`');
      }
      break;
    }

    // ── Notifications ─────────────────────────────────────────────────────────

    case '/notify': {
      const sep   = args.indexOf('|');
      const title = sep === -1 ? 'MoltDroid'            : args.slice(0, sep).trim();
      const body  = sep === -1 ? args.trim()             : args.slice(sep + 1).trim();
      if (!body) { await sendTelegram(chatId, 'Usage: /notify title | message'); break; }
      send('device', { command: 'notify', title, body });
      log(`🔔 Notification: ${title}`);
      await sendTelegram(chatId, `🔔 Notification sent: _"${title}"_`);
      break;
    }

    // ── Profile ───────────────────────────────────────────────────────────────

    case '/hatch': await startHatch(chatId); break;
    case '/whoami': {
      const p = getUserProfile();
      await sendTelegram(chatId, p ? `👤 *Your Profile*\n\n${p}` : `No profile yet. Run /hatch.`);
      break;
    }

    default: await sendTelegram(chatId, `Unknown command. /help for the full list.`);
  }
}

// ── Telegram bot ───────────────────────────────────────────────────────────────

function startTelegram() {
  const t = cfg.telegram;
  if (!t?.botToken) { log('💬 Telegram not configured'); return; }

  try {
    const TelegramBot = require('node-telegram-bot-api');
    telegramBot = new TelegramBot(t.botToken, { polling: true });

    telegramBot.on('message', async (msg) => {
      const fromId = String(msg.chat.id);

      // Auto-register the first user who messages the bot
      if (!cfg.telegram.chatId) {
        cfg.telegram.chatId = fromId;
        // Persist back to React Native so it survives restarts
        send('saveChatId', { chatId: fromId });
        log(`💬 Telegram: auto-registered chat ID ${fromId}`);
        await sendTelegram(fromId, '👋 Hello! I\'m your MoltDroid agent. I\'ve registered your chat — you\'re all set!');
      }

      if (fromId !== String(cfg.telegram.chatId)) return;

      // Detect photo/image
      let imageData = null;
      if (msg.photo && msg.photo.length > 0) {
        // Telegram sends multiple sizes; pick the largest
        const largest = msg.photo[msg.photo.length - 1];
        try {
          imageData = await downloadTelegramImage(largest.file_id);
          log(`🖼 Telegram [${fromId}]: received photo (${largest.width}x${largest.height})`);
        } catch (e) { log(`🖼 Photo download failed: ${e.message}`); }
      } else if (msg.document && msg.document.mime_type) {
        const docMime = msg.document.mime_type;
        if (docMime.startsWith('image/') || docMime === 'application/pdf') {
          try {
            imageData = await downloadTelegramFile(msg.document.file_id, docMime);
            log(`📎 Telegram [${fromId}]: received document (${docMime})`);
          } catch (e) { log(`📎 Document download failed: ${e.message}`); }
        }
      }

      const rawText = (msg.text || msg.caption || '').trim();
      // For documents with no caption, provide a default prompt so the agent processes them
      const text = (!rawText && imageData)
        ? (imageData.mime === 'application/pdf' ? 'Please read and summarize this document.' : 'What do you see in this image?')
        : rawText;
      if (!text && !imageData) return;

      lastActivity = Date.now();
      log(`💬 Telegram [${fromId}]: ${text.slice(0, 80)}`);

      // Pending /newskill
      const pendingSkill = chatHistories[`__newskill_${fromId}`];
      if (pendingSkill && text) {
        delete chatHistories[`__newskill_${fromId}`];
        try {
          fs.writeFileSync(path.join(resolveDir('skills'), `${pendingSkill}.js`), text, 'utf8');
          await sendTelegram(fromId, `✅ Skill *${pendingSkill}* saved! Run: /skill ${pendingSkill}`);
        } catch (e) { await sendTelegram(fromId, `❌ ${e.message}`); }
        return;
      }

      // Hatch
      if (isHatching(fromId) && text) { await handleHatchInput(fromId, text); return; }

      // Commands (text only)
      if (text.startsWith('/') && !imageData) {
        const parts = text.split(' ');
        await handleCommand(parts[0].split('@')[0], parts.slice(1).join(' '), fromId);
        return;
      }

      // Restore history on first contact
      if (!chatHistories[fromId]) loadHistory(fromId);

      // AI check
      const ai = cfg.ai || {};
      if (!ai.apiKey) { await sendTelegram(fromId, `⚠️ No API key for ${ai.provider}.`); return; }

      // Auto-compact before expensive call
      await autoCompact(fromId);

      try {
        await telegramBot.sendChatAction(fromId, 'typing');

        // Build user message — may include image
        if (imageData) {
          appendHistory(fromId, 'user', text || 'What do you see in this image?', imageData);
        } else {
          appendHistory(fromId, 'user', text);
        }

        const reply = await callAI(getHistory(fromId));

        // Log private thinking, strip from visible output
        const thinking = extractThinking(reply);
        if (thinking) log(`💭 Think: ${thinking.slice(0, 200)}`);
        const visibleReply = stripThinking(reply);

        const acts  = parseActions(visibleReply);
        const res   = acts.length ? await executeActions(acts, fromId) : [];
        const raw   = acts.length ? applyActionResults(visibleReply, res) : visibleReply;
        const final = stripRemainingActions(raw);
        appendHistory(fromId, 'assistant', final);
        saveHistory(fromId);
        appendDailyLog(`**User:** ${text.slice(0, 120)}\n**Agent:** ${final.slice(0, 200)}`);
        await sendTelegram(fromId, final);
      } catch (e) {
        log(`AI error: ${e.message}`);
        await sendTelegram(fromId, `❌ AI error: ${e.message}`);
      }
    });

    telegramBot.on('polling_error', (err) => { log(`Telegram polling error: ${err.message}`); send('telegram', 'error'); });
    telegramBot.getMe()
      .then(me => {
        log(`💬 Telegram connected as @${me.username}`);
        send('telegram', 'connected');
        refreshSkillCommands().catch(e => log(`⚠ refreshSkillCommands: ${e.message}`));
      })
      .catch(e => { log(`Telegram auth failed: ${e.message}`); send('telegram', 'error'); });
  } catch (e) { log(`Telegram init error: ${e.message}`); }
}

function stopTelegram() {
  if (telegramBot) { try { telegramBot.stopPolling(); } catch {} telegramBot = null; send('telegram', 'disconnected'); }
}

// ── HTTP gateway + Webhooks ────────────────────────────────────────────────────

function startGateway() {
  if (running) {
    send('status', 'running');
    send('telegram', telegramBot ? 'connected' : 'offline');
    return;
  }

  server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const method = req.method;

    // Status endpoint (GET /)
    if (method === 'GET' && (url === '/' || url === '')) {
      const ai = cfg.ai || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', agent: 'MoltDroid', version: '2.3.0',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        ai: { provider: ai.provider, model: ai.model, hasKey: !!ai.apiKey },
        telegram: telegramBot ? 'connected' : 'offline',
        tasks: { total: Object.keys(tasks).length, running: Object.values(tasks).filter(t => t.status === 'running').length },
        cron: { total: Object.keys(cronJobs).length, active: Object.values(cronJobs).filter(j => j.enabled).length },
        files: countFiles('data'), skills: countFiles('skills'),
      }));
      return;
    }

    // Webhook: POST /hooks/wake — run agent with a message
    if (method === 'POST' && url === '/hooks/wake') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { message = '', token } = JSON.parse(body || '{}');
          if (cfg.webhookToken && token !== cfg.webhookToken) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted' }));
          if (!message) return;
          log(`🔔 Webhook wake: ${message.slice(0, 60)}`);
          const chatId = cfg.telegram?.chatId;
          if (!chatId || !telegramBot) return;
          if (!chatHistories[chatId]) loadHistory(chatId);
          appendHistory(chatId, 'user', `[WEBHOOK] ${message}`);
          try {
            const reply = await callAI(getHistory(chatId));
            const acts  = parseActions(reply);
            const res2  = acts.length ? await executeActions(acts, chatId) : [];
            const final = applyActionResults(stripThinking(reply), res2);
            appendHistory(chatId, 'assistant', final);
            saveHistory(chatId);
            await sendTelegram(chatId, `🔔 *Webhook*\n${final.slice(0, 2000)}`);
          } catch (e) { log(`Webhook AI error: ${e.message}`); }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Webhook: POST /hooks/agent — isolated one-shot agent run
    if (method === 'POST' && url === '/hooks/agent') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { message = '', label = '', token } = JSON.parse(body || '{}');
          if (cfg.webhookToken && token !== cfg.webhookToken) {
            res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
          }
          const runId = `WH${Date.now().toString(36).slice(-6)}`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted', runId }));
          if (!message) return;
          log(`🔔 Webhook agent ${runId}: ${message.slice(0, 60)}`);
          try {
            const reply = await callAI([{ role: 'user', content: message }], false);
            const acts  = parseActions(reply);
            const res2  = acts.length ? await executeActions(acts, cfg.telegram?.chatId) : [];
            const final = applyActionResults(stripThinking(reply), res2);
            if (telegramBot && cfg.telegram?.chatId)
              await sendTelegram(cfg.telegram.chatId, `🔔 *Webhook ${label || runId}*\n${final.slice(0, 2000)}`);
          } catch (e) { log(`Webhook agent ${runId} error: ${e.message}`); }
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    // Web chat UI
    if (method === 'GET' && url === '/ui') {
      const ai = cfg.ai || {};
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MoltDroid</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#000;--surface:#111;--surface2:#1c1c1e;--border:#2c2c2e;
  --red:#e8202a;--red-dim:rgba(232,32,42,0.12);
  --green:#30d158;--amber:#ff9f0a;--blue:#0a84ff;
  --text:#fff;--text2:#8e8e93;--text3:#48484a;
  --mono:'JetBrains Mono',ui-monospace,monospace;
  --sans:'Inter',system-ui,sans-serif;
  --ease:cubic-bezier(0.2,0,0,1);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--sans);-webkit-font-smoothing:antialiased}
body{display:flex;flex-direction:column;height:100dvh}
::-webkit-scrollbar{width:3px}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:99px}

/* ── Header ── */
header{
  flex-shrink:0;height:54px;display:flex;align-items:center;
  padding:0 20px;gap:12px;
  background:var(--surface);border-bottom:1px solid var(--border);
}
.brand{display:flex;align-items:center;gap:10px}
.brand-hex{font-size:22px;color:var(--red);line-height:1}
.brand-name{font-size:16px;font-weight:700;color:var(--text);letter-spacing:-0.3px}
.vsep{width:1px;height:18px;background:var(--border);margin:0 2px}
.model-tag{
  font-family:var(--mono);font-size:11px;color:var(--text2);
  border:1px solid var(--border);border-radius:20px;
  padding:3px 10px;background:var(--surface2);
}
.live{
  margin-left:auto;display:flex;align-items:center;gap:7px;
  font-size:12px;color:var(--text2);font-weight:500;
}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:breathe 2.4s var(--ease) infinite}
@keyframes breathe{0%,100%{opacity:1;box-shadow:0 0 0 2px rgba(48,209,88,0.25)}50%{opacity:0.5;box-shadow:none}}

/* ── Chat log ── */
#chat{flex:1;overflow-y:auto;padding:12px 0}

/* User message bubble */
.msg-user{
  display:flex;justify-content:flex-end;
  padding:4px 16px;margin-bottom:2px;
}
.bubble-user{
  background:var(--red);color:#fff;
  border-radius:18px 18px 4px 18px;
  padding:10px 14px;max-width:75%;
  font-size:15px;line-height:1.5;word-break:break-word;
}

/* Agent message */
.msg-agent{
  display:flex;justify-content:flex-start;align-items:flex-end;gap:8px;
  padding:4px 16px;margin-bottom:2px;
}
.agent-avatar{
  width:28px;height:28px;border-radius:8px;flex-shrink:0;margin-bottom:2px;
  background:var(--surface2);border:1px solid var(--border);
  display:flex;align-items:center;justify-content:center;font-size:14px;
}
.bubble-agent{
  background:var(--surface);color:var(--text);
  border-radius:18px 18px 18px 4px;
  border:1px solid var(--border);
  padding:10px 14px;max-width:75%;
  font-size:15px;line-height:1.55;word-break:break-word;white-space:pre-wrap;
}

/* System message */
.msg-sys{
  text-align:center;padding:6px 20px;
}
.msg-sys span{
  font-size:12px;color:var(--text3);font-family:var(--mono);
  background:var(--surface2);border-radius:20px;
  padding:3px 10px;
}

/* ── Typing indicator ── */
.typing-dots{display:flex;align-items:center;gap:4px;height:20px;padding:2px 0}
.dot{width:6px;height:6px;border-radius:50%;background:var(--text2);animation:tick 1.2s var(--ease) infinite}
.dot:nth-child(2){animation-delay:0.15s}
.dot:nth-child(3){animation-delay:0.3s}
@keyframes tick{0%,60%,100%{opacity:0.15;transform:scale(0.85)}30%{opacity:1;transform:scale(1)}}

/* ── Footer ── */
footer{
  flex-shrink:0;border-top:1px solid var(--border);
  background:var(--surface);padding:12px 16px;
  display:flex;align-items:flex-end;gap:10px;
}
.input-shell{
  flex:1;display:flex;align-items:flex-end;
  border:1px solid var(--border);border-radius:22px;
  background:var(--surface2);
  transition:border-color 150ms var(--ease);
  padding:2px 4px 2px 16px;
}
.input-shell:focus-within{border-color:var(--red)}
#inp{
  flex:1;background:none;border:none;outline:none;
  color:var(--text);font-family:var(--sans);font-size:15px;
  line-height:1.5;padding:9px 0;resize:none;max-height:120px;
}
#inp::placeholder{color:var(--text3)}
#send{
  flex-shrink:0;background:var(--red);color:#fff;border:none;
  border-radius:50%;width:36px;height:36px;margin-bottom:3px;
  font-size:16px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:opacity 120ms var(--ease),transform 80ms var(--ease);
}
#send:hover{opacity:0.85}
#send:active{transform:scale(0.93)}
#send:disabled{opacity:0.25;cursor:not-allowed}
</style>
</head>
<body>
<header>
  <div class="brand">
    <span class="brand-hex">⬡</span>
    <span class="brand-name">MoltDroid</span>
  </div>
  <div class="vsep"></div>
  <span class="model-tag">${ai.provider === 'anthropic' ? 'Claude' : ai.provider === 'openai' ? 'OpenAI' : 'Gemini'} &middot; ${(ai.model || '').split('-').slice(0,3).join('-')}</span>
  <div class="live"><div class="live-dot"></div>Online</div>
</header>
<div id="chat" role="log" aria-live="polite">
  <div class="msg-sys"><span>Web session active &middot; isolated from Telegram</span></div>
</div>
<footer>
  <div class="input-shell">
    <textarea id="inp" rows="1" placeholder="Message the agent…" aria-label="Message"></textarea>
  </div>
  <button id="send" aria-label="Send">&#8593;</button>
</footer>
<script>
const log=document.getElementById('chat');
const inp=document.getElementById('inp');
const btn=document.getElementById('send');

function userMsg(text){
  const w=document.createElement('div');w.className='msg-user';
  const b=document.createElement('div');b.className='bubble-user';
  b.textContent=text;w.appendChild(b);
  log.appendChild(w);log.scrollTop=log.scrollHeight;
}

function agentMsg(content){
  const w=document.createElement('div');w.className='msg-agent';
  const av=document.createElement('div');av.className='agent-avatar';av.textContent='⬡';
  const b=document.createElement('div');b.className='bubble-agent';
  if(typeof content==='string')b.textContent=content;
  else b.appendChild(content);
  w.appendChild(av);w.appendChild(b);
  log.appendChild(w);log.scrollTop=log.scrollHeight;
  return w;
}

function sysMsg(text){
  const w=document.createElement('div');w.className='msg-sys';
  const s=document.createElement('span');s.textContent=text;
  w.appendChild(s);log.appendChild(w);log.scrollTop=log.scrollHeight;
}

function typing(){
  const dots=document.createElement('div');dots.className='typing-dots';
  dots.innerHTML='<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  return agentMsg(dots);
}

async function send(){
  const text=inp.value.trim();if(!text)return;
  inp.value='';inp.style.height='';
  btn.disabled=true;
  userMsg(text);
  const t=typing();
  try{
    const res=await fetch('/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text})});
    const j=await res.json();t.remove();
    agentMsg(j.reply||j.error||'(empty response)');
  }catch(e){t.remove();sysMsg('Network error: '+e.message);}
  btn.disabled=false;
  inp.focus();
}

btn.onclick=send;
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
inp.addEventListener('input',()=>{inp.style.height='';inp.style.height=Math.min(inp.scrollHeight,120)+'px';});
inp.focus();
</script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Web chat API — POST /chat
    if (method === 'POST' && url === '/chat') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { message = '' } = JSON.parse(body || '{}');
          if (!message.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'message required' }));
            return;
          }
          const ai = cfg.ai || {};
          if (!ai.apiKey) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ reply: '⚠️ No API key configured. Go to Settings in the MoltDroid app.' }));
            return;
          }
          const webChatId = '__web__';
          if (!chatHistories[webChatId]) loadHistory(webChatId);
          appendHistory(webChatId, 'user', message);
          const reply = await callAI(getHistory(webChatId));
          const visible = stripThinking(reply);
          const acts = parseActions(visible);
          const results = acts.length ? await executeActions(acts, cfg.telegram?.chatId) : [];
          const raw = acts.length ? applyActionResults(visible, results) : visible;
          const final = stripRemainingActions(raw);
          appendHistory(webChatId, 'assistant', final);
          saveHistory(webChatId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reply: final }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', paths: ['GET /', 'GET /ui', 'POST /chat', 'POST /hooks/wake', 'POST /hooks/agent'] }));
  });

  server.listen(PORT, '0.0.0.0', () => {
    running = true;
    log(`🌐 Agent on 0.0.0.0:${PORT} — Web UI: http://localhost:${PORT}/ui`);
    send('status', 'running');
    startHeartbeat();
    startCronRunner();
    startTelegram();
    setTimeout(() => runBootFile().catch(e => log(`Boot error: ${e.message}`)), 2000);
  });

  server.on('error', (e) => { log(`Gateway error: ${e.message}`); send('status', 'error'); running = false; });
}

function stopGateway() {
  stopTelegram(); stopHeartbeat(); stopCronRunner();
  if (server) {
    server.close(() => { running = false; log('🛑 Agent stopped'); send('status', 'stopped'); });
    server = null;
  } else { running = false; send('status', 'stopped'); }
}

// ── IPC dispatcher ─────────────────────────────────────────────────────────────

rn.channel.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const parsed = msg;
  const { type, payload = {}, requestId } = parsed;

  // Resolve pending native bridge calls
  if (parsed.requestId && pendingNative[parsed.requestId]) {
    const { resolve, reject } = pendingNative[parsed.requestId];
    delete pendingNative[parsed.requestId];
    if (parsed.payload?.error) reject(new Error(parsed.payload.error));
    else resolve(parsed.payload?.output ?? '');
    return;
  }

  switch (type) {
    case 'init':
      cfg.filesDir     = payload.filesDir;
      cfg.ai           = payload.ai || cfg.ai;
      cfg.telegram     = payload.telegram;
      cfg.webhookToken = payload.webhookToken || null;
      log(`🦞 Agent initialized`);
      log(`🧠 AI: ${providerLabel()}`);
      ensureWorkspaceFiles();
      loadTasks();
      loadCron();
      resolveDir('data');
      resolveDir('skills');
      startGateway();
      break;

    case 'stop':   stopGateway(); break;
    case 'status': send('status', running ? 'running' : 'idle'); break;
    case 'queryState':
      send('status', running ? 'running' : 'idle');
      send('telegram', telegramBot ? 'connected' : 'offline');
      break;

    case 'updateConfig':
      if (payload.ai)       { cfg.ai = { ...cfg.ai, ...payload.ai }; log(`🧠 AI config updated: ${providerLabel()}`); }
      if (payload.telegram) { cfg.telegram = payload.telegram; log(`💬 Telegram config updated`); }
      break;

    case 'createFile':
      try {
        const subdir = payload.subdir || 'data';
        writeDataFile(payload.name, payload.content, subdir);
        send('result', { path: path.join(resolveDir(subdir), payload.name) }, requestId);
        send('filesChanged', { subdir });
      } catch (e) { send('error', { message: e.message }, requestId); }
      break;

    case 'readFile':
      try { send('result', { content: readDataFile(payload.name, payload.subdir || 'data') }, requestId); }
      catch (e) { send('error', { message: e.message }, requestId); }
      break;

    case 'listFiles':
      try { send('result', { files: listDataFiles(payload.subdir || 'data') }, requestId); }
      catch (e) { send('error', { message: e.message }, requestId); }
      break;

    case 'runSkill':
      try {
        const p = path.join(resolveDir('skills'), `${payload.name}.js`);
        if (!fs.existsSync(p)) throw new Error(`Skill not found: ${payload.name}`);
        delete require.cache[require.resolve(p)];
        const skill = require(p);
        if (typeof skill.run !== 'function') throw new Error('Skill must export run()');
        log(`⚡ Running skill: ${payload.name}`);
        Promise.resolve(skill.run(payload.args || {}, { log, send, cfg, writeDataFile, readDataFile, listDataFiles }))
          .then(r  => send('result', r ?? null, requestId))
          .catch(e => send('error', { message: e.message }, requestId));
      } catch (e) { send('error', { message: e.message }, requestId); }
      break;

    default: log(`Unknown IPC: ${type}`);
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────────

log(`🦞 MoltDroid Agent v2.3 starting…`);
send('status', 'idle');
