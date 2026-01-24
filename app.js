/* ============================
   Strict Job Search — app.js
   Blacklist Foundation Fix
   ============================ */

/* ---------- State ---------- */

let jobs = [];
let renderedJobs = [];
let stagedRules = loadStagedRules();

/* ---------- Utilities ---------- */

function normalize(text) {
  return (text || "").toLowerCase();
}

function getVisibleLocationText(job) {
  // This MUST match exactly what the user sees on the card
  // If you ever change card rendering, update this function
  return normalize(job.displayLocation || job.location || "");
}

function getVisibleTitleText(job) {
  return normalize(job.title || "");
}

/* ---------- Rule Loaders ---------- */

function loadStagedRules() {
  try {
    return JSON.parse(localStorage.getItem("stagedRules")) || [];
  } catch {
    return [];
  }
}

function saveStagedRules() {
  localStorage.setItem("stagedRules", JSON.stringify(stagedRules));
}

/* ---------- Blacklist Evaluation ---------- */

function locationIsBlacklisted(job) {
  const locationText = getVisibleLocationText(job);
  return stagedRules.some(rule =>
    rule.type === "location" &&
    locationText.includes(normalize(rule.value))
  );
}

function titleIsBlacklisted(job) {
  const titleText = getVisibleTitleText(job);
  return stagedRules.some(rule =>
    rule.type === "title" &&
    titleText.includes(normalize(rule.value))
  );
}

function isHardExcluded(job) {
  // Location blacklist is ABSOLUTE
  if (locationIsBlacklisted(job)) return true;
  if (titleIsBlacklisted(job)) return true;
  return false;
}

/* ---------- Rendering ---------- */

function renderJobs(jobList) {
  const container = document.getElementById("results");
  container.innerHTML = "";
  renderedJobs = [];

  jobList.forEach(job => {
    if (isHardExcluded(job)) return;

    renderedJobs.push(job);

    const card = document.createElement("div");
    card.className = "job-card";

    card.innerHTML = `
      <div class="job-title">${job.title}</div>
      <div class="job-location">${job.displayLocation || job.location}</div>
      <div class="job-actions">
        <button onclick="viewJob('${job.id}')">View</button>
        <button onclick="rejectJob('${job.id}')">Reject</button>
      </div>
    `;

    container.appendChild(card);
  });
}

/* ---------- Blacklist UI ---------- */

function rejectJob(jobId) {
  const job = renderedJobs.find(j => j.id === jobId);
  if (!job) return;

  showBlacklistPanel(job);
}

function showBlacklistPanel(job) {
  const panel = document.getElementById("blacklist-panel");
  panel.innerHTML = `
    <h3>Blacklist</h3>
    <label>
      <input type="checkbox" id="bl-title" />
      Title: "${job.title}"
    </label>
    <label>
      <input type="checkbox" id="bl-location" />
      Location: "${job.displayLocation || job.location}"
    </label>
    <button onclick="saveBlacklist('${job.id}')">Save</button>
  `;
  panel.style.display = "block";
}

function saveBlacklist(jobId) {
  const job = renderedJobs.find(j => j.id === jobId);
  if (!job) return;

  if (document.getElementById("bl-title").checked) {
    stagedRules.push({ type: "title", value: job.title });
  }

  if (document.getElementById("bl-location").checked) {
    stagedRules.push({
      type: "location",
      value: job.displayLocation || job.location
    });
  }

  saveStagedRules();
  document.getElementById("blacklist-panel").style.display = "none";

  // 🔥 INSTANT PURGE
  purgeRenderedJobs();
}

/* ---------- Instant Purge ---------- */

function purgeRenderedJobs() {
  renderedJobs = renderedJobs.filter(job => !isHardExcluded(job));
  renderJobs(renderedJobs);
}

/* ---------- Search ---------- */

function runSearch() {
  fetchJobs().then(results => {
    jobs = results;
    renderJobs(jobs);
  });
}

/* ---------- Mock Fetch ---------- */

async function fetchJobs() {
  return window.JOB_FEED || [];
}

/* ---------- Init ---------- */

document.getElementById("run-search").addEventListener("click", runSearch);
