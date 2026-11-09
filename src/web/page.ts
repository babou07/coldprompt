// Static assets of the web console. No external resources: the page works
// offline on the tailnet and the CSP allows 'self' only.

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>ColdPrompt</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header id="top">
  <div class="row">
    <span id="conn" class="dot" title="connection"></span>
    <strong id="project">ColdPrompt</strong>
    <span id="badge" class="badge">…</span>
    <span class="spacer"></span>
    <button id="menu-btn" class="ghost" aria-label="show or hide the panel" aria-expanded="true">⋯</button>
  </div>
  <div id="mission" class="muted small"></div>
  <div id="menu" class="menu">
    <div class="actions">
      <button data-cmd="pause" class="link" title="Pause at the next safe boundary">Pause</button><span class="sep">|</span>
      <button data-cmd="stop" class="link danger" title="Stop gracefully after the current turn">Stop after this turn</button><span class="sep">|</span>
      <button id="logout" class="link" title="Forget the access token on this device">Forget token</button>
    </div>
    <div id="plan" class="plan" aria-label="progress"></div>
    <button id="plan-approve" class="primary" disabled>Nothing to approve</button>
  </div>
</header>

<section id="login" class="card" hidden>
  <h2>Access token</h2>
  <p class="muted small">Printed by <code>coldprompt web</code>, stored in <code>.coldprompt/web-token</code>.</p>
  <form id="login-form"><input id="token" type="password" autocomplete="off" placeholder="token"><button>Connect</button></form>
</section>

<section id="offline" class="card warn" hidden>
  <strong>ColdPrompt is not running.</strong>
  <div class="row"><button id="start-run">Start run</button><span id="start-msg" class="muted small"></span></div>
</section>

<section id="directives" class="card" hidden></section>

<main id="feed" aria-live="polite"></main>

<section id="blocked" class="card alert" hidden>
  <div class="row"><strong id="blocked-kind"></strong><span id="blocked-at" class="muted small"></span></div>
  <div id="blocked-reason" class="text clamp"></div>
  <button id="blocked-more" class="link">show all</button>
  <div class="muted small">Leave it with <b>resume</b> (text below), or with the panel's <b>Approve</b> when offered.</div>
</section>

<button id="jump" class="jump" hidden>↓ live</button>

<footer id="composer">
  <div class="modes" role="tablist">
    <button data-mode="ask" class="on" title="Question to the supervisor; the worker is untouched">ask</button>
    <button data-mode="raw" title="Your directive, delivered verbatim at the next turn boundary">tell --raw</button>
    <button data-mode="tell" title="The supervisor prepares a directive; you approve it">tell</button>
    <button data-mode="resume" title="Resolution required to leave BLOCKED / FAILED">resume</button>
  </div>
  <form id="send-form" class="row">
    <textarea id="text" rows="2" placeholder="Ask the supervisor…"></textarea>
    <button id="send" class="primary">Send</button>
  </form>
  <div id="toast" class="small" hidden></div>
</footer>

<dialog id="report">
  <div class="row"><strong id="report-title"></strong><span class="spacer"></span><button id="report-close" class="ghost">✕</button></div>
  <div id="report-body"></div>
</dialog>
</body>
</html>
`;

export const APP_CSS = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#6b7385;--line:#e2e5ea;--accent:#2f6fde;--ok:#1f8a4c;--warn:#b7791f;--bad:#c53030;--code:#f0f2f5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#181c24;--fg:#e6e9ef;--muted:#8f97a8;--line:#2a303b;--accent:#6aa0ff;--ok:#4cc38a;--warn:#e0a84f;--bad:#f06a6a;--code:#11151c}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
body{display:flex;flex-direction:column;min-height:100vh;padding-bottom:calc(150px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 14px}
.row{display:flex;align-items:center;gap:8px}.wrap{flex-wrap:wrap}.spacer{flex:1}
.muted{color:var(--muted)}.small{font-size:12.5px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--bad);flex:none}.dot.on{background:var(--ok)}
.badge{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--line);white-space:nowrap;flex:none}
#project{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge.RUNNING{background:color-mix(in srgb,var(--ok) 20%,transparent);color:var(--ok)}
.badge.BLOCKED,.badge.FAILED{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
.badge.APPROVAL{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
.badge.PAUSED{background:color-mix(in srgb,var(--warn) 20%,transparent);color:var(--warn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 12px}
.card.alert{border-color:var(--bad)}.card.warn{border-color:var(--warn)}
h2{font-size:16px;margin:0 0 6px}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:9px;padding:7px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--bad)}button.ghost{border:none;background:none;padding:4px 8px}
button.link{border:none;background:none;color:var(--accent);padding:2px 0;font-size:13px}
button:disabled{opacity:.5}
input,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:8px 10px;width:100%}
textarea{resize:vertical;min-height:44px;max-height:40vh}
form.row{align-items:flex-end}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
pre{background:var(--code);border-radius:8px;padding:8px 10px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:6px 0;max-height:60vh}
.text{white-space:pre-wrap;word-break:break-word}
.clamp{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.menu{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.sep{color:var(--muted)}
button.link.danger{color:var(--bad)}
.plan{max-height:min(30vh,220px);overflow-y:auto;overscroll-behavior:contain;font-size:13px;padding-right:4px}
.plan label{display:flex;gap:7px;align-items:baseline;padding:2px 0}
.plan label.session{font-weight:600;margin-top:6px}.plan label.session:first-child{margin-top:0}
.plan .missions{margin-left:22px}
.plan label.current{font-weight:600}
.plan input{pointer-events:none;accent-color:var(--accent);width:auto;padding:0;border:0;margin:0;flex:none;position:relative;top:2px}
.plan .t{color:var(--muted);font-weight:400}
#plan-approve{align-self:flex-start}
.plan .waiting{color:var(--bad);font-weight:600;white-space:nowrap}
#feed{flex:1;padding:4px 0}
.divider{margin:14px 12px 4px;font-size:12.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.divider.session{color:var(--fg);font-size:13.5px;border-top:1px solid var(--line);padding-top:10px}
.turn{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:8px 12px;overflow:hidden}
.turn>.head{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);font-size:13px;cursor:pointer;user-select:none}
.turn>.head::before{content:"▾";color:var(--muted);width:10px}
.turn.collapsed>.head::before{content:"▸"}
.turn.collapsed>.head{border-bottom:none}.turn.collapsed .body{display:none}
.turn.running>.head::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--ok);animation:pulse 1.2s infinite}
@keyframes pulse{50%{opacity:.25}}
.turn .body{padding:4px 12px 8px}
.item{padding:3px 0;border-bottom:1px dashed var(--line);font-size:13px}.item:last-child{border-bottom:none}
.item summary{cursor:pointer;list-style:none;display:flex;gap:6px;align-items:baseline}
.item summary::-webkit-details-marker{display:none}
.item .k{flex:none;width:16px;text-align:center}
.item .s{word-break:break-word}
.item.running .k{color:var(--warn)}.item.failed .k,.item.failed .s{color:var(--bad)}
.item.message{border-left:3px solid var(--accent);padding-left:8px;margin:6px 0}
.item.reasoning{color:var(--muted)}
.decision{margin:8px 12px;padding:8px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);font-size:13.5px}
.decision b{margin-right:6px}
.d-CONTINUE b,.d-MISSION_COMPLETE b{color:var(--ok)}.d-BLOCKED b,.d-STOP b{color:var(--bad)}.d-CLARIFY b{color:var(--warn)}
.note{margin:6px 12px;font-size:13px;color:var(--muted)}
.note.bad{color:var(--bad)}
.answer{margin:8px 12px;padding:10px 12px;border-radius:10px;background:var(--card);border:1px solid var(--accent)}
.answer .q{font-size:12.5px;color:var(--muted);margin-bottom:4px}
.pill{font-size:11.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--line)}
.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.bad{color:var(--bad);border-color:var(--bad)}
footer{position:fixed;bottom:0;left:0;right:0;z-index:5;background:var(--card);border-top:1px solid var(--line);padding:8px 12px calc(8px + env(safe-area-inset-bottom))}
.modes{display:flex;gap:6px;margin-bottom:6px;overflow-x:auto}
.modes button{font-size:12.5px;padding:4px 10px;border-radius:999px;white-space:nowrap}
.modes button.on{background:var(--fg);color:var(--card);border-color:var(--fg)}
#toast{margin-top:6px}#toast.err{color:var(--bad)}
.jump{position:fixed;right:14px;bottom:calc(140px + env(safe-area-inset-bottom));z-index:6;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.2)}
dialog{width:min(900px,96vw);max-height:90vh;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg);padding:12px 14px}
dialog::backdrop{background:rgba(0,0,0,.45)}
#report-body h3{font-size:14px;margin:12px 0 4px}
#directives .d{border-top:1px solid var(--line);padding:8px 0}#directives .d:first-of-type{border-top:none}
`;

export const APP_JS = String.raw`
'use strict';
const $ = (s, root = document) => root.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const KEY = 'coldprompt-web-token';
const PANEL_KEY = 'coldprompt-web-panel';
let token = '';
try { token = localStorage.getItem(KEY) || ''; } catch {}
const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromHash) { token = fromHash; try { localStorage.setItem(KEY, token); } catch {} history.replaceState(null, '', location.pathname); }

let mode = 'ask';
let status = null;
let connected = false;
let follow = true;
let streamAbort = null;
const turns = new Map();     // turnId -> { card, body, items: Map, plan }
const pendingQuestions = new Map(); // hot prompt id -> question text

// ---------------------------------------------------------------- api
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  return res.json();
}

function logout() {
  try { localStorage.removeItem(KEY); } catch {}
  token = '';
  if (streamAbort) streamAbort.abort();
  $('#login').hidden = false;
}

function toast(text, isError) {
  const t = $('#toast');
  t.textContent = text; t.className = 'small' + (isError ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 9000 : 4000);
}

async function command(cmd, text, raw, confirmText) {
  if (confirmText && !confirm(confirmText)) return false;
  try {
    const r = await api('/api/command', { command: cmd, text: text || '', raw: !!raw });
    if (!r.ok) { toast(r.error || 'error', true); return false; }
    toast((r.data && r.data.message) || 'ok');
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

// ---------------------------------------------------------------- stream
async function stream() {
  if (!token) { $('#login').hidden = false; return; }
  $('#login').hidden = true;
  for (;;) {
    streamAbort = new AbortController();
    try {
      const res = await fetch('/api/stream', { headers: { Authorization: 'Bearer ' + token }, signal: streamAbort.signal });
      if (res.status === 401) { logout(); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          let name = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) name = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) handle(name, JSON.parse(data));
        }
      }
    } catch (e) {
      if (!token) return;
    }
    setConn(false, true);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function handle(name, data) {
  if (name === 'hello') {
    $('#project').textContent = data.project || 'ColdPrompt';
    document.title = 'ColdPrompt · ' + (data.project || '');
    // Provider names first: the history below is labelled with them.
    if (data.status && data.status.providers) { names.worker = display(data.status.providers.worker, 'Worker'); names.supervisor = display(data.status.providers.supervisor, 'Supervisor'); }
    $('#feed').textContent = ''; turns.clear();
    const keepFollow = follow; follow = false;
    for (const e of data.history) renderEvent(e);
    follow = keepFollow; scrollEnd(true);
    setConn(data.connected);
    if (data.status) renderStatus(data.status);
  } else if (name === 'status') renderStatus(data);
  else if (name === 'connection') setConn(data.connected);
  else if (name === 'event') { renderEvent(data); scrollEnd(); }
}

function setConn(value, webDown) {
  connected = value;
  $('#conn').className = 'dot' + (value ? ' on' : '');
  $('#conn').title = value ? 'connected' : webDown ? 'web console unreachable' : 'ColdPrompt not running';
  $('#offline').hidden = value || webDown;
  if (!value) { $('#badge').textContent = webDown ? 'offline' : 'stopped'; $('#badge').className = 'badge'; }
}

// ---------------------------------------------------------------- plan
/** Read-only checkbox: checked = done, indeterminate = in progress. */
function checkLine(cls, title, detail, checked, partial) {
  const label = el('label', cls);
  const box = document.createElement('input');
  box.type = 'checkbox'; box.checked = checked; box.indeterminate = partial;
  box.tabIndex = -1; box.setAttribute('aria-readonly', 'true');
  box.onclick = (e) => e.preventDefault();
  const text = el('span', '', title);
  if (detail) text.append(' ', el('span', 't', detail));
  label.append(box, text);
  return label;
}

function approvable(s) {
  const b = s.blocked;
  return !!(b && (b.kind === 'MISSION_APPROVAL' || b.kind === 'VERIFICATION_FAILED') && s.session && s.mission);
}

let planFocus;

function renderPlan(s) {
  const box = $('#plan');
  const keepScroll = box.scrollTop;
  box.textContent = '';
  const current = s.mission ? s.mission.id : null;
  for (const session of s.plan || []) {
    const done = session.missions.every((m) => m.status === 'COMPLETED');
    const started = session.missions.some((m) => m.status !== 'PENDING');
    box.append(checkLine('session', 'Session ' + session.index + ' · ' + session.id, session.title || '', done, started && !done));
    const list = el('div', 'missions');
    for (const m of session.missions) {
      const active = m.id === current && m.status !== 'COMPLETED';
      const line = checkLine(active ? 'current' : '', m.index + '. ' + m.id, m.title, m.status === 'COMPLETED', active);
      if (active && approvable(s)) line.lastChild.append(' ', el('span', 'waiting', 'waiting for approval'));
      list.append(line);
    }
    box.append(list);
  }
  // Re-center on the current mission only when it changes (manual scrolling is kept otherwise).
  const currentLine = box.querySelector('label.current');
  if (current !== planFocus) {
    planFocus = current;
    if (currentLine) box.scrollTop = Math.max(0, currentLine.offsetTop - box.offsetTop - box.clientHeight / 3);
  } else box.scrollTop = keepScroll;
  const btn = $('#plan-approve');
  const ok = approvable(s);
  btn.disabled = !ok;
  btn.textContent = ok ? 'Approve session ' + s.session.index + ', mission ' + s.mission.inSession : 'Nothing to approve';
}

function approveMission() {
  const s = status;
  const last = s && s.mission && s.mission.inSession === s.mission.ofSession && s.session && s.session.index < s.session.of;
  command('approve', 'mission', false, last
    ? 'Approve mission ' + s.mission.id + '? It ends session ' + s.session.index + '; session ' + (s.session.index + 1) + ' starts on a new worker thread.'
    : 'Approve mission ' + (s && s.mission ? s.mission.id : '') + ' and start the next one?');
}

// ---------------------------------------------------------------- status
function renderStatus(s) {
  status = s;
  if (s.providers) {
    const changed = names.worker !== display(s.providers.worker, 'Worker') || names.supervisor !== display(s.providers.supervisor, 'Supervisor');
    names.worker = display(s.providers.worker, 'Worker');
    names.supervisor = display(s.providers.supervisor, 'Supervisor');
    if (changed) $('#text').placeholder = PLACEHOLDER[mode]();
  }
  const badge = $('#badge');
  renderPlan(s);
  const b = s.blocked;
  // A mission waiting for approval is a normal step, not an incident.
  const approval = !!b && s.status === 'BLOCKED' && b.kind === 'MISSION_APPROVAL';
  badge.textContent = (approval ? 'WAITING FOR APPROVAL' : s.status) + (s.stopping ? ' · stopping' : '') + (s.pauseRequested ? ' · pause requested' : '');
  badge.className = 'badge ' + (approval ? 'APPROVAL' : s.status);
  $('#mission').textContent = s.mission
    ? (s.session ? 'Session ' + s.session.index + '/' + s.session.of + ' ' + s.session.id + ' · ' : '')
      + 'Mission ' + (s.mission.inSession ? s.mission.inSession + '/' + s.mission.ofSession : s.mission.index + '/' + s.mission.of) + ' · ' + s.mission.id + ' · turn ' + s.missionTurns + ' (total ' + s.totalTurns + ')'
      + (s.git && s.git.isRepo ? ' · ' + s.git.branch + '@' + String(s.git.head).slice(0, 8) + (s.git.dirty ? ' dirty(' + s.git.changedFiles + ')' : ' clean') : '')
    : '';
  // A plain approval is shown in the panel (mission line + Approve button), not as a card.
  const wasHidden = $('#blocked').hidden;
  $('#blocked').hidden = !b || approval;
  if (b && !approval) {
    $('#blocked-kind').textContent = (s.status === 'FAILED' ? 'FAILED' : 'BLOCKED') + ' · ' + b.kind;
    $('#blocked-at').textContent = new Date(b.at).toLocaleString();
    $('#blocked-reason').textContent = b.reason;
    $('#blocked-reason').classList.add('clamp');
    $('#blocked-more').hidden = b.reason.length < 300;
    if (mode === 'ask' && !$('#text').value) setMode('resume', false);
    if (wasHidden) scrollEnd();
  }
  const box = $('#directives');
  box.textContent = '';
  const proposed = s.proposedDirectives || [], approved = s.approvedDirectives || [];
  box.hidden = !proposed.length && !approved.length;
  if (!box.hidden) {
    box.append(el('h2', '', 'Directives'));
    for (const d of proposed) {
      const row = el('div', 'd');
      row.append(el('div', 'small muted', d.id + ' · proposed by ' + names.supervisor + ', needs your approval'), el('div', 'text', d.content));
      const actions = el('div', 'row');
      const ok = el('button', 'primary', 'Approve'); ok.onclick = () => command('approve', d.id);
      const no = el('button', 'danger', 'Reject'); no.onclick = () => command('reject', d.id);
      actions.append(ok, no); row.append(actions); box.append(row);
    }
    for (const d of approved) {
      const row = el('div', 'd');
      row.append(el('div', 'small muted', d.id + ' · approved, delivered at the next turn'), el('div', 'text', d.content));
      const no = el('button', 'danger', 'Withdraw'); no.onclick = () => command('reject', d.id);
      row.append(no); box.append(row);
    }
  }
}

// ---------------------------------------------------------------- feed
const feed = () => $('#feed');
const time = (at) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

function turnCard(id, missionId, at, source) {
  let t = turns.get(id);
  if (t) return t;
  const card = el('section', 'turn');
  const head = el('div', 'head');
  head.append(el('strong', '', 'Turn ' + id), el('span', 'muted', (missionId || '') + (source ? ' · ' + source : '')), el('span', 'spacer'), el('span', 'muted', time(at)));
  const body = el('div', 'body');
  card.append(head, body);
  head.onclick = () => card.classList.toggle('collapsed');
  feed().append(card);
  t = { card, head, body, items: new Map(), plan: null, missionId };
  turns.set(id, t);
  return t;
}

const ICON = { command: '$', tool: '⚙', file_change: '✎', message: '💬', reasoning: '·', plan: '☑', web_search: '⌕', error: '!' };

function addItem(t, p) {
  if (p.kind === 'plan') {
    if (!t.plan) { t.plan = el('details', 'item'); t.body.prepend(t.plan); }
    t.plan.textContent = '';
    const s = el('summary'); s.append(el('span', 'k', ICON.plan), el('span', 's', 'Plan · ' + p.summary));
    t.plan.append(s, el('pre', '', p.detail || ''));
    return;
  }
  const key = p.kind + '|' + p.summary;
  let node = (p.phase !== 'started') ? t.items.get(key) : undefined;
  if (!node) {
    node = el('details', 'item ' + p.kind);
    t.body.append(node);
    if (p.phase === 'started') t.items.set(key, node);
  } else t.items.delete(key);
  node.textContent = '';
  const running = p.phase === 'started' || p.status === 'in_progress';
  node.className = 'item ' + p.kind + (running ? ' running' : '') + (p.status === 'failed' ? ' failed' : '');
  const s = el('summary');
  s.append(el('span', 'k', running ? '▶' : ICON[p.kind] || '·'), el('span', 's mono', p.summary || ''));
  node.append(s);
  if (p.detail) node.append(el('pre', '', p.detail));
  if (p.kind === 'message') node.open = true;
}

function note(text, cls) { feed().append(el('div', 'note ' + (cls || ''), text)); }

function renderEvent(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'run.started': note(time(e.at) + ' · orchestrator started'); break;
    case 'run.finished': note(time(e.at) + ' · orchestrator stopped (' + d.status + ')'); break;
    case 'session.started': feed().append(el('div', 'divider session', 'Session ' + d.sessionId)); break;
    case 'session.completed': note('✓ session ' + d.sessionId + ' completed'); break;
    case 'mission.started': feed().append(el('div', 'divider', 'Mission ' + d.missionId)); break;
    case 'mission.completed':
      // An approved mission's turns fold away; a click on a turn header opens it again.
      for (const t of turns.values()) if (!t.missionId || t.missionId === d.missionId) t.card.classList.add('collapsed');
      note('✓ mission ' + d.missionId + ' completed');
      break;
    case 'mission.completion_rejected': note('✗ completion rejected by ' + (d.failed || []).join(', '), 'bad'); break;
    case 'worker.session_started': note('new ' + names.worker + ' thread' + (d.readOnly ? ' (read-only)' : '')); break;
    case 'worker.session_resumed': note(names.worker + ' thread ' + String(d.threadId).slice(0, 8) + '… resumed' + (d.readOnly ? ' (read-only)' : '') + (d.fromResumeThread ? ' — existing thread from resumeThread' : '')); break;
    case 'turn.started': {
      const t = turnCard(d.turnId, d.missionId, e.at, d.source);
      t.card.classList.add('running');
      break;
    }
    case 'worker.progress': addItem(turnCard(d.turnId, d.missionId, e.at), d); break;
    case 'turn.completed': {
      const t = turnCard(d.turnId, d.missionId, e.at);
      t.card.classList.remove('running');
      const foot = el('div', 'row wrap');
      for (const v of d.verification || []) foot.append(el('span', 'pill ' + (v.passed ? 'ok' : 'bad'), v.name));
      if (d.commits && d.commits.length) foot.append(el('span', 'pill', d.commits.length + ' commit(s)'));
      foot.append(el('span', 'spacer'));
      const btn = el('button', 'link', 'Full report'); btn.onclick = () => openReport(d.turnId);
      foot.append(btn);
      t.body.append(foot);
      break;
    }
    case 'turn.failed': case 'turn.aborted': {
      const t = turnCard(d.turnId, '', e.at); t.card.classList.remove('running');
      t.body.append(el('div', 'item failed', (e.type === 'turn.failed' ? 'failed: ' + d.kind + ': ' : 'aborted: ') + (d.message || '')));
      break;
    }
    case 'turn.retry': note('retry ' + d.kind + ' #' + d.attempt + ' in ' + d.delaySeconds + 's: ' + (d.message || '')); break;
    case 'review.completed': {
      const box = el('div', 'decision d-' + d.decision);
      box.append(el('b', '', names.supervisor + ': ' + d.decision), el('span', 'text', d.reason || ''));
      feed().append(box);
      break;
    }
    case 'review.failed': note('review failed: ' + d.kind + ': ' + d.message, 'bad'); break;
    case 'runtime.blocked': if (d.kind !== 'MISSION_APPROVAL') note('⏸ BLOCKED (' + d.kind + ')', 'bad'); break;
    case 'runtime.failed': note('✗ FAILED (' + d.kind + ')', 'bad'); break;
    case 'runtime.resumed': note('▶ resumed'); break;
    case 'runtime.paused': note('paused'); break;
    case 'runtime.completed': note('✓ all missions completed'); break;
    case 'runtime.limit_reached': note('limit reached: ' + d.reason, 'bad'); break;
    case 'hot_prompt.received': {
      pendingQuestions.set(d.id, d.content);
      note('you (' + String(d.intent).toLowerCase() + '): ' + d.content);
      break;
    }
    case 'hot_prompt.answered': {
      const box = el('div', 'answer');
      const q = pendingQuestions.get(d.id);
      if (q) box.append(el('div', 'q', q));
      box.append(el('div', 'text', d.answer || ''));
      if (d.proposedDirectiveId) box.append(el('div', 'small muted', 'Proposed directive ' + d.proposedDirectiveId + ' — approve it above to deliver it.'));
      feed().append(box);
      break;
    }
    case 'hot_prompt.failed': note('question failed: ' + d.message, 'bad'); break;
    case 'directive.approved': note('directive ' + d.id + ' approved'); break;
    case 'directive.rejected': note('directive ' + d.id + ' rejected'); break;
    default: break;
  }
}

async function openReport(turnId) {
  const dlg = $('#report'), body = $('#report-body');
  $('#report-title').textContent = 'Turn ' + turnId;
  body.textContent = 'Loading…';
  dlg.showModal();
  try {
    const r = await api('/api/turn/' + encodeURIComponent(turnId));
    body.textContent = '';
    if (!r.ok) { body.textContent = r.error; return; }
    const t = r.data;
    const section = (title, content) => { body.append(el('h3', '', title)); if (typeof content === 'string') body.append(el('pre', '', content)); else body.append(content); };
    section('Worker report', t.finalResponse || '(none)');
    if (t.review) section(names.supervisor + ' review: ' + t.review.decision, t.review.reason + (t.review.evidence && t.review.evidence.length ? '\n\nEvidence:\n- ' + t.review.evidence.join('\n- ') : '') + (t.review.workerInstruction ? '\n\nInstruction to worker:\n' + t.review.workerInstruction : ''));
    for (const v of t.verification || []) section('Check ' + v.name + (v.passed ? ' ✓' : ' ✗'), v.output || '');
    if (t.completion) section('Completion checks', (t.completion.outcomes || []).map((o) => (o.passed ? '✓ ' : '✗ ') + o.name + '\n' + (o.output || '')).join('\n\n') || '(none)');
    if (t.fileChanges && t.fileChanges.length) section('Files changed', t.fileChanges.map((f) => f.kind + ' ' + f.path).join('\n'));
    if (t.commits && t.commits.length) section('Commits', t.commits.map((c) => typeof c === 'string' ? c : (c.hash || '') + ' ' + (c.subject || '')).join('\n'));
    if (t.commands && t.commands.length) section('Commands (' + t.commands.length + ')', t.commands.map((c) => (c.exitCode === undefined ? '  ' : String(c.exitCode).padStart(2)) + '  ' + c.command).join('\n'));
    if (t.errors && t.errors.length) section('Errors', t.errors.join('\n'));
    if (t.usage) section('Tokens', 'input ' + t.usage.inputTokens + ' (cached ' + t.usage.cachedInputTokens + '), output ' + t.usage.outputTokens);
  } catch (e) { body.textContent = e.message; }
}

function scrollEnd(force) {
  if (follow || force) requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
}

// ---------------------------------------------------------------- composer
// Display names of the configured providers (from status), e.g. Claude / Codex.
const names = { worker: 'Worker', supervisor: 'Supervisor' };
const display = (provider, fallback) => provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : fallback;
const PLACEHOLDER = {
  ask: () => 'Ask ' + names.supervisor + ' (the worker is untouched)…',
  raw: () => 'Directive for ' + names.worker + ', delivered verbatim at the next turn…',
  tell: () => 'Describe a directive; ' + names.supervisor + ' drafts it, you approve…',
  resume: () => 'Resolution: what to do to leave BLOCKED…'
};
function setMode(m, focus) {
  mode = m;
  for (const b of document.querySelectorAll('.modes button')) b.classList.toggle('on', b.dataset.mode === m);
  $('#text').placeholder = PLACEHOLDER[m]();
  if (focus !== false) $('#text').focus();
}

document.addEventListener('DOMContentLoaded', () => {
  for (const b of document.querySelectorAll('.modes button')) b.onclick = () => setMode(b.dataset.mode);
  $('#send-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const text = $('#text').value.trim();
    if (!text) return;
    const cmd = mode === 'raw' ? 'tell' : mode;
    const confirmText = mode === 'resume' ? 'Resume the worker with this resolution?' : mode === 'raw' ? 'Deliver this directive to ' + names.worker + ' at the next turn?' : '';
    $('#send').disabled = true;
    const ok = await command(cmd, text, mode === 'raw', confirmText);
    $('#send').disabled = false;
    if (ok) { $('#text').value = ''; if (mode === 'resume') setMode('ask', false); }
  };
  $('#text').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) $('#send-form').requestSubmit(); });
  $('#plan-approve').onclick = approveMission;
  $('#blocked-more').onclick = () => { $('#blocked-reason').classList.toggle('clamp'); };
  // The panel is open by default; folding it is remembered on this device.
  const setPanel = (open) => {
    $('#menu').hidden = !open;
    $('#menu-btn').setAttribute('aria-expanded', String(open));
    try { localStorage.setItem(PANEL_KEY, open ? 'open' : 'closed'); } catch {}
  };
  let panelOpen = true;
  try { panelOpen = localStorage.getItem(PANEL_KEY) !== 'closed'; } catch {}
  setPanel(panelOpen);
  $('#menu-btn').onclick = () => setPanel($('#menu').hidden);
  for (const b of document.querySelectorAll('#menu [data-cmd]')) b.onclick = () => { command(b.dataset.cmd, '', false, b.dataset.cmd === 'stop' ? 'Stop ColdPrompt after the current turn?' : ''); };
  $('#logout').onclick = () => logout();
  $('#report-close').onclick = () => $('#report').close();
  $('#start-run').onclick = async () => {
    if (!confirm('Start the ColdPrompt run?')) return;
    try {
      const r = await api('/api/start', {});
      $('#start-msg').textContent = r.ok ? r.data.message : r.error;
    } catch (e) { $('#start-msg').textContent = e.message; }
  };
  $('#login-form').onsubmit = (ev) => {
    ev.preventDefault();
    token = $('#token').value.trim();
    if (!token) return;
    try { localStorage.setItem(KEY, token); } catch {}
    stream();
  };
  window.addEventListener('scroll', () => {
    follow = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    $('#jump').hidden = follow;
  }, { passive: true });
  $('#jump').onclick = () => { follow = true; scrollEnd(true); };
  stream();
});
`;
