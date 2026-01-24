// app.js — Strict Job Search (rebase-safe)
// Aligned to index.html IDs: #btnRun #btnSettings #btnClear #modeStrict #modeRelaxed
// Settings textareas: #greenhouse #lever #custom ; Save: #btnSave ; Settings panel: #settings
// Results container: #results ; Controls container: .controls
//
// Fixes:
// 1) Settings persistence no longer gets wiped on reload.
// 2) Dirty plaque always mounts (no missing anchor).
// 3) Blacklist purge is authoritative: re-filter + re-render (Korea/Dublin/BizOps purge instantly).
// 4) Restores progress indicator semantics (animated + teal→blue convergence) in app.js, no CSS edits.

const $ = (id) => document.getElementById(id);

const state = {
  greenhouse: [],
  lever: [],
  custom: [],
  mode: "strict",

  memory: {},          // jobId -> { viewed, rejected, appliedConfirmed, job }
  rendered: {},        // jobId -> job (for current results view)
  currentResults: []   // canonical on-screen list (authoritative purge source)
};

const MAX_RESULTS = 15;
const MEMORY_KEY = "jobMemoryV3";
const TIMEOUT_MS = 180000; // 3 minutes

// Staged rules persistence
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

// ---------- Local persistence (sources + memory) ----------
function loadMemory() {
  state.memory = safeJsonParse(localStorage.getItem(MEMORY_KEY) || "{}", {});
}

function saveMemory() {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(state.memory)); } catch {}
}

function loadSettings() {
  // IMPORTANT: Never write storage here. Read only.
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

  // Guard: If the DOM nodes are missing for any reason, do NOT overwrite storage.
  if (!gh || !lv || !cu) {
    toast("Settings UI missing (did not overwrite storage)");
    return;
  }

  const nextGreenhouse = gh.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const nextLever = lv.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const nextCustom = cu.value.split(/\n+/).map(s => s.trim()).filter(Boolean);

  state.greenhouse = nextGreenhouse;
  state.lever = nextLever;
  state.custom = nextCustom;

  try { localStorage.setItem("greenhouse", JSON.stringify(state.greenhouse)); } catch {}
  try { localStorage.setItem("lever", JSON.stringify(state.lever)); } catch {}
  try { localStorage.setItem("custom", JSON.stringify(state.custom)); } catch {}

  setSettingsVisible(false);
  toast("Saved (settings closed)");
}

async function clearMemory() {
  // Clears all device-local persistence for this app.
  const explicitKeys = new Set([
    MEMORY_KEY,
    "greenhouse",
    "lever",
    "custom",
    STAGED_RULES_KEY
  ]);

  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (explicitKeys.has(k) || k.startsWith("sjs_")) {
        try { localStorage.removeItem(k); } catch {}
      }
    }
  } catch {}

  state.memory = {};
  state.rendered = {};
  state.currentResults = [];
  state.greenhouse = [];
  state.lever = [];
  state.custom = [];

  const out = $("results");
  if (out) out.innerHTML = "";

  const gh = $("greenhouse");
  const lv = $("lever");
  const cu = $("custom");
  if (gh) gh.value = "";
  if (lv) lv.value = "";
  if (cu) cu.value = "";

  refreshDirtyUI();
  toast("Device data cleared");
}

// ---------- Settings panel visibility ----------
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

// ---------- Mode ----------
function setMode(m) {
  state.mode = (m === "relaxed") ? "relaxed" : "strict";
  $("modeStrict")?.classList.toggle("active", state.mode === "strict");
  $("modeRelaxed")?.classList.toggle("active", state.mode === "relaxed");
  document.body.classList.toggle("relaxed", state.mode === "relaxed");
  toast(state.mode === "strict" ? "Strict" : "Relaxed");
}

// ---------- Rules (durable + staged) ----------
function getDurableRules() {
  return Array.isArray(window.APP_STATE?.rules?.explicitRules)
    ? window.APP_STATE.rules.explicitRules
    : [];
}

function loadStagedRulesFallback() {
  const raw = localStorage.getItem(STAGED_RULES_KEY);
  const parsed = raw ? safeJsonParse(raw, []) : [];
  return Array.isArray(parsed) ? parsed : [];
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
    if (window.APP_STATE && !Array.isArray(window.APP_STATE.stagedRules)) {
      window.APP_STATE.stagedRules = staged;
    }
  }

  refreshDirtyUI();
}

function evaluateExplicitRules(job) {
  const rules = getDurableRules().concat(getStagedRules());

  const comp = norm(job.company);
  const title = norm(job.title);
  const loc = norm(job.location);
  const text = norm(job.title + " " + job.location + " " + job.description);

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

// ---------- Authoritative purge ----------
function rerenderFromCurrentResults() {
  const out = $("results");
  if (!out) return;

  out.innerHTML = "";
  state.rendered = {};

  const filtered = (state.currentResults || []).filter(j => !evaluateExplicitRules(j));
  state.currentResults = filtered;

  filtered.forEach(j => out.appendChild(renderJob(j)));

  const loaded = document.createElement("div");
  loaded.className = "loaded";
  loaded.textContent = `Loaded ${filtered.length}`;
  out.appendChild(loaded);
}

function purgeAndRerender() {
  rerenderFromCurrentResults();
  refreshDirtyUI();
}

// ---------- Minimal UI CSS (no styles.css edits) ----------
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
    .bl-panel{ margin-top:10px; padding:10px; border-radius:12px; background:rgba(0,0,0,.20); border:1px solid rgba(255,255,255,.12); }
    .bl-row{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:8px 0; }
    .bl-row label{ margin:0; font-weight:650; opacity:.92; }
    .bl-row input[type="text"]{ flex:1; min-width:200px; padding:8px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.14); background:rgba(250,250,255,.92); color:rgba(15,15,18,.92); }
    .bl-hint{ font-size:12px; opacity:.78; margin-top:6px; }
    .bl-actions{ display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }
    .whyicon{ width:28px; height:28px; border-radius:10px; border:1px solid rgba(255,255,255,.16); background:rgba(0,0,0,.22); display:flex; align-items:center; justify-content:center; padding:4px; }
    .whyicon img{ width:100%; height:100%; object-fit:contain; }
    .whyicon.green{ box-shadow:0 0 0 2px rgba(100,255,100,.35); }
    .whyicon.yellow{ box-shadow:0 0 0 2px rgba(255,210,70,.35); }
    .whyicon.red{ box-shadow:0 0 0 2px rgba(255,90,90,.35); }
    .sjs-toast{
      position:fixed; left:50%; bottom:18px; transform:translateX(-50%) translateY(14px);
      opacity:0; pointer-events:none; padding:10px 14px; border-radius:999px;
      border:1px solid rgba(255,255,255,.18); background:rgba(0,0,0,.82); color:rgba(255,255,255,.92);
      font-size:12px; font-weight:650; transition: opacity .18s ease, transform .18s ease; z-index:9999;
    }
    .sjs-toast.show{ opacity:1; transform:translateX(-50%) translateY(0); }
  `;
  document.head.appendChild(style);
})();

// ---------- Progress UI (semantic + animated, restored in app.js) ----------
function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }

function mixHex(aHex, bHex, t) {
  const a = hexToRgb(aHex);
  const b = hexToRgb(bHex);
  const r = Math.round(lerp(a.r, b.r, t));
  const g = Math.round(lerp(a.g, b.g, t));
  const b2 = Math.round(lerp(a.b, b.b, t));
  return `rgb(${r}, ${g}, ${b2})`;
}

function ensureProgressUI() {
  const controls = document.querySelector(".controls");
  if (!controls) return null;

  let wrap = document.getElementById("sjsProgress");
  if (wrap) return wrap;

  wrap = document.createElement("div");
  wrap.id = "sjsProgress";
  wrap.className = "sjs-progress";
  wrap.hidden = true;

  const bar = document.createElement("div");
  bar.id = "sjsProgressBar";
  wrap.appendChild(bar);

  // Put it in the same place your CSS expects: after controls, before results
  controls.parentElement?.insertBefore(wrap, controls.nextSibling);

  // IMPORTANT: reassert animation from JS (app.js owns the operator signal).
  // CSS already defines @keyframes sjsGradientShift, we just guarantee it's engaged.
  bar.style.animation = "sjsGradientShift 1.4s linear infinite";
  bar.style.backgroundSize = "220% 100%";

  return wrap;
}

function setProgressRunning(on) {
  ensureProgressUI();
  const bar = document.getElementById("sjsProgressBar");
  if (!bar) return;

  // If a browser ever “optimizes away” animation, restarting it makes motion explicit.
  if (on) {
    bar.style.animation = "none";
    // force reflow
    void bar.offsetHeight;
    bar.style.animation = "sjsGradientShift 1.4s linear infinite";
  } else {
    // leave animation alone; hideProgress handles disappearance
  }
}

function applySemanticGradient(pct) {
  const bar = document.getElementById("sjsProgressBar");
  if (!bar) return;

  // Semantic intent:
  // early = teal-dominant (uncertain / in-flight)
  // late  = blue-dominant (settling / nearing completion)
  const t = Math.max(0, Math.min(1, pct / 100));

  const TEAL = "#4DDBB1";
  const BLUE = "#3FA9F5";

  // Drift toward blue as completion increases.
  const lead = mixHex(TEAL, BLUE, Math.min(1, t * 0.95));
  const mid = mixHex(TEAL, BLUE, Math.min(1, t * 1.15));
  const tail = mixHex(TEAL, BLUE, Math.min(1, t * 0.75));

  // Use a repeating-ish gradient so shifting background-position reads as motion.
  bar.style.background = `linear-gradient(90deg,
    ${lead},
    ${mid},
    ${tail},
    ${mid},
    ${lead}
  )`;

  // Subtle confidence glow: stronger as it converges
  const glow = 0.20 + (0.22 * t);
  bar.style.boxShadow = `0 0 18px rgba(63,169,245,${glow.toFixed(3)})`;
}

function setProgress(pct) {
  ensureProgressUI();
  const wrap = document.getElementById("sjsProgress");
  const bar = document.getElementById("sjsProgressBar");
  if (!wrap || !bar) return;

  wrap.hidden = false;
  wrap.style.display = "";

  const clamped = Math.max(0, Math.min(100, pct));
  bar.style.width = clamped.toFixed(1) + "%";

  // Restore semantic color shift in app.js.
  applySemanticGradient(clamped);
}

function hideProgress() {
  const wrap = document.getElementById("sjsProgress");
  const bar = document.getElementById("sjsProgressBar");
  if (!wrap || !bar) return;

  setTimeout(() => {
    wrap.hidden = true;
    wrap.style.display = "none";
    bar.style.width = "0%";
  }, 350);
}

// ---------- Dirty UI ----------
function ensureDirtyUI() {
  const controls = document.querySelector(".controls");
  if (!controls) return null;

  let wrap = document.getElementById("sjsDirtyWrap");
  if (wrap) return wrap;

  wrap = document.createElement("div");
  wrap.id = "sjsDirtyWrap";
  wrap.className = "sjs-dirtywrap";

  const tag = document.createElement("div");
  tag.id = "sjsDirtyTag";
  tag.className = "sjs-dirtytag";
  tag.textContent = "Dirty: 0";

  const note = document.createElement("div");
  note.id = "sjsDirtyNote";
  note.className = "sjs-dirtynote";
  note.textContent = "Staged rules are local until promoted.";

  const btnCopy = document.createElement("button");
  btnCopy.id = "btnCopyRulesJson";
  btnCopy.className = "btn sjs-dirtybtn";
  btnCopy.textContent = "Copy rules.json";
  btnCopy.onclick = async () => {
    const payload = exportRulesJsonPayload();
    const txt = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(txt);
      toast("Copied rules.json");
    } catch {
      toast("Copy failed (clipboard blocked)");
    }
  };

  const btnMail = document.createElement("button");
  btnMail.id = "btnMailDirty";
  btnMail.className = "btn sjs-dirtybtn";
  btnMail.textContent = "Mail promote packet";
  btnMail.onclick = mailPromotePacket;

  const btnDl = document.createElement("button");
  btnDl.id = "btnDlRulesJson";
  btnDl.className = "btn sjs-dirtybtn";
  btnDl.textContent = "Download rules.json";
  btnDl.onclick = downloadRulesJson;

  wrap.append(tag, note, btnCopy, btnMail, btnDl);
  controls.appendChild(wrap);
  return wrap;
}

function refreshDirtyUI() {
  const wrap = ensureDirtyUI();
  if (!wrap) return;

  const tag = $("sjsDirtyTag");
  const n = getStagedRules().length;
  if (tag) tag.textContent = `Dirty: ${n}`;

  const disabled = (n === 0);
  $("btnCopyRulesJson") && ($("btnCopyRulesJson").disabled = disabled);
  $("btnMailDirty") && ($("btnMailDirty").disabled = disabled);
  $("btnDlRulesJson") && ($("btnDlRulesJson").disabled = disabled);
}

function exportRulesJsonPayload() {
  const durable = window.APP_STATE?.rules || { version: "1", explicitRules: [] };
  const staged = getStagedRules() || [];
  return {
    version: durable.version || "1",
    explicitRules: (durable.explicitRules || []).concat(staged)
  };
}

function downloadRulesJson() {
  const payload = exportRulesJsonPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rules.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function mailPromotePacket() {
  const payload = exportRulesJsonPayload();
  const subject = `SJS PROMOTE PACKET`;
  const body = `==== RULES.JSON BEGIN ====\n${JSON.stringify(payload, null, 2)}\n==== RULES.JSON END ====`;
  window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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

// ---------- Gates ----------
function passesGates(job, relaxed = false) {
  if (evaluateExplicitRules(job)) return false;
  return true;
}

// ---------- Why icon semantics ----------
function whyVerdict(job) {
  if (evaluateExplicitRules(job)) return { color: "red", reason: "Explicit rule hit" };
  return { color: "green", reason: "No explicit rule hit" };
}

function showWhy(job) {
  const v = whyVerdict(job);
  const msg = `Verdict: ${v.color.toUpperCase()}\nReason: ${v.reason}\n\nTitle: ${job.title}\nLocation: ${job.location}\nCompany: ${job.company}`;
  toast(msg);
}

// ---------- Blacklist panel ----------
function buildBlacklistPanel(job) {
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
  hint.textContent = "Stage rules locally. Export via Copy/Mail/Download rules.json.";

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

    purgeAndRerender();
  };

  actions.append(btnApply, btnCancel);
  panel.append(row1, row2, row3, row4, hint, actions);
  return panel;
}

// ---------- Memory helpers / card state ----------
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
    const panel = buildBlacklistPanel(job);
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

  out.innerHTML = "";
  state.rendered = {};
  state.currentResults = [];

  loadMemory();

  const tasks = [];
  for (const g of state.greenhouse) tasks.push({ fn: () => fetchGreenhouse(g) });
  for (const l of state.lever) tasks.push({ fn: () => fetchLever(l) });
  for (const c of state.custom) tasks.push({ fn: () => fetchCustom(c) });

  const total = tasks.length;

  // Progress: show immediately + force motion even at 0%
  setProgress(0);
  setProgressRunning(true);

  if (!total) {
    out.innerHTML = `<div class="loaded">Loaded 0</div>`;
    toast("No sources configured");
    setProgressRunning(false);
    hideProgress();
    return;
  }

  let jobs = [];
  let done = 0;

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("TIMEOUT")), TIMEOUT_MS);
  });

  async function withTimeout(promise, ms) {
    let h = null;
    const t = new Promise((_, reject) => { h = setTimeout(() => reject(new Error("SOURCE_TIMEOUT")), ms); });
    return Promise.race([promise, t]).finally(() => { if (h) clearTimeout(h); });
  }

  const doSearch = (async () => {
    for (const t of tasks) {
      try {
        const chunk = await withTimeout(Promise.resolve().then(() => t.fn()), 12000);
        if (Array.isArray(chunk) && chunk.length) jobs.push(...chunk);
      } catch {}
      done += 1;
      setProgress((done / total) * 100);
    }
    return jobs;
  })();

  try {
    await Promise.race([doSearch, timeoutPromise]);
  } catch {}

  // De-dupe
  const seen = new Set();
  const uniq = [];
  for (const j of jobs) {
    const id = jobId(j);
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push(j);
  }

  const relaxed = (state.mode === "relaxed");
  const filtered = uniq
    .filter(j => !shouldHide(j))
    .filter(j => passesGates(j, relaxed))
    .filter(j => !evaluateExplicitRules(j))
    .slice(0, MAX_RESULTS);

  state.currentResults = filtered.slice();

  filtered.forEach(j => out.appendChild(renderJob(j)));

  const loaded = document.createElement("div");
  loaded.className = "loaded";
  loaded.textContent = `Loaded ${filtered.length}`;
  out.appendChild(loaded);

  refreshDirtyUI();

  setProgress(100);
  setProgressRunning(false);
  hideProgress();
}

// ---------- Wire UI ----------
function wire() {
  setSettingsVisible(false);

  $("btnSettings")?.addEventListener("click", toggleSettings);
  $("btnSave")?.addEventListener("click", saveSettings);
  $("btnRun")?.addEventListener("click", runSearch);
  $("btnClear")?.addEventListener("click", () => { clearMemory(); });

  $("modeStrict")?.addEventListener("click", () => setMode("strict"));
  $("modeRelaxed")?.addEventListener("click", () => setMode("relaxed"));

  loadSettings();
  loadMemory();
  ensureProgressUI();
  ensureDirtyUI();
  refreshDirtyUI();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire);
} else {
  wire();
}
