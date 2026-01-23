// app.js — Strict Job Search v3.2
// Fixes: Sources & Settings toggle (was inverted), adds Copy rules.json to clipboard.
// Keeps: WhyInfo red/yellow/green semantics + inline Why panel. No dirty-threshold gating changes.

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

  const fb = document.getElementById("sjsMailFallbackWrap");
  if (fb) fb.remove();

  setSettingsVisible(false);

  hardStopAllLoaders();
  refreshDirtyUI();

  toast("Device data cleared");
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

// ---------- Clipboard + fallback ----------
function ensureClipboardFallback(text) {
  let wrap = document.getElementById("sjsMailFallbackWrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "sjsMailFallbackWrap";
    wrap.className = "sjs-fallback-wrap";

    const hdr = document.createElement("div");
    hdr.className = "hdr";
    hdr.textContent = "Clipboard blocked. Copy manually:";

    const ta = document.createElement("textarea");
    ta.id = "sjsMailFallbackText";
    ta.readOnly = true;

    wrap.append(hdr, ta);

    const host = document.getElementById("dirtyHost") || document.querySelector(".controls") || document.body;
    host.insertAdjacentElement("afterend", wrap);
  }

  const ta = document.getElementById("sjsMailFallbackText");
  if (ta) {
    ta.value = text;
    ta.focus();
    ta.select();
  }
}

function copyToClipboard(text) {
  if (!navigator.clipboard || !window.isSecureContext) {
    return Promise.reject(new Error("CLIPBOARD_UNAVAILABLE"));
  }
  return navigator.clipboard.writeText(text);
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

function getExplicitRuleHits(job) {
  const durable = getDurableRules();
  const staged = getStagedRules();

  const comp = norm(job.company);
  const title = norm(job.title);
  const loc = norm(job.location);
  const text = norm(job.title + " " + job.location + " " + job.description);

  const hits = [];

  function checkRule(r, source) {
    const rt = norm(r?.type);
    const rv = norm(r?.value);
    if (!rt || !rv) return;

    let matched = false;

    if (rt === "company" && comp === rv) matched = true;
    else if (rt === "title" && title.includes(rv)) matched = true;
    else if (rt === "location" && (loc.includes(rv) || text.includes(rv))) matched = true;
    else if (rt === "keyword" && text.includes(rv)) matched = true;

    if (matched) hits.push({ type: rt, value: String(r.value), source });
  }

  for (const r of durable) checkRule(r, "durable");
  for (const r of staged) checkRule(r, "staged");

  return hits;
}

// ---------- Why (red/yellow/green) ----------
function explainGates(job, relaxed = false) {
  const hits = getExplicitRuleHits(job);
  if (hits.length) {
    return { pass: false, reasons: hits.map(h => `Explicit ${h.type} hit (${h.source}): ${h.value}`) };
  }

  const t = norm(job.title + " " + job.location + " " + job.description);
  const reasons = [];

  if (/crypto|blockchain|web3|token|coin|defi|nft|trading|investment/.test(t)) reasons.push("Gate: crypto/web3");
  if (!/remote/.test(t)) reasons.push("Gate: not remote");
  if (shouldExcludeForLocation(t)) reasons.push("Gate: non-US location");
  if (/visa|sponsor|work authorization/.test(t)) reasons.push("Gate: visa/sponsorship");
  if (excludeBackendInfraRole(t)) reasons.push("Gate: backend/infra role");
  if (/accountable|own results|manage budget|p&l|audit|enforcement/.test(t)) reasons.push("Gate: enforcement/ownership language");

  if (!relaxed) {
    if (/travel|offsite|retreat|onsite|hybrid|relocation/.test(t)) reasons.push("Gate: travel/onsite/hybrid/relocation (strict)");
  } else {
    if (/hybrid|onsite|on-site|relocation/.test(t)) reasons.push("Gate: onsite/hybrid/relocation (relaxed)");
  }

  return { pass: reasons.length === 0, reasons };
}

function getCandidateLeakHits(job) {
  const durable = getDurableRules();
  const staged = getStagedRules();

  const keywordSet = new Set(
    durable.concat(staged)
      .filter(r => norm(r?.type) === "keyword")
      .map(r => norm(r?.value))
      .filter(Boolean)
  );

  const titleRules = durable
    .filter(r => norm(r?.type) === "title")
    .map(r => String(r?.value || "").trim())
    .filter(v => v.length >= 3);

  const titleText = norm(job.title);
  const fullText = norm(job.title + " " + job.location + " " + job.description);

  const leaks = [];
  for (const v of titleRules) {
    const nv = norm(v);
    if (!nv) continue;
    if (keywordSet.has(nv)) continue;
    if (titleText.includes(nv)) continue;
    if (fullText.includes(nv)) leaks.push(v);
  }

  return Array.from(new Set(leaks));
}

function computeWhyStatus(job) {
  const strict = explainGates(job, false);
  const relaxed = explainGates(job, true);

  if (strict.pass) {
    const leaks = getCandidateLeakHits(job);
    if (leaks.length) return { status: "yellow", strict, relaxed, leaks };
    return { status: "green", strict, relaxed, leaks: [] };
  }

  if (relaxed.pass) return { status: "red", strict, relaxed, leaks: [] };
  return { status: "red", strict, relaxed, leaks: [] };
}

function buildWhyPanel(job, whyMeta) {
  const panel = document.createElement("div");
  panel.className = "why-panel";

  const header = document.createElement("div");
  header.className = "why-head";

  const title = document.createElement("div");
  title.className = "why-title";
  title.textContent = "Why";

  const close = document.createElement("button");
  close.className = "why-close";
  close.type = "button";
  close.textContent = "×";
  close.onclick = () => panel.remove();

  header.append(title, close);

  const body = document.createElement("div");
  body.className = "why-body";

  const lines = [];

  if (whyMeta.status === "green") lines.push("Verdict: PASS (strict)");
  if (whyMeta.status === "red") lines.push("Verdict: REJECT (only passes relaxed, or hard fail)");
  if (whyMeta.status === "yellow") lines.push("Verdict: REJECT (review for blacklist candidates)");

  if (whyMeta.strict.pass) {
    lines.push("Strict: PASS");
  } else {
    lines.push("Strict: FAIL");
    for (const r of whyMeta.strict.reasons.slice(0, 10)) lines.push(`• ${r}`);
  }

  if (!whyMeta.strict.pass) {
    if (whyMeta.relaxed.pass) {
      lines.push("Relaxed: PASS");
    } else {
      lines.push("Relaxed: FAIL");
      for (const r of whyMeta.relaxed.reasons.slice(0, 10)) lines.push(`• ${r}`);
    }
  }

  if (whyMeta.leaks && whyMeta.leaks.length) {
    lines.push("Potential blacklist candidates (present in text, not title):");
    for (const v of whyMeta.leaks.slice(0, 12)) lines.push(`• ${v}`);
  }

  body.textContent = lines.join("\n");
  panel.append(header, body);
  return panel;
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
    .bl-actions{ display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }
    .bl-actions .btn{ padding:8px 10px; border-radius:12px; border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.08); color:rgba(255,255,255,.92); cursor:pointer; }
    .bl-actions .btn:hover{ background:rgba(255,255,255,.12); }
    .bl-muted{ opacity:.82; font-size:12px; }
    .appliedWrap{ display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:14px; border:1px solid rgba(255,255,255,.14); background:rgba(0,0,0,.10); }
    .appliedWrap.checked{ border-color: rgba(150,255,120,.45); box-shadow: 0 0 0 2px rgba(150,255,120,.10) inset; }
    .appliedWrap input{ width:16px; height:16px; }
    .appliedWrap label{ margin:0; font-weight:700; letter-spacing:.2px; }

    .dirtyWrap{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-radius:14px;
      background:rgba(0,0,0,.18); border:1px solid rgba(255,255,255,.12); margin-top:10px; }
    .dirtyWrap .left{ display:flex; flex-direction:column; gap:2px; }
    .dirtyWrap .count{ font-weight:900; letter-spacing:.3px; }
    .dirtyWrap .hint{ opacity:.82; font-size:12px; }
    .dirtyWrap .right{ display:flex; gap:10px; flex-wrap:wrap; }
    .dirtyWrap .btn{ padding:8px 10px; border-radius:12px; border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.08); color:rgba(255,255,255,.92); cursor:pointer; }
    .dirtyWrap .btn:hover{ background:rgba(255,255,255,.12); }

    .sjs-statuswrap{ margin-top:12px; padding:12px; border-radius:14px; background:rgba(0,0,0,.18); border:1px solid rgba(255,255,255,.12); }
    .sjs-progress{ height:10px; border-radius:999px; overflow:hidden; background:rgba(255,255,255,.10); margin-top:10px; }
    .sjs-progress > div{ height:100%; width:0%; background:rgba(80,200,255,.9); transition: width .2s ease; }
    .sjs-note{ margin-top:8px; opacity:.85; font-size:12px; }

    .sjs-toast{
      position:fixed;
      left:50%;
      bottom:18px;
      transform:translateX(-50%) translateY(8px);
      background:rgba(0,0,0,.72);
      color:#fff;
      padding:10px 12px;
      border-radius:14px;
      border:1px solid rgba(255,255,255,.14);
      opacity:0;
      pointer-events:none;
      font-weight:650;
      transition: opacity .18s ease, transform .18s ease;
      z-index:9999;
    }
    .sjs-toast.show{
      opacity:1;
      transform:translateX(-50%) translateY(0);
    }

    .why-btn{
      width:34px; height:34px;
      border-radius:999px;
      border:2px solid rgba(255,255,255,.28);
      background:rgba(0,0,0,.18);
      display:flex; align-items:center; justify-content:center;
      padding:0;
      cursor:pointer;
      user-select:none;
      flex:0 0 auto;
    }
    .why-btn img{
      width:18px; height:18px;
      display:block;
      object-fit:contain;
      pointer-events:none;
    }
    .why-green{
      border-color: rgba(0,255,170,.75);
      box-shadow: 0 0 0 2px rgba(0,255,170,.18), 0 0 16px rgba(0,255,170,.22);
    }
    .why-yellow{
      border-color: rgba(255,210,90,.85);
      box-shadow: 0 0 0 2px rgba(255,210,90,.18), 0 0 16px rgba(255,210,90,.20);
    }
    .why-red{
      border-color: rgba(255,90,90,.85);
      box-shadow: 0 0 0 2px rgba(255,90,90,.18), 0 0 16px rgba(255,90,90,.20);
    }

    .job .job-head{
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:12px;
    }

    .why-panel{
      margin-top:10px;
      border-radius:12px;
      background:rgba(0,0,0,.22);
      border:1px solid rgba(255,255,255,.14);
      padding:10px;
      white-space:pre-wrap;
      line-height:1.35;
    }
    .why-head{
      display:flex;
      align-items:center;
      justify-content:space-between;
      margin-bottom:8px;
    }
    .why-title{
      font-weight:800;
      letter-spacing:.2px;
      opacity:.95;
    }
    .why-close{
      width:34px; height:34px;
      border-radius:10px;
      border:1px solid rgba(255,255,255,.16);
      background:rgba(255,255,255,.06);
      color:rgba(255,255,255,.92);
      cursor:pointer;
      font-size:18px;
      line-height:1;
    }
    .why-body{
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size:12.5px;
      opacity:.95;
    }

    .sjs-fallback-wrap{
      margin-top:10px;
      padding:10px;
      border-radius:12px;
      background:rgba(0,0,0,.20);
      border:1px solid rgba(255,255,255,.12);
    }
    .sjs-fallback-wrap .hdr{
      font-weight:800;
      margin-bottom:6px;
      opacity:.95;
    }
    .sjs-fallback-wrap textarea{
      width:100%;
      min-height:120px;
      border-radius:10px;
      border:1px solid rgba(255,255,255,.14);
      background:rgba(250,250,255,.92);
      color:rgba(15,15,18,.92);
      padding:8px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size:12px;
    }
  `;
  document.head.appendChild(style);
})();

// ---------- Mode UI ----------
function setMode(m) {
  state.mode = m;
  const strictBtn = $("modeStrict");
  const relaxedBtn = $("modeRelaxed");
  if (strictBtn && relaxedBtn) {
    strictBtn.classList.toggle("active", m === "strict");
    relaxedBtn.classList.toggle("active", m === "relaxed");
  }
}

function parseLinesToSlugs(text) {
  return String(text || "")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
}

function loadSources() {
  state.greenhouse = parseLinesToSlugs(localStorage.getItem("greenhouse") || "");
  state.lever = parseLinesToSlugs(localStorage.getItem("lever") || "");
  state.custom = parseLinesToSlugs(localStorage.getItem("custom") || "");
}

function saveSourcesFromUI() {
  const gh = $("greenhouse") ? $("greenhouse").value : "";
  const lv = $("lever") ? $("lever").value : "";
  const cu = $("custom") ? $("custom").value : "";

  localStorage.setItem("greenhouse", gh);
  localStorage.setItem("lever", lv);
  localStorage.setItem("custom", cu);

  state.greenhouse = parseLinesToSlugs(gh);
  state.lever = parseLinesToSlugs(lv);
  state.custom = parseLinesToSlugs(cu);

  setSettingsVisible(false);
  toast("Saved sources");
}

// ---------- Dirty UI ----------
function ensureDirtyUI() {
  let host = document.getElementById("dirtyHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "dirtyHost";
    const controls = document.querySelector(".controls") || document.body;
    controls.insertAdjacentElement("afterend", host);
  }

  let wrap = document.getElementById("dirtyWrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "dirtyWrap";
    wrap.className = "dirtyWrap";

    const left = document.createElement("div");
    left.className = "left";

    const count = document.createElement("div");
    count.id = "dirtyCount";
    count.className = "count";
    count.textContent = "Dirty: 0";

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Staged rules are local until promoted.";

    left.append(count, hint);

    const right = document.createElement("div");
    right.className = "right";

    const copyBtn = document.createElement("button");
    copyBtn.id = "copyRulesJson";
    copyBtn.className = "btn";
    copyBtn.textContent = "Copy rules.json";
    copyBtn.onclick = () => copyPromoteJson();

    const mailBtn = document.createElement("button");
    mailBtn.id = "mailPromotePacket";
    mailBtn.className = "btn";
    mailBtn.textContent = "Mail promote packet";
    mailBtn.onclick = () => sendMailPromotePacket();

    const dlBtn = document.createElement("button");
    dlBtn.id = "downloadRulesJson";
    dlBtn.className = "btn";
    dlBtn.textContent = "Download rules.json";
    dlBtn.onclick = () => downloadPromotePacket();

    right.append(copyBtn, mailBtn, dlBtn);

    wrap.append(left, right);
    host.appendChild(wrap);
  }

  return wrap;
}

function refreshDirtyUI() {
  ensureDirtyUI();
  const n = getStagedRules().length;
  const el = document.getElementById("dirtyCount");
  if (el) el.textContent = `Dirty: ${n}`;
}

// ---------- Promote packet ----------
function rulesAsPromotePacket() {
  const base = window.APP_STATE?.rules || { version: "1", explicitRules: [] };
  const durable = Array.isArray(base.explicitRules) ? base.explicitRules : [];
  const staged = getStagedRules();
  const explicitRules = durable.concat(staged);
  return {
    version: String(base.version || "1"),
    explicitRules
  };
}

function downloadPromotePacket() {
  const packet = rulesAsPromotePacket();
  downloadJsonFile("rules.json", packet);
  toast("Downloaded rules.json");
}

function copyPromoteJson() {
  const packet = rulesAsPromotePacket();
  const json = JSON.stringify(packet, null, 2);

  copyToClipboard(json).then(() => {
    toast("rules.json copied");
  }).catch(() => {
    ensureClipboardFallback(json);
    toast("Clipboard blocked, fallback shown");
  });
}

function sendMailPromotePacket() {
  const packet = rulesAsPromotePacket();
  const subject = `SJS PROMOTE PACKET — Dirty rules (${getStagedRules().length})`;
  const body = `SUBJECT: ${subject}\n\n==== RULES.JSON BEGIN ====\n${JSON.stringify(packet, null, 2)}\n==== RULES.JSON END ====\n`;

  copyToClipboard(body).then(() => {
    toast("Promote packet copied");
  }).catch(() => {
    ensureClipboardFallback(body);
    toast("Clipboard blocked, fallback shown");
  }).finally(() => {
    const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
  });
}

// ---------- Job Card UI ----------
function getRecord(id) {
  return state.memory[id] || { viewed: false, rejected: false, appliedConfirmed: false };
}

function setRecord(id, patch, job) {
  const prev = getRecord(id);
  const next = { ...prev, ...patch };
  if (job) next.job = job;
  state.memory[id] = next;
  saveMemory();
  return next;
}

function buildBlacklistPanel(job, id) {
  const panel = document.createElement("div");
  panel.className = "bl-panel";

  const intro = document.createElement("div");
  intro.className = "bl-muted";
  intro.textContent = "Blacklist (stages a rule into Dirty). Choose a type, then Save.";
  panel.appendChild(intro);

  const row1 = document.createElement("div");
  row1.className = "bl-row";

  const typeLabel = document.createElement("label");
  typeLabel.textContent = "Type";

  const typeSel = document.createElement("select");
  typeSel.className = "btn";
  ["title", "keyword", "location", "company"].forEach(t => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    typeSel.appendChild(opt);
  });

  row1.append(typeLabel, typeSel);

  const row2 = document.createElement("div");
  row2.className = "bl-row";

  const valueLabel = document.createElement("label");
  valueLabel.textContent = "Value";

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.value = job.title;

  const hint = document.createElement("div");
  hint.className = "bl-muted";
  hint.textContent = "Title blocks title text. Keyword blocks title/location/description. Location blocks location/text. Company blocks exact company slug.";

  row2.append(valueLabel, valueInput);

  const actions = document.createElement("div");
  actions.className = "bl-actions";

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn";
  saveBtn.textContent = "Save to Dirty";
  saveBtn.onclick = () => {
    stageRule({ type: typeSel.value, value: valueInput.value });
    purgeRuleBlockedFromDOM();
    toast("Rule staged");
    panel.remove();
  };

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = "Close";
  closeBtn.onclick = () => panel.remove();

  actions.append(saveBtn, closeBtn);

  typeSel.onchange = () => {
    const t = typeSel.value;
    if (t === "title") valueInput.value = job.title;
    if (t === "keyword") valueInput.value = job.title;
    if (t === "location") valueInput.value = job.location;
    if (t === "company") valueInput.value = job.company;
  };

  panel.append(row1, row2, hint, actions);
  return panel;
}

// ---------- Filtering ----------
function shouldHide(job) {
  const id = jobId(job);
  const r = state.memory[id] || null;
  if (!r) return false;
  return !!(r.rejected || r.appliedConfirmed);
}

const NON_US_LOCATION_TERMS = [
  "canada", "toronto", "vancouver",
  "united kingdom", "uk", "london", "ireland", "dublin",
  "europe", "emea", "germany", "france", "spain", "netherlands", "amsterdam",
  "sweden", "norway", "denmark", "finland",
  "australia", "new zealand",
  "singapore", "japan", "india", "bangalore", "gurugram", "hyderabad",
  "south africa",
  "brazil", "colombia", "chile",
  "mexico", "latam"
];

const AMBIGUOUS_OK_TERMS = [
  "remote - us", "us remote", "remote (us)", "united states", "usa", "u.s."
];

const HARD_BACKEND_TERMS = [
  "backend engineer", "back-end", "distributed systems", "microservices", "kubernetes",
  "sre", "site reliability", "devops", "platform engineer", "infrastructure engineer",
  "data engineer", "ml engineer", "machine learning engineer", "software engineer"
];

const BACKEND_PRIMITIVES = [
  "java", "golang", "c++", "rust", "kafka", "grpc", "k8s", "helm", "terraform",
  "aws", "gcp", "azure", "postgres", "mysql", "redis"
];

const INFRA_OWNERSHIP = [
  "on-call", "oncall", "pager", "incident", "latency", "throughput", "availability",
  "sla", "slo", "slis", "runbook"
];

function countHits(text, arr) {
  let n = 0;
  for (const t of arr) if (text.includes(t)) n++;
  return n;
}

function excludeBackendInfraRole(text) {
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

    const bar = document.createElement("div");
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
    progress: document.getElementById("sjsProgress"),
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
}

function setLoading(isLoading, opts = {}) {
  const ui = ensureLoadingUI();
  ui.statusWrap.hidden = !isLoading;
  ui.progress.hidden = !isLoading;
  ui.note.hidden = !isLoading;

  if (ui.statusText) ui.statusText.textContent = opts.statusText || (isLoading ? "Searching..." : "");
  if (ui.note) ui.note.textContent = opts.noteText || "";
  if (ui.bar) ui.bar.style.width = (opts.progressPct || 0) + "%";
}

function setProgress(statusText, done, total, noteText) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  setLoading(true, { statusText, progressPct: pct, noteText });
}

// ---------- Rendering + Search ----------
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
  const whyMeta = computeWhyStatus(job);

  const div = document.createElement("div");
  div.className = "job";
  div.setAttribute("data-jobid", id);

  if (record.viewed) div.classList.add("viewed");
  if (record.rejected) div.classList.add("rejected");
  if (record.appliedConfirmed) div.classList.add("appliedConfirmed");

  const head = document.createElement("div");
  head.className = "job-head";

  const titleWrap = document.createElement("div");
  const h3 = document.createElement("h3");
  h3.textContent = job.title;
  const p = document.createElement("p");
  p.textContent = job.location;
  titleWrap.append(h3, p);

  const whyBtn = document.createElement("button");
  whyBtn.type = "button";
  whyBtn.className = "why-btn " + (
    whyMeta.status === "green" ? "why-green" :
    whyMeta.status === "yellow" ? "why-yellow" : "why-red"
  );
  whyBtn.setAttribute("aria-label", "Why");
  whyBtn.title =
    whyMeta.status === "green" ? "PASS (strict)" :
    whyMeta.status === "yellow" ? "REJECT (review)" :
    "REJECT (hard)";

  const whyImg = document.createElement("img");
  whyImg.src = "WhyInfo.png";
  whyImg.alt = "Why";
  whyBtn.appendChild(whyImg);

  whyBtn.onclick = () => {
    const existing = div.querySelector(".why-panel");
    if (existing) { existing.remove(); return; }
    const panel = buildWhyPanel(job, whyMeta);
    div.appendChild(panel);
  };

  head.append(titleWrap, whyBtn);
  div.appendChild(head);

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
    const panel = buildBlacklistPanel(job, id);
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
  loadSources(); // re-load every run (mobile tends to keep state weirdly)

  const tasks = [];
  for (const g of state.greenhouse) tasks.push({ type: "Greenhouse", label: g, fn: () => fetchGreenhouse(g) });
  for (const l of state.lever) tasks.push({ type: "Lever", label: l, fn: () => fetchLever(l) });
  for (const c of state.custom) tasks.push({ type: "Custom", label: c, fn: () => fetchCustom(c) });

  if (!tasks.length) {
    setLoading(false);
    toast("No sources configured. Open Sources & Settings.");
    return;
  }

  const total = tasks.length;
  let done = 0, skipped = 0, failed = 0;
  let jobs = [];

  const PER_SOURCE_TIMEOUT_MS = 12000;

  setLoading(true, {
    statusText: `Searching sources (0/${total})...`,
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
      const aNew = isNewHit(a) ? 1 : 0;
      const bNew = isNewHit(b) ? 1 : 0;
      if (aNew !== bNew) return bNew - aNew;

      const aViewed = isViewedUndecided(a) ? 1 : 0;
      const bViewed = isViewedUndecided(b) ? 1 : 0;
      if (aViewed !== bViewed) return bViewed - aViewed;

      return norm(a.title).localeCompare(norm(b.title));
    });

    passed = passed.slice(0, MAX_RESULTS);

    for (const job of passed) out.appendChild(renderJob(job));

    refreshDirtyUI();
    purgeRuleBlockedFromDOM();

    setLoading(false);

    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (!passed.length) toast("No matches (after rules/gates)");
    else toast(`Loaded ${passed.length}`);
  })();

  try {
    await Promise.race([doSearch, timeoutPromise]);
  } catch {
    toast(timedOut ? "Search timed out" : "Search failed");
    setLoading(false);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    setLoading(false);
  }
}

// ---------- Boot ----------
function wireUI() {
  loadSources();
  loadMemory();

  if ($("greenhouse")) $("greenhouse").value = (localStorage.getItem("greenhouse") || "");
  if ($("lever")) $("lever").value = (localStorage.getItem("lever") || "");
  if ($("custom")) $("custom").value = (localStorage.getItem("custom") || "");

  const strictBtn = $("modeStrict");
  const relaxedBtn = $("modeRelaxed");
  if (strictBtn) strictBtn.onclick = () => setMode("strict");
  if (relaxedBtn) relaxedBtn.onclick = () => setMode("relaxed");
  setMode(state.mode);

  const runBtn = $("btnRun");
  if (runBtn) runBtn.onclick = () => runSearch();

  const settingsBtn = $("btnSettings");
  if (settingsBtn) settingsBtn.onclick = () => {
    const s = $("settings");
    // FIX: open if currently hidden, close if open
    const open = s ? s.hidden : true;
    setSettingsVisible(open);
  };

  const saveBtn = $("btnSave");
  if (saveBtn) saveBtn.onclick = () => saveSourcesFromUI();

  const deleteBtn = $("btnClear");
  if (deleteBtn) deleteBtn.onclick = () => clearMemory();

  refreshDirtyUI();
}

window.addEventListener("DOMContentLoaded", () => {
  try { wireUI(); } catch (e) { console.error(e); }
});
