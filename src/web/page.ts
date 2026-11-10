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
  </div>
  <nav class="tabs" role="tablist">
    <button data-tab="main" class="on" role="tab">Main</button>
    <button data-tab="logs" role="tab">Logs</button>
  </nav>
</header>

<section id="login" class="card" hidden>
  <h2>Access token</h2>
  <p class="muted small">Printed by <code>coldprompt web</code>, stored in <code>.coldprompt/web-token</code>.</p>
  <form id="login-form"><input id="token" type="password" autocomplete="off" placeholder="token"><button>Connect</button></form>
</section>

<div id="tab-main" class="tab">
  <section id="controls" class="card">
    <div class="actions">
      <span id="run-actions" class="group"><button data-cmd="pause" class="link" title="Pause at the next safe boundary">Pause</button><span class="sep">|</span>
      <button data-cmd="stop" class="link danger" title="Stop gracefully after the current turn">Stop after this turn</button><span class="sep">|</span>
      <span id="restart-group" hidden><button id="restart-run" class="link" title="Stop after the current turn, then start again with the YAML files reloaded; progress is kept">Restart</button><span class="sep">|</span></span></span>
      <span id="start-actions" class="group" hidden><button id="start-run" class="link" title="Start the run (it reloads the YAML files)">Start run</button><span class="sep">|</span></span>
      <span id="archive-actions" class="group" hidden><button id="archive-plan" class="link" title="Move this finished plan to .coldprompt/archive/ so the next plan starts fresh">Archive plan</button><span class="sep">|</span></span>
      <span id="reset-actions" class="group" hidden><button id="reset-run" class="link danger" title="Archive this run as reset and start the plan again from its first mission; the repository is not touched">Reset run</button><span class="sep">|</span></span>
      <button id="logout" class="link" title="Forget the access token on this device">Forget token</button>
    </div>
    <div id="offline" class="small" hidden><b>ColdPrompt is not running.</b> <span id="offline-hint" class="muted">The page shows the last known state; <b>Start run</b> reloads the YAML files.</span></div>
    <pre id="start-msg" class="small" hidden></pre>
    <div id="config-changed" class="small" hidden></div>
    <details id="plan-box">
      <summary><span id="mission" class="small">No mission</span></summary>
      <div id="plan" class="plan" aria-label="progress"></div>
    </details>
    <button id="plan-approve" class="primary" hidden>Approve</button>
    <div id="proposals" class="proposals" hidden>
      <div class="row"><strong>Proposed sessions</strong><span class="spacer"></span><button id="proposals-refresh" class="link">refresh</button></div>
      <div id="finalize" class="small" hidden></div>
      <div id="proposal-notes" class="small"></div>
      <div id="proposal-list"></div>
    </div>
  </section>

  <section id="blocked" class="card alert" hidden>
    <div class="row"><strong id="blocked-kind"></strong><span id="blocked-at" class="muted small"></span></div>
    <div id="blocked-reason" class="text clamp"></div>
    <button id="blocked-more" class="link">show all</button>
    <div id="blocked-actions" class="row wrap" hidden></div>
  </section>

  <section id="directives" class="card" hidden></section>

  <section id="composer" class="card">
    <form id="send-form">
      <textarea id="text" rows="3" placeholder="Message…"></textarea>
      <div class="row wrap send-row">
        <button id="to-supervisor" class="primary" type="submit">Ask</button>
        <button id="to-worker" type="button">Send</button>
        <span id="composer-hint" class="muted small"></span>
      </div>
    </form>
  </section>

  <div id="exchanges"></div>
</div>

<div id="tab-logs" class="tab" hidden>
  <main id="feed" aria-live="polite"></main>
  <button id="jump" class="jump" hidden>↑ latest</button>
</div>

<div id="toast" class="small" hidden></div>

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
[hidden]{display:none !important}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
body{display:flex;flex-direction:column;min-height:100vh;padding-bottom:calc(40px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 14px 0}
.tabs{display:flex;gap:4px;margin-top:8px}
.tabs button{border:none;border-bottom:2px solid transparent;border-radius:0;background:none;padding:6px 12px;color:var(--muted);font-weight:600}
.tabs button.on{color:var(--fg);border-bottom-color:var(--accent)}
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
#controls{display:flex;flex-direction:column;gap:8px}
#plan-box summary{cursor:pointer;color:var(--muted)}
#plan-box[open] summary{margin-bottom:6px}
#plan-approve{align-self:flex-start}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.sep{color:var(--muted)}
.actions .group{display:contents}
#config-changed{color:var(--warn);margin:4px 0}
#start-msg{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;max-height:40vh;overflow:auto}
button.link.danger{color:var(--bad)}
.plan{max-height:min(30vh,220px);overflow-y:auto;overscroll-behavior:contain;font-size:13px;padding-right:4px}
.plan label{display:flex;gap:7px;align-items:baseline;padding:2px 0}
.plan label.session{font-weight:600;margin-top:6px}.plan label.session:first-child{margin-top:0}
.plan .missions{margin-left:22px}
.plan label.current{font-weight:600}
.plan input{pointer-events:none;accent-color:var(--accent);width:auto;padding:0;border:0;margin:0;flex:none;position:relative;top:2px}
.plan .t{color:var(--muted);font-weight:400}

.proposals{border-top:1px solid var(--line);padding-top:8px;display:flex;flex-direction:column;gap:6px;max-height:min(40vh,320px);overflow-y:auto;overscroll-behavior:contain}
.proposal{border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:13px}
.proposal .ptitle{font-weight:600;word-break:break-word}
.proposal ul{margin:4px 0;padding-left:18px}
.proposal .err{color:var(--bad);white-space:pre-wrap;word-break:break-word}
#finalize.bad{color:var(--bad)}
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
.turn>.decision{margin:0;border:none;border-top:1px solid var(--line);border-radius:0}
.d-CONTINUE b,.d-MISSION_COMPLETE b{color:var(--ok)}.d-BLOCKED b,.d-STOP b{color:var(--bad)}.d-CLARIFY b{color:var(--warn)}
.note{margin:6px 12px;font-size:13px;color:var(--muted)}
.note.bad{color:var(--bad)}
.answer{margin:8px 12px;padding:10px 12px;border-radius:10px;background:var(--card);border:1px solid var(--accent)}
.answer .q{font-size:12.5px;color:var(--muted);margin-bottom:4px}
.pill{font-size:11.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--line)}
.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.bad{color:var(--bad);border-color:var(--bad)}
#composer form{display:flex;flex-direction:column;gap:8px}
.send-row{gap:8px}
#composer-hint{flex:1 1 200px}
.ex{margin:8px 12px;padding:10px 12px;border-radius:10px;background:var(--card);border:1px solid var(--line)}
.ex .who{font-size:12px;color:var(--muted);margin-bottom:2px}
.ex .msg{white-space:pre-wrap;word-break:break-word}
.ex .state{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);margin-top:8px}
.ex .state.err{color:var(--bad)}
.ex .ans{border-top:1px solid var(--line);margin-top:8px;padding-top:8px;white-space:pre-wrap;word-break:break-word}
.ex .ans.fold{display:-webkit-box;-webkit-line-clamp:10;-webkit-box-orient:vertical;overflow:hidden}
.ex .prop{margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--code);white-space:pre-wrap;word-break:break-word;font-size:13.5px}
.ex .acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
#toast{position:fixed;left:12px;right:12px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:7;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;box-shadow:0 2px 8px rgba(0,0,0,.2)}#toast.err{color:var(--bad);border-color:var(--bad)}
.jump{position:fixed;right:14px;bottom:calc(60px + env(safe-area-inset-bottom));z-index:6;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.2)}
dialog{width:min(900px,96vw);max-height:90vh;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg);padding:12px 14px}
dialog::backdrop{background:rgba(0,0,0,.45)}
#report-body h3{font-size:14px;margin:12px 0 4px}
#blocked-actions{gap:8px;margin-top:8px}
#directives .d{border-top:1px solid var(--line);padding:8px 0}#directives .d:first-of-type{border-top:none}
`;

export const APP_JS = String.raw`
'use strict';
const $ = (s, root = document) => root.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const KEY = 'coldprompt-web-token';
const PLAN_KEY = 'coldprompt-web-plan';
const TAB_KEY = 'coldprompt-web-tab';
let token = '';
try { token = localStorage.getItem(KEY) || ''; } catch {}
// A link like https://host/#token=... signs in at once. Whitespace slipped in
// by copy-paste is removed (tokens never contain any).
const hashParams = new URLSearchParams(location.hash.slice(1));
const fromHash = (hashParams.get('token') || '').replace(/\s+/g, '');
const hashTab = hashParams.get('tab'); // #tab=logs opens the Logs tab
if (fromHash) { token = fromHash; try { localStorage.setItem(KEY, token); } catch {} }
if (location.hash) history.replaceState(null, '', location.pathname);

let tab = 'main';
let status = null;
let connected = false;
let canStart = false;
let canArchive = false;
let canRestart = false;
let canReset = false;
let proposalsEnabled = false;
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
  if (res.status === 401) { logout(token); throw new Error('Unauthorized'); }
  return res.json();
}

/** Shows the sign-in form; 'refused' (a token the server rejected) is put back in the field. */
function logout(refused) {
  try { localStorage.removeItem(KEY); } catch {}
  token = '';
  if (streamAbort) streamAbort.abort();
  $('#login').hidden = false;
  $('#token').value = refused || '';
  if (refused) toast('Token refused: check it, then Connect', true);
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
      if (res.status === 401) { logout(token); return; }
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
    resetExchanges();
    const keepFollow = follow; follow = false;
    for (const e of data.history) renderEvent(e);
    follow = keepFollow; scrollEnd(true);
    renderExchanges();
    canStart = data.canStart === true;
    canArchive = data.canArchive === true;
    canRestart = data.canRestart === true;
    canReset = data.canReset === true;
    proposalsEnabled = data.proposals === true;
    if (proposalsEnabled) loadProposals();
    setConn(data.connected);
    if (data.status) renderStatus(data.status);
  } else if (name === 'status') renderStatus(data);
  else if (name === 'connection') setConn(data.connected);
  else if (name === 'archived') location.reload();
  else if (name === 'restart') {
    if (data.ok) toast(data.message);
    else { $('#start-msg').textContent = data.message; $('#start-msg').hidden = false; toast('Restart failed', true); }
  }
  else if (name === 'event') { renderEvent(data); scrollEnd(); }
}

function setConn(value, webDown) {
  connected = value;
  $('#conn').className = 'dot' + (value ? ' on' : '');
  $('#conn').title = value ? 'connected' : webDown ? 'web console unreachable' : 'ColdPrompt not running';
  $('#offline').hidden = value;
  $('#run-actions').hidden = !value;
  $('#start-actions').hidden = value || webDown || !canStart;
  $('#restart-group').hidden = !value || !canRestart;
  $('#offline-hint').hidden = !canStart;
  if (value) $('#start-msg').hidden = true;
  if (!value) { $('#badge').textContent = webDown ? 'offline' : 'stopped'; $('#badge').className = 'badge'; }
  refreshArchive(value || webDown);
  refreshReset(value || webDown);
  refreshConfigChanges();
  renderComposer();
}

/** "Reset run" is shown only while stopped, for a run that is not a finished plan. */
let resetCommits = [];
async function refreshReset(hide) {
  const group = $('#reset-actions');
  if (hide || !canReset) { group.hidden = true; return; }
  try {
    const r = await api('/api/reset');
    resetCommits = r.ok ? r.data.commits || [] : [];
    group.hidden = !(r.ok && r.data.resettable && !connected);
  } catch { group.hidden = true; }
}

/** Warns when the YAML files changed since the run started (they apply only after a restart). */
async function refreshConfigChanges() {
  const box = $('#config-changed');
  if (!connected) { box.hidden = true; return; }
  try {
    const r = await api('/api/config-changes');
    const files = r.ok ? r.data.files : [];
    box.textContent = files.length ? 'Changed since the run started (not applied yet): ' + files.join(', ') + '. ' + (canRestart ? 'Restart to apply.' : 'Restart the run to apply.') : '';
    box.hidden = !files.length;
  } catch { box.hidden = true; }
}

/** "Archive plan" is shown only while stopped, for a finished plan. */
async function refreshArchive(hide) {
  const group = $('#archive-actions');
  if (hide || !canArchive) { group.hidden = true; return; }
  try {
    const r = await api('/api/archive');
    group.hidden = !(r.ok && r.data.archivable && !connected);
  } catch { group.hidden = true; }
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
      const line = checkLine(active ? 'current' : '', m.index + '. ' + m.id, m.title + (m.skipped ? ' (skipped)' : ''), m.status === 'COMPLETED', active);
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
  btn.hidden = !ok;
  if (ok) btn.textContent = 'Approve session ' + s.session.index + ', mission ' + s.mission.inSession;
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
    if (changed) renderExchanges();
  }
  const badge = $('#badge');
  renderPlan(s);
  renderFinalize(s.finalize);
  const b = s.blocked;
  // A mission waiting for approval is a normal step, not an incident.
  const approval = !!b && s.status === 'BLOCKED' && b.kind === 'MISSION_APPROVAL';
  badge.textContent = (approval ? 'WAITING FOR APPROVAL' : s.status) + (s.stopping ? ' · stopping' : '') + (s.pauseRequested ? ' · pause requested' : '');
  badge.className = 'badge ' + (approval ? 'APPROVAL' : s.status);
  $('#mission').textContent = s.mission
    ? (s.session ? 'Session ' + s.session.index + '/' + s.session.of + ' ' + s.session.id + ' · ' : '')
      + 'Mission ' + (s.mission.inSession ? s.mission.inSession + '/' + s.mission.ofSession : s.mission.index + '/' + s.mission.of) + ' · ' + s.mission.id + ' · turn ' + s.missionTurns + ' (total ' + s.totalTurns + ')'
      + (s.git && s.git.isRepo ? ' · ' + s.git.branch + '@' + String(s.git.head).slice(0, 8) + (s.git.dirty ? ' dirty(' + s.git.changedFiles + ')' : ' clean') : '')
    : 'No mission';
  // A plain approval is shown in the panel (mission line + Approve button), not as a card.
  $('#blocked').hidden = !b || approval;
  if (b && !approval) {
    $('#blocked-kind').textContent = (s.status === 'FAILED' ? 'FAILED' : 'BLOCKED') + ' · ' + b.kind;
    $('#blocked-at').textContent = new Date(b.at).toLocaleString();
    $('#blocked-reason').textContent = b.reason;
    $('#blocked-reason').classList.add('clamp');
    $('#blocked-more').hidden = b.reason.length < 300;
  }
  renderBlockedActions(s);
  const box = $('#directives');
  box.textContent = '';
  const proposed = s.proposedDirectives || [], approved = s.approvedDirectives || [];
  box.hidden = !proposed.length && !approved.length;
  if (!box.hidden) {
    box.append(el('h2', '', 'Directives'));
    for (const d of proposed) {
      const row = el('div', 'd');
      row.append(el('div', 'small muted', d.id + ' · proposed by the supervisor (' + names.supervisor + '), needs your approval'), el('div', 'text', d.content));
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
  // "after this turn" only when a turn is actually running.
  const stop = $('#controls [data-cmd="stop"]');
  const turnRunning = !!s.pendingTurn;
  stop.textContent = s.stopping ? 'Stopping…' : turnRunning ? 'Stop after this turn' : 'Stop';
  stop.title = turnRunning ? 'Stop gracefully after the current turn' : 'Stop the orchestrator now (no turn is running)';
  renderComposer();
  refreshExchangeActions();
}

/** Buttons that end a block without the worker: more turns, complete (checks run), skip. */
function renderBlockedActions(s) {
  const box = $('#blocked-actions');
  box.textContent = '';
  const b = s.blocked;
  const show = connected && b && (s.status === 'BLOCKED' || s.status === 'FAILED') && b.kind !== 'MISSION_APPROVAL' && b.kind !== 'PROVIDER_CHECK' && s.mission && !s.pendingTurn;
  box.hidden = !show;
  if (!show) return;
  const id = s.mission.id;
  const act = (label, cls, cmd, text, question, busyLabel) => {
    const btn = el('button', cls, label);
    btn.onclick = async () => {
      if (question && !confirm(question)) return;
      btn.disabled = true;
      const keep = btn.textContent;
      if (busyLabel) { btn.textContent = ''; btn.append(el('span', 'spin'), ' ' + busyLabel); }
      try { await command(cmd, text); } finally { btn.disabled = false; btn.textContent = keep; }
    };
    box.append(btn);
  };
  if (b.kind === 'MISSION_LIMIT') {
    act('+3 turns', 'primary', 'extend', '3', '', '');
    act('+10 turns', '', 'extend', '10', '', '');
  }
  act('Complete mission', '', 'complete', '', 'End mission ' + id + ' now? Its completion checks run first; it ends only if they pass.', 'Checking…');
  act('Skip mission', 'danger', 'skip', '', 'Skip mission ' + id + '? It ends without completion checks and is marked skipped; the next mission starts.', '');
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
  feed().prepend(card);
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

function note(text, cls) { feed().prepend(el('div', 'note ' + (cls || ''), text)); }

function renderEvent(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'run.started': note(time(e.at) + ' · orchestrator started'); break;
    case 'run.finished': note(time(e.at) + ' · orchestrator stopped (' + d.status + ')'); break;
    case 'session.started': feed().prepend(el('div', 'divider session', 'Session ' + d.sessionId)); break;
    case 'session.completed': note('✓ session ' + d.sessionId + ' completed'); break;
    case 'mission.started': feed().prepend(el('div', 'divider', 'Mission ' + d.missionId)); break;
    case 'mission.completed':
      // An approved mission's turns fold away; a click on a turn header opens it again.
      for (const t of turns.values()) if (!t.missionId || t.missionId === d.missionId) t.card.classList.add('collapsed');
      note('✓ mission ' + d.missionId + ' completed');
      break;
    case 'mission.completion_rejected': note('✗ completion rejected by ' + (d.failed || []).join(', '), 'bad'); break;
    case 'worker.session_started': note('new worker (' + names.worker + ') thread' + (d.readOnly ? ' (read-only)' : '')); break;
    case 'worker.session_resumed': note('worker (' + names.worker + ') thread ' + String(d.threadId).slice(0, 8) + '… resumed' + (d.readOnly ? ' (read-only)' : '') + (d.fromResumeThread ? ' — existing thread from resumeThread' : '')); break;
    case 'turn.started': {
      const t = turnCard(d.turnId, d.missionId, e.at, d.source);
      t.card.classList.add('running');
      break;
    }
    case 'worker.progress': addItem(turnCard(d.turnId, d.missionId, e.at), d); break;
    case 'turn.completed': {
      const t = turnCard(d.turnId, d.missionId, e.at);
      t.card.classList.remove('running');
      t.card.classList.add('collapsed'); // only the running turn stays open
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
      const t = turnCard(d.turnId, '', e.at); t.card.classList.remove('running'); t.card.classList.add('collapsed');
      t.body.append(el('div', 'item failed', (e.type === 'turn.failed' ? 'failed: ' + d.kind + ': ' : 'aborted: ') + (d.message || '')));
      break;
    }
    case 'turn.retry': note('retry ' + d.kind + ' #' + d.attempt + ' in ' + d.delaySeconds + 's: ' + (d.message || '')); break;
    case 'review.completed': {
      const box = el('div', 'decision d-' + d.decision);
      box.append(el('b', '', 'Supervisor (' + names.supervisor + '): ' + d.decision), el('span', 'text', d.reason || ''));
      const t = turns.get(d.turnId);
      if (t) t.card.append(box); else feed().prepend(box);
      break;
    }
    case 'review.failed': note('review failed: ' + d.kind + ': ' + d.message, 'bad'); break;
    case 'runtime.blocked': if (d.kind !== 'MISSION_APPROVAL') note('⏸ BLOCKED (' + d.kind + ')', 'bad'); break;
    case 'runtime.failed': note('✗ FAILED (' + d.kind + ')', 'bad'); break;
    case 'runtime.resumed': note('▶ resumed'); break;
    case 'runtime.paused': note('paused'); break;
    case 'runtime.completed': note('✓ all missions completed'); break;
    case 'mission.extended': note('mission ' + d.missionId + ': +' + d.added + ' turn(s), limit ' + d.limit); break;
    case 'mission.skipped': note('⤼ mission ' + d.missionId + ' skipped (no completion checks)', 'bad'); break;
    case 'mission.output': note('output "' + d.name + '" of ' + d.missionId + ' stored'); break;
    case 'plan.finalize_started': note('supervisor (' + names.supervisor + ') finalizes the plan…'); break;
    case 'plan.finalized': note('✓ plan finalized: ' + d.summary); if (proposalsEnabled) loadProposals(); break;
    case 'plan.finalize_failed': note('finalize failed: ' + d.error, 'bad'); if (proposalsEnabled) loadProposals(); break;
    case 'runtime.limit_reached': note('limit reached: ' + d.reason, 'bad'); break;
    case 'hot_prompt.received': {
      pendingQuestions.set(d.id, d.content);
      note('you (' + String(d.intent).toLowerCase() + '): ' + d.content);
      exchangeReceived(d);
      break;
    }
    case 'hot_prompt.answered': {
      const box = el('div', 'answer');
      const q = pendingQuestions.get(d.id);
      if (q) box.append(el('div', 'q', q));
      const text = el('div', 'text clamp', d.answer || '');
      text.title = 'click to show all'; text.onclick = () => text.classList.toggle('clamp');
      box.append(text);
      if (d.proposedDirectiveId) box.append(el('div', 'small muted', 'Proposed directive ' + d.proposedDirectiveId + ' — approve it in the Main tab to deliver it.'));
      feed().prepend(box);
      exchangeAnswered(d);
      break;
    }
    case 'hot_prompt.failed': note('question failed: ' + d.message, 'bad'); exchangeFailed(d); break;
    case 'directive.approved': note('directive ' + d.id + ' approved'); break;
    case 'directive.rejected': note('directive ' + d.id + ' rejected'); break;
    default: break;
  }
}

// ---------------------------------------------------------------- proposals
function renderFinalize(f) {
  const box = $('#finalize');
  box.hidden = !f;
  if (!f) return;
  box.className = 'small' + (f.status === 'FAILED' ? ' bad' : '');
  box.textContent = (f.status === 'DONE' ? 'Finalized ' : 'Finalize FAILED ') + new Date(f.at).toLocaleString() + ': ' + (f.status === 'DONE' ? (f.summary || '') : (f.error || '')) + (f.status === 'FAILED' ? ' (retried at the next Start run)' : '');
  $('#proposals').hidden = false;
}

async function loadProposals() {
  let r;
  try { r = await api('/api/proposals'); } catch { return; }
  if (!r.ok) return;
  const list = $('#proposal-list'), notes = $('#proposal-notes');
  list.textContent = ''; notes.textContent = '';
  for (const n of r.data.notes) {
    const b = el('button', 'link', n.file);
    b.onclick = () => showText(n.file, n.text);
    notes.append(b, document.createTextNode(' '));
  }
  for (const p of r.data.items) {
    const card = el('div', 'proposal');
    card.append(el('div', 'ptitle', (p.id || p.file) + (p.title ? ' — ' + p.title : '')));
    if (p.error) card.append(el('div', 'err small', p.error));
    else {
      const ul = el('ul', '');
      for (const m of p.missions) ul.append(el('li', '', m.title + (m.readOnly ? ' (read only)' : '') + (m.requireHumanApproval ? ' · waits for approval' : '')));
      card.append(el('div', 'muted small', p.file + ' · ' + p.missions.length + ' mission(s)'), ul);
    }
    const actions = el('div', 'actions-inline');
    if (!p.error) {
      const accept = el('button', 'link', 'Accept');
      accept.onclick = () => proposalAction('accept', p, 'Accept ' + (p.id || p.file) + ' into the plan? Accepting authorizes its missions; they run at the next Start run.');
      actions.append(accept, el('span', 'sep', ' | '));
    }
    const dismiss = el('button', 'link danger', 'Dismiss');
    dismiss.onclick = () => proposalAction('dismiss', p, 'Dismiss ' + p.file + '? It moves to dismissed/.');
    actions.append(dismiss);
    card.append(actions);
    list.append(card);
  }
  $('#proposals').hidden = !r.data.items.length && !r.data.notes.length && $('#finalize').hidden;
}

async function proposalAction(action, p, question) {
  if (!confirm(question)) return;
  try {
    const r = await api('/api/proposals/' + action, { file: p.file });
    if (r.ok) toast(r.data.message); else toast(r.error || 'error', true);
  } catch (e) { toast(e.message, true); }
  loadProposals();
}

function showText(title, text) {
  $('#report-title').textContent = title;
  const body = $('#report-body');
  body.textContent = '';
  body.append(el('pre', '', text));
  $('#report').showModal();
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
    if (t.review) section('Supervisor (' + names.supervisor + ') review: ' + t.review.decision, t.review.reason + (t.review.evidence && t.review.evidence.length ? '\n\nEvidence:\n- ' + t.review.evidence.join('\n- ') : '') + (t.review.workerInstruction ? '\n\nInstruction to worker:\n' + t.review.workerInstruction : ''));
    for (const v of t.verification || []) section('Check ' + v.name + (v.passed ? ' ✓' : ' ✗'), v.output || '');
    if (t.completion) section('Completion checks', (t.completion.outcomes || []).map((o) => (o.passed ? '✓ ' : '✗ ') + o.name + '\n' + (o.output || '')).join('\n\n') || '(none)');
    if (t.fileChanges && t.fileChanges.length) section('Files changed', t.fileChanges.map((f) => f.kind + ' ' + f.path).join('\n'));
    if (t.commits && t.commits.length) section('Commits', t.commits.map((c) => typeof c === 'string' ? c : (c.hash || '') + ' ' + (c.subject || '')).join('\n'));
    if (t.commands && t.commands.length) section('Commands (' + t.commands.length + ')', t.commands.map((c) => (c.exitCode === undefined ? '  ' : String(c.exitCode).padStart(2)) + '  ' + c.command).join('\n'));
    if (t.errors && t.errors.length) section('Errors', t.errors.join('\n'));
    if (t.usage) section('Tokens', 'input ' + t.usage.inputTokens + ' (cached ' + t.usage.cachedInputTokens + '), output ' + t.usage.outputTokens);
  } catch (e) { body.textContent = e.message; }
}

/** Newest first: following the live feed means staying at the top of the Logs tab. */
function scrollEnd(force) {
  if (tab !== 'logs') return;
  if (follow || force) requestAnimationFrame(() => window.scrollTo(0, 0));
}

// ---------------------------------------------------------------- composer
// Display names of the configured providers (from status), e.g. Claude / Codex.
const names = { worker: 'Worker', supervisor: 'Supervisor' };
const display = (provider, fallback) => provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : fallback;

/** A run waiting for a human: text sent to the worker resumes it. */
function waitingForHuman() {
  return connected && status && (status.status === 'BLOCKED' || status.status === 'FAILED' || status.status === 'PAUSED') && !(status.blocked && status.blocked.kind === 'MISSION_APPROVAL');
}

function renderComposer() {
  const resume = waitingForHuman();
  $('#to-supervisor').textContent = 'Ask supervisor (' + names.supervisor + ')';
  $('#to-worker').textContent = (resume ? 'Resume worker (' : 'Ask worker (') + names.worker + ')';
  $('#to-supervisor').disabled = !connected;
  $('#to-worker').disabled = !connected;
  $('#text').placeholder = connected ? 'Message…' : 'ColdPrompt is not running';
  $('#composer-hint').textContent = !connected ? ''
    : resume
      ? 'Worker: your text is the resolution, the run resumes. Supervisor: ask, or let it propose the fix.'
      : 'Supervisor: question or request; it may propose an instruction you approve. Worker: your text as is, at its next turn.';
}

// Exchanges: each message sent from this page and its answer, newest first, under the composer.
const EXCHANGES_SHOWN = 12;
let exchanges = [];          // { key, id, target, intent, text, state, answer, directiveId, directive, info, at }
let exchangeSeq = 0;
function resetExchanges() { exchanges = []; }

function exchangeReceived(d) {
  if (exchanges.some((x) => x.id === d.id)) return;
  // The event may arrive before the HTTP answer of the page that sent it.
  const mine = exchanges.find((x) => !x.id && x.state === 'sending' && x.text === d.content);
  if (mine) { mine.id = d.id; renderExchanges(); return; }
  const target = d.intent === 'QUESTION' ? 'supervisor' : 'worker';
  exchanges.push({
    key: 'h' + (exchangeSeq++), id: d.id, target, intent: d.intent, text: d.content,
    state: d.intent === 'QUESTION' ? 'waiting' : 'done',
    info: d.intent === 'RESOLUTION' ? 'Resolution: the run resumed with it.' : d.intent === 'DIRECTIVE' ? 'Directive.' : ''
  });
  renderExchanges();
}

function exchangeAnswered(d) {
  const x = exchanges.find((e) => e.id === d.id);
  if (!x) return;
  x.state = 'answered'; x.answer = d.answer || ''; x.target = 'supervisor';
  x.directiveId = d.proposedDirectiveId; x.directive = d.proposedDirective;
  renderExchanges();
}

function exchangeFailed(d) {
  const x = exchanges.find((e) => e.id === d.id);
  if (!x) return;
  x.state = 'error'; x.info = 'Failed: ' + (d.message || '');
  renderExchanges();
}

function stateLine(spinning, text, isError) {
  const line = el('div', 'state' + (isError ? ' err' : ''));
  if (spinning) line.append(el('span', 'spin'));
  line.append(el('span', '', text));
  return line;
}

function directiveProposed(id) {
  return !!(status && (status.proposedDirectives || []).some((d) => d.id === id));
}

function renderExchanges() {
  const box = $('#exchanges');
  box.textContent = '';
  for (const x of exchanges.slice(-EXCHANGES_SHOWN).reverse()) {
    const card = el('div', 'ex');
    const who = x.target === 'supervisor' ? 'You → supervisor (' + names.supervisor + ')' : 'You → worker (' + names.worker + ')';
    card.append(el('div', 'who', who), el('div', 'msg', x.text));
    if (x.state === 'sending') card.append(stateLine(true, 'Sending…'));
    else if (x.state === 'waiting') card.append(stateLine(true, 'Supervisor (' + names.supervisor + ') is thinking…'));
    else if (x.state === 'error') card.append(stateLine(false, x.info || 'Failed', true));
    else if (x.state === 'done' && x.info) card.append(stateLine(false, x.info));
    if (x.state === 'answered') {
      const ans = el('div', 'ans', x.answer);
      card.append(ans);
      if (x.answer.length > 500 || x.answer.split('\n').length > 10) {
        if (!x.expanded) ans.classList.add('fold');
        const more = el('button', 'link', x.expanded ? 'show less' : 'show all');
        more.onclick = () => { x.expanded = !x.expanded; renderExchanges(); };
        card.append(more);
      }
      if (x.directiveId) {
        card.append(el('div', 'who', 'Proposed instruction for the worker (' + names.worker + ') · ' + x.directiveId), el('div', 'prop', x.directive || ''));
        const acts = el('div', 'acts');
        acts.dataset.directive = x.directiveId;
        card.append(acts);
      }
    }
    box.append(card);
  }
  refreshExchangeActions();
}

/** Approve buttons only while the proposed directive is still waiting (status). */
function refreshExchangeActions() {
  for (const acts of document.querySelectorAll('#exchanges .acts')) {
    const id = acts.dataset.directive;
    acts.textContent = '';
    if (!directiveProposed(id)) { acts.append(el('span', 'muted small', 'Handled (approved, rejected or delivered).')); continue; }
    if (waitingForHuman()) {
      const both = el('button', 'primary', 'Approve and resume');
      both.onclick = async () => {
        if (!(await command('approve', id))) return;
        await command('resume', 'Apply the approved directive ' + id + '.');
      };
      acts.append(both);
    }
    const ok = el('button', waitingForHuman() ? '' : 'primary', 'Approve → worker');
    ok.onclick = () => command('approve', id);
    const no = el('button', 'danger', 'Reject');
    no.onclick = () => command('reject', id);
    acts.append(ok, no);
  }
}

/** Sends the composer text to the supervisor (ask) or to the worker (tell --raw, or resume when the run waits). */
async function send(target) {
  const text = $('#text').value.trim();
  if (!text) { $('#text').focus(); return; }
  const resume = target === 'worker' && waitingForHuman();
  if (target === 'worker' && !confirm(resume
    ? 'Resume the run with this resolution? It goes to the worker (' + names.worker + ') with its next turn.'
    : 'Send this to the worker (' + names.worker + ') as is? It is delivered at its next turn.')) return;
  const x = { key: 'l' + (exchangeSeq++), target, text, state: 'sending', info: '' };
  exchanges.push(x);
  $('#text').value = '';
  renderExchanges();
  const cmd = target === 'supervisor' ? 'ask' : resume ? 'resume' : 'tell';
  try {
    const r = await api('/api/command', { command: cmd, text, raw: cmd === 'tell' });
    if (!r.ok) throw new Error(r.error || 'error');
    const data = r.data || {};
    if (data.hotPromptId && !x.id) x.id = data.hotPromptId;
    if (target === 'supervisor') { if (x.state === 'sending') x.state = 'waiting'; }
    else { x.state = 'done'; x.info = data.message || (resume ? 'Resumed.' : 'Delivered at the next turn.'); }
  } catch (e) {
    x.state = 'error'; x.info = 'Not sent: ' + e.message;
    if (!$('#text').value) $('#text').value = text;
  }
  renderExchanges();
}

function setTab(name) {
  tab = name;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  $('#tab-main').hidden = name !== 'main';
  $('#tab-logs').hidden = name !== 'logs';
  try { localStorage.setItem(TAB_KEY, name); } catch {}
  if (name === 'logs') { follow = true; scrollEnd(true); } else $('#jump').hidden = true;
}

document.addEventListener('DOMContentLoaded', () => {
  $('#send-form').onsubmit = (ev) => { ev.preventDefault(); send('supervisor'); };
  $('#to-worker').onclick = () => send('worker');
  $('#text').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); send('supervisor'); } });
  $('#plan-approve').onclick = approveMission;
  $('#blocked-more').onclick = () => { $('#blocked-reason').classList.toggle('clamp'); };
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => setTab(b.dataset.tab);
  let savedTab = 'main';
  try { savedTab = localStorage.getItem(TAB_KEY) === 'logs' ? 'logs' : 'main'; } catch {}
  if (hashTab === 'logs' || hashTab === 'main') savedTab = hashTab;
  setTab(savedTab);
  // The plan recap is folded by default; opening it is remembered on this device.
  try { $('#plan-box').open = localStorage.getItem(PLAN_KEY) === 'open'; } catch {}
  $('#plan-box').addEventListener('toggle', () => { try { localStorage.setItem(PLAN_KEY, $('#plan-box').open ? 'open' : 'closed'); } catch {} });
  renderComposer();
  for (const b of document.querySelectorAll('#controls [data-cmd]')) b.onclick = () => { command(b.dataset.cmd, '', false, b.dataset.cmd === 'stop' ? (status && status.pendingTurn ? 'Stop ColdPrompt after the current turn?' : 'Stop ColdPrompt?') : ''); };
  $('#logout').onclick = () => logout();
  $('#proposals-refresh').onclick = () => loadProposals();
  $('#report-close').onclick = () => $('#report').close();
  $('#start-run').onclick = async () => {
    if (!confirm('Start the ColdPrompt run of ' + ($('#project').textContent || 'this project') + '? It reloads the YAML files.')) return;
    const b = $('#start-run');
    b.disabled = true; b.textContent = 'Starting…';
    $('#start-msg').hidden = true;
    try {
      const r = await api('/api/start', {});
      if (r.ok) toast(r.data.message);
      else { $('#start-msg').textContent = r.error; $('#start-msg').hidden = false; toast('Start failed', true); }
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; b.textContent = 'Start run'; }
  };
  setInterval(() => { if (connected) refreshConfigChanges(); }, 30000);
  $('#restart-run').onclick = async () => {
    if (!confirm('Restart ColdPrompt? The current turn finishes first, then the run starts again with the YAML files reloaded. Progress is kept.')) return;
    const b = $('#restart-run');
    b.disabled = true;
    try {
      const r = await api('/api/restart', {});
      if (r.ok) toast(r.data.message); else toast(r.error, true);
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; }
  };
  $('#reset-run').onclick = async () => {
    const commits = resetCommits.length
      ? '\n\nCommits made by this run stay as they are:\n' + resetCommits.map((c) => '  ' + c).join('\n')
      : '';
    if (!confirm('Reset the run? It is archived (.coldprompt/archive/, reason "reset") and the plan starts again from its first mission, with the YAML files as they are then. The repository is not touched.' + commits)) return;
    const startNow = canStart && confirm('Start the run now?');
    const b = $('#reset-run');
    b.disabled = true;
    try {
      const r = await api('/api/reset', { start: startNow });
      if (r.ok) {
        toast(r.data.message);
        if (r.data.started && !r.data.started.ok) { $('#start-msg').textContent = r.data.started.message; $('#start-msg').hidden = false; }
        else setTimeout(() => location.reload(), 800);
      } else toast(r.error, true);
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; }
  };
  $('#archive-plan').onclick = async () => {
    if (!confirm('Archive the finished plan? Its state, events, turns and outputs move to .coldprompt/archive/; the next Start run begins a new plan with the YAML files as they are then.')) return;
    const b = $('#archive-plan');
    b.disabled = true;
    try {
      const r = await api('/api/archive', {});
      if (r.ok) { toast(r.data.message); setTimeout(() => location.reload(), 800); }
      else toast(r.error, true);
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; }
  };
  $('#login-form').onsubmit = (ev) => {
    ev.preventDefault();
    token = $('#token').value.trim();
    if (!token) return;
    try { localStorage.setItem(KEY, token); } catch {}
    stream();
  };
  window.addEventListener('scroll', () => {
    if (tab !== 'logs') return;
    follow = window.scrollY < 80;
    $('#jump').hidden = follow;
  }, { passive: true });
  $('#jump').onclick = () => { follow = true; scrollEnd(true); };
  stream();
});
`;
