// app.js — Strict Job Search v3.2 (repo-ready)
// FINAL+ : removes rules.txt everywhere, Save closes Settings (hard), dirty stack (json only)
// FIX: blacklist purge is now authoritative (re-filter + re-render), so Korea/Dublin/BizOps purge instantly.

const $ = (id) => document.getElementById(id);

const state = {
  greenhouse: [],
  lever: [],
  custom: [],
  mode: "strict",
  memory: {},       // jobId -> { viewed, rejected, appliedConfirmed, job }
  rendered: {},     // jobId -> job (for current results view)
  currentResults: [] // canonical on-screen list for purge + rerender
};

const MAX_RESULTS = 15;
const MEMORY_KEY = "jobMemoryV3";
const TIMEOUT_MS = 180000; // 3 minutes

// Volatile staged rules (dirty list)
const STAGED_RULES_KEY = "sjs_staged_rules_v1";

// ---------- Utilities ----------
function jobId(job) {
  const base = job.url || (job.company + "|" + job.title + "|" + job.location);
  return btoa(unescape(encodeURIComponent(base))).slice(0, 64);
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}

function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------- Memory ----------
function loadMemory() {
  const raw = localStorage.getItem(MEMORY_KEY);
  state.memory = raw ? safeJsonParse(raw, {}) : {};
}

function saveMemory() {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(state.memory)); } catch {}
}

function clearMemory() {
  localStorage.removeItem(MEMORY_KEY);
  localStorage.removeItem(STAGED_RULES_KEY);
  state.memory = {};
  state.rendered = {};
  state.currentResults = [];
  refreshDirtyUI();
  toast("Memory cleared");
  const out = $("results");
  if (out) out.innerHTML = "";
}

// ---------- Settings ----------
function setSettingsVisible(open) {
  const s = $("settings");
  if (!s) return;
  if (open) {
    s.hidden = false;
    s.style.display = "";
  } else {
    s.hidden = true;
    s.style.display = "none";
  }
}

function loadSettingsUI() {
  const g = $("greenhouseSlugs");
  const l = $("leverSlugs");
  const c = $("customAtsUrls");
  if (g) g.value = (state.greenhouse || []).join("\n");
  if (l) l.value = (state.lever || []).join("\n");
  if (c) c.value = (state.custom || []).join("\n");
}

function parseLines(text) {
  return String(text || "")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
}

function saveSettings() {
  const g = $("greenhouseSlugs");
  const l = $("leverSlugs");
  const c = $("customAtsUrls");

  state.greenhouse = g ? parseLines(g.value) : [];
  state.lever = l ? parseLines(l.value) : [];
  state.custom = c ? parseLines(c.value) : [];

  localStorage.setItem("sjs_sources_v3", JSON.stringify({
    greenhouse: state.greenhouse,
    lever: state.lever,
    custom: state.custom
  }));

  // Hard close after Save (by design)
  setSettingsVisible(false);
  toast("Saved sources (closed)");
}

function loadSourcesFromStorage() {
  const raw = localStorage.getItem("sjs_sources_v3");
  const s = raw ? safeJsonParse(raw, null) : null;
  if (s) {
    state.greenhouse = Array.isArray(s.greenhouse) ? s.greenhouse : [];
    state.lever = Array.isArray(s.lever) ? s.lever : [];
    state.custom = Array.isArray(s.custom) ? s.custom : [];
  }
}

// ---------- Rules: durable + staged ----------
async function loadRulesJson() {
  // rules.json is authoritative durable rule store
  try {
    const r = await fetch("./rules.json", { cache: "no-store" });
    if (!r.ok) return { version: "1", explicitRules: [] };
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.explicitRules)) return { version: "1", explicitRules: [] };
    return j;
  } catch {
    return { version: "1", explicitRules: [] };
  }
}

function getDurableRules() {
  return Array.isArray(window.APP_STATE?.rules?.explicitRules)
    ? window.APP_STATE.rules.explicitRules
    : [];
}

function loadStagedRulesFallback() {
  try {
    const raw = localStorage.getItem(STAGED_RULES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveStagedRulesFallback(arr) {
  try { localStorage.setItem(STAGED_RULES_KEY, JSON.stringify(arr)); } catch {}
}

function getStagedRules() {
  if (Array.isArray(window.APP_STATE?.stagedRules)) return window.APP_STATE.stagedRules;
  return loadStagedRulesFallback();
}

function stageRule(rule) {
  const type = String(rule?.type || "").trim();
  const value = String(rule?.value || "").trim();
  if (!type || !value) return;

  const normalized = { type, value };

  const all = getDurableRules().concat(getStagedRules());
  const exists = all.some(r =>
    String(r?.type || "").toLowerCase() === normalized.type.toLowerCase() &&
    String(r?.value || "").trim().toLowerCase() === normalized.value.trim().toLowerCase()
  );
  if (exists) return;

  if (window.APP_ACTIONS?.stageRule && Array.isArray(window.APP_STATE?.stagedRules)) {
    window.APP_ACTIONS.stageRule(normalized);
  } else {
    const staged = getStagedRules();
    staged.push(normalized);
    saveStagedRulesFallback(staged);

    if (window.APP_STATE && !Array.isArray(window.APP_STATE.stagedRules)) {
      window.APP_STATE.stagedRules = staged;
    }
  }

  refreshDirtyUI();
}

function evaluateExplicitRules(job) {
  // Contract: location rules must match what the user sees in the Location line on the card.
  // In this app, that is job.location (a single composed string).
  const rules = getDurableRules().concat(getStagedRules());

  const comp = norm(job.company);
  const title = norm(job.title);
  const loc = norm(job.location); // user-visible location text
  const text = norm(job.title + " " + job.description); // for keyword checks only

  for (const r of rules) {
    const rt = norm(r?.type);
    const rv = norm(r?.value);
    if (!rt || !rv) continue;

    if (rt === "company" && comp === rv) return true;
    if (rt === "title" && title.includes(rv)) return true;
    if (rt === "location" && loc.includes(rv)) return true;
    if (rt === "keyword" && (title.includes(rv) || text.includes(rv))) return true;
  }

  return false;
}

// ---------- Authoritative Purge + Rerender (FIX) ----------
function rerenderFromCurrentResults() {
  const out = $("results");
  if (!out) return;

  out.innerHTML = "";
  state.rendered = {};

  const filtered = (state.currentResults || []).filter(j => !evaluateExplicitRules(j));
  state.currentResults = filtered;

  for (const job of filtered) {
    out.appendChild(renderJob(job));
  }

  const loaded = document.createElement("div");
  loaded.className = "loaded";
  loaded.textContent = `Loaded ${filtered.length}`;
  out.appendChild(loaded);
}

function purgeAndRerender() {
  // This is the foundation contract: after staging a blacklist rule,
  // anything visible that matches must be removed immediately.
  rerenderFromCurrentResults();
  refreshDirtyUI();
}

// ---------- Minimal UI CSS (no styles.css change) ----------
(function injectCSS() {
  if (document.getElementById("sjs-inline-css")) return;
  const style = document.createElement("style");
  style.id = "sjs-inline-css";
  style.textContent = `
    .bl-panel{ margin-top:10px; padding:10px; border-radius:12px; background:rgba(0,0,0,.20); border:1px solid rgba(255,255,255,.12); }
    .bl-row{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:8px 0; }
    .bl-row label{ margin:0; font-weight:650; opacity:.92; }
    .bl-row input[type="text"]{ flex:1; min-width:180px; padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.15); background:rgba(0,0,0,.22); color:#fff; }
    .bl-hint{ font-size:12px; opacity:.78; margin:8px 0 0; }
    .bl-actions{ display:flex; gap:10px; margin-top:10px; }
    .bl-actions .btn{ flex:0 0 auto; }
    .toast{ position:fixed; left:50%; transform:translateX(-50%); bottom:14px; background:rgba(0,0,0,.75); border:1px solid rgba(255,255,255,.12); color:#fff; padding:8px 12px; border-radius:10px; opacity:0; pointer-events:none; transition:opacity .2s ease; }
    .toast.show{ opacity:1; }
    .sjs-dirtywrap{ margin-top:10px; padding:10px; border-radius:16px; background:rgba(0,0,0,.18); border:1px solid rgba(255,255,255,.12); display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .sjs-dirtytag{ font-weight:800; opacity:.95; }
    .sjs-dirtynote{ font-size:12px; opacity:.8; }
    .whyicon{ width:26px; height:26px; border-radius:10px; border:1px solid rgba(255,255,255,.16); background:rgba(0,0,0,.22); display:flex; align-items:center; justify-content:center; padding:4px; }
    .whyicon img{ width:100%; height:100%; object-fit:contain; }
    .whyicon.green{ box-shadow:0 0 0 2px rgba(100,255,100,.35); }
    .whyicon.yellow{ box-shadow:0 0 0 2px rgba(255,210,70,.35); }
    .whyicon.red{ box-shadow:0 0 0 2px rgba(255,90,90,.35); }
  `;
  document.head.appendChild(style);
})();

// ---------- Fetchers ----------
async function fetchGreenhouse(token) {
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.jobs)) return [];
    return j.jobs.map(x => ({
      company: token,
      title: x?.title || "",
      location: x?.location?.name || "",
      description: x?.content || "",
      url: x?.absolute_url || ""
    }));
  } catch { return []; }
}

async function fetchLever(slug) {
  try {
    const r = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json().catch(() => null);
    if (!Array.isArray(j)) return [];
    return j.map(x => ({
      company: slug,
      title: x?.text || "",
      location: x?.categories?.location || "",
      description: x?.description || "",
      url: x?.hostedUrl || ""
    }));
  } catch { return []; }
}

async function fetchCustom(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json().catch(() => null);
    const jobs = Array.isArray(j) ? j : (j && Array.isArray(j.jobs) ? j.jobs : []);
    return jobs.map(x => ({
      company: x?.company || "custom",
      title: x?.title || "",
      location: x?.location || "",
      description: x?.description || "",
      url: x?.url || ""
    }));
  } catch { return []; }
}

// ---------- Loading UI ----------
function ensureLoadingUI() {
  let statusWrap = document.getElementById("sjsStatusWrap");
  if (statusWrap) return statusWrap;

  const root = document.getElementById("app");
  if (!root) return null;

  statusWrap = document.createElement("div");
  statusWrap.id = "sjsStatusWrap";
  statusWrap.className = "sjsStatusWrap";

  const statusText = document.createElement("div");
  statusText.id = "sjsStatusText";
  statusText.className = "sjsStatusText";
  statusText.textContent = "";

  const barOuter = document.createElement("div");
  barOuter.className = "sjsBarOuter";

  const barInner = document.createElement("div");
  barInner.id = "sjsBarInner";
  barInner.className = "sjsBarInner";
  barInner.style.width = "0%";

  barOuter.appendChild(barInner);

  const note = document.createElement("div");
  note.id = "sjsStatusNote";
  note.className = "sjsStatusNote";
  note.textContent = "";

  statusWrap.append(statusText, barOuter, note);
  root.insertBefore(statusWrap, root.firstChild);

  return statusWrap;
}

function setLoading(on, { statusText = "", progressPct = 0, noteText = "" } = {}) {
  const wrap = ensureLoadingUI();
  if (!wrap) return;
  wrap.style.display = on ? "" : "none";

  const st = document.getElementById("sjsStatusText");
  const bi = document.getElementById("sjsBarInner");
  const nt = document.getElementById("sjsStatusNote");

  if (st) st.textContent = statusText;
  if (bi) bi.style.width = `${Math.max(0, Math.min(100, progressPct))}%`;
  if (nt) nt.textContent = noteText;
}

function setProgress(label, done, total, noteText = "") {
  const pct = total ? Math.round((done / total) * 100) : 0;
  setLoading(true, { statusText: label, progressPct: pct, noteText });
}

function hardStopAllLoaders() {
  setLoading(false, { statusText: "", progressPct: 0, noteText: "" });
}

// ---------- Mode ----------
function setMode(mode) {
  state.mode = mode === "relaxed" ? "relaxed" : "strict";
  $("modeStrict").classList.toggle("active", state.mode === "strict");
  $("modeRelaxed").classList.toggle("active", state.mode === "relaxed");
  toast(state.mode === "strict" ? "Strict mode" : "Relaxed mode");
}

// ---------- Future Opportunities Kill Switch ----------
function isFutureOp(job) {
  const t = norm(job.title);
  return t.startsWith("future opportunities") || t.includes("future opportunity");
}

// ---------- Positive Gates / Semantics ----------
const allowSignalsStrict = [
  "governance", "ai governance", "automation governance",
  "automation", "ai", "ml", "machine learning",
  "risk", "compliance", "grcp", "grc", "policy",
  "platform", "internal tools", "tooling",
  "enablement", "evaluation", "operating model",
  "solutions consultant", "solutions architect",
  "developer support", "technical support", "customer support",
  "program", "ops", "operations"
];

function hasAllowSignal(job) {
  const t = norm(job.title + " " + job.description);
  return allowSignalsStrict.some(s => t.includes(s));
}

function passesGates(job, relaxed = false) {
  // Hard excludes (durable + staged)
  if (evaluateExplicitRules(job)) return false;

  // Future opportunities kill switch
  if (isFutureOp(job)) return false;

  const t = (job.title + " " + job.location + " " + job.description).toLowerCase();

  // global deny
  if (/crypto|blockchain|web3|token|coin|defi|nft|trading|investment/.test(t)) return false;

  // strict inclusion: must match at least one allow signal
  if (!relaxed && !hasAllowSignal(job)) return false;

  return true;
}

// ---------- Why / Color Semantics ----------
function whyVerdict(job) {
  // Red: hard exclude
  if (evaluateExplicitRules(job)) {
    return { color: "red", reason: "Explicit rule hit (company/title/location/keyword)" };
  }
  if (isFutureOp(job)) {
    return { color: "red", reason: "Future Opportunities kill-switch" };
  }

  const strictPass = passesGates(job, false);
  if (strictPass) return { color: "green", reason: "Passes Strict gates" };
  return { color: "yellow", reason: "Does not pass Strict gates (inspect why)" };
}

function showWhy(job) {
  const v = whyVerdict(job);
  const msg = [
    `Verdict: ${v.color.toUpperCase()}`,
    `Reason: ${v.reason}`,
    "",
    `Title: ${job.title}`,
    `Location: ${job.location}`,
    `Company: ${job.company}`
  ].join("\n");
  toast(msg);
}

// ---------- Dirty UI / Promotion ----------
function refreshDirtyUI() {
  const wrap = $("dirtyWrap");
  if (!wrap) return;

  const staged = getStagedRules();
  const n = Array.isArray(staged) ? staged.length : 0;

  const tag = $("sjsDirtyTag");
  if (tag) tag.textContent = `Dirty: ${n}`;

  const note = $("dirtyNote");
  if (note) note.textContent = "Staged rules are local until promoted.";

  const btnCopy = $("btnCopyRulesJson");
  const btnMail = $("btnMailDirty");
  const btnDlJson = $("btnDlRulesJson");

  if (btnCopy) btnCopy.hidden = (n <= 0);
  if (btnMail) btnMail.hidden = (n <= 0);
  if (btnDlJson) btnDlJson.hidden = (n <= 0);
}

function getRulesJsonPayload() {
  const durable = window.APP_STATE?.rules || { version: "1", explicitRules: [] };
  const staged = getStagedRules() || [];
  const combined = (durable.explicitRules || []).concat(staged);
  return {
    version: nowStamp(),
    explicitRules: combined
  };
}

function downloadRulesJson() {
  const payload = getRulesJsonPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rules.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function mailDirtyList() {
  const payload = getRulesJsonPayload();
  const subject = `SJS PROMOTE PACKET — ${nowStamp()}`;
  const body = `==== RULES.JSON BEGIN ====\n${JSON.stringify(payload, null, 2)}\n==== RULES.JSON END ====`;
  const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = url;
}

// ---------- Blacklist panel ----------
function buildBlacklistPanel(job, id, cardDiv) {
  const panel = document.createElement("div");
  panel.className = "bl-panel";

  const mkRow = () => { const d = document.createElement("div"); d.className = "bl-row"; return d; };

  const row1 = mkRow();
  const cbCompany = document.createElement("input"); cbCompany.type = "checkbox";
  const labCompany = document.createElement("label"); labCompany.textContent = `Company (${job.company})`;
  row1.append(cbCompany, labCompany);

  const row2 = mkRow();
  const cbTitle = document.createElement("input"); cbTitle.type = "checkbox";
  const labTitle = document.createElement("label"); labTitle.textContent = "Title phrase";
  const inTitle = document.createElement("input"); inTitle.type = "text"; inTitle.value = job.title || "";
  row2.append(cbTitle, labTitle, inTitle);

  const row3 = mkRow();
  const cbLoc = document.createElement("input"); cbLoc.type = "checkbox";
  const labLoc = document.createElement("label"); labLoc.textContent = "Location phrase";
  const inLoc = document.createElement("input"); inLoc.type = "text"; inLoc.value = job.location || "";
  row3.append(cbLoc, labLoc, inLoc);

  const row4 = mkRow();
  const cbKw = document.createElement("input"); cbKw.type = "checkbox";
  const labKw = document.createElement("label"); labKw.textContent = "Keyword(s)";
  const inKw = document.createElement("input"); inKw.type = "text"; inKw.placeholder = "comma-separated (optional)";
  row4.append(cbKw, labKw, inKw);

  const hint = document.createElement("div");
  hint.className = "bl-hint";
  hint.textContent = "Stage rules locally. Mail/Download exports RULES.JSON only.";

  const actions = document.createElement("div");
  actions.className = "bl-actions";

  const btnApply = document.createElement("button");
  btnApply.className = "btn primary";
  btnApply.textContent = "Stage rules";

  const btnCancel = document.createElement("button");
  btnCancel.className = "btn";
  btnCancel.textContent = "Cancel";
  btnCancel.onclick = () => panel.remove();

  btnApply.onclick = () => {
    if (cbCompany.checked) stageRule({ type: "company", value: job.company });
    if (cbTitle.checked) stageRule({ type: "title", value: inTitle.value });
    if (cbLoc.checked) stageRule({ type: "location", value: inLoc.value });
    if (cbKw.checked) {
      const parts = (inKw.value || "").split(",").map(s => s.trim()).filter(Boolean);
      parts.forEach(p => stageRule({ type: "keyword", value: p }));
    }

    // FIX: authoritative purge (not DOM-only)
    purgeAndRerender();
  };

  actions.append(btnApply, btnCancel);
  panel.append(row1, row2, row3, row4, hint, actions);
  return panel;
}

// ---------- Records / Cards ----------
function getRecord(id) {
  return state.memory[id] || { viewed: false, rejected: false, appliedConfirmed: false, job: null };
}

function setRecord(id, patch, job) {
  const prev = getRecord(id);
  const next = {
    viewed: !!(patch.viewed ?? prev.viewed),
    rejected: !!(patch.rejected ?? prev.rejected),
    appliedConfirmed: !!(patch.appliedConfirmed ?? prev.appliedConfirmed),
    job: job || prev.job || null
  };
  if (next.appliedConfirmed) next.viewed = true;
  state.memory[id] = next;
  saveMemory();
  return next;
}

function shouldHide(job) {
  const r = state.memory[jobId(job)] || null;
  if (!r) return false;
  return !!(r.rejected || r.appliedConfirmed);
}

function renderJob(job) {
  const id = jobId(job);
  state.rendered[id] = job;

  const record = getRecord(id);

  const div = document.createElement("div");
  div.className = "job";
  div.setAttribute("data-jobid", id);

  if (record.viewed) div.classList.add("viewed");
  if (record.rejected) div.classList.add("rejected");
  if (record.appliedConfirmed) div.classList.add("appliedConfirmed");

  div.innerHTML = `<h3>${job.title}</h3><p>${job.location}</p>`;

  const actions = document.createElement("div");
  actions.className = "actions";

  // Why icon
  const whyWrap = document.createElement("button");
  whyWrap.className = "whyicon";
  const verdict = whyVerdict(job);
  whyWrap.classList.add(verdict.color);
  const img = document.createElement("img");
  img.alt = "Why";
  img.src = "./WhyInfo.png";
  whyWrap.appendChild(img);
  whyWrap.onclick = () => showWhy(job);

  const appliedWrap = document.createElement("div");
  appliedWrap.className = "appliedWrap" + (record.appliedConfirmed ? " checked" : "");

  const appliedCb = document.createElement("input");
  appliedCb.type = "checkbox";
  appliedCb.checked = !!record.appliedConfirmed;
  appliedCb.disabled = !record.viewed;

  const appliedLabel = document.createElement("label");
  appliedLabel.textContent = "Applied";

  appliedCb.onchange = () => {
    if (!getRecord(id).viewed) {
      appliedCb.checked = false;
      return;
    }
    const next = setRecord(id, { appliedConfirmed: appliedCb.checked }, job);
    appliedWrap.classList.toggle("checked", next.appliedConfirmed);
    div.classList.toggle("appliedConfirmed", next.appliedConfirmed);
  };

  appliedWrap.append(appliedCb, appliedLabel);

  const viewBtn = document.createElement("button");
  viewBtn.className = "btn" + (record.viewed ? " touched" : "");
  viewBtn.textContent = "View";
  viewBtn.onclick = () => {
    const next = setRecord(id, { viewed: true }, job);
    viewBtn.classList.toggle("touched", next.viewed);
    div.classList.add("viewed");

    appliedCb.disabled = false;

    if (!appliedWrap.parentElement) actions.appendChild(appliedWrap);
    if (job.url) window.open(job.url, "_blank");
  };

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "btn" + (record.rejected ? " touched" : "");
  rejectBtn.textContent = "Reject";

  const blBtn = document.createElement("button");
  blBtn.className = "btn";
  blBtn.textContent = "Blacklist";
  blBtn.hidden = !record.rejected;

  rejectBtn.onclick = () => {
    const next = setRecord(id, { rejected: true }, job);
    rejectBtn.classList.toggle("touched", next.rejected);
    div.classList.add("rejected");
    blBtn.hidden = false;
  };

  blBtn.onclick = () => {
    const existing = div.querySelector(".bl-panel");
    if (existing) { existing.remove(); return; }
    const panel = buildBlacklistPanel(job, id, div);
    div.appendChild(panel);
  };

  actions.append(whyWrap, viewBtn, rejectBtn, blBtn);
  if (record.viewed) actions.appendChild(appliedWrap);

  div.appendChild(actions);
  return div;
}

// ---------- Search ----------
async function runSearch() {
  const out = $("results");
  if (!out) return;

  hardStopAllLoaders();
  out.innerHTML = "";
  state.rendered = {};
  state.currentResults = [];

  loadMemory();

  const tasks = [];
  for (const g of state.greenhouse) tasks.push({ type: "Greenhouse", label: g, fn: () => fetchGreenhouse(g) });
  for (const l of state.lever) tasks.push({ type: "Lever", label: l, fn: () => fetchLever(l) });
  for (const c of state.custom) tasks.push({ type: "Custom", label: c, fn: () => fetchCustom(c) });

  const total = tasks.length;
  let done = 0, skipped = 0, failed = 0;
  let jobs = [];

  const PER_SOURCE_TIMEOUT_MS = 12000;

  setLoading(true, {
    statusText: total ? `Searching sources (0/${total})...` : "No sources configured. Open Sources & Settings.",
    progressPct: 0,
    noteText: ""
  });

  let timeoutHandle = null;
  let timedOut = false;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new Error("TIMEOUT"));
    }, TIMEOUT_MS);
  });

  function withTimeout(promise, ms) {
    let h = null;
    const t = new Promise((_, reject) => { h = setTimeout(() => reject(new Error("SOURCE_TIMEOUT")), ms); });
    return Promise.race([promise, t]).finally(() => { if (h) clearTimeout(h); });
  }

  const doSearch = (async () => {
    for (const t of tasks) {
      setProgress(`${t.type}: ${t.label} (${done}/${total})`, done, total, `Skipped: ${skipped}  Failed/Timed: ${failed}`);

      try {
        const chunk = await withTimeout(Promise.resolve().then(() => t.fn()), PER_SOURCE_TIMEOUT_MS);
        if (Array.isArray(chunk) && chunk.length) jobs.push(...chunk);
        else skipped += 1;
      } catch {
        failed += 1;
      }

      done += 1;
      setProgress(`${t.type}: ${t.label} (${done}/${total})`, done, total, `Skipped: ${skipped}  Failed/Timed: ${failed}`);
    }
    return jobs;
  })();

  let allJobs = [];
  try {
    allJobs = await Promise.race([doSearch, timeoutPromise]);
  } catch (e) {
    if (timedOut) toast("Search timed out");
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // De-dupe
  const seen = new Set();
  const uniq = [];
  for (const j of allJobs) {
    const id = jobId(j);
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push(j);
  }

  // Apply gates + hide previously resolved
  const relaxed = (state.mode === "relaxed");
  const filtered = uniq
    .filter(j => !shouldHide(j))
    .filter(j => passesGates(j, relaxed))
    .slice(0, MAX_RESULTS);

  // Canonical current results for purge + rerender
  state.currentResults = filtered.slice();

  filtered.forEach(j => out.appendChild(renderJob(j)));

  setLoading(false, {});

  const loaded = document.createElement("div");
  loaded.className = "loaded";
  loaded.textContent = `Loaded ${filtered.length}`;
  out.appendChild(loaded);

  refreshDirtyUI();
}

// ---------- Dirty UI Mount ----------
function mountDirtyUI() {
  const controls = $("controls");
  if (!controls) return;

  // Already mounted?
  if ($("dirtyWrap")) return;

  const wrap = document.createElement("div");
  wrap.id = "dirtyWrap";
  wrap.className = "sjs-dirtywrap";

  const tag = document.createElement("div");
  tag.id = "sjsDirtyTag";
  tag.className = "sjs-dirtytag";
  tag.textContent = "Dirty: 0";

  const note = document.createElement("div");
  note.id = "dirtyNote";
  note.className = "sjs-dirtynote";
  note.textContent = "Staged rules are local until promoted.";

  const btnCopy = document.createElement("button");
  btnCopy.id = "btnCopyRulesJson";
  btnCopy.className = "btn sjs-dirtybtn";
  btnCopy.textContent = "Copy rules.json";
  btnCopy.onclick = async () => {
    const payload = getRulesJsonPayload();
    const txt = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(txt);
      toast("Copied rules.json to clipboard");
    } catch {
      toast("Copy failed (clipboard blocked)");
    }
  };

  const btnMail = document.createElement("button");
  btnMail.id = "btnMailDirty";
  btnMail.className = "btn sjs-dirtybtn";
  btnMail.textContent = "Mail promote packet";
  btnMail.onclick = mailDirtyList;

  const btnDlJson = document.createElement("button");
  btnDlJson.id = "btnDlRulesJson";
  btnDlJson.className = "btn sjs-dirtybtn";
  btnDlJson.textContent = "Download rules.json";
  btnDlJson.onclick = downloadRulesJson;

  wrap.append(tag, note, btnCopy, btnMail, btnDlJson);
  controls.appendChild(wrap);

  refreshDirtyUI();
}

// ---------- App State Boot ----------
async function boot() {
  loadSourcesFromStorage();
  loadMemory();

  window.APP_STATE = window.APP_STATE || {};
  const rules = await loadRulesJson();
  window.APP_STATE.rules = rules;

  mountDirtyUI();
  loadSettingsUI();

  setMode(state.mode);

  // Toast node
  if (!$("toast")) {
    const t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    document.body.appendChild(t);
  }

  refreshDirtyUI();
}

// ---------- Wiring ----------
function wire() {
  // Force initial closed state regardless of CSS.
  setSettingsVisible(false);

  $("btnSettings").onclick = () => {
    const s = $("settings");
    const isOpen = s ? (s.hidden === false && s.style.display !== "none") : false;
    setSettingsVisible(!isOpen);
    toast(!isOpen ? "Settings open" : "Settings closed");
  };

  $("btnSave").onclick = saveSettings;
  $("btnRun").onclick = runSearch;
  $("btnClear").onclick = () => { clearMemory(); };

  $("modeStrict").onclick = () => setMode("strict");
  $("modeRelaxed").onclick = () => setMode("relaxed");
}

// ---------- Start ----------
document.addEventListener("DOMContentLoaded", () => {
  wire();
  boot();
});
