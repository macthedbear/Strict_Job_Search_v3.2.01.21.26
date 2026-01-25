// app.js — Strict Job Search (de-duplicated full file)
// Aligned to index.html IDs: #btnRun #btnSettings #btnClear #modeStrict #modeRelaxed
// Settings textareas: #greenhouse #lever #custom ; Save: #btnSave ; Settings panel: #settings
// Results container: #results ; Controls container: .controls
//
// Guarantees in this file:
// • Single definition per function (no shadowing/overrides).
// • Red verdicts never render.
// • Why control uses WhyInfo.png (no "i" glyph).
// • Canada anywhere in location string hard-excludes.
// • Explicit rules gate before first render (best-effort wait + fallback rules fetch).
// • Strict remote-first; Relaxed keeps non-remote but signals via yellow.
//
// Notes:
// • DOM is a view; localStorage + in-memory state are authoritative.
// • No CSS file edits required.

const $ = (id) => document.getElementById(id);

const state = {
  greenhouse: [],
  lever: [],
  custom: [],
  mode: "strict",

  memory: {},          // jobId -> { viewed, rejected, appliedConfirmed, job }
  rendered: {},        // jobId -> job (for current results view)
  currentResults: []   // canonical on-screen list used for purge + rerender
};

const MAX_RESULTS = 15;
const MEMORY_KEY = "jobMemoryV3";
const STAGED_RULES_KEY = "sjs_staged_rules_v1";

const TIMEOUT_MS = 180000;            // whole-run hard stop
const PER_SOURCE_TIMEOUT_MS = 12000;  // per-source timeout
const PROGRESS_BASELINE_PCT = 6;

// ---------- Utilities ----------
function norm(s) {
  return String(s || "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jobId(job) {
  const base = job.url || (job.company + "|" + job.title + "|" + job.location);
  return btoa(unescape(encodeURIComponent(base))).slice(0, 64);
}

function toast(msg) {
  let el = document.getElementById("sjsToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "sjsToast";
    el.className = "sjs-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 1700);
}

function locationHasCanada(locRaw) {
  const raw = String(locRaw || "");
  if (!raw) return false;
  if (/\bcanada\b/i.test(raw)) return true;
  if (/(?:^|[,\s\(\[])CAN(?:$|[,\s\)\]-])/.test(raw)) return true;
  return false;
}

async function awaitRulesReady(timeoutMs = 1500) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    const rules = window.APP_STATE?.rules?.explicitRules;
    if (Array.isArray(rules)) return true;
    await sleep(50);
  }
  return false;
}

async function ensureDurableRulesLoaded() {
  if (Array.isArray(window.APP_STATE?.rules?.explicitRules)) return true;
  try {
    const res = await fetch("./rules.json", { cache: "no-store" });
    if (!res.ok) return false;
    const rules = await res.json();
    window.APP_STATE = window.APP_STATE || {};
    window.APP_STATE.rules = rules;
    window.APP_STATE.version = rules?.version || null;
    return Array.isArray(rules?.explicitRules);
  } catch {
    return false;
  }
}

// ---------- Inline CSS (only what app.js needs) ----------
(function injectCSS() {
  if (document.getElementById("sjs-inline-css")) return;
  const style = document.createElement("style");
  style.id = "sjs-inline-css";
  style.textContent = `
    .sjs-dirtywrap{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-left:auto; }
    .sjs-dirtytag{
      display:inline-flex; align-items:center; height:32px; padding:0 12px;
      border-radius:999px; background:rgba(77,219,177,.28);
      border:1px solid rgba(77,219,177,.55); color:rgba(15,15,18,.92);
      font-weight:800;
    }
    .sjs-dirtynote{ font-size:12px; opacity:.82; margin-left:6px; }
    .sjs-dirtybtn{ height:32px; }

    .whyicon{
      width:28px; height:28px; border-radius:10px;
      border:1px solid rgba(255,255,255,.16);
      background:rgba(0,0,0,.22);
      display:flex; align-items:center; justify-content:center;
      padding:4px;
      cursor:pointer;
    }
    .whyicon.green{ box-shadow:0 0 0 2px rgba(100,255,100,.35); }
    .whyicon.yellow{ box-shadow:0 0 0 2px rgba(255,210,70,.35); }
    .whyicon.red{ box-shadow:0 0 0 2px rgba(255,90,90,.35); }
    .whyicon img{ width:100%; height:100%; object-fit:contain; }

    .bl-panel{
      margin-top:10px; padding:10px; border-radius:12px;
      background:rgba(0,0,0,.20);
      border:1px solid rgba(255,255,255,.12);
    }
    .bl-row{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:8px 0; }
    .bl-row label{ margin:0; font-weight:650; opacity:.92; }
    .bl-row input[type="text"]{
      flex:1; min-width:200px; padding:8px 10px;
      border-radius:10px; border:1px solid rgba(255,255,255,.14);
      background:rgba(250,250,255,.92); color:rgba(15,15,18,.92);
    }
    .bl-hint{ font-size:12px; opacity:.78; margin-top:6px; }
    .bl-actions{ display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }

    .sjs-toast{
      position:fixed; left:50%; bottom:18px;
      transform:translateX(-50%) translateY(14px);
      opacity:0; pointer-events:none;
      padding:10px 14px; border-radius:999px;
      border:1px solid rgba(255,255,255,.18);
      background:rgba(0,0,0,.82);
      color:rgba(255,255,255,.92);
      font-size:12px; font-weight:650;
      transition: opacity .18s ease, transform .18s ease;
      z-index:9999;
      white-space:pre-line;
      max-width:min(520px, calc(100vw - 30px));
    }
    .sjs-toast.show{ opacity:1; transform:translateX(-50%) translateY(0); }
  `;
  document.head.appendChild(style);
})();

// ---------- Settings persistence ----------
function loadSettings() {
  state.greenhouse = safeJsonParse(localStorage.getItem("greenhouse") || "[]", []);
  state.lever = safeJsonParse(localStorage.getItem("lever") || "[]", []);
  state.custom = safeJsonParse(localStorage.getItem("custom") || "[]", []);

  const gh = $("greenhouse");
  const lv = $("lever");
  const cu = $("custom");
  if (gh) gh.value = (state.greenhouse || []).join("\n");
  if (lv) lv.value = (state.lever || []).join("\n");
  if (cu) cu.value = (state.custom || []).join("\n");
}

function saveSettings() {
  const gh = $("greenhouse");
  const lv = $("lever");
  const cu = $("custom");
  if (!gh || !lv || !cu) {
    toast("Settings UI missing (did not overwrite storage)");
    return;
  }
  state.greenhouse = gh.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
  state.lever = lv.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
  state.custom = cu.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
  try { localStorage.setItem("greenhouse", JSON.stringify(state.greenhouse)); } catch {}
  try { localStorage.setItem("lever", JSON.stringify(state.lever)); } catch {}
  try { localStorage.setItem("custom", JSON.stringify(state.custom)); } catch {}
  setSettingsVisible(false);
  toast("Saved");
}

function setSettingsVisible(open) {
  const s = $("settings");
  if (!s) return;
  s.hidden = !open;
  s.style.display = open ? "" : "none";
}

function toggleSettings() {
  const s = $("settings");
  if (!s) return;
  const open = !(s.hidden === false && s.style.display !== "none");
  setSettingsVisible(open);
}

// ---------- Memory ----------
function loadMemory() {
  state.memory = safeJsonParse(localStorage.getItem(MEMORY_KEY) || "{}", {});
}

function saveMemory() {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(state.memory)); } catch {}
}

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
  const r = state.memory[jobId(job)];
  return !!(r && (r.rejected || r.appliedConfirmed));
}

// ---------- Mode ----------
function setMode(m) {
  state.mode = (m === "relaxed") ? "relaxed" : "strict";
  $("modeStrict")?.classList.toggle("active", state.mode === "strict");
  $("modeRelaxed")?.classList.toggle("active", state.mode === "relaxed");
  document.body.classList.toggle("relaxed", state.mode === "relaxed");
  toast(state.mode === "strict" ? "Strict" : "Relaxed");
}

// ---------- Rules ----------
function loadStagedRulesFallback() {
  const raw = localStorage.getItem(STAGED_RULES_KEY);
  const parsed = raw ? safeJsonParse(raw, []) : [];
  return Array.isArray(parsed) ? parsed : [];
}

function saveStagedRulesFallback(arr) {
  try { localStorage.setItem(STAGED_RULES_KEY, JSON.stringify(arr)); } catch {}
}

function getDurableRules() {
  return Array.isArray(window.APP_STATE?.rules?.explicitRules)
    ? window.APP_STATE.rules.explicitRules
    : [];
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
    norm(r?.type) === norm(normalized.type) &&
    norm(r?.value) === norm(normalized.value)
  );
  if (exists) return;

  if (window.APP_ACTIONS?.stageRule && Array.isArray(window.APP_STATE?.stagedRules)) {
    window.APP_ACTIONS.stageRule(normalized);
  } else {
    const staged = getStagedRules();
    staged.push(normalized);
    saveStagedRulesFallback(staged);
    window.APP_STATE = window.APP_STATE || {};
    if (!Array.isArray(window.APP_STATE.stagedRules)) window.APP_STATE.stagedRules = staged;
  }
  refreshDirtyUI();
}

function evaluateExplicitRules(job) {
  const rules = getDurableRules().concat(getStagedRules());
  const comp = norm(job.company);
  const title = norm(job.title);
  const loc = norm(job.location);
  const text = norm(job.title + " " + job.location + " " + (job.description || ""));
  for (const r of rules) {
    const rt = norm(r?.type);
    const rv = norm(r?.value);
    if (!rt || !rv) continue;
    if (rt === "company" && comp === rv) return true;
    if (rt === "title" && title.includes(rv)) return true;
    if (rt === "location" && loc.includes(rv)) return true;
    if (rt === "keyword" && text.includes(rv)) return true;
  }
  return false;
}

// ---------- Gates ----------
function passesGates(job, relaxed = false) {
  if (evaluateExplicitRules(job)) return false;
  const locRaw = String(job.location || "").trim();
  if (locationHasCanada(locRaw)) return false;

  const loc = norm(locRaw);
  const isRemote = loc.includes("remote");
  const isHybrid = loc.includes("hybrid");
  const isOnsite =
    loc.includes("onsite") ||
    loc.includes("on-site") ||
    loc.includes("in office") ||
    loc.includes("in-office") ||
    loc.includes("office");

  if (!relaxed) {
    if (isOnsite || isHybrid) return false;
    if (!isRemote) return false;
  }
  return true;
}

// ---------- Why semantics ----------
const US_STATE_ABBRS = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DC","DE","FL","GA","HI","IA","ID","IL","IN","KS","KY","LA","MA","MD","ME","MI","MN","MO","MS","MT","NC","ND","NE","NH","NJ","NM","NV","NY","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VA","VT","WA","WI","WV","WY"
]);

function looksLikeUSLocation(locRaw) {
  const raw = String(locRaw || "");
  const loc = norm(raw);
  if (!loc) return false;
  if (locationHasCanada(raw)) return false;
  if (loc.includes("united states") || loc.includes("usa") || loc.includes("u.s.") || loc.includes("us ")) return true;
  const m = raw.match(/,\s*([A-Z]{2})\b/);
  if (m && US_STATE_ABBRS.has(m[1])) return true;
  const upper = raw.toUpperCase();
  for (const ab of US_STATE_ABBRS) {
    if (upper.match(new RegExp(`\\b${ab}\\b`))) return true;
  }
  return false;
}

const TITLE_CONTRADICTION_TERMS = [
  "marketing","account executive","business development","sales","recruiter",
  "human resources","hr","finance","payroll","treasury","customer success",
  "regional marketing","partner marketing","legal counsel","attorney","paralegal"
];

function titleContradiction(job) {
  const t = norm(job?.title);
  if (!t) return null;
  for (const term of TITLE_CONTRADICTION_TERMS) {
    const n = norm(term);
    if (n && t.includes(n)) return term;
  }
  return null;
}

function whyVerdict(job) {
  if (evaluateExplicitRules(job)) return { color: "red", reason: "Explicit rule hit" };
  if (locationHasCanada(job?.location)) return { color: "red", reason: "Canada in location string" };

  const contra = titleContradiction(job);
  if (contra) return { color: "red", reason: `Title contradiction: ${contra}` };

  const locRaw = String(job?.location || "").trim();
  const loc = norm(locRaw);
  if (!loc) return { color: "yellow", reason: "Missing location string" };

  const isRemote = loc.includes("remote");
  const isHybrid = loc.includes("hybrid");
  const isOnsite =
    loc.includes("onsite") ||
    loc.includes("on-site") ||
    loc.includes("in office") ||
    loc.includes("in-office") ||
    loc.includes("office");

  if (state.mode === "strict") {
    if (isOnsite || isHybrid) return { color: "red", reason: "Not remote" };
    if (!isRemote) return { color: "red", reason: "Location does not say remote" };

    const hasHardConstraint =
      /must be|must reside|must live|within|commutable|commute|in[- ]person|on[- ]site|come in|onsite|on-site/.test(loc) ||
      /\b(\d{1,2})\s*(days|day)\s*(a|per)?\s*week\b/.test(loc);

    const hasCitySignal =
      /,\s*[A-Z]{2}\b/.test(locRaw) ||
      /\b(seattle|san\s*francisco|sf\b|bay\s*area|new\s*york|nyc|austin|boston|chicago|denver|los\s*angeles|la\b|atlanta|dallas|miami|portland|phoenix|san\s*diego|washington\s*dc|dc\b)\b/i.test(locRaw);

    if (hasHardConstraint || hasCitySignal) return { color: "yellow", reason: "Remote with location constraint" };

    if (isRemote && !looksLikeUSLocation(locRaw) && !(loc.includes("united states") || loc.includes("usa") || loc.includes("us"))) {
      return { color: "yellow", reason: "Remote, region unclear" };
    }
    return { color: "green", reason: "Remote (no explicit rule hit)" };
  }

  if (isOnsite || isHybrid) return { color: "yellow", reason: "Onsite/Hybrid (relaxed mode)" };
  if (!isRemote) return { color: "yellow", reason: "Not remote (relaxed mode)" };

  const hasCitySignal =
    /,\s*[A-Z]{2}\b/.test(locRaw) ||
    /\b(seattle|san\s*francisco|sf\b|bay\s*area|new\s*york|nyc|austin|boston|chicago|denver|los\s*angeles|la\b|atlanta|dallas|miami|portland|phoenix|san\s*diego|washington\s*dc|dc\b)\b/i.test(locRaw);

  if (hasCitySignal) return { color: "yellow", reason: "Remote with location signal" };
  return { color: "green", reason: "Remote" };
}

function showWhy(job) {
  const v = whyVerdict(job);
  toast(
    `Verdict: ${v.color.toUpperCase()}\n` +
    `Reason: ${v.reason}\n\n` +
    `Title: ${job.title}\n` +
    `Location: ${job.location}\n` +
    `Company: ${job.company}`
  );
}

// ---------- Rendering ----------
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

  const whyWrap = document.createElement("button");
  whyWrap.className = "whyicon";
  const verdict = whyVerdict(job);
  whyWrap.classList.add(verdict.color);
  whyWrap.title = "Why";

  const iconImg = document.createElement("img");
  iconImg.src = "WhyInfo.png";
  iconImg.alt = "Why";
  whyWrap.appendChild(iconImg);
  whyWrap.onclick = () => showWhy(job);

  const appliedWrap = document.createElement("div");
  appliedWrap.className = "appliedWrap" + (record.appliedConfirmed ? " checked" : "");
  const applied = document.createElement("input");
  applied.type = "checkbox";
  applied.checked = !!record.appliedConfirmed;
  applied.disabled = !record.viewed;
  const appliedLabel = document.createElement("label");
  appliedLabel.textContent = "Applied";
  applied.onchange = () => {
    if (!getRecord(id).viewed) { applied.checked = false; return; }
    const next = setRecord(id, { appliedConfirmed: applied.checked }, job);
    appliedWrap.classList.toggle("checked", next.appliedConfirmed);
    div.classList.toggle("appliedConfirmed", next.appliedConfirmed);
  };
  appliedWrap.append(applied, appliedLabel);

  const btnView = document.createElement("button");
  btnView.className = "btn" + (record.viewed ? " touched" : "");
  btnView.textContent = "View";
  btnView.onclick = () => {
    const next = setRecord(id, { viewed: true }, job);
    div.classList.add("viewed");
    btnView.classList.toggle("touched", next.viewed);
    applied.disabled = false;
    if (!appliedWrap.parentElement) actions.appendChild(appliedWrap);
    if (job.url) window.open(job.url, "_blank");
  };

  const btnReject = document.createElement("button");
  btnReject.className = "btn" + (record.rejected ? " touched" : "");
  btnReject.textContent = "Reject";
  btnReject.onclick = () => {
    const next = setRecord(id, { rejected: true }, job);
    div.classList.add("rejected");
    btnReject.classList.toggle("touched", next.rejected);
  };

  actions.append(whyWrap, btnView, btnReject);
  if (record.viewed) actions.appendChild(appliedWrap);

  div.appendChild(actions);
  return div;
}

// ---------- Search ----------
async function withTimeout(promise, ms) {
  let h = null;
  const t = new Promise((_, reject) => { h = setTimeout(() => reject(new Error("SOURCE_TIMEOUT")), ms); });
  return Promise.race([promise, t]).finally(() => { if (h) clearTimeout(h); });
}

function verdictScore(color) {
  if (color === "green") return 0;
  if (color === "yellow") return 1;
  return 2;
}

async function runSearch() {
  const out = $("results");
  if (!out) return;

  await Promise.race([awaitRulesReady(1500), ensureDurableRulesLoaded()]);

  out.innerHTML = "";
  state.rendered = {};
  state.currentResults = [];
  loadMemory();

  const tasks = [];
  for (const g of state.greenhouse) tasks.push({ type: "Greenhouse", label: g, fn: () => fetchGreenhouse(g) });
  for (const l of state.lever) tasks.push({ type: "Lever", label: l, fn: () => fetchLever(l) });
  for (const c of state.custom) tasks.push({ type: "Custom", label: c, fn: () => fetchCustom(c) });

  if (!tasks.length) {
    out.innerHTML = `<div class="loaded">Loaded 0</div>`;
    toast("No sources configured");
    return;
  }

  let jobs = [];
  for (const t of tasks) {
    try {
      const chunk = await withTimeout(Promise.resolve().then(() => t.fn()), PER_SOURCE_TIMEOUT_MS);
      if (Array.isArray(chunk) && chunk.length) jobs.push(...chunk);
    } catch {}
  }

  const seen = new Set();
  const uniq = [];
  for (const j of jobs) {
    const id = jobId(j);
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push(j);
  }

  const relaxed = (state.mode === "relaxed");
  const prefiltered = uniq
    .filter(j => !shouldHide(j))
    .filter(j => passesGates(j, relaxed))
    .filter(j => !evaluateExplicitRules(j))
    .filter(j => !locationHasCanada(j?.location))
    .filter(j => whyVerdict(j).color !== "red");

  const ranked = prefiltered
    .map((j, idx) => ({ j, idx, v: whyVerdict(j) }))
    .sort((a, b) => (verdictScore(a.v.color) - verdictScore(b.v.color)) || (a.idx - b.idx))
    .map(x => x.j)
    .slice(0, MAX_RESULTS);

  state.currentResults = ranked.slice();
  ranked.forEach(j => out.appendChild(renderJob(j)));

  const loaded = document.createElement("div");
  loaded.className = "loaded";
  loaded.textContent = `Loaded ${ranked.length}`;
  out.appendChild(loaded);
}

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

// ---------- Wire UI ----------
function wire() {
  setSettingsVisible(false);
  $("btnSettings")?.addEventListener("click", toggleSettings);
  $("btnSave")?.addEventListener("click", saveSettings);
  $("btnRun")?.addEventListener("click", runSearch);
  $("btnClear")?.addEventListener("click", () => {
    try { localStorage.removeItem(MEMORY_KEY); } catch {}
    try { localStorage.removeItem(STAGED_RULES_KEY); } catch {}
    loadMemory();
    toast("Cleared job memory + staged rules");
  });
  $("modeStrict")?.addEventListener("click", () => setMode("strict"));
  $("modeRelaxed")?.addEventListener("click", () => setMode("relaxed"));
  loadSettings();
  loadMemory();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire);
} else {
  wire();
}
