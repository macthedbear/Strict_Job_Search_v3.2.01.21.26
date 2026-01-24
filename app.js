// app.js — Strict Job Search (foundation-stable)
// Progress bar restored via app.js (CSS unchanged)

const $ = (id) => document.getElementById(id);

const state = {
  greenhouse: [],
  lever: [],
  custom: [],
  mode: "strict",
  memory: {},
  rendered: {},
  currentResults: []
};

const MAX_RESULTS = 15;
const MEMORY_KEY = "jobMemoryV3";
const TIMEOUT_MS = 180000;
const STAGED_RULES_KEY = "sjs_staged_rules_v1";

// ---------- Utilities ----------
function jobId(job) {
  const base = job.url || (job.company + "|" + job.title + "|" + job.location);
  return btoa(unescape(encodeURIComponent(base))).slice(0, 64);
}
function norm(s) { return String(s || "").trim().toLowerCase(); }
function safeJsonParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

// ---------- Memory ----------
function loadMemory() {
  state.memory = safeJsonParse(localStorage.getItem(MEMORY_KEY) || "{}", {});
}
function saveMemory() {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(state.memory)); } catch {}
}

// ---------- Settings ----------
function loadSettings() {
  state.greenhouse = safeJsonParse(localStorage.getItem("greenhouse") || "[]", []);
  state.lever = safeJsonParse(localStorage.getItem("lever") || "[]", []);
  state.custom = safeJsonParse(localStorage.getItem("custom") || "[]", []);
  $("greenhouse") && ($("greenhouse").value = state.greenhouse.join("\n"));
  $("lever") && ($("lever").value = state.lever.join("\n"));
  $("custom") && ($("custom").value = state.custom.join("\n"));
}
function saveSettings() {
  if (!$("greenhouse") || !$("lever") || !$("custom")) return;
  state.greenhouse = $("greenhouse").value.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  state.lever = $("lever").value.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  state.custom = $("custom").value.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  localStorage.setItem("greenhouse", JSON.stringify(state.greenhouse));
  localStorage.setItem("lever", JSON.stringify(state.lever));
  localStorage.setItem("custom", JSON.stringify(state.custom));
  setSettingsVisible(false);
}
function setSettingsVisible(open) {
  const s = $("settings");
  if (!s) return;
  s.hidden = !open;
  s.style.display = open ? "" : "none";
}

// ---------- Progress Bar (RESTORED) ----------
function ensureProgressUI() {
  const controls = document.querySelector(".controls");
  if (!controls) return;
  if (document.getElementById("sjsProgress")) return;

  const wrap = document.createElement("div");
  wrap.id = "sjsProgress";
  wrap.className = "sjs-progress";
  wrap.hidden = true;

  const bar = document.createElement("div");
  bar.id = "sjsProgressBar";
  wrap.appendChild(bar);

  controls.insertAdjacentElement("afterend", wrap);
}

function showProgressBaseline() {
  ensureProgressUI();
  const wrap = $("sjsProgress");
  const bar = $("sjsProgressBar");
  if (!wrap || !bar) return;
  wrap.hidden = false;
  wrap.style.display = "";
  bar.style.width = "6%";
}

function setProgress(pct) {
  const wrap = $("sjsProgress");
  const bar = $("sjsProgressBar");
  if (!wrap || !bar) return;
  wrap.hidden = false;
  wrap.style.display = "";
  bar.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + "%";
}

function hideProgress() {
  const wrap = $("sjsProgress");
  const bar = $("sjsProgressBar");
  if (!wrap || !bar) return;
  setTimeout(() => {
    wrap.hidden = true;
    wrap.style.display = "none";
    bar.style.width = "0%";
  }, 300);
}

// ---------- Fetchers ----------
async function fetchGreenhouse(t) {
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`);
    const j = await r.json();
    return (j.jobs || []).map(x => ({
      company: t, title: x.title, location: x.location?.name || "",
      description: x.content || "", url: x.absolute_url || ""
    }));
  } catch { return []; }
}
async function fetchLever(s) {
  try {
    const r = await fetch(`https://api.lever.co/v0/postings/${s}?mode=json`);
    const j = await r.json();
    return j.map(x => ({
      company: s, title: x.text, location: x.categories?.location || "",
      description: x.description || "", url: x.hostedUrl || ""
    }));
  } catch { return []; }
}
async function fetchCustom(u) {
  try {
    const r = await fetch(u);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : j.jobs || [];
    return arr.map(x => ({
      company: x.company || "custom", title: x.title,
      location: x.location || "", description: x.description || "", url: x.url || ""
    }));
  } catch { return []; }
}

// ---------- Rendering ----------
function renderJob(job) {
  const d = document.createElement("div");
  d.className = "job";
  d.innerHTML = `<h3>${job.title}</h3><p>${job.location}</p>`;
  return d;
}

// ---------- Search ----------
async function runSearch() {
  const out = $("results");
  if (!out) return;

  out.innerHTML = "";
  state.currentResults = [];
  loadMemory();

  const tasks = [];
  state.greenhouse.forEach(g => tasks.push(() => fetchGreenhouse(g)));
  state.lever.forEach(l => tasks.push(() => fetchLever(l)));
  state.custom.forEach(c => tasks.push(() => fetchCustom(c)));

  const total = tasks.length;
  showProgressBaseline();

  if (!total) {
    hideProgress();
    out.innerHTML = `<div class="loaded">Loaded 0</div>`;
    return;
  }

  let done = 0;
  let jobs = [];

  for (const t of tasks) {
    try { jobs.push(...await t()); } catch {}
    done++;
    setProgress((done / total) * 100);
  }

  jobs.slice(0, MAX_RESULTS).forEach(j => out.appendChild(renderJob(j)));
  out.appendChild(Object.assign(document.createElement("div"), {
    className: "loaded", textContent: `Loaded ${Math.min(jobs.length, MAX_RESULTS)}`
  }));

  setProgress(100);
  hideProgress();
}

// ---------- Wire ----------
function wire() {
  setSettingsVisible(false);
  $("btnRun")?.addEventListener("click", runSearch);
  $("btnSettings")?.addEventListener("click", () => setSettingsVisible(true));
  $("btnSave")?.addEventListener("click", saveSettings);
  loadSettings();
  loadMemory();
  ensureProgressUI();
}

document.readyState === "loading"
  ? document.addEventListener("DOMContentLoaded", wire)
  : wire();
