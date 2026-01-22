// index.js
// Bootstrap + state authority for Strict Job Search v3

// ---- CONFIG ----

// Durable rules baseline (read-only at runtime)
const RULES_FILE_PATH = './rules.json';

// LocalStorage keys (volatile)
const STAGED_RULES_KEY = 'sjs_staged_rules_v1';

// ---- STATE ----

const AppState = {
  rules: null,        // durable baseline loaded from file
  stagedRules: [],    // volatile buffer accumulated across runs
  version: null
};

// ---- LOADERS ----

async function loadRulesFile() {
  const res = await fetch(RULES_FILE_PATH, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load rules.json');
  return res.json();
}

function loadStagedRules() {
  try {
    const raw = localStorage.getItem(STAGED_RULES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ---- VOLATILE PERSISTENCE ----

function saveStagedRules(buffer) {
  localStorage.setItem(STAGED_RULES_KEY, JSON.stringify(buffer));
}

function clearStagedRules() {
  localStorage.removeItem(STAGED_RULES_KEY);
  AppState.stagedRules = [];
}

// ---- PROMOTION GATE ----
// This is the ONLY place rules are allowed to change.
// In a static app, this prepares an export for you to commit to GitHub.

function promoteStagedRules() {
  if (!AppState.stagedRules.length) {
    return { ok: false, reason: 'NO_STAGED_RULES' };
  }

  const base = AppState.rules || {};
  const baseExplicit = Array.isArray(base.explicitRules) ? base.explicitRules : [];

  const updated = {
    ...base,
    explicitRules: baseExplicit.concat(AppState.stagedRules),
    version: bumpVersion(base.version)
  };

  // Expose for manual export / commit
  window.EXPORT_RULES_JSON = updated;

  // Update in-memory baseline for this session
  AppState.rules = updated;
  AppState.version = updated.version || null;

  // Clear volatile buffer after promotion
  clearStagedRules();

  return { ok: true, updated };
}

function bumpVersion(v) {
  if (!v) return '1';
  const n = Number(v);
  return Number.isFinite(n) ? String(n + 1) : v;
}

// ---- BOOTSTRAP ----

async function bootstrap() {
  const rules = await loadRulesFile();
  const staged = loadStagedRules();

  AppState.rules = rules;
  AppState.stagedRules = staged;
  AppState.version = rules.version || null;

  // Expose contract to app.js
  window.APP_STATE = AppState;
  window.APP_ACTIONS = {
    stageRule(rule) {
      AppState.stagedRules.push(rule);
      saveStagedRules(AppState.stagedRules);
    },
    promoteStagedRules,
    clearStagedRules
  };
}

// ---- INIT ----

bootstrap().catch(err => {
  console.error('Bootstrap failed:', err);

  // Fail soft: still expose contract so app.js can run
  window.APP_STATE = AppState;
  window.APP_ACTIONS = {
    stageRule(rule) {
      AppState.stagedRules.push(rule);
      saveStagedRules(AppState.stagedRules);
    },
    promoteStagedRules,
    clearStagedRules
  };
});
