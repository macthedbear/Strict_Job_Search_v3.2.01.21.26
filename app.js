// app.js — Strict Job Search (foundation restore, full pasteover)
// Aligned to index.html IDs:
//   #btnRun #btnSettings #btnClear #modeStrict #modeRelaxed
//   #settings #greenhouse #lever #custom #btnSave
//   #results
// Mounts into: .controls
//
// Restores:
// • Animated progress bar (CSS in styles.css: .sjs-progress)
// • Progress status text under bar (.sjs-note): step/total + ok/fail/timeout/empty + current source
// • Full job card function buttons: View, Reject, Blacklist (after Reject), Applied (after View)
// • Why icon per card (no external image dependency)
// • Authoritative purge: stage rule -> re-filter state.currentResults -> rerender
// • Settings persistence guard: never overwrite storage if settings DOM missing

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

const TIMEOUT_MS = 180000;          // whole-run hard stop
const PER_SOURCE_TIMEOUT_MS = 12000; // per-source timeout
const PROGRESS_BASELINE_PCT = 6;

// ---------- Utilities ----------
function norm(s) { return String(s || "").trim().toLowerCase(); }

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

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
    .whyicon .whyglyph{
      font-weight:900; font-size:14px; line-height:1;
      color:rgba(255,255,255,.92);
      width:100%; height:100%;
      display:flex; align-items:center; justify-content:center;
      user-select:none;
    }

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

  // Guard: never overwrite storage if DOM nodes are missing (prevents wipes).
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

// ---------- Staged rules ----------
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

// ---------- Dirty plaque ----------
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
  ensureDirtyUI();
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
  const subject = "SJS PROMOTE PACKET";
  const body = `==== RULES.JSON BEGIN ====\n${JSON.stringify(payload, null, 2)}\n==== RULES.JSON END ====`;
  window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ---------- Progress UI ----------
function ensureProgressUI() {
  const controls = document.querySelector(".controls");
  if (!controls) return null;

  let wrap = document.getElementById("sjsProgress");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "sjsProgress";
    wrap.className = "sjs-progress";
    wrap.hidden = true;
    wrap.style.display = "none";

    const bar = document.createElement("div");
    bar.id = "sjsProgressBar";
    wrap.appendChild(bar);

    controls.insertAdjacentElement("afterend", wrap);
  }

  let note = document.getElementById("sjsProgressNote");
  if (!note) {
    note = document.createElement("div");
    note.id = "sjsProgressNote";
    note.className = "sjs-note"; // styles.css defines this
    note.textContent = "";
  }
  if (wrap.nextSibling !== note) {
    wrap.insertAdjacentElement("afterend", note);
  }

  return wrap;
}

function showProgressBaseline() {
  ensureProgressUI();
  const wrap = document.getElementById("sjsProgress");
  const bar = document.getElementById("sjsProgressBar");
  if (!wrap || !bar) return;

  wrap.hidden = false;
  wrap.style.display = "";
  bar.style.width = `${PROGRESS_BASELINE_PCT}%`;
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
}

function setProgressNote(text) {
  const note = document.getElementById("sjsProgressNote");
  if (!note) return;
  note.textContent = text || "";
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

// ---------- Gates (strict vs relaxed) ----------
function passesGates(job, relaxed = false) {
  // Hard exclusion: explicit rules (durable + staged) are authoritative.
  if (evaluateExplicitRules(job)) return false;

  // "Strict" is remote-first. "Relaxed" allows non-remote to be reviewed.
  const loc = norm(job.location);

  const isRemote = loc.includes("remote");
  const isHybrid = loc.includes("hybrid");
  const isOnsite =
    loc.includes("onsite") ||
    loc.includes("on-site") ||
    loc.includes("in office") ||
    loc.includes("in-office") ||
    loc.includes("office");

  if (!relaxed) {
    // Strict: hide obvious non-remote roles.
    if (isOnsite || isHybrid) return false;
    if (!isRemote) return false;
  }

  // Otherwise keep it for operator judgment.
  return true;
}

// ---------- Why semantics (UI signal) ----------
const US_STATE_ABBRS = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DC","DE","FL","GA","HI","IA","ID","IL","IN","KS","KY","LA","MA","MD","ME","MI","MN","MO","MS","MT","NC","ND","NE","NH","NJ","NM","NV","NY","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VA","VT","WA","WI","WV","WY"
]);

function looksLikeUSLocation(locRaw) {
  const loc = norm(locRaw);
  if (!loc) return false;
  if (loc.includes("canada")) return false;
  if (loc.includes("united states") || loc.includes("usa") || loc.includes("u.s.") || loc.includes("us ")) return true;

  const m = String(locRaw || "").match(/,\s*([A-Z]{2})\b/);
  if (m && US_STATE_ABBRS.has(m[1])) return true;

  const upper = String(locRaw || "").toUpperCase();
  for (const ab of US_STATE_ABBRS) {
    if (upper.match(new RegExp(`\\b${ab}\\b`))) return true;
  }
  return false;
}

function whyVerdict(job) {
  // Red if it would be excluded by explicit rules.
  if (evaluateExplicitRules(job)) return { color: "red", reason: "Explicit rule hit" };

  const locRaw = String(job.location || "").trim();
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

  // Strict: remote-first coloring.
  if (state.mode === "strict") {
    if (isOnsite || isHybrid) return { color: "red", reason: "Not remote" };
    if (!isRemote) return { color: "red", reason: "Location does not say remote" };

    // Remote but with constraints should be Yellow.
    const hasHardConstraint =
      /must be|must reside|must live|within|commutable|commute|hybrid|in[- ]person|on[- ]site|on[- ]call|come in|onsite|on-site/.test(loc) ||
      /\b(\d{1,2})\s*(days|day)\s*(a|per)?\s*week\b/.test(loc);

    // City/state pattern
    const hasCitySignal =
      /,\s*[A-Z]{2}\b/.test(locRaw) ||
      /\b(seattle|san\s*francisco|sf\b|bay\s*area|new\s*york|nyc|austin|boston|chicago|denver|los\s*angeles|la\b|atlanta|dallas|miami|portland|phoenix|san\s*diego|washington\s*dc|dc\b)\b/i.test(locRaw);

    if (hasHardConstraint || hasCitySignal) {
      return { color: "yellow", reason: "Remote with location constraint" };
    }

    // Remote but region unclear -> Yellow (review)
    if (isRemote && !looksLikeUSLocation(locRaw) && !(loc.includes("united states") || loc.includes("usa") || loc.includes("us"))) {
      return { color: "yellow", reason: "Remote, region unclear" };
    }

    return { color: "green", reason: "Remote (no explicit rule hit)" };
  }

  // Relaxed: signal non-remote as Yellow (review) instead of Red.
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

// ---------- Blacklist panel (appears after Reject) ----------
function buildBlacklistPanel(job, hostCard) {
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
  hint.textContent = "Stages rules locally. Export via Copy/Mail/Download rules.json.";

  const actions = document.createElement("div");
  actions.className = "bl-actions";

  const btnStage = document.createElement("button");
  btnStage.className = "btn primary";
  btnStage.textContent = "Stage rules";

  const btnClose = document.createElement("button");
  btnClose.className = "btn";
  btnClose.textContent = "Close";
  btnClose.onclick = () => panel.remove();

  btnStage.onclick = () => {
    if (cbCompany.checked) stageRule({ type: "company", value: job.company });
    if (cbTitle.checked) stageRule({ type: "title", value: inTitle.value });
    if (cbLoc.checked) stageRule({ type: "location", value: inLoc.value });
    if (cbKw.checked) {
      const parts = (inKw.value || "").split(",").map(s => s.trim()).filter(Boolean);
      parts.forEach(p => stageRule({ type: "keyword", value: p }));
    }

    // Authoritative purge
    purgeAndRerender();
  };

  actions.append(btnStage, btnClose);
  panel.append(row1, row2, row3, row4, hint, actions);

  // Ensure only one panel per card
  const existing = hostCard.querySelector(".bl-panel");
  if (existing) existing.remove();

  return panel;
}

// ---------- Rendering (FULL function buttons restored) ----------
function renderJob(job) {
  const id = jobId(job);
  state.rendered[id] = job;

  const record = getRecord(id);

  const card = document.createElement("div");
  card.className = "job";
  card.setAttribute("data-jobid", id);

  if (record.viewed) card.classList.add("viewed");
  if (record.rejected) card.classList.add("rejected");
  if (record.appliedConfirmed) card.classList.add("appliedConfirmed");

  const title = document.createElement("h3");
  title.textContent = job.title || "(untitled)";

  const loc = document.createElement("p");
  loc.textContent = job.location || "";

  card.append(title, loc);

  const actions = document.createElement("div");
  actions.className = "actions";

  // Why
  const whyBtn = document.createElement("button");
  whyBtn.type = "button";
  whyBtn.className = "whyicon";
  const verdict = whyVerdict(job);
  whyBtn.classList.add(verdict.color);
  whyBtn.title = "Why";
  const glyph = document.createElement("span");
  glyph.className = "whyglyph";
  glyph.textContent = "i";
  whyBtn.appendChild(glyph);
  whyBtn.onclick = () => showWhy(job);

  // View
  const viewBtn = document.createElement("button");
  viewBtn.type = "button";
  viewBtn.className = "btn" + (record.viewed ? " touched" : "");
  viewBtn.textContent = "View";
  viewBtn.onclick = () => {
    const next = setRecord(id, { viewed: true }, job);
    card.classList.add("viewed");
    viewBtn.classList.toggle("touched", next.viewed);
    appliedCb.disabled = false;
    if (!appliedWrap.parentElement) actions.appendChild(appliedWrap);
    if (job.url) window.open(job.url, "_blank");
  };

  // Reject
  const rejectBtn = document.createElement("button");
  rejectBtn.type = "button";
  rejectBtn.className = "btn" + (record.rejected ? " touched" : "");
  rejectBtn.textContent = "Reject";
  rejectBtn.onclick = () => {
    const next = setRecord(id, { rejected: true }, job);
    card.classList.add("rejected");
    rejectBtn.classList.toggle("touched", next.rejected);
    blBtn.hidden = false;
  };

  // Applied (only after View)
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
    card.classList.toggle("appliedConfirmed", next.appliedConfirmed);
  };

  appliedWrap.append(appliedCb, appliedLabel);

  // Blacklist (only after Reject)
  const blBtn = document.createElement("button");
  blBtn.type = "button";
  blBtn.className = "btn";
  blBtn.textContent = "Blacklist";
  blBtn.hidden = !record.rejected;
  blBtn.onclick = () => {
    const panel = buildBlacklistPanel(job, card);
    card.appendChild(panel);
  };

  actions.append(whyBtn, viewBtn, rejectBtn, blBtn);
  if (record.viewed) actions.appendChild(appliedWrap);

  card.appendChild(actions);
  return card;
}

// ---------- Search ----------
async function withTimeout(promise, ms) {
  let h = null;
  const t = new Promise((_, reject) => { h = setTimeout(() => reject(new Error("SOURCE_TIMEOUT")), ms); });
  return Promise.race([promise, t]).finally(() => { if (h) clearTimeout(h); });
}

async function runSearch() {
  const out = $("results");
  if (!out) return;

  out.innerHTML = "";
  state.rendered = {};
  state.currentResults = [];

  loadMemory(); // latest

  const tasks = [];
  for (const g of state.greenhouse) tasks.push({ type: "Greenhouse", label: g, fn: () => fetchGreenhouse(g) });
  for (const l of state.lever) tasks.push({ type: "Lever", label: l, fn: () => fetchLever(l) });
  for (const c of state.custom) tasks.push({ type: "Custom", label: c, fn: () => fetchCustom(c) });

  const total = tasks.length;
  ensureProgressUI();

  if (!total) {
    out.innerHTML = `<div class="loaded">Loaded 0</div>`;
    toast("No sources configured");
    setProgressNote("No sources configured");
    hideProgress();
    return;
  }

  showProgressBaseline();
  setProgress(0);

  let jobs = [];
  let done = 0;

  let ok = 0;
  let failed = 0;
  let timedOut = 0;
  let empty = 0;

  setProgressNote(`Starting… 0/${total} | ok:0 fail:0 timeout:0 empty:0`);

  const hardStop = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("TIMEOUT")), TIMEOUT_MS);
  });

  const doSearch = (async () => {
    for (const t of tasks) {
      const step = done + 1;
      setProgressNote(
        `Checking ${t.type}: ${t.label} (${step}/${total}) | ok:${ok} fail:${failed} timeout:${timedOut} empty:${empty}`
      );

      try {
        const chunk = await withTimeout(Promise.resolve().then(() => t.fn()), PER_SOURCE_TIMEOUT_MS);
        ok += 1;

        if (Array.isArray(chunk) && chunk.length) jobs.push(...chunk);
        else empty += 1;
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (msg === "SOURCE_TIMEOUT") timedOut += 1;
        else failed += 1;
      }

      done += 1;
      setProgress((done / total) * 100);
      setProgressNote(
        `Checked ${done}/${total} | ok:${ok} fail:${failed} timeout:${timedOut} empty:${empty}`
      );
    }
    return jobs;
  })();

  try { await Promise.race([doSearch, hardStop]); } catch {}

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

  setProgress(100);
  setProgressNote(`Done. Checked ${done}/${total} | ok:${ok} fail:${failed} timeout:${timedOut} empty:${empty}`);
  hideProgress();

  refreshDirtyUI();
}

// ---------- Wire UI ----------
function wire() {
  setSettingsVisible(false);

  $("btnSettings")?.addEventListener("click", toggleSettings);
  $("btnSave")?.addEventListener("click", saveSettings);

  $("btnRun")?.addEventListener("click", runSearch);
  $("btnClear")?.addEventListener("click", () => {
    // Conservative: clears job memory + staged rules, not sources.
    try { localStorage.removeItem(MEMORY_KEY); } catch {}
    try { localStorage.removeItem(STAGED_RULES_KEY); } catch {}
    loadMemory();
    refreshDirtyUI();
    toast("Cleared job memory + staged rules");
    rerenderFromCurrentResults();
  });

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
