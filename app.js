// app.js — Strict Job Search v3.2 (repo-ready)
// FINAL+ : removes rules.txt everywhere, Save closes Settings (hard), dirty stack (json only)

const $ = (id) => document.getElementById(id);

const state = {
  greenhouse: [],
  lever: [],
  custom: [],
  mode: "strict",
  memory: {},     // jobId -> { viewed, rejected, appliedConfirmed, job }
  rendered: {}    // jobId -> job (for current results view)
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

function loadMemory() {
  state.memory = JSON.parse(localStorage.getItem(MEMORY_KEY) || "{}");
}

function saveMemory() {
  localStorage.setItem(MEMORY_KEY, JSON.stringify(state.memory));
}

function setSettingsVisible(isOpen) {
  const s = $("settings");
  if (!s) return;

  // Use BOTH, so CSS can't lie about visibility.
  s.hidden = !isOpen;
  s.style.display = isOpen ? "" : "none";
}

async function clearMemory() {
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

  try { sessionStorage.clear(); } catch {}

  try {
    if ("caches" in window && window.caches?.keys) {
      const names = await window.caches.keys();
      for (const n of names) {
        try { await window.caches.delete(n); } catch {}
      }
    }
  } catch {}

  try {
    if ("serviceWorker" in navigator && navigator.serviceWorker?.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        try { await r.unregister(); } catch {}
      }
    }
  } catch {}

  state.memory = {};
  state.rendered = {};
  state.greenhouse = [];
  state.lever = [];
  state.custom = [];

  if ($("greenhouse")) $("greenhouse").value = "";
  if ($("lever")) $("lever").value = "";
  if ($("custom")) $("custom").value = "";
  if ($("results")) $("results").innerHTML = "";

  const fb = document.getElementById("sjsMailFallback");
  if (fb) fb.hidden = true;

  setSettingsVisible(false);

  hardStopAllLoaders();
  refreshDirtyUI();

  toast("Device data cleared");
}

function isLikelyMobile() {
  const ua = navigator.userAgent || "";
  const coarse = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(pointer: coarse)").matches
    : false;
  const small = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 820px)").matches
    : false;

  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (coarse && small);
}

function downloadTextFile(filename, text) {
  try {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch {}
      try { a.remove(); } catch {}
    }, 0);
  } catch {}
}

function downloadJsonFile(filename, obj) {
  const json = JSON.stringify(obj, null, 2);
  downloadTextFile(filename, json);
}

// ---------- Rules (durable + staged) ----------
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
    String(r?.value || "").trim().toLowerCase() === normalized.value.toLowerCase()
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
    if (rt === "location" && (loc.includes(rv) || text.includes(rv))) return true;
    if (rt === "keyword" && text.includes(rv)) return true;
  }

  return false;
}

function purgeRuleBlockedFromDOM() {
  const out = $("results");
  if (!out) return;
  const cards = out.querySelectorAll(".job[data-jobid]");
  cards.forEach(card => {
    const id = card.getAttribute("data-jobid");
    const job = state.rendered[id];
    if (job && evaluateExplicitRules(job)) card.remove();
  });
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
    .bl-row input[type="text"]{ flex:1; min-width:200px; padding:8px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.14); background:rgba(250,250,255,.92); color:rgba(15,15,18,.92); }
    .bl-hint{ font-size:12px; opacity:.78; margin-top:6px; }
    .bl-actions{ display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }
    .sjs-dirtywrap{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-left:auto; }

    .sjs-dirtytag{
      display:inline-flex;
      align-items:center;
      height:32px;
      padding:0 12px;
      border-radius:999px;
      border:1px solid rgba(0,0,0,.28);
      background:#2dd4bf;
      color:#0b0b0b;
      font-size:12px;
      font-weight:750;
      letter-spacing:.2px;
      white-space:nowrap;
      opacity:1;
    }

    .sjs-dirtybtn{
      height:32px;
      padding:0 12px;
      border-radius:999px;
      border:1px solid rgba(0,0,0,.28);
      background:#2dd4bf;
      color:#0b0b0b;
      font-size:12px;
      font-weight:750;
      letter-spacing:.2px;
      white-space:nowrap;
      line-height:32px;
    }
    .sjs-dirtybtn:hover{ filter:brightness(0.98); }
    .sjs-dirtybtn:active{ filter:brightness(0.95); }
    .sjs-dirtybtn:disabled{
      opacity:.45;
      cursor:not-allowed;
      filter:none;
    }

    .sjs-toast{
      position:fixed;
      left:50%;
      bottom:18px;
      transform:translateX(-50%) translateY(14px);
      opacity:0;
      pointer-events:none;
      padding:10px 14px;
      border-radius:999px;
      border:1px solid rgba(255,255,255,.18);
      background:rgba(0,0,0,.82);
      color:rgba(255,255,255,.92);
      font-size:12px;
      font-weight:650;
      transition: opacity .18s ease, transform .18s ease;
      z-index:9999;
    }
    .sjs-toast.show{
      opacity:1;
      transform:translateX(-50%) translateY(0);
    }
  `;
  document.head.appendChild(style);
})();

// ---------- Settings ----------
function parseLines(val) {
  return String(val || "")
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function loadSettings() {
  state.greenhouse = JSON.parse(localStorage.getItem("greenhouse") || "[]");
  state.lever = JSON.parse(localStorage.getItem("lever") || "[]");
  state.custom = JSON.parse(localStorage.getItem("custom") || "[]");

  if ($("greenhouse")) $("greenhouse").value = state.greenhouse.join("\n");
  if ($("lever")) $("lever").value = state.lever.join("\n");
  if ($("custom")) $("custom").value = state.custom.join("\n");
}

function saveSettings() {
  state.greenhouse = parseLines($("greenhouse")?.value);
  state.lever = parseLines($("lever")?.value);
  state.custom = parseLines($("custom")?.value);

  localStorage.setItem("greenhouse", JSON.stringify(state.greenhouse));
  localStorage.setItem("lever", JSON.stringify(state.lever));
  localStorage.setItem("custom", JSON.stringify(state.custom));

  // Always close panel on Save (hard close, CSS-proof)
  setSettingsVisible(false);

  toast(`Saved (Greenhouse: ${state.greenhouse.length}, Lever: ${state.lever.length}, Custom: ${state.custom.length})`);
}

// ---------- Mode ----------
function setMode(m) {
  state.mode = m;
  $("modeStrict")?.classList.toggle("active", m === "strict");
  $("modeRelaxed")?.classList.toggle("active", m === "relaxed");
  document.body.classList.toggle("relaxed", m === "relaxed");
}

// ---------- Gates ----------
const HARD_BACKEND_TERMS = [
  "on-call","pager","own production","production ownership","operating distributed",
  "real-time systems","low-latency","multi-region aws","incident response",
];
const BACKEND_PRIMITIVES = [
  "grpc","protobuf","redis","kafka","kinesis","flink","spark streaming",
  "real-time streaming","streaming","event-driven","distributed cache","tcp","udp",
];
const INFRA_OWNERSHIP = [
  "production infrastructure","service reliability","capacity planning",
  "latency budget","latency budgets","availability target","availability targets",
  "postmortem","terraform","cloudformation","kubernetes",
];
const NON_US_LOCATION_TERMS = [
  "uk","united kingdom","london","england","scotland","wales","ireland",
  "canada","toronto","vancouver","montreal","emea","apac","latam","eu","europe",
  "european union","india","bangalore","bengaluru","hyderabad","pune","chennai",
  "gurgaon","noida","singapore","australia","sydney","melbourne","germany","berlin",
  "munich","france","paris","spain","madrid","barcelona","netherlands","amsterdam",
  "sweden","stockholm","switzerland","zurich","geneva","poland","warsaw","romania",
  "bucharest","czech","prague","austria","vienna","italy","milan","rome","portugal",
  "lisbon","israel","tel aviv","japan","tokyo","korea","seoul","china","shanghai",
  "beijing","shenzhen","mexico","brazil","argentina","chile","colombia",
  "south africa","cape town","johannesburg","thailand","bangkok","vietnam",
  "ho chi minh","hcmc","hanoi"
];
const AMBIGUOUS_OK_TERMS = ["global","remote","distributed","multiple locations","anywhere","americas"];

function countHits(text, terms) {
  let hits = 0;
  for (const term of terms) if (text.includes(term)) hits += 1;
  return hits;
}
function excludeBackendInfraRole(jobText) {
  const text = jobText.toLowerCase();
  if (countHits(text, HARD_BACKEND_TERMS) >= 1) return true;
  if (countHits(text, BACKEND_PRIMITIVES) >= 2) return true;
  if (countHits(text, INFRA_OWNERSHIP) >= 2) return true;
  return false;
}
function shouldExcludeForLocation(geoTextRaw) {
  const geo = (geoTextRaw || "").toLowerCase().trim();
  if (!geo) return false;
  if (AMBIGUOUS_OK_TERMS.some(t => geo.includes(t))) return false;
  if (NON_US_LOCATION_TERMS.some(t => geo.includes(t))) return true;
  return false;
}
function passesGates(job, relaxed = false) {
  if (evaluateExplicitRules(job)) return false;

  const t = (job.title + " " + job.location + " " + job.description).toLowerCase();

  if (/crypto|blockchain|web3|token|coin|defi|nft|trading|investment/.test(t)) return false;
  if (!/remote/.test(t)) return false;

  if (shouldExcludeForLocation(t)) return false;
  if (/visa|sponsor|work authorization/.test(t)) return false;

  if (excludeBackendInfraRole(t)) return false;

  if (/accountable|own results|manage budget|p&l|audit|enforcement/.test(t)) return false;

  if (!relaxed) {
    if (/travel|offsite|retreat|onsite|hybrid|relocation/.test(t)) return false;
  } else {
    if (/hybrid|onsite|on-site|relocation/.test(t)) return false;
  }

  return true;
}

// ---------- Fetchers ----------
async function fetchGreenhouse(token) {
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`, { cache: "no-store" });
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
  let progress = document.getElementById("sjsProgress");
  let bar = document.getElementById("sjsProgressBar");
  let note = document.getElementById("sjsNote");

  if (!statusWrap) {
    statusWrap = document.createElement("div");
    statusWrap.id = "sjsStatusWrap";
    statusWrap.className = "sjs-statuswrap";
    statusWrap.hidden = true;

    const statusText = document.createElement("div");
    statusText.id = "sjsStatusText";
    statusText.textContent = "Searching...";

    statusWrap.append(statusText);

    const controls = document.querySelector(".controls") || document.body;
    controls.insertAdjacentElement("afterend", statusWrap);
  }

  if (!progress) {
    progress = document.createElement("div");
    progress.id = "sjsProgress";
    progress.className = "sjs-progress";
    progress.hidden = true;

    bar = document.createElement("div");
    bar.id = "sjsProgressBar";
    progress.appendChild(bar);

    statusWrap.insertAdjacentElement("afterend", progress);
  }

  if (!note) {
    note = document.createElement("div");
    note.id = "sjsNote";
    note.className = "sjs-note";
    note.hidden = true;
    progress.insertAdjacentElement("afterend", note);
  }

  return {
    statusWrap,
    statusText: document.getElementById("sjsStatusText"),
    progress,
    bar: document.getElementById("sjsProgressBar"),
    note: document.getElementById("sjsNote")
  };
}

function hardStopAllLoaders() {
  const sw = document.getElementById("sjsStatusWrap");
  const pr = document.getElementById("sjsProgress");
  const nt = document.getElementById("sjsNote");
  const br = document.getElementById("sjsProgressBar");
  if (sw) sw.hidden = true;
  if (pr) pr.hidden = true;
  if (nt) nt.hidden = true;
  if (br) br.style.width = "0%";

  const btn = $("btnRun");
  if (btn) btn.disabled = false;
}

function setLoading(on, opts = {}) {
  const ui = ensureLoadingUI();
  const btn = $("btnRun");

  if (on) {
    if (btn) {
      btn.disabled = true;
      btn.dataset.origText = btn.textContent;
      btn.textContent = opts.buttonText || "Searching...";
    }
    ui.statusWrap.hidden = false;
    ui.progress.hidden = false;
    ui.note.hidden = false;

    ui.statusText.textContent = opts.statusText || "Searching...";
    ui.bar.style.width = (opts.progressPct ?? 0) + "%";
    ui.note.textContent = opts.noteText || "";
    return;
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = btn.dataset.origText || "Run Search";
  }

  ui.statusWrap.hidden = true;
  ui.progress.hidden = true;
  ui.note.hidden = true;
  ui.bar.style.width = "0%";
  ui.note.textContent = "";
}

function setProgress(statusText, done, total, noteText = "") {
  const ui = ensureLoadingUI();
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  ui.statusText.textContent = statusText;
  ui.bar.style.width = pct + "%";
  ui.note.textContent = noteText;
}

// ---------- Dirty export (JSON ONLY) ----------
const SUBJECT_PREFIX = "new dirty addtions as of";
function pad2(n) { return String(n).padStart(2, "0"); }
function timestampForSubject(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}:${mm}:${dd} ${hh}:${mi}`;
}
function buildGmailComposeUrl({ subject, body }) {
  const base = "https://mail.google.com/mail/?view=cm&fs=1";
  return `${base}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
function ensureMailFallbackUI() {
  const controls = document.querySelector(".controls") || document.body;

  let wrap = document.getElementById("sjsMailFallback");
  if (wrap) return wrap;

  wrap = document.createElement("div");
  wrap.id = "sjsMailFallback";
  wrap.className = "bl-panel";

  const h = document.createElement("div");
  h.id = "sjsMailFallbackHeader";
  h.style.fontWeight = "700";
  h.textContent = "Mail packet (RULES.JSON only). Gmail opens with Subject + instructions. Paste clipboard payload into Gmail.";

  const subjLabel = document.createElement("div");
  subjLabel.className = "bl-hint";
  subjLabel.textContent = "Subject (auto)";

  const subj = document.createElement("input");
  subj.type = "text";
  subj.id = "sjsFallbackSubject";

  const payloadLabel = document.createElement("div");
  payloadLabel.className = "bl-hint";
  payloadLabel.textContent = "Clipboard payload (RULES.JSON)";

  const payload = document.createElement("textarea");
  payload.id = "sjsFallbackPayload";
  payload.rows = 12;
  payload.style.width = "100%";

  const actions = document.createElement("div");
  actions.className = "bl-actions";

  const btnCopyPayload = document.createElement("button");
  btnCopyPayload.className = "btn primary sjs-dirtybtn";
  btnCopyPayload.textContent = "Copy payload";

  const btnDlJson = document.createElement("button");
  btnDlJson.className = "btn sjs-dirtybtn";
  btnDlJson.textContent = "Download rules.json";

  const btnHide = document.createElement("button");
  btnHide.className = "btn";
  btnHide.textContent = "Hide";
  btnHide.onclick = () => (wrap.hidden = true);

  btnCopyPayload.onclick = async () => {
    try { await navigator.clipboard.writeText(payload.value || ""); } catch {}
  };

  btnDlJson.onclick = () => {
    try {
      const staged = getStagedRules();
      downloadJsonFile("rules.json", staged);
    } catch {}
  };

  actions.append(btnCopyPayload, btnDlJson, btnHide);
  wrap.append(h, subjLabel, subj, payloadLabel, payload, actions);
  wrap.hidden = true;

  controls.insertAdjacentElement("afterend", wrap);
  return wrap;
}
async function mailDirtyList() {
  const staged = getStagedRules();
  if (!staged.length) return;

  const subject = `${SUBJECT_PREFIX} ${timestampForSubject()}`;
  const rulesJson = JSON.stringify(staged, null, 2);
  const clipboardPayload = [
    "SJS PROMOTE PACKET",
    `SUBJECT: ${subject}`,
    "",
    "==== RULES.JSON BEGIN ====",
    rulesJson,
    "==== RULES.JSON END ====",
    ""
  ].join("\n");

  let clipboardOK = false;
  try { await navigator.clipboard.writeText(clipboardPayload); clipboardOK = true; } catch { clipboardOK = false; }

  const ui = ensureMailFallbackUI();
  ui.hidden = false;

  const header = document.getElementById("sjsMailFallbackHeader");
  if (header) {
    header.textContent = clipboardOK
      ? "Clipboard payload copied. Gmail will open with Subject + instructions. Paste payload into Gmail body. Enter TO. Send."
      : "Clipboard blocked. Use Copy payload. Gmail will open with Subject + instructions. Paste payload into Gmail body. Enter TO. Send.";
  }

  const subjEl = document.getElementById("sjsFallbackSubject");
  const payloadEl = document.getElementById("sjsFallbackPayload");
  if (subjEl) subjEl.value = subject;
  if (payloadEl) payloadEl.value = clipboardPayload;

  const bodyInstructions = [
    "OPERATOR STEPS:",
    "1) Enter recipient email address in the TO: field.",
    "2) Paste the clipboard payload into this email body (it contains RULES.JSON).",
    "3) Hit send."
  ].join("\n");

  const gmailUrl = buildGmailComposeUrl({ subject, body: bodyInstructions });
  try { window.open(gmailUrl, "_blank", "noopener,noreferrer"); } catch {}
}
function exportRulesJson() {
  const staged = getStagedRules();
  if (!staged.length) return;
  downloadJsonFile("rules.json", staged);
}

// ---------- Rendering / Search / Dirty UI / Wire ----------
/* The rest of the file is unchanged from your last version, except it now uses setSettingsVisible()
   instead of directly setting .hidden, and it still contains NO rules.txt UI. */

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
    purgeRuleBlockedFromDOM();
    cardDiv.remove();
  };

  actions.append(btnApply, btnCancel);
  panel.append(row1, row2, row3, row4, hint, actions);
  return panel;
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
  const r = state.memory[jobId(job)] || null;
  if (!r) return false;
  return !!(r.rejected || r.appliedConfirmed);
}
function isNewHit(job) { return !state.memory[jobId(job)]; }
function isViewedUndecided(job) {
  const r = state.memory[jobId(job)] || null;
  if (!r) return false;
  return !!(r.viewed && !r.rejected && !r.appliedConfirmed);
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

  actions.append(viewBtn, rejectBtn, blBtn);
  if (record.viewed) actions.appendChild(appliedWrap);

  div.appendChild(actions);
  return div;
}

async function runSearch() {
  const out = $("results");
  if (!out) return;

  hardStopAllLoaders();
  out.innerHTML = "";
  state.rendered = {};

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

    let passed = [];
    if (state.mode === "relaxed") {
      setMode("relaxed");
      passed = jobs.filter(j => passesGates(j, true));
    } else {
      const strictPassed = jobs.filter(j => passesGates(j, false)).filter(j => !shouldHide(j));
      const strictNew = strictPassed.filter(isNewHit);

      if (strictNew.length === 0) {
        setMode("relaxed");
        passed = jobs.filter(j => passesGates(j, true));
      } else {
        setMode("strict");
        passed = strictPassed;
      }
    }

    passed = passed.filter(j => !shouldHide(j));

    passed.sort((a, b) => {
      const aw = isViewedUndecided(a) ? 0 : (isNewHit(a) ? 1 : 2);
      const bw = isViewedUndecided(b) ? 0 : (isNewHit(b) ? 1 : 2);
      return aw - bw;
    });

    passed.slice(0, MAX_RESULTS).forEach(j => out.appendChild(renderJob(j)));

    if (total > 0) toast(`Run complete. Sources: ${total}. Results: ${Math.min(passed.length, MAX_RESULTS)}.`);
    refreshDirtyUI();
  })();

  try {
    await Promise.race([doSearch, timeoutPromise]);
  } catch (err) {
    if (String(err?.message || err) === "TIMEOUT" || timedOut) {
      out.innerHTML = `<div class="sjs-error"><strong>Timed out</strong><div>Search exceeded 3 minutes. Start a new search.</div></div>`;
      toast("Timed out (3 minutes)");
    } else {
      out.innerHTML = `<div class="sjs-error"><strong>Search error</strong><div>${String(err)}</div></div>`;
      toast("Search error");
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    setLoading(false);
  }
}

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

  const btnMail = document.createElement("button");
  btnMail.id = "btnMailDirty";
  btnMail.className = "btn sjs-dirtybtn";
  btnMail.textContent = "Mail promote packet";
  btnMail.onclick = mailDirtyList;

  const btnDlJson = document.createElement("button");
  btnDlJson.id = "btnDlRulesJson";
  btnDlJson.className = "btn sjs-dirtybtn";
  btnDlJson.textContent = "Download rules.json";
  btnDlJson.onclick = exportRulesJson;

  if (isLikelyMobile()) {
    // leave both visible; adjust later if you want
  }

  wrap.append(tag, btnMail, btnDlJson);
  controls.appendChild(wrap);
  return wrap;
}

function refreshDirtyUI() {
  const wrap = ensureDirtyUI();
  if (!wrap) return;

  const tag = document.getElementById("sjsDirtyTag");
  const btnMail = document.getElementById("btnMailDirty");
  const btnJ = document.getElementById("btnDlRulesJson");

  const n = getStagedRules().length;
  if (tag) tag.textContent = `Dirty: ${n}`;

  const disabled = n === 0;
  if (btnMail) btnMail.disabled = disabled;
  if (btnJ) btnJ.disabled = disabled;

  if (n > 0) purgeRuleBlockedFromDOM();
}

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

  loadSettings();
  loadMemory();

  setTimeout(hardStopAllLoaders, 0);
  refreshDirtyUI();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire);
} else {
  wire();
}
