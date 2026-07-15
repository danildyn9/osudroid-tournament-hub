// ==================== DATA ====================
const STAGES = ['RO32','RO16','QF','SF','F','GF'];
const STAGE_NAMES = { RO32:'Round of 32', RO16:'Round of 16', QF:'Quarterfinals', SF:'Semifinals', F:'Finals', GF:'Grand Finals' };
const SLOTS =['NM1','NM2','NM3','NM4','NM5','HD1','HD2','HD3','HR1','HR2','HR3','DT1','DT2','DT3','DT4','FM1','FM2','FM3','FM4','PR1','PR2','PR3','PR4','TB'];
const STORAGE_KEY = 'odt_state_v2';

function newTournament(name, opts={}) {
  return {
    id: 't' + Date.now() + Math.floor(Math.random()*1000),
    name: name || 'New Tournament',
    sub: opts.sub || '',
    format: opts.format || 'Team VS',
    status: opts.status || 'Upcoming',
    dates: opts.dates || '',
    banner: opts.banner || '',           // data URL of banner background
    teamRed: opts.teamRed || '',          // display name for team 0 ('' = "Red")
    teamBlue: opts.teamBlue || '',        // display name for team 1 ('' = "Blue")
    challongeSlug: opts.challongeSlug || '',
    slug: opts.slug || '',                // readable URL slug (?tournament=<slug>); assigned by ensureSlug
    rules: opts.rules || '',              // free-text rules (overview page)
    rulesUrl: opts.rulesUrl || '',        // optional external "read full rules" link
    discordUrl: opts.discordUrl || '',    // overview Media link
    spectatorUrl: opts.spectatorUrl || '',// overview Media link
    livestreamUrl: opts.livestreamUrl || '', // overview Media link
    spreadsheetUrl: opts.spreadsheetUrl || '', // overview Media link
    schedule: opts.schedule || [],        // [{ label, dates }] rows for the overview Schedule block
    mode: opts.mode || '',                // win condition / mod, e.g. "Relax" (General Info)
    modeInfo: opts.modeInfo || '',        // click-through details for custom win conditions
    prizePool: opts.prizePool || '',      // prize pool shown in General Info
    elimination: opts.elimination || '',  // bracket type, e.g. "Single Elimination, Double Elim from RO16"
    staff: opts.staff || [],              // [{ role, name, uid, discord, avatar }] one person per entry
    aliases: opts.aliases || {},          // { 'oldnicklower': 'CanonicalNick' } — merges a player's alt nicks into one profile
    matchSchedule: opts.matchSchedule || [], // [{ matchId, roomId, roomLink, time, p1, score1, score2, p2, referee, streamer, commentator, streamLink }]
    bracket: opts.bracket || { type: 'double', size: 8, participants: [], scores: {}, slots: {} }, // custom bracket engine
    hiddenStages: {},                     // { RO32: true } = hidden from stage bar
    teams: opts.teams || [],              // [{ id, name, players: [{ droid, discord, avatar, rank, profile }] }]
    stages: {}                            // { RO16: { matches, mapOrder, slotOverrides } }
  };
}

// readable, URL-safe slug from a tournament name
function slugify(s) {
  return (s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tournament';
}
// assign a unique slug if missing (kept stable afterwards so links don't rot)
function ensureSlug(t) {
  if (t.slug) return;
  const base = slugify(t.name);
  let s = base, n = 2;
  while (state.tournaments.some(x => x !== t && x.slug === s)) s = base + '-' + (n++);
  t.slug = s;
}
function tBySlug(slug) { return state.tournaments.find(t => t.slug === slug) || null; }

let state = {
  page: 'home',                 // home | stats | bracket
  currentTournamentId: null,    // tournament open in the stats view
  adminTournamentId: null,      // tournament being edited in admin
  currentMatchId: null,         // match open in the Matches view (null = match list)
  logo: '',                     // data URL of the site logo ('' = built-in mark)
  splashBg: '',                 // data URL of the home splash background ('' = gradient)
  // global UI state (not per-tournament)
  currentStage: 'RO16',
  adminStage: 'RO16',
  view: 'mappool',
  lbSort: { key: 'score', dir: 'desc' },
  playerSort: { key: 'avgScore', dir: 'desc' },
  playerSearch: '',
  tournaments: []
};

// ---- tournament context helpers ----
function tById(id) { return state.tournaments.find(t => t.id === id) || null; }
function curT() { return tById(state.currentTournamentId); }
function admT() { return tById(state.adminTournamentId); }

function getStageData(t, stage) {
  if (!t) return { matches: [], mapOrder: [], slotOverrides: {}, manualScores: [], mapMeta: {} };
  if (!t.stages[stage]) t.stages[stage] = { matches: [], mapOrder: [], slotOverrides: {}, manualScores: [], mapMeta: {} };
  const sd = t.stages[stage];
  if (!sd.manualScores) sd.manualScores = [];
  if (!sd.mapMeta) sd.mapMeta = {};   // { [sessKey]: { cover, setId, beatmapId, version, mapper, sr, ar, cs, od, hp, bpm, length } }
  return sd;
}

// localStorage quota (~5MB) can overflow when the state carries many base64 images.
// Warn once per session (not on every navigation), and keep the remote push working
// even when the local cache write fails — the Worker copy has no such limit.
let storageFullWarned = false;
function saveState() {
  state.updatedAt = Date.now();
  let ok = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch(e) {
    ok = false;
    if (!storageFullWarned) {
      storageFullWarned = true;
      const size = Math.round(JSON.stringify(state).length / 1024);
      alert(`Local browser storage is full (state is ~${size} KB, browsers allow ~5000 KB).\n\n`
        + `Your data is still synced to the server, but the offline cache can't update.\n`
        + `To fix: re-upload smaller banner / logo / splash background images (Admin → Media), `
        + `or delete unused tournaments.`);
    }
    setSyncStatus('Local cache full — remote only', 'err');
  }
  schedulePush(); // remote sync must run even if the local cache write failed
  return ok;
}

function loadState() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) { const p = JSON.parse(s); Object.assign(state, p); }
  } catch(e) {}
}

// True once the admin password has been entered this session (stays true after the
// overlay is closed, so admin-only controls like the in-match add-score form remain
// visible while browsing the public views). Reset on page reload.
// ⚠️ Declared here (before the INIT block runs applyPage/renderAll) — adminVisible()
// reads it during the first render, and a `let` below that point would throw (TDZ).
let adminUnlocked = false;
function isAdminUnlocked() { return adminUnlocked; }

// ==================== REMOTE SYNC (Cloudflare Worker + KV) ====================
// Shared dataset across devices with server-side write protection. Offline-first:
// localStorage is the instant cache + fallback; the Worker is the source of truth
// whenever it's reachable. Only a device holding the admin password can write.
let adminSecret = '';
try { adminSecret = localStorage.getItem('odt_admin_secret') || ''; } catch (e) {}

function stateApiUrl() {
  return PROXY_BASE ? PROXY_BASE.replace(/\/+$/, '') + '/state' : '';
}

// Verify the admin password server-side (the Worker holds the real secret; no hash
// lives in this public file). Returns true / false, or 'unreachable' on network error.
async function verifyAdminPassword(pw) {
  if (!PROXY_BASE) return false;
  const url = PROXY_BASE.replace(/\/+$/, '') + '/auth';
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + pw } });
    return r.ok;
  } catch (e) {
    return 'unreachable';
  }
}

function setSyncStatus(text, cls) {
  const el = document.getElementById('sync-status');
  if (el) { el.textContent = text; el.className = 'fetch-status' + (cls ? ' ' + cls : ''); }
}

// Pull the shared state on load. Only replace local data if the remote copy is at
// least as new (protects unsynced offline admin edits).
async function syncFromRemote() {
  const url = stateApiUrl();
  if (!url) return;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return;
    const remote = await r.json();
    // Only adopt the remote copy if it actually has data AND is strictly newer than
    // what we hold locally. This protects existing local data (e.g. pre-sync saves
    // that have no updatedAt) from being wiped by an empty or equal-age remote.
    const remoteHasData = remote && Array.isArray(remote.tournaments) && remote.tournaments.length > 0;
    if (!remoteHasData) {
      if (adminSecret) pushRemote();          // remote empty → seed it from local
      return;
    }
    if ((remote.updatedAt || 0) > (state.updatedAt || 0)) {
      Object.keys(state).forEach(k => delete state[k]);
      Object.assign(state, remote);
      ensureSeed();
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
      readStateFromURL();
      renderBrand();
      applyPage();
      renderAll();
      if (adminUnlocked) refreshAdminPanel();
      setSyncStatus('Synced ✓', 'ok');
    } else if (adminSecret) {
      pushRemote();                            // local is newer → push it up
    }
  } catch (e) { /* offline → keep local cache */ }
}

let pushTimer = null;
function schedulePush() {
  if (!adminSecret || !stateApiUrl()) return;
  setSyncStatus('Saving…', '');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushRemote, 1500);
}

async function pushRemote() {
  const url = stateApiUrl();
  if (!url || !adminSecret) return;
  clearTimeout(pushTimer);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminSecret },
      body: JSON.stringify(state),
    });
    if (r.status === 401) { setSyncStatus('Wrong password — not synced', 'err'); return; }
    if (!r.ok) { setSyncStatus('Sync failed (' + r.status + ')', 'err'); return; }
    setSyncStatus('Synced ✓', 'ok');
  } catch (e) {
    setSyncStatus('Offline — saved locally', 'err');
  }
}

function backupFileName() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `osudroid-tournament-hub-${stamp}.json`;
}

function exportStateJSON() {
  const st = document.getElementById('state-io-status');
  try {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (st) { st.textContent = 'Exported current state.'; st.className = 'fetch-status ok'; }
  } catch (e) {
    if (st) { st.textContent = 'Export failed.'; st.className = 'fetch-status err'; }
  }
}

function importStateJSON(input) {
  const st = document.getElementById('state-io-status');
  const file = input && input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const next = JSON.parse(String(reader.result || ''));
      if (!next || !Array.isArray(next.tournaments)) throw new Error('Invalid backup format');
      if (!confirm('Import this backup? Current local data will be replaced.')) return;
      Object.keys(state).forEach(k => delete state[k]);
      Object.assign(state, next);
      ensureSeed();
      saveState();
      renderBrand();
      applyPage();
      refreshAdminPanel();
      if (st) { st.textContent = 'Imported backup.'; st.className = 'fetch-status ok'; }
    } catch (e) {
      if (st) { st.textContent = 'Import failed: invalid JSON backup.'; st.className = 'fetch-status err'; }
    } finally {
      input.value = '';
    }
  };
  reader.onerror = () => {
    if (st) { st.textContent = 'Import failed: could not read file.'; st.className = 'fetch-status err'; }
    input.value = '';
  };
  reader.readAsText(file);
}

function ensureSeed() {
  if (!Array.isArray(state.tournaments) || !state.tournaments.length) {
    const t = newTournament('osu!droid 18th Tournament', {
      status: 'Ongoing',
      format: 'Team VS',
      challongeSlug: 'droiddiscordtour18'
    });
    state.tournaments = [t];
  }
  // assign a stable URL slug to any tournament missing one (migration + new tournaments)
  for (const t of state.tournaments) ensureSlug(t);
  // migrate: older tournaments predate the name-alias map
  for (const t of state.tournaments) if (!t.aliases || typeof t.aliases !== 'object') t.aliases = {};
  // migrate legacy staff rows ({role, members:"a, b"}) → one person per entry ({role, name})
  for (const t of state.tournaments) {
    if (Array.isArray(t.staff) && t.staff.some(s => s && s.members != null && s.name == null)) {
      const out = [];
      for (const s of t.staff) {
        if (s && s.members != null && s.name == null) {
          (s.members || '').split(',').map(n => n.trim()).filter(Boolean)
            .forEach(n => out.push({ role: s.role || '', name: n, uid: '', discord: '', avatar: '' }));
        } else if (s) out.push(s);
      }
      t.staff = out;
    }
  }
  // make sure selections point at existing tournaments
  if (!tById(state.currentTournamentId)) state.currentTournamentId = state.tournaments[0].id;
  if (!tById(state.adminTournamentId)) state.adminTournamentId = state.currentTournamentId;
}

// ==================== INIT ====================
// ⚠️ The real init call sequence lives at the very END of this file (see KICK OFF).
// It must run after every top-level const/let is initialized — function declarations
// hoist, but consts (VIEWS, BYE, SPLASH_*, …) don't, and calling into them earlier
// throws "Cannot access before initialization" and kills the whole script on
// deep links like ?page=bracket or &view=matches.

// ==================== BRAND / LOGO ====================
function defaultLogoSVG() {
  // temporary built-in mark — replace by uploading your own logo in Admin → Site Logo
  return `<span class="brand-mark"><svg width="34" height="34" viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="32" height="32" rx="9" fill="#7c6ff7"/>
    <rect x="1" y="1" width="32" height="32" rx="9" fill="url(#g)" fill-opacity="0.35"/>
    <circle cx="17" cy="17" r="9" stroke="#fff" stroke-width="2.4"/>
    <circle cx="17" cy="17" r="3.4" fill="#fff"/>
    <defs><linearGradient id="g" x1="1" y1="1" x2="33" y2="33" gradientUnits="userSpaceOnUse">
      <stop stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient></defs>
  </svg></span><span class="brand-word">osu!<span>droid</span></span>`;
}

function renderBrand() {
  const el = document.getElementById('brand');
  if (!el) return;
  el.innerHTML = state.logo
    ? `<img src="${escAttr(state.logo)}" alt="logo">`
    : defaultLogoSVG();
  updateFavicon();
}

// Favicon follows the uploaded logo; falls back to the built-in mark as an inline SVG.
function updateFavicon() {
  const link = document.getElementById('favicon');
  if (!link) return;
  const builtin = () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><rect x="1" y="1" width="32" height="32" rx="9" fill="#7c6ff7"/><circle cx="17" cy="17" r="9" fill="none" stroke="#fff" stroke-width="2.4"/><circle cx="17" cy="17" r="3.4" fill="#fff"/></svg>';
    link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  };
  if (!state.logo) { builtin(); return; }
  // The logo is usually a wide wordmark padded with transparent margins. Trim those
  // margins first so the mark fills the tab icon instead of sitting as a tiny strip,
  // then letterbox the trimmed mark onto a transparent square (no stretch/skew).
  const img = new Image();
  img.onload = () => {
    try {
      const iw = img.width, ih = img.height;
      // draw at native size to inspect the alpha channel
      const src = document.createElement('canvas');
      src.width = iw; src.height = ih;
      const sctx = src.getContext('2d');
      sctx.drawImage(img, 0, 0);
      // find the bounding box of non-transparent pixels
      let x0 = iw, y0 = ih, x1 = 0, y1 = 0, found = false;
      try {
        const data = sctx.getImageData(0, 0, iw, ih).data;
        for (let y = 0; y < ih; y++) {
          for (let x = 0; x < iw; x++) {
            if (data[(y * iw + x) * 4 + 3] > 12) {
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
              found = true;
            }
          }
        }
      } catch (e) { found = false; }
      if (!found) { x0 = 0; y0 = 0; x1 = iw - 1; y1 = ih - 1; }
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      // square canvas sized to the trimmed mark, with a small breathing margin
      const size = Math.round(Math.max(cw, ch) * 1.08);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.drawImage(src, x0, y0, cw, ch,
        Math.round((size - cw) / 2), Math.round((size - ch) / 2), cw, ch);
      link.href = c.toDataURL('image/png');
    } catch (e) { link.href = state.logo; }
  };
  img.onerror = builtin;
  img.src = state.logo;
}

// Big centered logo for the splash intro. Uses the uploaded logo if present,
// otherwise the built-in mark + wordmark.
function renderSplash() {
  const sec = document.getElementById('splash-section');
  const bg = document.getElementById('splash-bg');
  if (sec && bg) {
    if (state.splashBg) { bg.style.backgroundImage = `url('${state.splashBg}')`; sec.classList.add('has-img'); }
    else { bg.style.backgroundImage = ''; sec.classList.remove('has-img'); }
  }
  const el = document.getElementById('splash-inner');
  if (!el) return;
  const mark = state.logo
    ? `<img class="splash-img" src="${escAttr(state.logo)}" alt="logo">`
    : `<svg width="150" height="150" viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="32" height="32" rx="9" fill="#7c6ff7"/>
        <rect x="1" y="1" width="32" height="32" rx="9" fill="url(#sg)" fill-opacity="0.35"/>
        <circle cx="17" cy="17" r="9" stroke="#fff" stroke-width="2.4"/>
        <circle cx="17" cy="17" r="3.4" fill="#fff"/>
        <defs><linearGradient id="sg" x1="1" y1="1" x2="33" y2="33" gradientUnits="userSpaceOnUse">
          <stop stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
        </linearGradient></defs>
      </svg>`;
  el.innerHTML = `<div class="splash-mark">${mark}
    <div class="splash-title">
      <div class="splash-word">osu!<span>droid</span></div>
      <div class="splash-sub">Tournament Hub</div>
    </div>
  </div>`;
}

function scrollToGallery() {
  const a = document.getElementById('gallery-anchor');
  if (a) a.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ==================== SPLASH VIDEO (random liveplay background) ====================
// Host clips on any public URL (Cloudflare R2 recommended — free egress) and list
// them below. A random clip loads on each page visit. Leave SPLASH_CLIPS empty to
// keep the plain gradient splash.
const SPLASH_VIDEO_BASE = 'https://pub-616ef5f1afd4424d83de3bbf0a078a96.r2.dev/';
const SPLASH_CLIPS = [                  // filenames (joined to BASE) or full URLs
  'clip-01.mp4', 'clip-02.mp4', 'clip-03.mp4', 'clip-04.mp4', 'clip-05.mp4', 'clip-06.mp4',
  'clip-07.mp4', 'clip-08.mp4', 'clip-09.mp4', 'clip-10.mp4', 'clip-11.mp4',
];
const SPLASH_VIDEO_POSTERS = true;      // each clip has a matching .jpg poster
const SPLASH_VIDEO_ON_MOBILE = true;    // also load video on small screens?

function setupSplashVideo() {
  const vid = document.getElementById('splash-video');
  const sec = document.getElementById('splash-section');
  if (!vid || !sec || !SPLASH_CLIPS.length) return;
  // by default only skip small screens (save mobile data/battery). Reduced-motion is
  // NOT honored here on purpose — the video is a muted decorative background the site
  // owner opted into; gating on it hid the video on machines with animations disabled.
  const mm = window.matchMedia ? window.matchMedia.bind(window) : null;
  const small = mm && mm('(max-width: 680px)').matches;
  if (small && !SPLASH_VIDEO_ON_MOBILE) return;

  // pick a clip, avoiding the one shown on the previous visit so refreshes feel varied
  let last = -1;
  try { last = parseInt(localStorage.getItem('odt_splash_last'), 10); } catch (e) {}
  let idx = Math.floor(Math.random() * SPLASH_CLIPS.length);
  if (SPLASH_CLIPS.length > 1 && idx === last) idx = (idx + 1) % SPLASH_CLIPS.length;

  const tried = new Set();
  const load = (i) => {
    idx = i; tried.add(i);
    const pick = SPLASH_CLIPS[i];
    const url = /^https?:\/\//i.test(pick) ? pick : SPLASH_VIDEO_BASE + pick;
    if (SPLASH_VIDEO_POSTERS) {
      const poster = url.replace(/\.(mp4|webm)(\?.*)?$/i, '.jpg');
      if (poster !== url) vid.poster = poster;
    }
    vid.src = url;
    vid.preload = 'auto';
    const p = vid.play();
    if (p && p.catch) p.catch(() => {/* autoplay blocked — poster/first frame still shows */});
  };

  vid.addEventListener('loadeddata', () => {
    sec.classList.add('has-video');
    try { localStorage.setItem('odt_splash_last', String(idx)); } catch (e) {}
  }, { once: true });

  // if this visitor can't load the chosen clip (network/blocked), quietly try another
  vid.addEventListener('error', () => {
    if (tried.size >= SPLASH_CLIPS.length) return;
    let n = Math.floor(Math.random() * SPLASH_CLIPS.length), guard = 0;
    while (tried.has(n) && guard++ < SPLASH_CLIPS.length) n = (n + 1) % SPLASH_CLIPS.length;
    if (!tried.has(n)) load(n);
  });

  load(idx);
}

// ==================== ROUTING ====================
function goHome() {
  state.page = 'home';
  saveState();
  syncURL();
  applyPage();
}
function goStats() {
  if (!curT() && state.tournaments.length) state.currentTournamentId = state.tournaments[0].id;
  state.page = 'stats';
  saveState();
  syncURL();
  applyPage();
}
// Clicking a tournament card now lands on its overview page (entry point).
function openTournament(id) {
  if (!tById(id)) return;
  state.currentTournamentId = id;
  state.currentMatchId = null;
  // reset to first visible stage of this tournament
  const t = curT();
  const visible = STAGES.filter(s => !t.hiddenStages[s]);
  if (visible.length && t.hiddenStages[state.currentStage]) state.currentStage = visible[0];
  state.page = 'overview';
  saveState();
  syncURL();
  applyPage();
}

// Go back to the current tournament's overview (used by deeper pages).
function goOverview() {
  if (!curT() && state.tournaments.length) state.currentTournamentId = state.tournaments[0].id;
  state.currentMatchId = null;
  state.page = 'overview';
  saveState();
  syncURL();
  applyPage();
}
function applyPage() {
  document.getElementById('view-home').style.display = state.page === 'home' ? 'block' : 'none';
  document.getElementById('view-overview').style.display = state.page === 'overview' ? 'block' : 'none';
  document.getElementById('view-rules').style.display = state.page === 'rules' ? 'block' : 'none';
  document.getElementById('view-staff').style.display = state.page === 'staff' ? 'block' : 'none';
  document.getElementById('view-stats').style.display = state.page === 'stats' ? 'block' : 'none';
  document.getElementById('view-bracket').style.display = state.page === 'bracket' ? 'block' : 'none';
  document.getElementById('view-mappool').style.display = state.page === 'mappool' ? 'block' : 'none';
  document.getElementById('view-teams').style.display = state.page === 'teams' ? 'block' : 'none';
  document.getElementById('view-matchschedule').style.display = state.page === 'matchschedule' ? 'block' : 'none';
  const navHome = document.getElementById('nl-home');
  if (navHome) navHome.classList.toggle('active', state.page === 'home');
  if (state.page === 'home') renderHome();
  if (state.page === 'overview') renderOverview();
  if (state.page === 'rules') renderRules();
  if (state.page === 'staff') renderStaff();
  if (state.page === 'stats') { buildStageTabs(); updateStatsHeader(); switchView(state.view); }
  if (state.page === 'mappool') { buildMappoolStageTabs(); renderMappool(); }
  if (state.page === 'teams') renderTeams();
  if (state.page === 'bracket') renderBracket();
  if (state.page === 'matchschedule') renderMatchSchedule();
  renderTopNav();
}

// Per-tournament sub-navigation in the topbar. Only shown while a tournament
// is open, so users can jump between its sections without going back to Overview.
function renderTopNav() {
  const el = document.getElementById('nav-sub');
  if (!el) return;
  const inTournament = state.page !== 'home' && !!curT();
  if (!inTournament) { el.innerHTML = ''; return; }
  const items = [
    { p: 'overview', label: 'Overview', fn: 'goOverview()' },
    { p: 'stats',    label: 'Stats',    fn: 'goStats()' },
    { p: 'bracket',  label: 'Bracket',  fn: 'openBracket()' },
    { p: 'mappool',  label: 'Mappool',  fn: 'openMappool()' },
    { p: 'teams',    label: 'Teams',    fn: 'openTeams()' },
  ];
  el.innerHTML = items.map(x =>
    `<div class="nav-link${state.page === x.p ? ' active' : ''}" onclick="${x.fn}">${x.label}</div>`
  ).join('');
}

// Esc closes the topmost open modal/overlay.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const closers = [
    ['profile-modal', closeProfile],
    ['slot-modal', closeSlotModal],
    ['mode-info-modal', closeModeInfo],
    ['team-modal', closeTeamEditor],
  ];
  for (const [id, close] of closers) {
    const m = document.getElementById(id);
    if (m && m.classList.contains('show')) { close(); return; }
  }
  const ov = document.getElementById('admin-overlay');
  if (ov && ov.classList.contains('show')) toggleAdmin();
});

function updateStatsHeader() {
  const t = curT();
  const el = document.getElementById('stats-title');
  if (el && t) el.innerHTML = tournamentNameHTML(t.name);
}

// "First <span>rest</span>" split on first space, for accent coloring
function tournamentNameHTML(name) {
  const n = (name || 'Tournament').trim();
  const sp = n.indexOf(' ');
  return sp > 0 ? `${escAttr(n.slice(0,sp))} <span>${escAttr(n.slice(sp+1))}</span>` : escAttr(n);
}

// ==================== SHAREABLE URL STATE ====================
// Reflect the open screen into the query string (?t=...&stage=QF&view=players&match=ID)
// so links can be copied/shared. Wrapped in try/catch because history.replaceState
// can throw when the file is opened directly via file:// in some browsers.
const VIEWS = ['mappool','leaderboard','players','matches'];

function readStateFromURL() {
  let params;
  try { params = new URLSearchParams(location.search); } catch(e) { return; }
  const slug = params.get('tournament');
  const tid = params.get('t');                 // legacy id param (back-compat)
  const stage = params.get('stage');
  const view = params.get('view');
  const match = params.get('match');
  const page = params.get('page');

  // resolve the tournament from slug first, then fall back to the old id param
  const t = (slug && tBySlug(slug)) || (tid && tById(tid));
  if (t) state.currentTournamentId = t.id;
  if (stage && (STAGES.includes(stage) || stage === 'ALL')) state.currentStage = stage;
  if (view && VIEWS.includes(view)) state.view = view;

  // a match link implies the Matches view on the stats page
  if (match) {
    state.currentMatchId = match;
    state.view = 'matches';
    state.page = 'stats';
  } else {
    state.currentMatchId = null;
  }

  if (page === 'home') state.page = 'home';
  else if (page === 'overview') state.page = 'overview';
  else if (page === 'rules') state.page = 'rules';
  else if (page === 'staff') state.page = 'staff';
  else if (page === 'bracket') state.page = 'bracket';
  else if (page === 'mappool') state.page = 'mappool';
  else if (page === 'teams') state.page = 'teams';
  else if (page === 'matchschedule') state.page = 'matchschedule';
  else if (page === 'stats') state.page = 'stats';
  // a bare tournament link (slug/id with no explicit page) lands on the overview
  else if (t) state.page = (stage || view || match) ? 'stats' : 'overview';
  // a bare URL (no page param, no tournament, no match/stage/view) is the home
  // gallery — this makes browser Back to "/" actually show home, not leave a
  // stale inner page visible.
  else if (!match && !stage && !view) state.page = 'home';
}

// URL param for the current tournament: readable slug when available, legacy id otherwise
function setTParam(p) {
  const t = curT();
  if (!t) return;
  if (t.slug) p.set('tournament', t.slug);
  else p.set('t', t.id);
}

// Identity of the current "screen" — a change here means a real navigation
// (new history entry) rather than a minor in-page tweak (stage/view swap).
let lastNavKey = null;
function navKey() {
  return [state.page, state.currentTournamentId || '', state.currentMatchId || ''].join('|');
}

function syncURL() {
  try {
    const p = new URLSearchParams();
    if (state.page === 'overview') {
      setTParam(p);
      p.set('page', 'overview');
    } else if (state.page === 'rules') {
      setTParam(p);
      p.set('page', 'rules');
    } else if (state.page === 'staff') {
      setTParam(p);
      p.set('page', 'staff');
    } else if (state.page === 'bracket') {
      setTParam(p);
      p.set('page', 'bracket');
    } else if (state.page === 'mappool') {
      setTParam(p);
      p.set('page', 'mappool');
      p.set('stage', state.currentStage);
    } else if (state.page === 'teams') {
      setTParam(p);
      p.set('page', 'teams');
    } else if (state.page === 'matchschedule') {
      setTParam(p);
      p.set('page', 'matchschedule');
    } else if (state.page === 'stats') {
      setTParam(p);
      p.set('stage', state.currentStage);
      p.set('view', state.view);
      if (state.view === 'matches' && state.currentMatchId) p.set('match', state.currentMatchId);
    }
    // page === 'home' → bare URL (no params)
    const qs = p.toString();
    const url = location.pathname + (qs ? '?' + qs : '') + location.hash;
    const key = navKey();
    // First sync (page load) and same-screen tweaks just replace the entry;
    // moving to a different screen pushes a new one so browser Back steps back.
    if (lastNavKey !== null && key !== lastNavKey) {
      history.pushState(null, '', url);
    } else {
      history.replaceState(null, '', url);
    }
    lastNavKey = key;
  } catch(e) { /* file:// or unsupported — sharing just won't update the URL */ }
}

// Back/forward re-applies the state from the URL entry we navigated to.
window.addEventListener('popstate', () => {
  readStateFromURL();
  applyPage();
  if (state.page !== 'home') renderAll();
  lastNavKey = navKey();   // keep the nav key in sync with the restored screen
});

// ==================== HOME GALLERY ====================
function tournamentAutoMeta(t) {
  // dates string, or auto "N matches · M players"
  if (t.dates) return t.dates;
  const players = new Set();
  let matchCount = 0;
  for (const s of STAGES) {
    const sd = t.stages[s];
    if (!sd) continue;
    matchCount += (sd.matches || []).length;
    for (const m of (sd.matches || [])) for (const sess of (m.sessions || [])) for (const sc of (sess.scores || [])) if (sc.userName) players.add(sc.userName);
  }
  return matchCount ? `${matchCount} matches · ${players.size} players` : 'TBD';
}

function statusClass(status) {
  const s = (status || '').toLowerCase();
  if (s.startsWith('ongoing') || s.startsWith('live')) return 'ongoing';
  if (s.startsWith('finish') || s.startsWith('done') || s.startsWith('complete')) return 'finished';
  return 'upcoming';
}

// True only после ввода пароля. Раньше проверялась лишь видимость кнопки Admin
// (#admin в URL) — из-за этого «＋ Add Tournament» и правка команд были доступны
// любому, кто дописал #admin, без пароля.
function adminVisible() {
  return isAdminUnlocked();
}

function renderHome() {
  renderSplash();
  const g = document.getElementById('tour-gallery');
  if (!g) return;

  let html = '';
  for (const t of state.tournaments) {
    const sc = statusClass(t.status);
    const bg = t.banner
      ? `<div class="tcard-bg" style="background-image:url('${escAttr(t.banner)}')"></div>`
      : `<div class="tcard-bg fallback"></div>`;
    html += `<div class="tcard" onclick="openTournament('${escJsAttr(t.id)}')">
      ${bg}
      <div class="tcard-overlay"></div>
      <span class="tcard-status ${sc}"><span class="dot"></span>${escAttr(t.status || 'Upcoming')}</span>
      <div class="tcard-label">
        <span class="tcard-name">${escAttr(t.name)}</span>
        <span class="tcard-dates">${svgIcon('calendar')} ${escAttr(tournamentAutoMeta(t))}</span>
      </div>
      <span class="tcard-go">View →</span>
    </div>`;
  }

  if (!state.tournaments.length) {
    html += `<div class="home-empty"><b style="color:var(--text);font-size:16px;">No tournaments yet</b>
      <p style="margin-top:8px;">Open Admin (add <code>#admin</code> to the URL) to create one.</p></div>`;
  }

  if (adminVisible()) {
    html += `<div class="tcard-add" onclick="addTournament()">＋ Add Tournament</div>`;
  }

  g.innerHTML = html;
}

// ==================== TOURNAMENT OVERVIEW ====================
// Inline SVG icons (stroke = currentColor) — used instead of emoji on the public pages.
function svgIcon(name) {
  if (name === 'discord') {
    return `<svg class="svg-ico svg-discord" viewBox="0 0 127.14 96.36" fill="currentColor" aria-hidden="true"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0 105.89 105.89 0 0 0 19.39 8.09C2.79 32.65-1.71 56.6.54 80.21A105.73 105.73 0 0 0 32.71 96.36a77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53 48.84 65.69 42.45 65.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"/></svg>`;
  }
  const P = {
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    bars: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-6"/><path d="M22 20H2"/>',
    bracket: '<path d="M3 7h6"/><path d="M3 17h6"/><path d="M9 7v10"/><path d="M9 12h5"/><path d="M14 12h7"/>',
    arrow: '<path d="M5 12h14"/><path d="M13 5l7 7-7 7"/>',
    book: '<path d="M3 5a2 2 0 0 1 2-2h6v18H5a2 2 0 0 1-2-2z"/><path d="M21 5a2 2 0 0 0-2-2h-6v18h6a2 2 0 0 0 2-2z"/>',
    trophy: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/>',
    gift: '<path d="M20 12v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14"/><path d="M15 6v14"/>',
    team: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
    shield: '<path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    sheet: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/><path d="M8 9h2"/>',
  };
  const inner = P[name] || '';
  return `<svg class="svg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function renderOverview() {
  const t = curT();
  const c = document.getElementById('overview-body');
  if (!c) return;
  if (!t) { c.innerHTML = `<div class="ov-wrap">${noTournamentHTML()}</div>`; return; }

  const sc = statusClass(t.status);
  const heroBg = t.banner
    ? `<div class="ov-hero-bg" style="background-image:url('${escAttr(t.banner)}')"></div>`
    : `<div class="ov-hero-bg ov-fallback"></div>`;
  const metaBits = [];
  if (t.dates) metaBits.push(escAttr(t.dates));
  const prizePoolText = (t.prizePool || '').trim() || 'Prize Pool TBA';

  const mediaItems = [
    { ico: 'discord', label: 'Discord', url: t.discordUrl },
    { ico: 'eye', label: 'Spectator Client', url: t.spectatorUrl },
    { ico: 'play', label: 'Livestream', url: t.livestreamUrl },
    { ico: 'sheet', label: 'Main Spreadsheet', url: t.spreadsheetUrl },
  ].map(x => ({ ...x, url: safeURL(x.url) })).filter(x => x.url);
  const mediaHTML = mediaItems.length ? `<div class="ov-section">
      <h2 class="ov-h2">Media</h2>
      <div class="ov-media-grid">${mediaItems.map(x => `<a class="ov-media-card" href="${escAttr(x.url)}" target="_blank" rel="noopener">
        <span class="ov-media-icon">${svgIcon(x.ico)}</span>
        <span class="ov-media-title">${escAttr(x.label)}</span>
      </a>`).join('')}</div>
    </div>` : '';

  // General Info block (replaces the number tiles)
  const modeHasInfo = !!(t.modeInfo || '').trim();
  const ginfoRows = [
    { ico: 'users', v: t.format },
    { ico: 'bracket', v: t.elimination, wide: (t.elimination || '').length > 28 },
    { ico: 'play',  v: t.mode, clickable: !!(t.mode || '').trim(), star: modeHasInfo },
    { ico: 'gift', v: prizePoolText, wide: (prizePoolText || '').length > 28 || /\n/.test(prizePoolText) },
  ].filter(x => (x.v || '').trim())
   .map(x => {
      const classes = ['ov-ginfo-row'];
      if (x.wide) classes.push('ov-ginfo-wide');
      if (x.clickable) classes.push('is-clickable');
      const star = x.star ? '<span class="ov-ginfo-star" title="Click for details">*</span>' : '';
      const val = x.clickable
        ? `<span class="ov-ginfo-modewrap"><span class="ov-ginfo-val ov-ginfo-link" onclick="openModeInfo()">${escAttr(x.v)}</span>${star}</span>`
        : `<span class="ov-ginfo-val">${escAttr(x.v)}</span>`;
      return `<div class="${classes.join(' ')}"><span class="ov-ginfo-ico">${svgIcon(x.ico)}</span>${val}</div>`;
    }).join('');
  const ginfoHTML = ginfoRows ? `<div class="ov-section">
      <h2 class="ov-h2">General Info</h2>
      <div class="ov-ginfo">${ginfoRows}</div>
    </div>` : '';

  const hasSchedule = (t.matchSchedule || []).some(r => r && ((r.matchId || '').trim() || (r.p1 || '').trim() || (r.time || '').trim()));
  const cards = [
    { ico: 'book',   t: 'Statistics', d: 'Mappool stats, leaderboards & players', fn: 'goStats()' },
    { ico: 'trophy', t: 'Bracket', d: 'Tournament bracket', fn: 'openBracket()' },
    { ico: 'map',    t: 'Mappool', d: 'Beatmaps for each stage', fn: 'openMappool()' },
    { ico: 'users',  t: 'Teams', d: 'Rosters & players', fn: 'openTeams()' },
    hasSchedule ? { ico: 'calendar', t: 'Match Schedule', d: 'Upcoming & played matches', fn: 'openMatchSchedule()' } : null,
  ].filter(Boolean).map(x => `<div class="ov-card" onclick="${x.fn}">
      <div class="ov-card-icon">${svgIcon(x.ico)}</div>
      <div class="ov-card-body"><div class="ov-card-title">${x.t}</div><div class="ov-card-desc">${x.d}</div></div>
      <div class="ov-card-arrow">${svgIcon('arrow')}</div>
    </div>`).join('');

  // Rules block — entry point to the dedicated Rules page
  let rulesHTML = '';
  if ((t.rules && t.rules.trim()) || t.rulesUrl) {
    const teaser = t.rules && t.rules.trim()
      ? `<div class="ov-rules-text ov-rules-teaser">${escAttr(t.rules.trim())}</div>` : '';
    rulesHTML = `<div class="ov-section ov-linkable" onclick="openRules()">
      <h2 class="ov-h2 ov-h2-plain">Rules <span class="ov-h2-arrow">${svgIcon('arrow')}</span></h2>
      ${teaser}
    </div>`;
  }

  // Schedule block
  let scheduleHTML = '';
  const sched = (t.schedule || []).filter(r => (r.label || '').trim() || (r.dates || '').trim());
  if (sched.length) {
    const rows = sched.map(r => `<div class="ov-sched-row">
      <span class="ov-sched-label">${escAttr(r.label || '')}</span>
      <span class="ov-sched-dot"></span>
      <span class="ov-sched-dates">${escAttr(r.dates || '')}</span>
    </div>`).join('');
    scheduleHTML = `<div class="ov-section">
      <h2 class="ov-h2">Schedule</h2>
      <div class="ov-sched ov-sched-grid">${rows}</div>
    </div>`;
  }

  // Staff block — entry point to the dedicated Staff page (avatar preview)
  let staffHTML = '';
  const staffPeople = (t.staff || []).filter(r => (r.name || '').trim());
  if (staffPeople.length) {
    const avs = staffPeople.slice(0, 10).map(m => {
      const u = avatarURL(m);
      return `<span class="ov-staff-av" title="${escAttr(m.name || '')}" ${u ? `style="background-image:url('${escAttr(u)}')"` : ''}></span>`;
    }).join('');
    const more = staffPeople.length > 10 ? `<span class="ov-staff-more">+${staffPeople.length - 10}</span>` : '';
    staffHTML = `<div class="ov-section ov-linkable" onclick="openStaff()">
      <h2 class="ov-h2 ov-h2-plain">Staff <span class="ov-h2-arrow">${svgIcon('arrow')}</span></h2>
      <div class="ov-staff-preview">${avs}${more}</div>
    </div>`;
  }

  c.innerHTML = `
    <div class="ov-hero">
      ${heroBg}
      <div class="ov-hero-shade"></div>
      <button class="ov-hero-back" onclick="goHome()">← Tournaments</button>
      <span class="tcard-status ${sc}" style="position:absolute;top:18px;left:22px;z-index:3;"><span class="dot"></span>${escAttr(t.status || 'Upcoming')}</span>
      <div class="ov-hero-label">
        <div class="ov-hero-name">${tournamentNameHTML(t.name)}</div>
        ${metaBits.length ? `<div class="ov-hero-meta">${metaBits.join('  ·  ')}</div>` : ''}
      </div>
    </div>
    <div class="ov-wrap">
      ${t.sub ? `<p class="ov-sub">${escAttr(t.sub)}</p>` : ''}
      ${mediaHTML}
      ${ginfoHTML}
      <div class="ov-section">
        <h2 class="ov-h2">Explore</h2>
        <div class="ov-cards">${cards}</div>
      </div>
      ${scheduleHTML}
      ${staffHTML}
    </div>`;
}

function defaultModeInfo(mode) {
  const m = (mode || '').toLowerCase();
  if (m.includes('scorev2') || m.includes('score v2')) {
    return 'ScoreV2 is used as the match win condition for this tournament. This event uses a slightly modified ScoreV2 ruleset, so map results may differ from default score-only judging.';
  }
  return 'This is the tournament win condition used to decide map and match results.';
}

function openModeInfo() {
  const t = curT();
  if (!t || !(t.mode || '').trim()) return;
  const title = document.getElementById('mode-info-title');
  const body = document.getElementById('mode-info-body');
  if (title) title.textContent = t.mode;
  if (body) body.textContent = (t.modeInfo || '').trim() || defaultModeInfo(t.mode);
  document.getElementById('mode-info-modal').classList.add('show');
}

function closeModeInfo() {
  document.getElementById('mode-info-modal').classList.remove('show');
}

function handleModeInfoOverlayClick(e) {
  if (e.target === document.getElementById('mode-info-modal')) closeModeInfo();
}

// ==================== MATCH SCHEDULE PAGE ====================
function openMatchSchedule() {
  if (!curT() && state.tournaments.length) state.currentTournamentId = state.tournaments[0].id;
  state.page = 'matchschedule';
  state.currentMatchId = null;
  saveState();
  syncURL();
  applyPage();
}

function renderMatchSchedule() {
  const t = curT();
  const c = document.getElementById('matchschedule-body');
  if (!c) return;
  if (!t) { c.innerHTML = `<div class="ov-wrap">${noTournamentHTML()}</div>`; return; }

  const rows = (t.matchSchedule || []);
  let body;
  if (!rows.length) {
    body = `<div class="ms-empty">No matches scheduled yet.</div>`;
  } else {
    const groups = [];
    const gi = {};
    rows.forEach((r, idx) => {
      const stage = matchStageLabel(r);
      if (gi[stage] == null) { gi[stage] = groups.length; groups.push({ stage, rows: [] }); }
      groups[gi[stage]].rows.push({ r, idx });
    });
    const chip = (label, value, htmlValue='') => {
      const raw = String(value || '').trim();
      if (!raw && !htmlValue) return '';
      return `<span class="ms-chip"><b>${escAttr(label)}:</b> ${htmlValue || escAttr(raw)}</span>`;
    };
    const matchCard = (r, idx) => {
      const dt = splitScheduleDateTime(r.time);
      const streamURL = safeURL(r.streamLink);
      const stream = streamURL ? `<a class="ms-action" href="${escAttr(streamURL)}" target="_blank" rel="noopener">${escAttr(streamLabel(streamURL))}</a>` : '';
      const roomURL = safeURL(r.roomLink);
      const room = (r.roomId || '').trim();
      const roomHTML = room && roomURL ? `<a class="ms-action" href="${escAttr(roomURL)}" target="_blank" rel="noopener">${escAttr(room)}</a>` : escAttr(room);
      const casters = [r.streamer, r.commentator].filter(Boolean).join(' / ');
      return `<article class="ms-match" style="animation-delay:${Math.min(idx * 0.03, 0.36)}s">
        <div class="ms-match-top">
          <span class="ms-id">${escAttr((r.matchId || '').trim() || 'Match')}</span>
          <span class="ms-when">${escAttr([dt.date, dt.time].filter(Boolean).join(' · ') || 'Date TBA')}</span>
        </div>
        <div class="ms-versus">
          <div class="ms-team left">
            <span class="ms-team-role">Player 1</span>
            <span class="ms-team-name">${escAttr((r.p1 || '').trim() || 'TBD')}</span>
          </div>
          <div class="ms-scorebox">
            <span class="ms-score">${escAttr((r.score1 || '').trim() || '-')}</span>
            <span class="ms-vs">VS</span>
            <span class="ms-score">${escAttr((r.score2 || '').trim() || '-')}</span>
          </div>
          <div class="ms-team right">
            <span class="ms-team-role">Player 2</span>
            <span class="ms-team-name">${escAttr((r.p2 || '').trim() || 'TBD')}</span>
          </div>
        </div>
        <div class="ms-meta">
          ${chip('Ref', r.referee)}
          ${chip('Casters', casters)}
          ${chip('Stream', stream ? 'stream' : '', stream)}
          ${chip('Room', room, roomHTML)}
        </div>
      </article>`;
    };
    body = groups.map((g, gi) => `<section class="ms-stage-group" style="animation-delay:${Math.min(gi * 0.05, 0.3)}s">
      <div class="ms-stage-top"><h2 class="ms-stage-name">${escAttr(g.stage)}</h2></div>
      <div class="ms-grid">${g.rows.map(x => matchCard(x.r, x.idx)).join('')}</div>
    </section>`).join('');
  }

  c.innerHTML = `<div class="ov-wrap">
    <div class="ms-head">
      <button class="bracket-back" onclick="goOverview()">← Overview</button>
      <h1 class="ms-title">Match schedule</h1>
    </div>
    <div class="ms-list">${body}</div>
  </div>`;
}

// short label for a stream URL (YouTube / Twitch / Link)
function streamLabel(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('youtu')) return 'YouTube';
  if (u.includes('twitch')) return 'Twitch';
  if (u.includes('bilibili')) return 'Bilibili';
  return 'Watch';
}

function parseScheduleTime(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\D+(\d{1,2})(?::|\.|h)?(\d{2})?)?/i);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const y = Number(m[3].length === 2 ? '20' + m[3] : m[3]);
  const h = Number(m[4] || 0);
  const min = Number(m[5] || 0);
  const time = Date.UTC(y, mo, d, h, min);
  return Number.isFinite(time) ? time : null;
}

function splitScheduleDateTime(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.+?)(?:\s+(\d{1,2}(?::|\.|h)?\d{2})(?:\s*\S*)?)?$/);
  if (!m) return { date: s, time: '' };
  const date = (m[1] || '').replace(/[,|-]\s*$/, '').trim();
  const time = (m[2] || '').replace('.', ':').replace('h', ':');
  return { date, time };
}

function matchStageLabel(r) {
  const explicit = (r && r.stage || '').trim();
  if (explicit) return explicit;
  const id = String((r && r.matchId) || '').trim();
  const m = id.match(/^(RO32|RO16|QF|SF|F|GF)\b/i);
  if (m) return STAGE_NAMES[m[1].toUpperCase()] || m[1].toUpperCase();
  return 'Stage TBA';
}

// ==================== RULES PAGE ====================
function openRules() {
  if (!curT() && state.tournaments.length) state.currentTournamentId = state.tournaments[0].id;
  state.page = 'rules';
  state.currentMatchId = null;
  saveState();
  syncURL();
  applyPage();
}

function renderRules() {
  const t = curT();
  const c = document.getElementById('rules-body');
  if (!c) return;
  if (!t) { c.innerHTML = `<div class="ov-wrap">${noTournamentHTML()}</div>`; return; }
  const body = (t.rules && t.rules.trim())
    ? rulesHTML(t.rules.trim())
    : `<p class="ms-dim" style="font-size:14px;">No rules have been added yet.</p>`;
  const rurl = safeURL(t.rulesUrl);
  const link = rurl
    ? `<a class="ov-link" href="${escAttr(rurl)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:18px;">Read full rules →</a>` : '';
  c.innerHTML = `<div class="ov-wrap">
    <div class="ms-head">
      <button class="bracket-back" onclick="goOverview()">← Overview</button>
      <h1 class="ms-title">Rules</h1>
    </div>
    ${body}${link}
  </div>`;
}

function isRuleHeading(line) {
  if (!line || line.length > 54) return false;
  if (/[.!?]$/.test(line)) return false;
  if (/^\d+[\.)]/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 7) return false;
  return words.every(w => /^(and|or|of|to|the|a|an|in|on)$/i.test(w) || /^[A-Z0-9][A-Za-z0-9!/'()+-]*$/.test(w));
}

function splitRuleRow(line) {
  const colon = line.match(/^([^:]{2,32}):\s+(.+)$/);
  if (colon) return [colon[1], colon[2]];
  const dash = line.match(/^(.{2,32})\s+-\s+(.+)$/);
  if (dash) return [dash[1], dash[2]];
  return null;
}

function ruleSectionId(title, idx) {
  return 'rule-' + slugify(`${idx + 1}-${title || 'section'}`);
}

function rulesHTML(raw) {
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const sections = [];
  let cur = null;
  for (const line of lines) {
    if (isRuleHeading(line)) {
      cur = { title: line, rows: [] };
      sections.push(cur);
    } else {
      if (!cur) { cur = { title: 'Rules', rows: [] }; sections.push(cur); }
      cur.rows.push(line);
    }
  }
  if (!sections.length) return `<div class="ov-rules-text rules-page-text">${escAttr(raw)}</div>`;
  return `<div class="rules-layout">${sections.map((sec, idx) => {
    const rows = sec.rows.length
      ? sec.rows.map(line => {
          const pair = splitRuleRow(line);
          return pair
            ? `<div class="rules-row rules-row-grid"><span class="rules-row-key">${escAttr(pair[0])}</span><span class="rules-row-val">${escAttr(pair[1])}</span></div>`
            : `<div class="rules-row">${escAttr(line)}</div>`;
        }).join('')
      : `<div class="rules-row">No details added.</div>`;
    return `<section class="rules-block" id="${escAttr(ruleSectionId(sec.title, idx))}"><h2 class="rules-block-title">${escAttr(sec.title)}</h2>${rows}</section>`;
  }).join('')}</div>`;
}

// ==================== STAFF PAGE ====================
function openStaff() {
  if (!curT() && state.tournaments.length) state.currentTournamentId = state.tournaments[0].id;
  state.page = 'staff';
  state.currentMatchId = null;
  saveState();
  syncURL();
  applyPage();
}

// Group staff entries by role, preserving first-seen order.
function staffGroups(t) {
  const staff = (t.staff || []).filter(r => (r.name || '').trim() || (r.role || '').trim());
  const groups = []; const gi = {};
  for (const m of staff) {
    const role = (m.role || 'Staff').trim() || 'Staff';
    if (gi[role] == null) { gi[role] = groups.length; groups.push({ role, people: [] }); }
    groups[gi[role]].people.push(m);
  }
  return groups;
}

function staffPersonHTML(m, role, delay=0) {
  const u = avatarURL(m);
  const av = `<span class="ov-staff-av" ${u ? `style="background-image:url('${escAttr(u)}')"` : ''}></span>`;
  const disc = (m.discord || '').trim() ? `<span class="ov-staff-pdiscord">${escAttr(m.discord.trim())}</span>` : '';
  const inner = `${av}<span class="ov-staff-ptext"><span class="ov-staff-pname">${escAttr(m.name || '')}</span>${disc}</span>`;
  const prof = profileURL(m);
  const st = ` style="animation-delay:${delay}s"`;
  return prof
    ? `<a class="ov-staff-person"${st} href="${escAttr(prof)}" target="_blank" rel="noopener">${inner}</a>`
    : `<div class="ov-staff-person"${st}>${inner}</div>`;
}

function renderStaff() {
  const t = curT();
  const c = document.getElementById('staff-body');
  if (!c) return;
  if (!t) { c.innerHTML = `<div class="ov-wrap">${noTournamentHTML()}</div>`; return; }
  const groups = staffGroups(t);
  const inner = groups.length
    ? `<div class="ov-staff">${groups.map((g, gi) => `<div class="ov-staff-group" style="animation-delay:${Math.min(gi * 0.06, 0.3)}s">
        <h3 class="ov-staff-role">${escAttr(g.role)}</h3>
        <div class="ov-staff-people">${g.people.map((m, pi) => staffPersonHTML(m, g.role, Math.min((gi * 0.06) + (pi * 0.025), 0.45))).join('')}</div>
      </div>`).join('')}</div>`
    : `<p class="ms-dim" style="font-size:14px;">No staff have been added yet.</p>`;
  c.innerHTML = `<div class="ov-wrap">
    <div class="ms-head">
      <button class="bracket-back" onclick="goOverview()">← Overview</button>
      <h1 class="ms-title">Staff</h1>
    </div>
    ${inner}
  </div>`;
}

// ==================== STAGE TABS ====================
// Stage helpers: the active stage may be a real stage or the "ALL" aggregate.
function visibleStagesOf(t) { return STAGES.filter(s => !t.hiddenStages[s]); }
function currentStageList(t) { return state.currentStage === 'ALL' ? visibleStagesOf(t) : [state.currentStage]; }
// Flattened maps across the active stage(s), each carrying its own stage + stage-data
// so slot lookups (getSlot) and covers stay correct when aggregating "All Stages".
function collectStageMaps(t) {
  const out = [];
  for (const stage of currentStageList(t)) {
    const sd = getStageData(t, stage);
    for (const { key, info } of getOrderedMaps(t, stage)) out.push({ stage, sd, key, info });
  }
  return out;
}

function buildStageTabs() {
  const bar = document.getElementById('stage-bar');
  const t = curT();
  if (!t) { bar.innerHTML = ''; return; }
  const visible = visibleStagesOf(t);
  if (state.currentStage !== 'ALL' && t.hiddenStages[state.currentStage] && visible.length) state.currentStage = visible[0];
  const tabs = visible.map(s =>
    `<div class="stage-tab ${s===state.currentStage?'active':''}" onclick="selectStage('${s}')">${s}</div>`
  ).join('');
  const allTab = visible.length > 1
    ? `<div class="stage-tab stage-tab-all ${state.currentStage==='ALL'?'active':''}" onclick="selectStage('ALL')">All</div><span class="stage-bar-div"></span>` : '';
  bar.innerHTML = allTab + tabs;
}

function buildAdminStagePills() {
  const c = document.getElementById('admin-stage-pills');
  c.innerHTML = STAGES.map(s =>
    `<div class="stage-pill ${s===state.adminStage?'active':''}" onclick="selectAdminStage('${s}')">${s}</div>`
  ).join('');
}

function buildAdminStageVisibility() {
  const c = document.getElementById('admin-stage-visibility');
  if (!c) return;
  const t = admT();
  const hidden = t ? t.hiddenStages : {};
  c.innerHTML = STAGES.map(s => {
    const on = !hidden[s];
    return `<div class="stage-pill ${on?'vis-on':'vis-off'}" onclick="toggleStageVisibility('${s}')">${on?'👁':'🚫'} ${s}</div>`;
  }).join('');
}

function toggleStageVisibility(s) {
  const t = admT();
  if (!t) return;
  if (t.hiddenStages[s]) delete t.hiddenStages[s];
  else t.hiddenStages[s] = true;
  saveState();
  buildAdminStageVisibility();
  buildStageTabs();
  renderAll();
}

function selectStage(s) {
  state.currentStage = s;
  state.currentMatchId = null;
  saveState();
  syncURL();
  buildStageTabs();
  renderAll();
  if (state.view === 'matches') renderMatchesTab();
}

function selectAdminStage(s) {
  state.adminStage = s;
  saveState();
  buildAdminStagePills();
  renderAdminMatchList();
  renderAdminMapOrder();
}

function switchView(v) {
  state.view = v;
  document.getElementById('vt-mappool').classList.toggle('active', v==='mappool');
  document.getElementById('vt-leaderboard').classList.toggle('active', v==='leaderboard');
  document.getElementById('vt-players').classList.toggle('active', v==='players');
  document.getElementById('vt-matches').classList.toggle('active', v==='matches');
  document.getElementById('panel-mappool').classList.toggle('show', v==='mappool');
  document.getElementById('panel-leaderboard').classList.toggle('show', v==='leaderboard');
  document.getElementById('panel-players').classList.toggle('show', v==='players');
  document.getElementById('panel-matches').classList.toggle('show', v==='matches');
  if (v==='mappool') renderMappoolStats();
  else if (v==='leaderboard') renderLeaderboard();
  else if (v==='players') renderPlayersTab();
  else if (v==='matches') renderMatchesTab();
  // keep the active tab fully visible when the tab bar scrolls horizontally (mobile)
  const at = document.getElementById('vt-' + v);
  if (at && at.scrollIntoView) at.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncURL();
}

// ==================== TOURNAMENT CRUD (admin) ====================
function renderAdminTournaments() {
  const c = document.getElementById('adm-tour-list');
  if (!c) return;
  c.innerHTML = state.tournaments.map(t => `
    <div class="adm-tour-item ${t.id===state.adminTournamentId?'active':''}" onclick="selectAdminTournament('${escJsAttr(t.id)}')">
      <div style="flex:1;min-width:0;">
        <div class="adm-tour-name">${escAttr(t.name)}</div>
        <div class="adm-tour-badge">${escAttr(t.status||'')}</div>
      </div>
      <button class="adm-tour-open" onclick="event.stopPropagation();openTournament('${escJsAttr(t.id)}')">Open ↗</button>
    </div>`).join('');
  const chip = document.getElementById('adm-editing-chip');
  const mediaChip = document.getElementById('adm-media-chip');
  const t = admT();
  if (chip) chip.textContent = t ? t.name : '—';
  if (mediaChip) mediaChip.textContent = t ? t.name : '-';
}

function selectAdminTournament(id) {
  if (!tById(id)) return;
  state.adminTournamentId = id;
  saveState();
  renderAdminTournaments();
  fillTournamentInfoFields();
  buildAdminStageVisibility();
  renderAdminMatchList();
  renderAdminMapOrder();
  fillChallongeField();
}

function addTournament() {
  const t = newTournament('New Tournament', { status: 'Upcoming' });
  state.tournaments.push(t);
  ensureSlug(t);
  state.adminTournamentId = t.id;
  saveState();
  renderAdminTournaments();
  fillTournamentInfoFields();
  buildAdminStageVisibility();
  renderAdminMatchList();
  renderAdminMapOrder();
  fillChallongeField();
  if (state.page === 'home') renderHome();
}

function deleteTournament() {
  const t = admT();
  if (!t) return;
  if (!confirm(`Delete tournament "${String(t.name || '')}"? This removes all its stages and data.`)) return;
  state.tournaments = state.tournaments.filter(x => x.id !== t.id);
  if (!state.tournaments.length) ensureSeed();
  // fix selections
  if (!tById(state.adminTournamentId)) state.adminTournamentId = state.tournaments[0].id;
  if (!tById(state.currentTournamentId)) state.currentTournamentId = state.tournaments[0].id;
  saveState();
  renderAdminTournaments();
  fillTournamentInfoFields();
  buildAdminStageVisibility();
  renderAdminMatchList();
  renderAdminMapOrder();
  fillChallongeField();
  if (state.page === 'home') renderHome();
  else if (state.page === 'stats') { buildStageTabs(); updateStatsHeader(); renderAll(); }
}

function fillTournamentInfoFields() {
  const t = admT() || {};
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  setVal('meta-name', t.name);
  setVal('meta-sub', t.sub);
  setVal('meta-format', t.format);
  setVal('meta-mode', t.mode);
  setVal('meta-mode-info', t.modeInfo);
  setVal('meta-prize', t.prizePool);
  setVal('meta-elim', t.elimination);
  setVal('meta-status', t.status);
  setVal('meta-dates', t.dates);
  setVal('meta-rules', t.rules);
  setVal('meta-rules-url', t.rulesUrl);
  setVal('meta-discord-url', t.discordUrl);
  setVal('meta-spectator-url', t.spectatorUrl);
  setVal('meta-livestream-url', t.livestreamUrl);
  setVal('meta-spreadsheet-url', t.spreadsheetUrl);
  renderScheduleEditor();
  renderStaffEditor();
  renderMsEditor();
  renderAliasEditor();
  fillBracketFields();
  // banner preview
  const bp = document.getElementById('banner-preview');
  if (bp) {
    if (t.banner) { bp.style.backgroundImage = `url('${t.banner}')`; bp.classList.add('show'); }
    else { bp.style.backgroundImage = ''; bp.classList.remove('show'); }
  }
}

function saveTournamentInfo() {
  const t = admT();
  if (!t) return;
  const newName = document.getElementById('meta-name').value.trim() || 'Untitled Tournament';
  const nameChanged = newName !== t.name;
  t.name = newName;
  // keep the URL slug in sync with the name (regenerated on rename)
  if (nameChanged) { t.slug = ''; ensureSlug(t); }
  t.sub = document.getElementById('meta-sub').value.trim();
  t.format = document.getElementById('meta-format').value.trim() || 'Team VS';
  t.mode = document.getElementById('meta-mode').value.trim();
  t.modeInfo = document.getElementById('meta-mode-info').value.trim();
  t.prizePool = document.getElementById('meta-prize').value.trim();
  t.elimination = document.getElementById('meta-elim').value.trim();
  t.status = document.getElementById('meta-status').value.trim() || 'Upcoming';
  t.dates = document.getElementById('meta-dates').value.trim();
  t.rules = document.getElementById('meta-rules').value.trim();
  t.rulesUrl = document.getElementById('meta-rules-url').value.trim();
  t.discordUrl = document.getElementById('meta-discord-url').value.trim();
  t.spectatorUrl = document.getElementById('meta-spectator-url').value.trim();
  t.livestreamUrl = document.getElementById('meta-livestream-url').value.trim();
  t.spreadsheetUrl = document.getElementById('meta-spreadsheet-url').value.trim();
  t.schedule = readScheduleRows();
  t.staff = readStaffRows();
  if (document.getElementById('meta-ms-rows')) t.matchSchedule = readMsRows();
  if (document.getElementById('meta-alias-rows')) t.aliases = readAliasRows();
  const ok = saveState();
  const msg = document.getElementById('meta-status-msg');
  if (msg) { msg.textContent = ok ? 'Saved.' : ''; msg.className = 'fetch-status ok'; }
  renderAdminTournaments();
  if (state.page === 'home') renderHome();
  else if (state.page === 'stats') updateStatsHeader();
  else if (state.page === 'overview') renderOverview();
  else if (state.page === 'matchschedule') renderMatchSchedule();
  else if (state.page === 'rules') renderRules();
  else if (state.page === 'staff') renderStaff();
}

// ---- schedule rows editor (admin) ----
function renderScheduleEditor() {
  const c = document.getElementById('meta-schedule-rows');
  if (!c) return;
  const t = admT();
  const rows = (t && t.schedule) ? t.schedule : [];
  c.innerHTML = rows.map((r, i) => `
    <div class="sched-edit-row" data-i="${i}">
      <input class="sched-e-label" placeholder="Stage / phase" value="${escAttr(r.label || '')}">
      <input class="sched-e-dates" placeholder="29/05 – 15/06/2026" value="${escAttr(r.dates || '')}">
      <button class="sched-e-del" onclick="removeScheduleRow(${i})" title="Remove">✕</button>
    </div>`).join('');
}

function readScheduleRows(keepEmpty) {
  return [...document.querySelectorAll('#meta-schedule-rows .sched-edit-row')].map(r => ({
    label: r.querySelector('.sched-e-label').value.trim(),
    dates: r.querySelector('.sched-e-dates').value.trim()
  })).filter(r => keepEmpty || r.label || r.dates);
}

function addScheduleRow() {
  const t = admT();
  if (!t) return;
  t.schedule = readScheduleRows(true);
  t.schedule.push({ label: '', dates: '' });
  renderScheduleEditor();
}

function removeScheduleRow(i) {
  const t = admT();
  if (!t) return;
  t.schedule = readScheduleRows(true);
  t.schedule.splice(i, 1);
  renderScheduleEditor();
}

// ---- name-alias editor (admin) — merge a player's alt nicks into one canonical profile ----
// Stored as t.aliases = { 'oldnicklower': 'CanonicalNick' }. Editor shows one row per pair.
function renderAliasEditor() {
  const c = document.getElementById('meta-alias-rows');
  if (!c) return;
  const t = admT();
  const entries = (t && t.aliases) ? Object.entries(t.aliases) : [];
  c.innerHTML = entries.map(([from, to], i) => `
    <div class="alias-edit-row" data-i="${i}">
      <input class="alias-e-from" placeholder="Old / alt nick" value="${escAttr(from)}">
      <span class="alias-e-arrow">→</span>
      <input class="alias-e-to" placeholder="Canonical nick" value="${escAttr(to)}">
      <button class="sched-e-del" onclick="removeAliasRow(${i})" title="Remove">✕</button>
    </div>`).join('');
}

function readAliasRows(keepEmpty) {
  const rows = [...document.querySelectorAll('#meta-alias-rows .alias-edit-row')].map(r => ({
    from: r.querySelector('.alias-e-from').value.trim(),
    to: r.querySelector('.alias-e-to').value.trim()
  }));
  if (keepEmpty) return rows;
  // Build the { fromLower: canonical } map, skipping incomplete or self-referential rows.
  const map = {};
  for (const { from, to } of rows) {
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
    map[from.toLowerCase()] = to;
  }
  return map;
}

// Re-render the editor from the current DOM rows plus one blank/removed row.
function aliasRowsToArray() {
  return [...document.querySelectorAll('#meta-alias-rows .alias-edit-row')].map(r => ({
    from: r.querySelector('.alias-e-from').value,
    to: r.querySelector('.alias-e-to').value
  }));
}
function renderAliasRowsFrom(arr) {
  const c = document.getElementById('meta-alias-rows');
  if (!c) return;
  c.innerHTML = arr.map(({ from, to }, i) => `
    <div class="alias-edit-row" data-i="${i}">
      <input class="alias-e-from" placeholder="Old / alt nick" value="${escAttr(from || '')}">
      <span class="alias-e-arrow">→</span>
      <input class="alias-e-to" placeholder="Canonical nick" value="${escAttr(to || '')}">
      <button class="sched-e-del" onclick="removeAliasRow(${i})" title="Remove">✕</button>
    </div>`).join('');
}
function addAliasRow() {
  const arr = aliasRowsToArray();
  arr.push({ from: '', to: '' });
  renderAliasRowsFrom(arr);
}
function removeAliasRow(i) {
  const arr = aliasRowsToArray();
  arr.splice(i, 1);
  renderAliasRowsFrom(arr);
}

// ---- staff editor (admin) — one person per row, avatar from osudroid player ID ----
function renderStaffEditor() {
  const c = document.getElementById('meta-staff-rows');
  if (!c) return;
  const t = admT();
  const rows = (t && t.staff) ? t.staff : [];
  c.innerHTML = rows.map((r, i) => {
    const u = avatarURL(r);
    const prev = u ? `style="background-image:url('${escAttr(u)}')"` : '';
    return `
    <div class="staff-edit-row" data-i="${i}">
      <div class="tp-e-prev staff-e-prev" ${prev}></div>
      <input class="staff-e-role" placeholder="Role (e.g. Host)" value="${escAttr(r.role || '')}">
      <input class="staff-e-name" placeholder="Name" value="${escAttr(r.name || '')}">
      <input class="staff-e-uid" placeholder="player ID" value="${escAttr(r.uid || '')}" oninput="onStaffUid(${i})">
      <input class="staff-e-discord" placeholder="Discord (optional)" value="${escAttr(r.discord || '')}">
      <input class="staff-e-avatar" placeholder="Avatar URL (override, optional)" value="${escAttr(r.avatar || '')}">
      <button class="sched-e-del" onclick="removeStaffRow(${i})" title="Remove">✕</button>
    </div>`;
  }).join('');
}

// Live avatar preview as the staff player ID / override is typed.
function onStaffUid(i) {
  const row = document.querySelector(`#meta-staff-rows .staff-edit-row[data-i="${i}"]`);
  if (!row) return;
  const uid = row.querySelector('.staff-e-uid').value.trim();
  const ovr = row.querySelector('.staff-e-avatar').value.trim();
  const url = ovr || (/^\d+$/.test(uid) ? `https://osudroid.moe/user/avatar/${uid}.png` : '');
  row.querySelector('.staff-e-prev').style.backgroundImage = url ? `url('${url}')` : '';
}

function readStaffRows(keepEmpty) {
  return [...document.querySelectorAll('#meta-staff-rows .staff-edit-row')].map(r => ({
    role: r.querySelector('.staff-e-role').value.trim(),
    name: r.querySelector('.staff-e-name').value.trim(),
    uid: r.querySelector('.staff-e-uid').value.trim(),
    discord: r.querySelector('.staff-e-discord').value.trim(),
    avatar: r.querySelector('.staff-e-avatar').value.trim()
  })).filter(r => keepEmpty || r.role || r.name || r.uid);
}

function addStaffRow() {
  const t = admT();
  if (!t) return;
  t.staff = readStaffRows(true);
  t.staff.push({ role: '', name: '', uid: '', discord: '', avatar: '' });
  renderStaffEditor();
}

function removeStaffRow(i) {
  const t = admT();
  if (!t) return;
  t.staff = readStaffRows(true);
  t.staff.splice(i, 1);
  renderStaffEditor();
}

// ---- match schedule editor (admin) ----
const MS_FIELDS = [
  { k: 'stage', ph: 'Stage (RO16 / QF / Semifinals)' }, { k: 'matchId', ph: 'Match ID' }, { k: 'roomId', ph: 'Room ID' }, { k: 'roomLink', ph: 'Room link (optional)' },
  { k: 'time', ph: 'Time (DD/MM/YYYY, UTC)' },
  { k: 'p1', ph: 'Player 1' }, { k: 'score1', ph: 'Score 1' }, { k: 'score2', ph: 'Score 2' }, { k: 'p2', ph: 'Player 2' },
  { k: 'referee', ph: 'Referee' }, { k: 'streamer', ph: 'Streamer' }, { k: 'commentator', ph: 'Commentator' },
  { k: 'streamLink', ph: 'Stream link (optional)' }
];
function renderMsEditor() {
  const c = document.getElementById('meta-ms-rows');
  if (!c) return;
  const t = admT();
  const rows = (t && t.matchSchedule) ? t.matchSchedule : [];
  c.innerHTML = rows.map((r, i) => `
    <div class="ms-edit-row" data-i="${i}">
      ${MS_FIELDS.map(f => `<input class="ms-e-${f.k}" placeholder="${f.ph}" value="${escAttr(r[f.k] || '')}">`).join('')}
      <button class="sched-e-del" onclick="removeMsRow(${i})" title="Remove">✕</button>
    </div>`).join('');
}

function readMsRows(keepEmpty) {
  return [...document.querySelectorAll('#meta-ms-rows .ms-edit-row')].map(row => {
    const o = {};
    MS_FIELDS.forEach(f => { o[f.k] = row.querySelector('.ms-e-' + f.k).value.trim(); });
    return o;
  }).filter(o => keepEmpty || MS_FIELDS.some(f => o[f.k]));
}

function addMsRow() {
  const t = admT();
  if (!t) return;
  t.matchSchedule = readMsRows(true);
  t.matchSchedule.push({});
  renderMsEditor();
}

function removeMsRow(i) {
  const t = admT();
  if (!t) return;
  t.matchSchedule = readMsRows(true);
  t.matchSchedule.splice(i, 1);
  renderMsEditor();
}

// ==================== IMAGE UPLOAD ====================
// Read an image file, downscale it via canvas, and return a compact data URL.
// mime 'image/png' preserves transparency (use for logos); 'image/jpeg' is smaller (banners).
function loadImageDownscaled(file, maxW, maxH, cb, mime, quality) {
  if (!file) return;
  mime = mime || 'image/jpeg';
  quality = quality == null ? 0.85 : quality;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxW / width, maxH / height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      let out;
      try { out = canvas.toDataURL(mime, quality); }
      catch(e) { out = reader.result; } // fallback to original (e.g. SVG)
      cb(out);
    };
    img.onerror = () => cb(reader.result);
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function onLogoFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  // PNG keeps transparency so the logo sits cleanly on the dark topbar
  loadImageDownscaled(file, 320, 120, (dataUrl) => {
    state.logo = dataUrl;
    if (saveState()) {
      renderBrand();
      renderSplash();
      const p = document.getElementById('logo-preview');
      if (p) { p.src = dataUrl; p.classList.add('show'); }
    }
  }, 'image/png');
  input.value = '';
}

function removeLogo() {
  state.logo = '';
  saveState();
  renderBrand();
  renderSplash();
  const p = document.getElementById('logo-preview');
  if (p) { p.src = ''; p.classList.remove('show'); }
}

function onSplashBgFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  loadImageDownscaled(file, 1600, 900, (dataUrl) => {
    state.splashBg = dataUrl;
    if (saveState()) {
      renderSplash();
      const p = document.getElementById('splashbg-preview');
      if (p) { p.style.backgroundImage = `url('${dataUrl}')`; p.classList.add('show'); }
    }
  });
  input.value = '';
}

function removeSplashBg() {
  state.splashBg = '';
  saveState();
  renderSplash();
  const p = document.getElementById('splashbg-preview');
  if (p) { p.style.backgroundImage = ''; p.classList.remove('show'); }
}

function onBannerFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const t = admT();
  if (!t) return;
  loadImageDownscaled(file, 1200, 600, (dataUrl) => {
    t.banner = dataUrl;
    if (saveState()) {
      const bp = document.getElementById('banner-preview');
      if (bp) { bp.style.backgroundImage = `url('${dataUrl}')`; bp.classList.add('show'); }
      if (state.page === 'home') renderHome();
    }
  });
  input.value = '';
}

function removeBanner() {
  const t = admT();
  if (!t) return;
  t.banner = '';
  saveState();
  const bp = document.getElementById('banner-preview');
  if (bp) { bp.style.backgroundImage = ''; bp.classList.remove('show'); }
  if (state.page === 'home') renderHome();
}

// ==================== ADMIN: MATCHES ====================
function handleOverlayClick(e) {
  if (e.target === document.getElementById('admin-overlay')) toggleAdmin();
}

async function addMatch() {
  const raw = document.getElementById('add-match-input').value.trim();
  const st = document.getElementById('fetch-status');
  const t = admT();
  if (!t) { st.textContent = 'Select a tournament first.'; st.className = 'fetch-status err'; return; }
  if (!raw) { st.textContent = 'Enter a URL or ID.'; st.className = 'fetch-status err'; return; }

  const mid = raw.match(/[?&]id=(\d+)/)?.[1] || raw.match(/^(\d+)$/)?.[1];
  if (!mid) { st.textContent = 'Could not find match ID.'; st.className = 'fetch-status err'; return; }

  st.textContent = 'Loading...'; st.className = 'fetch-status';

  try {
    const resp = await fetch(`https://osudroid.kansenindex.dev/api/tournament/getrooms_history?id=${mid}`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();

    const sd = getStageData(t, state.adminStage);

    if (sd.matches.find(m => m.id === mid)) {
      st.textContent = 'Match already added.'; st.className = 'fetch-status err'; return;
    }

    sd.matches.push({ id: mid, name: data.name || 'Match #' + mid, sessions: data.sessions || [] });

    for (const sess of data.sessions || []) {
      const key = sessKey(sess);
      if (!sd.mapOrder.includes(key)) sd.mapOrder.push(key);
    }

    saveState();
    document.getElementById('add-match-input').value = '';
    st.textContent = `Added: ${data.name || 'Match #'+mid} (${(data.sessions||[]).length} maps)`; st.className = 'fetch-status ok';
    renderAdminMatchList();
    renderAdminMapOrder();
    renderAll();
    if (state.page === 'home') renderHome();
  } catch(e) {
    st.textContent = 'Error: ' + e.message; st.className = 'fetch-status err';
  }
}

function removeMatch(mid) {
  const t = admT();
  if (!t) return;
  const sd = getStageData(t, state.adminStage);
  sd.matches = sd.matches.filter(m => m.id !== mid);
  const allKeys = new Set();
  for (const m of sd.matches) for (const s of m.sessions) allKeys.add(sessKey(s));
  sd.mapOrder = sd.mapOrder.filter(k => allKeys.has(k) || k.startsWith('EMPTY:'));
  for (const k of allKeys) if (!sd.mapOrder.includes(k)) sd.mapOrder.push(k);
  saveState();
  renderAdminMatchList();
  renderAdminMapOrder();
  renderAll();
}

function clearStage() {
  const t = admT();
  if (!t) return;
  if (!confirm(`Clear all data for ${state.adminStage} in "${String(t.name || '')}"?`)) return;
  t.stages[state.adminStage] = { matches: [], mapOrder: [], slotOverrides: {}, manualScores: [], mapMeta: {} };
  saveState();
  renderAdminMatchList();
  renderAdminMapOrder();
  renderAll();
}

function renderAdminMatchList() {
  const t = admT();
  const c = document.getElementById('match-list');
  if (!t) { c.innerHTML = '<div style="font-size:12px;color:var(--muted);">No tournament selected.</div>'; return; }
  const sd = getStageData(t, state.adminStage);
  if (!sd.matches.length) { c.innerHTML = '<div style="font-size:12px;color:var(--muted);">No matches yet.</div>'; return; }
  c.innerHTML = sd.matches.map(m => `
    <div class="match-item" draggable="true" data-mid="${escAttr(m.id)}"
        ondragstart="matchDragStart(event)" ondragover="matchDragOver(event)" ondrop="matchDragDrop(event)" ondragend="matchDragEnd(event)">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="match-info">
        <div class="match-name">${escAttr(m.name)}</div>
        <div class="match-id">ID: ${m.id} · ${m.sessions.length} maps</div>
      </div>
      <button class="match-del" onclick="renameMatch('${m.id}')" title="Rename" style="color:var(--accent);">✎</button>
      <button class="match-del" onclick="removeMatch('${m.id}')" title="Remove">✕</button>
    </div>`).join('');
}

// ---- match reordering (drag & drop in admin; order is reflected in the public Matches list) ----
let matchDragSrc = null;
function matchDragStart(e) { matchDragSrc = e.currentTarget.dataset.mid; e.currentTarget.classList.add('dragging'); }
function matchDragEnd(e) { e.currentTarget.classList.remove('dragging'); document.querySelectorAll('#match-list .match-item').forEach(el => el.classList.remove('drag-over')); }
function matchDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function matchDragDrop(e) {
  e.preventDefault();
  const target = e.currentTarget.dataset.mid;
  if (!matchDragSrc || matchDragSrc === target) return;
  const t = admT();
  if (!t) return;
  const sd = getStageData(t, state.adminStage);
  const from = sd.matches.findIndex(m => m.id === matchDragSrc);
  const to = sd.matches.findIndex(m => m.id === target);
  if (from < 0 || to < 0) return;
  const [moved] = sd.matches.splice(from, 1);
  sd.matches.splice(to, 0, moved);
  saveState();
  renderAdminMatchList();
  renderAll();
}

function renameMatch(mid) {
  const t = admT();
  if (!t) return;
  const sd = getStageData(t, state.adminStage);
  const m = sd.matches.find(x => x.id === mid);
  if (!m) return;
  const name = prompt('Match name:', m.name);
  if (name === null) return;
  m.name = name.trim() || m.name;
  m.customName = true;
  saveState();
  renderAdminMatchList();
  renderAll();
}

// ==================== MAP ORDER ====================
let dragSrc = null;
function sessKey(sess) { return sess.mapName; }

function getSlot(sd, key, mapName) {
  if (sd.slotOverrides[key]) return sd.slotOverrides[key];
  // Only treat a bracketed token as a slot if it's a real slot code (NM1, HD2, …),
  // NOT a difficulty name like [REI], [ONI], [Insane]. Unknown → null (shows "??").
  const brackets = mapName.match(/\[([^\]]+)\]/g) || [];
  for (const br of brackets) {
    const inner = br.slice(1, -1).trim();
    if (/^(NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*$/i.test(inner)) return inner.toUpperCase();
  }
  return null;
}

function renderAdminMapOrder() {
  const t = admT();
  const c = document.getElementById('map-order-list');
  if (!t) { c.innerHTML = '<div style="font-size:12px;color:var(--muted);">No tournament selected.</div>'; renderManualScoreEditor(); renderMappoolAdmin(); return; }
  const sd = getStageData(t, state.adminStage);
  if (!sd.mapOrder.length) { c.innerHTML = '<div style="font-size:12px;color:var(--muted);">No maps yet.</div>'; renderManualScoreEditor(); renderMappoolAdmin(); return; }

  const sessMap = buildSessMap(t, state.adminStage);

  c.innerHTML = sd.mapOrder.map((key, i) => {
    const isEmpty = key.startsWith('EMPTY:');
    const info = isEmpty ? null : sessMap[key];
    const rawName = isEmpty ? '(Not played)' : (info ? info.mapName : key);
    const slot = isEmpty ? sd.slotOverrides[key] : (info ? getSlot(sd, key, rawName) : null);
    const displayName = isEmpty ? '(Not played)' : rawName.replace(/\[(?:NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*\]\s*/i, '').trim();
    const sc = slotClass(slot);
    const ke = escAttr(key);
    return `<div class="map-order-item" draggable="true" data-key="${ke}" data-idx="${i}"
        ondragstart="dragStart(event)" ondragover="dragOver(event)" ondrop="dragDrop(event)" ondragend="dragEnd(event)">
      <span class="drag-handle">⠿</span>
      <span class="slot-badge ${sc} map-order-slot" style="cursor:pointer"
        data-key="${ke}" data-name="${escAttr(rawName)}" onclick="openSlotModalFromEl(this)">${slot||'??'}</span>
      <span class="map-order-name" title="${escAttr(rawName)}" style="${isEmpty?'font-style:italic;':''}">${escAttr(displayName)}</span>
      <button class="slot-edit-btn" data-key="${ke}" data-name="${escAttr(rawName)}" onclick="openSlotModalFromEl(this)">Slot</button>
      <button class="slot-edit-btn" style="color:#ef5350;border-color:#ef535044;" data-key="${ke}" onclick="removeMapFromEl(this)">✕</button>
    </div>`;
  }).join('');
  renderManualScoreEditor();
  renderMappoolAdmin();
}

function openSlotModalFromEl(el) { openSlotModal(el.dataset.key, el.dataset.name); }
function removeMapFromEl(el) { removeMap(el.dataset.key); }

// ==================== MANUAL SCORES ====================
function renderManualScoreEditor() {
  const t = admT();
  const mapSel = document.getElementById('ms-map');
  const matchSel = document.getElementById('ms-match');
  const list = document.getElementById('ms-list');
  if (!mapSel || !matchSel || !list) return;
  if (!t) { mapSel.innerHTML = ''; matchSel.innerHTML = ''; list.innerHTML = ''; return; }

  const sd = getStageData(t, state.adminStage);
  const maps = getOrderedMaps(t, state.adminStage).filter(({info}) => !info._empty);

  mapSel.innerHTML = maps.length
    ? maps.map(({key, info}) => {
        const slot = getSlot(sd, key, info.mapName) || '??';
        const dn = info.mapName.replace(/\[(?:NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*\]\s*/i,'').trim();
        return `<option value="${escAttr(key)}">${escAttr(slot)} — ${escAttr(dn)}</option>`;
      }).join('')
    : `<option value="">No played maps in this stage</option>`;

  matchSel.innerHTML = `<option value="">Match: Manual</option>` +
    sd.matches.map(m => { const n = cleanMatchName(m.name, m); return `<option value="${escAttr(n)}">Match: ${escAttr(n)}</option>`; }).join('');

  const items = sd.manualScores || [];
  list.innerHTML = items.length
    ? items.map(ms => {
        const dn = ms.key.replace(/\[(?:NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*\]\s*/i,'').trim();
        const mline = `${escAttr(dn)} · ${(ms.accuracy*100).toFixed(2)}% · ${escAttr((ms.mods||[]).join(' ')||'NM')}${ms.match?(' · '+escAttr(ms.match)):''}`;
        return `<div class="match-item">
          <div class="match-info">
            <div class="match-name">${escAttr(ms.userName)} · ${Number(ms.score).toLocaleString()}</div>
            <div class="match-id">${mline}</div>
          </div>
          <button class="match-del" onclick="removeManualScore('${escJsAttr(ms.id)}')" title="Remove">✕</button>
        </div>`;
      }).join('')
    : '<div style="font-size:12px;color:var(--muted);">No manual scores yet.</div>';
}

function addManualScore() {
  const t = admT();
  const st = document.getElementById('ms-status');
  if (!t) { st.textContent = 'Select a tournament first.'; st.className = 'fetch-status err'; return; }
  const sd = getStageData(t, state.adminStage);
  const key = document.getElementById('ms-map').value;
  const userName = document.getElementById('ms-player').value.trim();
  const scoreRaw = document.getElementById('ms-score').value.trim().replace(/[,\s]/g,'');
  const accRaw = document.getElementById('ms-acc').value.trim();
  const modsRaw = document.getElementById('ms-mods').value.trim();
  const matchLbl = document.getElementById('ms-match').value;

  if (!key) { st.textContent = 'No map selected — add the match for this stage first.'; st.className = 'fetch-status err'; return; }
  if (!userName) { st.textContent = 'Enter a player name.'; st.className = 'fetch-status err'; return; }
  const score = parseInt(scoreRaw, 10);
  if (!Number.isFinite(score) || score < 0) { st.textContent = 'Enter a valid score.'; st.className = 'fetch-status err'; return; }
  let acc = parseFloat(accRaw.replace('%','').replace(',','.'));
  if (!Number.isFinite(acc)) acc = 0;
  acc = Math.max(0, Math.min(100, acc)) / 100;
  const mods = modsRaw ? modsRaw.toUpperCase().split(/[\s,]+/).filter(Boolean) : [];

  sd.manualScores = sd.manualScores || [];
  sd.manualScores.push({
    id: 'ms' + Date.now() + Math.floor(Math.random()*1000),
    key, userName, score, accuracy: acc, mods, match: matchLbl
  });
  saveState();
  document.getElementById('ms-player').value = '';
  document.getElementById('ms-score').value = '';
  document.getElementById('ms-acc').value = '';
  document.getElementById('ms-mods').value = '';
  st.textContent = `Added ${userName} (${score.toLocaleString()}).`; st.className = 'fetch-status ok';
  renderManualScoreEditor();
  renderAll();
  if (state.page === 'home') renderHome();
}

function removeManualScore(id) {
  const t = admT();
  if (!t) return;
  const sd = getStageData(t, state.adminStage);
  sd.manualScores = (sd.manualScores || []).filter(ms => ms.id !== id);
  saveState();
  renderManualScoreEditor();
  renderAll();
}

function dragStart(e) { dragSrc = e.currentTarget.dataset.key; e.currentTarget.classList.add('dragging'); }
function dragEnd(e) { e.currentTarget.classList.remove('dragging'); document.querySelectorAll('.map-order-item').forEach(el=>el.classList.remove('drag-over')); }
function dragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dragDrop(e) {
  e.preventDefault();
  const target = e.currentTarget.dataset.key;
  if (!dragSrc || dragSrc === target) return;
  const t = admT();
  if (!t) return;
  const sd = getStageData(t, state.adminStage);
  const from = sd.mapOrder.indexOf(dragSrc);
  const to = sd.mapOrder.indexOf(target);
  if (from < 0 || to < 0) return;
  sd.mapOrder.splice(from, 1);
  sd.mapOrder.splice(to, 0, dragSrc);
  saveState();
  renderAdminMapOrder();
  renderAll();
}

// ==================== SLOT MODAL ====================
let slotModalKey = null;
let slotModalSelected = null;

function openSlotModal(key, mapName) {
  slotModalKey = key;
  const t = admT();
  const sd = getStageData(t, state.adminStage);
  const current = getSlot(sd, key, mapName);
  slotModalSelected = current;
  document.getElementById('slot-modal-mapname').textContent = mapName.replace(/\[(?:NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*\]\s*/i,'').trim();
  const grid = document.getElementById('slot-grid');
  grid.innerHTML = SLOTS.map(s => {
    const sc = slotClass(s);
    return `<div class="slot-opt ${sc} ${s===current?'selected':''}" onclick="selectSlotOpt('${s}',this)">${s}</div>`;
  }).join('');
  document.getElementById('slot-modal').classList.add('show');
}

function selectSlotOpt(s, el) {
  slotModalSelected = s;
  document.querySelectorAll('.slot-opt').forEach(e=>e.classList.remove('selected'));
  el.classList.add('selected');
}

function confirmSlot() {
  if (!slotModalKey || !slotModalSelected) return;
  const t = admT();
  const sd = getStageData(t, state.adminStage);
  sd.slotOverrides[slotModalKey] = slotModalSelected;
  saveState();
  closeSlotModal();
  renderAdminMapOrder();
  renderAll();
}

function closeSlotModal() { document.getElementById('slot-modal').classList.remove('show'); slotModalKey=null; }

// ==================== RENDER HELPERS ====================
function cleanMatchName(name, match) {
  if (match && match.customName) return (match.name || '').trim();

  let n = (name || '').trim();
  n = n.replace(/\s*Ref{1,2}(eree)?:?\s*\S*/gi, '').trim();

  const stageMap = [
    [/grand\s*final/i, 'GF'],
    [/^gf/i, 'GF'],
    [/round\s*of\s*32|^ro32/i, 'RO32'],
    [/round\s*of\s*16|^ro16/i, 'RO16'],
    [/quarter\s*final|^qf/i, 'QF'],
    [/semi\s*final|^sf/i, 'SF'],
    [/^final(?!s)|^f(?=[\s\-_]|\d)/i, 'F'],
  ];

  for (const [re, code] of stageMap) {
    if (re.test(n)) {
      const numMatch = n.match(/(\d+)/);
      const num = numMatch ? numMatch[1] : '';
      return num ? `${code}-${num}` : code;
    }
  }

  const shortMatch = n.match(/^(RO32|RO16|QF|SF|GF|F)[-_\s]?(\d+)/i);
  if (shortMatch) return `${shortMatch[1].toUpperCase()}-${shortMatch[2]}`;

  return n;
}

function buildSessMap(t, stage) {
  const sd = getStageData(t, stage);
  const map = {};
  for (const m of sd.matches) {
    const matchName = cleanMatchName(m.name, m);
    const hidden = m.hiddenMaps || {};
    for (const s of m.sessions) {
      const key = sessKey(s);
      if (hidden[key]) continue; // map removed by admin in match detail (✕)
      const taggedScores = (s.scores || []).map(sc => ({ ...sc, _matchName: matchName }));
      if (!map[key]) {
        map[key] = { ...s, scores: taggedScores, matchName };
      } else {
        map[key].scores = [...(map[key].scores || []), ...taggedScores];
      }
    }
  }
  // inject manually-added scores (for players missing from match history, e.g. disconnects).
  // They attach to an already-played map (session must exist).
  for (const ms of (sd.manualScores || [])) {
    if (!map[ms.key]) continue;
    map[ms.key].scores = [...(map[ms.key].scores || []), {
      userName: ms.userName,
      score: ms.score,
      accuracy: ms.accuracy,
      playMod: (ms.mods || []).map(a => ({ acronym: a })),
      team: (ms.team != null ? ms.team : 1),
      isAlive: true,
      _matchName: ms.match || 'Manual',
      _manual: true
    }];
  }
  return map;
}

function getOrderedMaps(t, stage) {
  const sd = getStageData(t, stage);
  const sessMap = buildSessMap(t, stage);
  return sd.mapOrder.map(key => {
    if (key.startsWith('EMPTY:')) {
      return { key, info: { mapName: '', scores: [], matchName: '', _empty: true } };
    }
    return { key, info: sessMap[key] };
  }).filter(x => x.info);
}

function buildEmptySlotGrid() {
  const grid = document.getElementById('empty-slot-grid');
  if (!grid) return;
  grid.innerHTML = SLOTS.map(s => {
    const sc = slotClass(s);
    return `<div class="slot-opt ${sc}" data-slot="${s}" onclick="addEmptySlot(this)">${s}</div>`;
  }).join('');
}

function addEmptySlot(el) {
  const slot = el.dataset.slot;
  const t = admT();
  if (!t) return;
  const sd = getStageData(t, state.adminStage);
  const key = 'EMPTY:' + slot + ':' + Date.now();
  sd.mapOrder.push(key);
  sd.slotOverrides[key] = slot;
  saveState();
  renderAdminMapOrder();
  renderAll();
}

// Resolve a nickname to its canonical form using the current tournament's alias map.
// A player who changed nick between stages is registered as { oldnick: CanonicalNick }
// so all their scores aggregate into one profile. Case-insensitive lookup.
function canonName(name, t) {
  t = t || curT();
  if (!t || !t.aliases || !name) return name;
  const canon = t.aliases[String(name).trim().toLowerCase()];
  return canon || name;
}

function getPlayerScores(info) {
  const valid = (info.scores||[]).filter(s => s.team !== null && !(s.score===0 && !s.isAlive));
  // Dedupe per player: if a player has multiple scores on the same map (e.g. their team
  // played two matches in a losers bracket), keep only their highest score. Nicknames are
  // canonicalized first, so a player's alt nicks collapse into a single entry (highest kept).
  const best = new Map();
  for (const s of valid) {
    const cn = canonName(s.userName);
    const rec = (cn !== s.userName) ? { ...s, userName: cn } : s;
    const prev = best.get(cn);
    if (!prev || rec.score > prev.score) best.set(cn, rec);
  }
  return [...best.values()];
}

// ==================== RENDER (public, current tournament) ====================
function renderAll() {
  renderMappoolStats();
  renderLeaderboard();
  renderPlayersTab();
  renderMatchesTab();
}

function noTournamentHTML() {
  return `<div class="empty"><b>No tournament selected</b><p>Go back to Tournaments and pick one.</p></div>`;
}

function renderPlayersTab(opts={}) {
  const t = curT();
  if (!t) { document.getElementById('panel-players').innerHTML = noTournamentHTML(); return; }
  const roster = rosterByName();
  const entries = collectStageMaps(t).filter(e => !e.info._empty);

  if (!entries.length) {
    document.getElementById('panel-players').innerHTML =
      `<div class="empty"><b>No data for ${escAttr(stageLabel(state.currentStage))} yet</b><p>Data is not available yet.</p></div>`;
    return;
  }

  const agg = {};
  for (const {sd, key, info} of entries) {
    const slot = getSlot(sd, key, info.mapName) || '??';
    for (const p of getPlayerScores(info)) {
      if (!agg[p.userName]) agg[p.userName] = { name: p.userName, maps: 0, totalScore: 0, totalAcc: 0, best: 0, bestSlot: null };
      const a = agg[p.userName];
      a.maps++;
      a.totalScore += p.score;
      a.totalAcc += p.accuracy * 100;
      if (p.score > a.best) { a.best = p.score; a.bestSlot = slot; }
    }
  }

  let rows = Object.values(agg).map(a => ({
    name: a.name,
    maps: a.maps,
    avgScore: Math.round(a.totalScore / a.maps),
    avgAcc: a.totalAcc / a.maps,
    best: a.best,
    bestSlot: a.bestSlot,
    totalScore: a.totalScore
  }));

  const totalPlayers = rows.length;

  const q = (state.playerSearch || '').trim().toLowerCase();
  if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));

  const sortKey = state.playerSort.key;
  const sortDir = state.playerSort.dir;
  const arrow = (k) => sortKey === k ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';

  rows.sort((a,b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return sortDir === 'desc' ? 1 : -1;
    if (va > vb) return sortDir === 'desc' ? -1 : 1;
    return 0;
  });

  const flip = opts.flip;
  let firstRects = null;
  if (flip) {
    firstRects = {};
    document.querySelectorAll('#panel-players tbody tr[data-name]').forEach(tr => {
      firstRects[tr.dataset.name] = tr.getBoundingClientRect().top;
    });
  }

  const countLine = q
    ? `<div class="search-count">${rows.length} of ${totalPlayers} players</div>`
    : `<div class="search-count">${totalPlayers} players</div>`;

  let html = `<div class="player-search-wrap">
      <input type="text" class="player-search" id="player-search-input" placeholder="Search player…"
        value="${escAttr(state.playerSearch||'')}" oninput="onPlayerSearch(this.value)">
    </div>${countLine}
    <table class="players-table ${flip?'no-entrance':''}"><thead><tr>
    <th style="width:32px;">#</th>
    <th onclick="setPlayerSort('name')">Player${arrow('name')}</th>
    <th class="r" onclick="setPlayerSort('maps')" style="width:90px;">Maps${arrow('maps')}</th>
    <th class="r" onclick="setPlayerSort('avgScore')" style="width:120px;">Avg Score${arrow('avgScore')}</th>
    <th class="r" onclick="setPlayerSort('avgAcc')" style="width:110px;">Avg Acc${arrow('avgAcc')}</th>
    <th class="r" onclick="setPlayerSort('best')" style="width:150px;">Best Score${arrow('best')}</th>
    <th class="r" onclick="setPlayerSort('totalScore')" style="width:130px;">Total Score${arrow('totalScore')}</th>
  </tr></thead><tbody>`;

  if (!rows.length) {
    html += `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:1.5rem;">No players match “${escAttr(state.playerSearch)}”.</td></tr>`;
  }

  rows.forEach((r,i)=>{
    const rc = i===0?'r1':i===1?'r2':i===2?'r3':'';
    const delay = flip ? 0 : Math.min(i*0.035, 0.5);
    html += `<tr data-name="${escAttr(r.name)}" style="${flip?'':'animation-delay:'+delay+'s'}">
      <td class="rc ${rc}" style="font-weight:700;">${i+1}</td>
      <td class="pc clickable" onclick="openProfile('${escJsAttr(r.name)}')">${playerNameHTML(r.name, roster)}</td>
      <td class="r">${r.maps}</td>
      <td class="r">${r.avgScore.toLocaleString()}</td>
      <td class="r">${r.avgAcc.toFixed(2)}%</td>
      <td class="r"><span style="display:inline-flex;align-items:center;gap:8px;justify-content:flex-end;">${r.best.toLocaleString()} <span class="slot-badge ${slotClass(r.bestSlot)}" style="font-size:10px;padding:2px 6px;">${r.bestSlot||'??'}</span></span></td>
      <td class="r">${r.totalScore.toLocaleString()}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  document.getElementById('panel-players').innerHTML = html;

  if (flip && firstRects) {
    const trs = document.querySelectorAll('#panel-players tbody tr[data-name]');
    trs.forEach(tr => {
      const prevTop = firstRects[tr.dataset.name];
      if (prevTop === undefined) return;
      const newTop = tr.getBoundingClientRect().top;
      const dy = prevTop - newTop;
      if (!dy) return;
      tr.style.transform = `translateY(${dy}px)`;
      tr.style.transition = 'none';
    });
    requestAnimationFrame(() => {
      trs.forEach(tr => {
        tr.style.transition = 'transform .45s cubic-bezier(.22,.61,.36,1)';
        tr.style.transform = '';
      });
    });
  }
}

let playerSearchTimer = null;
function onPlayerSearch(val) {
  state.playerSearch = val;
  clearTimeout(playerSearchTimer);
  playerSearchTimer = setTimeout(() => {
    renderPlayersTab();
    const inp = document.getElementById('player-search-input');
    if (inp) { inp.focus(); const v = inp.value; inp.value=''; inp.value=v; }
  }, 120);
}

function setPlayerSort(key) {
  if (state.playerSort.key === key) {
    state.playerSort.dir = state.playerSort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    state.playerSort.key = key;
    state.playerSort.dir = key === 'name' ? 'asc' : 'desc';
  }
  saveState();
  renderPlayersTab({ flip: true });
}

function renderMappoolStats() {
  const t = curT();
  if (!t) { document.getElementById('panel-mappool').innerHTML = noTournamentHTML(); return; }
  const entries = collectStageMaps(t);

  if (!entries.length) {
    document.getElementById('panel-mappool').innerHTML =
      `<div class="empty"><b>No data for ${escAttr(stageLabel(state.currentStage))} yet</b><p>Data is not available yet.</p></div>`;
    return;
  }

  const allScores = entries.flatMap(e => getPlayerScores(e.info));
  const players = new Set(allScores.map(s=>s.userName));
  const matchNames = new Set();
  for (const st of currentStageList(t)) for (const m of (getStageData(t, st).matches || [])) matchNames.add(cleanMatchName(m.name, m));
  const playedMaps = entries.filter(e => !e.info._empty);

  let html = `<div class="summary-bar">
    <div class="sum-item"><div class="sum-val" data-count="${matchNames.size}">0</div><div class="sum-lbl">Matches</div></div>
    <div class="sum-item"><div class="sum-val" data-count="${playedMaps.length}">0</div><div class="sum-lbl">Maps</div></div>
    <div class="sum-item"><div class="sum-val" data-count="${players.size}">0</div><div class="sum-lbl">Players</div></div>
    <div class="sum-item"><div class="sum-val" data-count="${allScores.length}">0</div><div class="sum-lbl">Total Scores</div></div>
  </div>`;

  const mpGroup = state.currentStage === 'ALL';
  let mpLastStage = null, mpGridOpen = false;
  for (const {stage, sd, key, info} of entries) {
    if (mpGroup && stage !== mpLastStage) {
      if (mpGridOpen) html += '</div>';
      html += `<div class="mm-stage-head">${escAttr(stageLabel(stage))}</div><div class="map-grid">`;
      mpLastStage = stage; mpGridOpen = true;
    } else if (!mpGridOpen) {
      html += '<div class="map-grid">';
      mpGridOpen = true;
    }
    const slot = getSlot(sd, key, info.mapName);
    const sc = slotClass(slot);

    if (info._empty) {
      const meta = (sd.mapMeta || {})[key] || {};
      if (meta.title || meta.cover) {
        // unplayed slot that has a beatmap attached → show the map, no scores yet
        const dn = meta.artist ? `${meta.artist} - ${meta.title}` : (meta.title || '');
        html += `<div class="map-card empty-slot">
          <div class="map-card-head">
            <span class="slot-badge ${sc}">${slot||'??'}</span>
            <span class="map-card-title" title="${escAttr(dn)}">${escAttr(dn)}${meta.version?` <span style="color:var(--muted);font-weight:500;">[${escAttr(meta.version)}]</span>`:''}</span>
          </div>
          <div class="empty-note">No scores yet — this map hasn't been played.</div>
        </div>`;
      } else {
        html += `<div class="map-card empty-slot">
          <div class="map-card-head">
            <span class="slot-badge ${sc}">${slot||'??'}</span>
            <span class="map-card-title" style="font-style:italic;">Not played</span>
          </div>
          <div class="empty-note">This slot wasn't played this stage.</div>
        </div>`;
      }
      continue;
    }

    const ps = getPlayerScores(info).sort((a,b)=>b.score-a.score);
    const displayName = info.mapName.replace(/\[(?:NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*\]\s*/i,'').trim();
    const avgScore = ps.length ? Math.round(ps.reduce((s,x)=>s+x.score,0)/ps.length) : 0;
    const avgAcc = ps.length ? (ps.reduce((s,x)=>s+(x.accuracy*100),0)/ps.length).toFixed(2) : '0.00';

    html += `<div class="map-card">
      <div class="map-card-head">
        <span class="slot-badge ${sc}">${slot||'??'}</span>
        <span class="map-card-title" title="${escAttr(info.mapName)}">${escAttr(displayName)}</span>
      </div>
      <div class="map-card-stats">
        <div><div class="cs-val">${avgScore.toLocaleString()}</div><div class="cs-lbl">Avg Score</div></div>
        <div><div class="cs-val">${avgAcc}%</div><div class="cs-lbl">Avg Acc</div></div>
        <div><div class="cs-val">${ps.length}</div><div class="cs-lbl">Scores</div></div>
      </div>
      <div class="map-card-players">`;

    ps.slice(0,5).forEach((p,i)=>{
      const rc = i===0?'r1':i===1?'r2':i===2?'r3':'';
      const mods = (p.playMod||[]).map(m=>m.acronym).filter(m=>m!=='V2');
      html += `<div class="tp-row">
        <span class="tp-rank ${rc}">#${i+1}</span>
        <span class="tp-name">${escAttr(p.userName)}</span>
        <span class="tp-score">${p.score.toLocaleString()}</span>
        <span class="tp-acc ${accCls(p.accuracy*100)}">${(p.accuracy*100).toFixed(2)}%</span>
        <span class="tp-mods">${modPills(mods)}</span>
      </div>`;
    });

    html += `</div></div>`;
  }

  if (mpGridOpen) html += '</div>';
  document.getElementById('panel-mappool').innerHTML = html;
  animateCounts(document.getElementById('panel-mappool'));
}

function animateCounts(container) {
  const els = container.querySelectorAll('[data-count]');
  els.forEach(el => {
    const target = parseInt(el.dataset.count, 10) || 0;
    if (target === 0) { el.textContent = '0'; return; }
    const duration = 700;
    let startTs = null;
    function step(ts) {
      if (startTs === null) startTs = ts;
      const p = Math.min((ts - startTs) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = target.toLocaleString();
    }
    requestAnimationFrame(step);
  });
}

function renderLeaderboard() {
  const t = curT();
  if (!t) { document.getElementById('panel-leaderboard').innerHTML = noTournamentHTML(); return; }
  const entries = collectStageMaps(t);
  const roster = rosterByName();

  if (!entries.length) {
    document.getElementById('panel-leaderboard').innerHTML =
      `<div class="empty"><b>No data for ${escAttr(stageLabel(state.currentStage))} yet</b><p>Data is not available yet.</p></div>`;
    return;
  }

  const sortKey = state.lbSort.key;
  const sortDir = state.lbSort.dir;
  const arrow = (k) => sortKey === k ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';

  let html = '';
  let any = false;
  const lbGroup = state.currentStage === 'ALL';
  let lbLastStage = null;

  for (const {stage, sd, key, info} of entries) {
    if (info._empty) continue;
    any = true;
    if (lbGroup && stage !== lbLastStage) { html += `<div class="mm-stage-head">${escAttr(stageLabel(stage))}</div>`; lbLastStage = stage; }
    const slot = getSlot(sd, key, info.mapName);
    const sc = slotClass(slot);
    const displayName = info.mapName.replace(/\[(?:NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*\]\s*/i,'').trim();
    let ps = getPlayerScores(info);

    ps = ps.slice().sort((a,b) => {
      let va, vb;
      if (sortKey === 'acc') { va = a.accuracy; vb = b.accuracy; }
      else if (sortKey === 'player') { va = a.userName.toLowerCase(); vb = b.userName.toLowerCase(); }
      else { va = a.score; vb = b.score; }
      if (va < vb) return sortDir === 'desc' ? 1 : -1;
      if (va > vb) return sortDir === 'desc' ? -1 : 1;
      return 0;
    });

    html += `<div class="lb-section">
      <div class="lb-head">
        <span class="slot-badge ${sc}">${slot||'??'}</span>
        <span class="lb-mapname">${escAttr(displayName)}</span>
      </div>
      <table class="lb-table"><thead><tr>
        <th style="width:32px;">#</th>
        <th onclick="setLbSort('player')">Player${arrow('player')}</th>
        <th class="r" onclick="setLbSort('score')" style="width:110px;">Score${arrow('score')}</th>
        <th class="r" onclick="setLbSort('acc')" style="width:90px;">Accuracy${arrow('acc')}</th>
        <th class="r" style="width:130px;">Mods</th>
        <th class="r" style="width:150px;">Match</th>
      </tr></thead><tbody>`;

    ps.forEach((p,i)=>{
      const rc = i===0?'r1':i===1?'r2':i===2?'r3':'';
      const mods = (p.playMod||[]).map(m=>m.acronym).filter(m=>m!=='V2');
      const acc = (p.accuracy*100).toFixed(2);
      html += `<tr>
        <td class="rc ${rc}">${i+1}</td>
        <td class="pc clickable" onclick="openProfile('${escJsAttr(p.userName)}')">${playerNameHTML(p.userName, roster)}</td>
        <td class="sc">${p.score.toLocaleString()}</td>
        <td class="ac">${acc}%</td>
        <td class="mod-pills-cell">${modPills(mods)}</td>
        <td class="mc-cell" title="${escAttr(p._matchName || info.matchName || '')}">${escAttr(p._matchName || info.matchName || '')}</td>
      </tr>`;
    });

    html += `</tbody></table></div>`;
  }

  if (!any) html = `<div class="empty"><b>No played maps yet</b><p>All slots in this stage are marked as not played.</p></div>`;

  document.getElementById('panel-leaderboard').innerHTML = html;
}

// ==================== MATCHES VIEW ====================
function teamColorClass(i) { return i === 0 ? 'team-red' : i === 1 ? 'team-blue' : ''; }
// Per-tournament custom team name, falling back to Red/Blue.
function teamName(t, i) {
  if (i === 0) return (t && t.teamRed && t.teamRed.trim()) || 'Red';
  if (i === 1) return (t && t.teamBlue && t.teamBlue.trim()) || 'Blue';
  return 'Team ' + (i + 1);
}
const ADMIN_TABS = ['media','tournament','bracket','stages','matches','mappool','danger'];
let adminTab = 'tournament';
try { adminTab = localStorage.getItem('odt_admin_tab') || adminTab; } catch(e) {}

function switchAdminTab(tab) {
  if (!ADMIN_TABS.includes(tab)) tab = 'tournament';
  adminTab = tab;
  try { localStorage.setItem('odt_admin_tab', tab); } catch(e) {}
  document.querySelectorAll('[data-admin-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.adminTab === tab);
  });
  document.querySelectorAll('[data-admin-pane]').forEach(pane => {
    pane.classList.toggle('active', pane.dataset.adminPane === tab);
  });
  const wrap = document.querySelector('.admin-pane-wrap');
  if (wrap) wrap.scrollTop = 0;
}

// Break a single match into per-map results. If exactly two teams are present
// it's treated as Team VS (per-map team sums + maps-won tally); otherwise each
// map's winner is simply its top scorer.
function analyzeMatch(t, stage, m) {
  const sd = getStageData(t, stage);
  const matchName = cleanMatchName(m.name, m);
  // Manual scores attributed to this match (auto-pickup from the Manual Scores panel
  // and from the in-match add form), keyed by map session key.
  const manualForMatch = (sd.manualScores || []).filter(ms => ms.match === matchName);

  // First collapse the match's own sessions by map key. Match history sometimes
  // records the same map twice (a real session + an empty "[Image #1]" placeholder);
  // without merging, a manual score keyed to that map would attach to BOTH copies,
  // producing a duplicate map card and an extra tally point.
  // Maps removed by the admin (✕ on the map card) live in m.hiddenMaps and are skipped.
  const hidden = m.hiddenMaps || {};
  const byKey = new Map();
  for (const s of (m.sessions || [])) {
    const key = sessKey(s);
    if (hidden[key]) continue;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { s, key, scores: [...(s.scores || [])] });
    else prev.scores.push(...(s.scores || []));
  }

  // For each played map, merge the match's own scores with any manual scores
  // attributed to this match on the same map.
  const sessions = [...byKey.values()].map(({ s, key, scores }) => {
    const manual = manualForMatch.filter(ms => ms.key === key).map(ms => ({
      userName: ms.userName, score: ms.score, accuracy: ms.accuracy,
      playMod: (ms.mods || []).map(a => ({ acronym: a })),
      team: (ms.team != null ? ms.team : 1), isAlive: true, _manual: true
    }));
    return { s, key, scores: [...scores, ...manual] };
  });

  const teamSet = new Set();
  for (const ss of sessions) for (const p of getPlayerScores({ scores: ss.scores })) {
    if (p.team !== null && p.team !== undefined) teamSet.add(String(p.team));
  }
  const teamKeys = [...teamSet].sort();
  const isTeamVs = teamKeys.length === 2;

  const maps = sessions.map(({ s, key, scores }) => {
    const slot = getSlot(sd, key, s.mapName) || '??';
    const name = s.mapName.replace(/\[(?:NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*\]\s*/i, '').trim();
    const ps = getPlayerScores({ scores }).slice().sort((a, b) => b.score - a.score);
    const sums = {};
    teamKeys.forEach(k => sums[k] = 0);
    ps.forEach(p => { const k = String(p.team); if (k in sums) sums[k] += p.score; });
    let winTeam = null;
    if (isTeamVs) {
      const a = sums[teamKeys[0]], b = sums[teamKeys[1]];
      if (a > b) winTeam = teamKeys[0]; else if (b > a) winTeam = teamKeys[1];
    }
    // Players grouped by team for the detailed per-map scoreboard.
    const byTeam = {};
    teamKeys.forEach(k => byTeam[k] = []);
    ps.forEach(p => { const k = String(p.team); (byTeam[k] || (byTeam[k] = [])).push(p); });
    return { slot, name, mapName: s.mapName, ps, sums, winTeam, top: ps[0] || null, byTeam };
  });

  const tally = {};
  if (isTeamVs) {
    teamKeys.forEach(k => tally[k] = 0);
    maps.forEach(mp => { if (mp.winTeam) tally[mp.winTeam]++; });
  }
  return { maps, isTeamVs, teamKeys, tally };
}

// Match cost per player (osu!-style):  cost = 2/(n'+2) * Σ (s_i / m_i)
// where n' = games the player played, s_i = player's score on game i,
// m_i = average score on game i (over players who played that game).
// Returns players sorted by cost desc: [{ name, team, cost, played }].
function computeMatchCosts(a) {
  const acc = {}; // name -> { sum, played, team }
  for (const mp of a.maps) {
    const ps = mp.ps || [];
    if (!ps.length) continue;
    const avg = ps.reduce((n, p) => n + (p.score || 0), 0) / ps.length;
    if (avg <= 0) continue;
    for (const p of ps) {
      const name = p.userName;
      if (!name) continue;
      const rec = acc[name] || (acc[name] = { sum: 0, played: 0, team: p.team });
      rec.sum += (p.score || 0) / avg;
      rec.played++;
    }
  }
  return Object.keys(acc).map(name => {
    const r = acc[name];
    return { name, team: r.team, played: r.played, cost: (2 / (r.played + 2)) * r.sum };
  }).sort((x, y) => y.cost - x.cost);
}

// Renders the match-cost leaderboard shown under the scoreboard.
function matchCostHTML(a) {
  const costs = computeMatchCosts(a);
  if (!costs.length) return '';
  const rows = costs.map((c, i) => {
    const cls = a.isTeamVs ? teamColorClass(c.team === 0 || c.team === '0' ? 0 : 1) : '';
    return `<div class="mm-cost-row${i === 0 ? ' mvp' : ''}">
      <span class="mm-cost-rank">${i + 1}</span>
      <span class="mm-cost-name ${cls}">${escAttr(c.name)}</span>
      <span class="mm-cost-val">${c.cost.toFixed(2)}</span>
    </div>`;
  }).join('');
  return `<div class="mm-cost">
    <div class="mm-cost-title">Match Cost</div>
    <div class="mm-cost-list">${rows}</div>
  </div>`;
}

// ---- hide/restore a map inside a match (admin ✕ on the map card) ----
// Hidden maps are stored per match as m.hiddenMaps = { [sessKey]: true } and are
// excluded from match detail AND from the stage-wide stats (buildSessMap).
function hideMatchMap(matchId, key) {
  const t = curT();
  if (!t || !isAdminUnlocked()) return;
  const sd = getStageData(t, state.currentStage);
  const m = (sd.matches || []).find(x => x.id === matchId);
  if (!m) return;
  if (!confirm(`Remove this map from the match?\n\n${key}\n\nIt will also disappear from the stage stats. You can restore it from the "Removed maps" list at the bottom of the match.`)) return;
  (m.hiddenMaps || (m.hiddenMaps = {}))[key] = true;
  saveState();
  renderMatchDetail();
}
function unhideMatchMap(matchId, key) {
  const t = curT();
  if (!t || !isAdminUnlocked()) return;
  const sd = getStageData(t, state.currentStage);
  const m = (sd.matches || []).find(x => x.id === matchId);
  if (!m || !m.hiddenMaps) return;
  delete m.hiddenMaps[key];
  saveState();
  renderMatchDetail();
}

function renderMatchesTab() {
  const t = curT();
  const panel = document.getElementById('panel-matches');
  if (!panel) return;
  if (!t) { panel.innerHTML = noTournamentHTML(); return; }
  if (state.currentMatchId) { renderMatchDetail(); return; }

  const isAll = state.currentStage === 'ALL';
  const stages = currentStageList(t);
  const totalMatches = stages.reduce((n, s) => n + (getStageData(t, s).matches || []).length, 0);
  if (!totalMatches) {
    panel.innerHTML = `<div class="empty"><b>No matches for ${escAttr(stageLabel(state.currentStage))} yet</b><p>Match data is not available yet.</p></div>`;
    return;
  }

  const cardHTML = (stage, m) => {
    const a = analyzeMatch(t, stage, m);
    const name = escAttr(cleanMatchName(m.name, m));
    let result;
    if (a.isTeamVs) {
      const k0 = a.teamKeys[0], k1 = a.teamKeys[1];
      const w0 = a.tally[k0] > a.tally[k1], w1 = a.tally[k1] > a.tally[k0];
      result = `<span class="${teamColorClass(0)}" style="${w0 ? 'text-shadow:0 0 12px currentColor' : ''}">${a.tally[k0]}</span>
        <span class="mm-dash">–</span>
        <span class="${teamColorClass(1)}" style="${w1 ? 'text-shadow:0 0 12px currentColor' : ''}">${a.tally[k1]}</span>`;
    } else {
      result = `<span style="color:var(--muted);font-size:13px;">${a.maps.length} map${a.maps.length !== 1 ? 's' : ''}</span>`;
    }
    const onclick = isAll ? `openMatchAt('${stage}','${escJsAttr(m.id)}')` : `openMatch('${escJsAttr(m.id)}')`;
    return `<div class="mm-card" onclick="${onclick}">
      <div class="mm-card-main">
        <div class="mm-card-name">${name}</div>
        <div class="mm-card-meta">${a.maps.length} map${a.maps.length !== 1 ? 's' : ''}${a.isTeamVs ? ' · Team VS' : ''}</div>
      </div>
      <div class="mm-card-result">${result}</div>
      <span class="mm-card-go">›</span>
    </div>`;
  };

  let html;
  if (isAll) {
    html = stages.map(stage => {
      const matches = getStageData(t, stage).matches || [];
      if (!matches.length) return '';
      return `<div class="mm-stage-head">${escAttr(stageLabel(stage))}</div>
        <div class="match-cards">${matches.map(m => cardHTML(stage, m)).join('')}</div>`;
    }).join('');
  } else {
    const matches = getStageData(t, state.currentStage).matches || [];
    html = `<div class="match-cards">${matches.map(m => cardHTML(state.currentStage, m)).join('')}</div>`;
  }
  panel.innerHTML = html;
}

// From the "All Stages" match list, drilling into a match switches to that match's
// real stage (match-detail reads state.currentStage), then opens it.
function openMatchAt(stage, id) {
  if (STAGES.includes(stage)) state.currentStage = stage;
  buildStageTabs();
  openMatch(id);
}

function openMatch(id) {
  state.currentMatchId = id;
  state.view = 'matches';
  saveState();
  syncURL();
  renderMatchDetail();
}

function closeMatch() {
  state.currentMatchId = null;
  saveState();
  syncURL();
  renderMatchesTab();
}

function renderMatchDetail() {
  const t = curT();
  const panel = document.getElementById('panel-matches');
  if (!panel) return;
  if (!t) { panel.innerHTML = noTournamentHTML(); return; }
  const stage = state.currentStage;
  const sd = getStageData(t, stage);
  const m = (sd.matches || []).find(x => x.id === state.currentMatchId);
  if (!m) { state.currentMatchId = null; renderMatchesTab(); return; }

  const a = analyzeMatch(t, stage, m);
  const name = escAttr(cleanMatchName(m.name, m));

  // ---- middle scoreboard: "Team Red name  N – M  Team Blue name" ----
  let scoreboard;
  if (a.isTeamVs) {
    const k0 = a.teamKeys[0], k1 = a.teamKeys[1];
    const t0 = a.tally[k0], t1 = a.tally[k1];
    const w0 = t0 > t1, w1 = t1 > t0;
    scoreboard = `<div class="mm-scoreboard">
      <div class="mm-team ${teamColorClass(0)}${w0 ? ' win' : ''}"><span class="mm-team-name">${escAttr(teamName(t, 0))}</span><span class="mm-team-tally">${t0}</span></div>
      <div class="mm-vs">–</div>
      <div class="mm-team ${teamColorClass(1)}${w1 ? ' win' : ''}"><span class="mm-team-tally">${t1}</span><span class="mm-team-name">${escAttr(teamName(t, 1))}</span></div>
    </div>`;
  } else {
    scoreboard = `<div class="mm-scoreboard"><div class="mm-team">${a.maps.length} map${a.maps.length !== 1 ? 's' : ''} played</div></div>`;
  }
  // Match cost leaderboard replaces the old "X wins / Draw" line under the score.
  const costBlock = matchCostHTML(a);

  // ---- per-map detailed scoreboards (osu! result-screen style) ----
  const scoreRow = (p, colorCls) => {
    const mods = (p.playMod || []).map(x => x.acronym).filter(x => x !== 'V2');
    return `<div class="mm-pl ${colorCls}">
      <span class="mm-pl-name">${escAttr(p.userName)}</span>
      <span class="mm-pl-acc">${(p.accuracy * 100).toFixed(2)}%</span>
      <span class="mm-pl-score">${p.score.toLocaleString()}</span>
      <span class="mm-pl-mods">${modPills(mods)}</span>
    </div>`;
  };

  let mapsHtml = `<div class="mm-maps">`;
  for (const mp of a.maps) {
    let body, footer = '';
    if (a.isTeamVs) {
      const k0 = a.teamKeys[0], k1 = a.teamKeys[1];
      const s0 = mp.sums[k0] || 0, s1 = mp.sums[k1] || 0;
      const col0 = (mp.byTeam[k0] || []).map(p => scoreRow(p, 'team-red')).join('') || `<div class="mm-pl-empty">—</div>`;
      const col1 = (mp.byTeam[k1] || []).map(p => scoreRow(p, 'team-blue')).join('') || `<div class="mm-pl-empty">—</div>`;
      body = `<div class="mm-cols">
        <div class="mm-col ${mp.winTeam === k0 ? 'win' : ''}">${col0}</div>
        <div class="mm-col ${mp.winTeam === k1 ? 'win' : ''}">${col1}</div>
      </div>`;
      const diff = Math.abs(s0 - s1);
      const margin = mp.winTeam === k0 ? `${escAttr(teamName(t, 0))} wins by ${diff.toLocaleString()}`
        : mp.winTeam === k1 ? `${escAttr(teamName(t, 1))} wins by ${diff.toLocaleString()}`
        : 'Draw';
      footer = `<div class="mm-map-foot">
        <div class="mm-foot-side team-red"><span class="mm-foot-lbl">${escAttr(teamName(t, 0))}</span><span class="mm-foot-val">${s0.toLocaleString()}</span></div>
        <div class="mm-foot-margin">${margin}</div>
        <div class="mm-foot-side team-blue"><span class="mm-foot-lbl">${escAttr(teamName(t, 1))}</span><span class="mm-foot-val">${s1.toLocaleString()}</span></div>
      </div>`;
    } else {
      body = `<div class="mm-col">${mp.ps.length ? mp.ps.map((p, i) => scoreRow(p, i === 0 ? 'mm-top' : '')).join('') : `<div class="mm-pl-empty">—</div>`}</div>`;
    }
    mapsHtml += `<div class="mm-mapcard">
      <div class="mm-mapcard-head">
        <span class="slot-badge ${slotClass(mp.slot)}">${mp.slot}</span>
        <div class="mm-map-name" title="${escAttr(mp.name)}">${escAttr(mp.name)}</div>
        ${isAdminUnlocked() ? `<button class="mm-map-del" title="Remove this map from the match" onclick="hideMatchMap('${escJsAttr(m.id)}','${escJsAttr(mp.mapName)}')">✕</button>` : ''}
      </div>
      ${body}
      ${footer}
    </div>`;
  }
  mapsHtml += `</div>`;

  // ---- restore list for maps hidden via ✕ (admin only) ----
  let hiddenHtml = '';
  const hiddenKeys = Object.keys(m.hiddenMaps || {});
  if (isAdminUnlocked() && hiddenKeys.length) {
    hiddenHtml = `<div class="mm-hidden">
      <div class="mm-hidden-title">Removed maps</div>
      ${hiddenKeys.map(k => `<div class="mm-hidden-row">
        <span class="mm-hidden-name" title="${escAttr(k)}">${escAttr(k)}</span>
        <button class="mm-hidden-restore" onclick="unhideMatchMap('${escJsAttr(m.id)}','${escJsAttr(k)}')">Restore</button>
      </div>`).join('')}
    </div>`;
  }

  // ---- in-match add-score form (admin only) ----
  let addForm = '';
  if (isAdminUnlocked()) {
    const mapOpts = a.maps.map(mp => `<option value="${escAttr(sessKeyFromName(mp.mapName))}">${escAttr(mp.slot)} — ${escAttr(mp.name)}</option>`).join('')
      || `<option value="">No maps in this match</option>`;
    addForm = `<div class="mm-addbox">
      <div class="mm-addbox-title">＋ Add a missing score to this match</div>
      <div class="mm-addgrid">
        <select id="mm-add-map">${mapOpts}</select>
        <input type="text" id="mm-add-player" placeholder="Player name" />
        <input type="text" id="mm-add-score" placeholder="Score" />
        <input type="text" id="mm-add-acc" placeholder="Acc %" />
        <input type="text" id="mm-add-mods" placeholder="Mods (HD HR)" />
        <select id="mm-add-team"><option value="0">Red</option><option value="1" selected>Blue</option></select>
        <button class="btn" style="width:auto;" onclick="addMatchScore()">Add</button>
      </div>
      <div class="fetch-status" id="mm-add-status"></div>
    </div>`;
  }

  panel.innerHTML = `<div class="mm-detail">
    <button class="mm-back" onclick="closeMatch()">← All matches</button>
    <div class="stats-title" style="margin-bottom:1rem;">${name}</div>
    ${scoreboard}
    ${costBlock}
    ${mapsHtml}
    ${hiddenHtml}
    ${addForm}
  </div>`;
}

// session key derived from a map name (mirror of sessKey, which keys on mapName)
function sessKeyFromName(mapName) { return mapName; }

// Add a manual score from inside the match-detail view (attributed to this match).
function addMatchScore() {
  const t = curT();
  const st = document.getElementById('mm-add-status');
  if (!t) return;
  const stage = state.currentStage;
  const sd = getStageData(t, stage);
  const m = (sd.matches || []).find(x => x.id === state.currentMatchId);
  if (!m) return;
  const key = document.getElementById('mm-add-map').value;
  const userName = document.getElementById('mm-add-player').value.trim();
  const scoreRaw = document.getElementById('mm-add-score').value.trim().replace(/[,\s]/g, '');
  const accRaw = document.getElementById('mm-add-acc').value.trim();
  const modsRaw = document.getElementById('mm-add-mods').value.trim();
  const team = parseInt(document.getElementById('mm-add-team').value, 10) || 0;

  if (!key) { st.textContent = 'No map selected.'; st.className = 'fetch-status err'; return; }
  if (!userName) { st.textContent = 'Enter a player name.'; st.className = 'fetch-status err'; return; }
  const score = parseInt(scoreRaw, 10);
  if (!Number.isFinite(score) || score < 0) { st.textContent = 'Enter a valid score.'; st.className = 'fetch-status err'; return; }
  let acc = parseFloat(accRaw.replace('%', '').replace(',', '.'));
  if (!Number.isFinite(acc)) acc = 0;
  acc = Math.max(0, Math.min(100, acc)) / 100;
  const mods = modsRaw ? modsRaw.toUpperCase().split(/[\s,]+/).filter(Boolean) : [];

  sd.manualScores = sd.manualScores || [];
  sd.manualScores.push({
    id: 'ms' + Date.now() + Math.floor(Math.random() * 1000),
    key, userName, score, accuracy: acc, mods, team,
    match: cleanMatchName(m.name, m)
  });
  if (!saveState()) { st.textContent = 'Storage full — could not save.'; st.className = 'fetch-status err'; return; }
  renderMatchDetail();
  renderAll();
  renderManualScoreEditor();
}

// ==================== BRACKET ====================
function openBracket() {
  if (!curT() && state.tournaments.length) state.currentTournamentId = state.tournaments[0].id;
  state.page = 'bracket';
  saveState();
  syncURL();
  applyPage();
}

// ==================== MAPPOOL PAGE ====================
function openMappool(stage) {
  if (!curT() && state.tournaments.length) state.currentTournamentId = state.tournaments[0].id;
  if (stage && STAGES.includes(stage)) state.currentStage = stage;
  state.page = 'mappool';
  state.currentMatchId = null;
  saveState();
  syncURL();
  applyPage();
}

function buildMappoolStageTabs() {
  const bar = document.getElementById('mappool-stage-bar');
  const t = curT();
  if (!bar) return;
  if (!t) { bar.innerHTML = ''; return; }
  const visible = STAGES.filter(s => !t.hiddenStages[s]);
  if ((state.currentStage === 'ALL' || t.hiddenStages[state.currentStage]) && visible.length) state.currentStage = visible[0];
  bar.innerHTML = visible.map(s =>
    `<div class="stage-tab ${s===state.currentStage?'active':''}" onclick="selectMappoolStage('${s}')">${s}</div>`
  ).join('');
}

function selectMappoolStage(s) {
  state.currentStage = s;
  saveState();
  syncURL();
  buildMappoolStageTabs();
  renderMappool();
}

// Parse "artist, title (mapper) [difficulty]" into parts.
// osu!droid uses "artist, title"; difficulty is the last [bracket] that isn't a slot code.
function parseMapName(mapName) {
  let s = (mapName || '').trim();
  let version = '';
  // pull the last [..] that is a real difficulty name (not a slot like NM1/HD2)
  const brs = [...s.matchAll(/\[([^\]]+)\]/g)];
  for (let i = brs.length - 1; i >= 0; i--) {
    const inner = brs[i][1].trim();
    if (!/^(NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*$/i.test(inner)) { version = inner; break; }
  }
  // strip slot codes and the chosen difficulty bracket from the title text
  let core = s.replace(/\[(?:NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*\]/ig, '');
  if (version) core = core.replace('[' + version + ']', '');
  core = core.trim();
  let mapper = '';
  const mp = core.match(/\(([^()]+)\)\s*$/);
  if (mp) { mapper = mp[1].trim(); core = core.slice(0, mp.index).trim(); }
  let artist = '', title = core;
  const comma = core.indexOf(', ');
  if (comma > 0) { artist = core.slice(0, comma).trim(); title = core.slice(comma + 2).trim(); }
  return { artist, title, version, mapper };
}

function formatLength(sec) {
  sec = parseInt(sec, 10);
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderMappool() {
  const t = curT();
  const titleEl = document.getElementById('mappool-title');
  const body = document.getElementById('mappool-body');
  if (!body) return;
  if (titleEl && t) titleEl.innerHTML = tournamentNameHTML(t.name) + ' <span style="color:var(--muted);font-weight:600;">— Mappool</span>';
  if (!t) { body.innerHTML = noTournamentHTML(); return; }

  const stage = state.currentStage;
  const sd = getStageData(t, stage);
  const maps = getOrderedMaps(t, stage);
  if (!maps.length) {
    body.innerHTML = `<div class="empty"><b>No mappool for ${escAttr(stageLabel(stage))} yet</b><p>Mappool data is not available yet.</p></div>`;
    return;
  }

  // played maps only (skip "Not played" empty slots), grouped by mod into bands
  const MOD_ORDER = ['NM','HD','HR','DT','NC','FM','PR','FL','EZ','TB','XX'];
  const modOf = (slot) => {
    const u = (slot || '').toUpperCase().replace(/[0-9]/g, '');
    return MOD_ORDER.includes(u) ? u : 'XX';
  };
  const groups = {};
  for (const { key, info } of maps) {
    const slot = getSlot(sd, key, info.mapName || '');
    (groups[modOf(slot)] = groups[modOf(slot)] || []).push({ key, info, slot });
  }
  if (!Object.keys(groups).length) {
    body.innerHTML = `<div class="empty"><b>No mappool for ${escAttr(stageLabel(stage))} yet</b><p>Mappool data is not available yet.</p></div>`;
    return;
  }

  const cardHTML = ({ key, info, slot }) => {
    const sc = slotClass(slot);
    const meta = (sd.mapMeta || {})[key] || {};
    const hasMap = meta.cover || meta.title;
    // unplayed slot with no attached beatmap → "Not played" placeholder
    if (info._empty && !hasMap) {
      return `<div class="mp-card mp-empty">
        <div class="mp-card-overlay">
          <div class="mp-card-top"><span class="slot-badge ${sc}">${slot || '??'}</span></div>
          <div class="mp-card-mid"><div class="mp-empty-label">Not played</div></div>
        </div>
      </div>`;
    }
    const p = parseMapName(info.mapName);
    const cover = meta.cover ? `style="background-image:url('${escAttr(meta.cover)}')"` : '';

    const chips = [];
    if (meta.sr != null) chips.push(`<span class="mp-chip mp-sr">★ ${Number(meta.sr).toFixed(2)}</span>`);
    if (meta.bpm != null) chips.push(`<span class="mp-chip">${Math.round(meta.bpm)} BPM</span>`);
    if (meta.length) chips.push(`<span class="mp-chip">${formatLength(meta.length)}</span>`);
    const diffBits = [];
    if (meta.cs != null) diffBits.push(`CS ${meta.cs}`);
    if (meta.ar != null) diffBits.push(`AR ${meta.ar}`);
    if (meta.od != null) diffBits.push(`OD ${meta.od}`);
    if (meta.hp != null) diffBits.push(`HP ${meta.hp}`);

    // Build "artist - title" from a SINGLE source to avoid duplicating the artist.
    // (osu!droid mapNames may use "artist - title" with a hyphen, which parseMapName
    // can't split on a comma — so its `title` already contains the artist. Mixing that
    // with meta.artist would double it, e.g. "sokoninaru - sokoninaru - METALIN".)
    let artist, rawTitle;
    if (meta.title) { artist = meta.artist || ''; rawTitle = meta.title; }
    else if (p.artist) { artist = p.artist; rawTitle = p.title; }
    else { artist = ''; rawTitle = p.title || info.mapName || '(map)'; }
    const titleLine = artist ? `${artist} - ${rawTitle}` : rawTitle;
    const version = meta.version || p.version || '';
    const mapper = p.mapper || meta.mapper || '';
    const subBits = [];
    if (version) subBits.push('[' + escAttr(version) + ']');
    if (mapper) subBits.push('mapped by ' + escAttr(mapper));

    return `<div class="mp-card">
      <div class="mp-card-bg" ${cover}></div>
      <div class="mp-card-shade"></div>
      <div class="mp-card-overlay">
        <div class="mp-card-top">
          <span class="slot-badge ${sc}">${slot || '??'}</span>
          ${chips.join('')}
        </div>
        <div class="mp-card-mid">
          <div class="mp-title" title="${escAttr(info.mapName || titleLine)}">${escAttr(titleLine)}</div>
          <div class="mp-sub">${subBits.join(' · ')}</div>
        </div>
        ${diffBits.length ? `<div class="mp-card-foot"><div class="mp-diffline">${diffBits.join('  ·  ')}</div></div>` : ''}
      </div>
    </div>`;
  };

  let html = '<div class="mp-pool">';
  for (const mod of MOD_ORDER) {
    const g = groups[mod];
    if (!g || !g.length) continue;
    g.sort((a, b) => (a.slot || '').localeCompare(b.slot || '', undefined, { numeric: true }));
    html += `<div class="mp-row">${g.map(cardHTML).join('')}</div>`;
  }
  html += '</div>';
  body.innerHTML = html;
}

// ---- admin: per-map osu! link → fetch cover + stats ----
function renderMappoolAdmin() {
  const c = document.getElementById('mpc-list');
  if (!c) return;
  const t = admT();
  if (!t) { c.innerHTML = '<div style="font-size:12px;color:var(--muted);">No tournament selected.</div>'; return; }
  const sd = getStageData(t, state.adminStage);
  const maps = getOrderedMaps(t, state.adminStage);
  if (!maps.length) { c.innerHTML = '<div style="font-size:12px;color:var(--muted);">No maps or slots in this stage. Add a match or an unplayed slot first.</div>'; return; }

  c.innerHTML = maps.map(({ key, info }) => {
    const slot = getSlot(sd, key, info.mapName || '') || '??';
    const sc = slotClass(slot);
    const p = parseMapName(info.mapName);
    const meta = (sd.mapMeta || {})[key] || {};
    const ke = escAttr(key);
    const have = meta.cover ? `<span class="mpc-ok">✓ ${meta.sr != null ? '★' + Number(meta.sr).toFixed(2) : 'cover'}</span>` : '';
    const linkVal = escAttr(meta.sourceUrl || '');
    const label = p.title || meta.title || (info._empty ? '(unplayed slot)' : info.mapName);
    return `<div class="mpc-item">
      <div class="mpc-head">
        <span class="slot-badge ${sc}">${slot}</span>
        <span class="mpc-name" title="${escAttr(info.mapName || label)}">${escAttr(label)}</span>
        ${have}
      </div>
      <div class="mpc-row">
        <input type="text" class="mpc-input" data-key="${ke}" value="${linkVal}" placeholder="osu! beatmap link or ID" />
        <button class="slot-edit-btn" onclick="fetchMapMeta(this)" data-key="${ke}">Fetch</button>
        ${meta.cover ? `<button class="slot-edit-btn" style="color:#ef5350;border-color:#ef535044;" onclick="clearMapMeta('${escJsAttr(key)}')">Clear</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

// Extract { setId, beatmapId } from an osu! link or bare ID.
function parseBeatmapLink(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;
  let setId = null, beatmapId = null;
  let m = raw.match(/beatmapsets\/(\d+)/i);
  if (m) setId = m[1];
  m = raw.match(/#(?:osu|taiko|fruits|mania)\/(\d+)/i);
  if (m) beatmapId = m[1];
  m = raw.match(/\/b(?:eatmaps)?\/(\d+)/i);
  if (m && !beatmapId) beatmapId = m[1];
  // bare number → treat as beatmap (diff) id; lets us resolve the set from the API
  if (!setId && !beatmapId && /^\d+$/.test(raw)) beatmapId = raw;
  if (!setId && !beatmapId) return null;
  return { setId, beatmapId };
}

async function fetchMapMeta(btn) {
  const key = btn.dataset.key;
  const input = document.querySelector(`.mpc-input[data-key="${CSS.escape(key)}"]`);
  const st = document.getElementById('mpc-status');
  const t = admT();
  if (!t || !input) return;
  const parsed = parseBeatmapLink(input.value);
  if (!parsed) { st.textContent = 'Could not read a beatmap link/ID.'; st.className = 'fetch-status err'; return; }

  st.textContent = 'Fetching…'; st.className = 'fetch-status';
  try {
    let setId = parsed.setId;
    // If we only have a beatmap (diff) id, resolve its set first.
    if (!setId && parsed.beatmapId) {
      const r = await fetch(`https://osu.direct/api/v2/b/${parsed.beatmapId}`);
      if (r.ok) { const b = await r.json(); setId = b.beatmapset_id || (b.beatmapset && b.beatmapset.id); }
    }
    if (!setId) throw new Error('no beatmapset id');

    const resp = await fetch(`https://osu.direct/api/v2/s/${setId}`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const set = await resp.json();
    const diffs = set.beatmaps || [];

    // choose the matching difficulty: by beatmap id, else by version name from mapName, else first std diff.
    const sd = getStageData(t, state.adminStage);
    const info = (getOrderedMaps(t, state.adminStage).find(x => x.key === key) || {}).info || { mapName: key };
    const wantVer = parseMapName(info.mapName).version.toLowerCase();
    let b = parsed.beatmapId ? diffs.find(d => String(d.id) === String(parsed.beatmapId)) : null;
    if (!b && wantVer) b = diffs.find(d => (d.version || '').toLowerCase() === wantVer);
    if (!b) b = diffs.find(d => d.mode === 'osu') || diffs[0];
    if (!b) throw new Error('no difficulties in set');

    const cover = (set.covers && (set.covers['cover@2x'] || set.covers.cover))
      || `https://assets.ppy.sh/beatmaps/${setId}/covers/cover.jpg`;

    sd.mapMeta = sd.mapMeta || {};
    sd.mapMeta[key] = {
      sourceUrl: input.value.trim(),
      setId: setId, beatmapId: b.id,
      cover: cover.split('?')[0],
      title: set.title || '', artist: set.artist || '', mapper: set.creator || '',
      version: b.version || '',
      sr: b.difficulty_rating, ar: b.ar, cs: b.cs, od: b.accuracy, hp: b.drain,
      bpm: b.bpm, length: b.total_length || b.hit_length
    };
    if (!saveState()) { st.textContent = 'Storage full — could not save.'; st.className = 'fetch-status err'; return; }
    st.textContent = `Loaded: ${set.title || setId} [${b.version || ''}]`; st.className = 'fetch-status ok';
    renderMappoolAdmin();
    if (state.page === 'mappool') renderMappool();
  } catch (e) {
    st.textContent = 'Error: ' + e.message + ' (map may not exist on osu!).'; st.className = 'fetch-status err';
  }
}

function clearMapMeta(key) {
  const t = admT();
  if (!t) return;
  const sd = getStageData(t, state.adminStage);
  if (sd.mapMeta) delete sd.mapMeta[key];
  saveState();
  renderMappoolAdmin();
  if (state.page === 'mappool') renderMappool();
}

// ==================== TEAMS PAGE ====================
function openTeams() {
  if (!curT() && state.tournaments.length) state.currentTournamentId = state.tournaments[0].id;
  state.page = 'teams';
  state.currentMatchId = null;
  saveState();
  syncURL();
  applyPage();
}

function curTeams() {
  const t = curT();
  if (!t) return [];
  if (!t.teams) t.teams = [];
  return t.teams;
}

// ---- osudroid.moe identity helpers (avatar + profile from a numeric player ID) ----
// Avatars/profiles on osudroid.moe are keyed by numeric uid, e.g.
// https://osudroid.moe/user/avatar/173730.png  and  https://osudroid.moe/profile.php?uid=173730
function droidUid(p) {
  const raw = (p && (p.uid != null ? p.uid : p.id));
  const s = String(raw == null ? '' : raw).trim();
  return /^\d+$/.test(s) ? s : '';
}
function avatarURL(p) {
  if (p && p.avatar) return p.avatar;            // explicit override wins
  const uid = droidUid(p);
  return uid ? `https://osudroid.moe/user/avatar/${uid}.png` : '';
}
function profileURL(p) {
  if (p && p.profile) return p.profile;          // explicit override wins
  const uid = droidUid(p);
  return uid ? `https://osudroid.moe/profile.php?uid=${uid}` : '';
}

// ---- country flags (osudroid.moe's own flag assets — same icons as the players'
// profiles on osudroid.moe; rendered as images so they look identical on
// Windows/phone/etc., unlike emoji flags which Windows doesn't draw) ----
// A country code is a 2-letter ISO code (e.g. "PL"); we lowercase it for the asset path.
function countryCode(p) {
  const raw = (p && p.country != null) ? String(p.country).trim() : '';
  return /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : '';
}
// Small inline flag <img> for a 2-letter code, or '' if none/invalid.
function flagHTML(code, cls) {
  const cc = (/^[A-Za-z]{2}$/.test(String(code || '').trim())) ? String(code).trim().toLowerCase() : '';
  if (!cc) return '';
  return `<img class="flag${cls ? ' ' + cls : ''}" src="https://osudroid.moe/assets/smallflags/${cc}.png" `
    + `alt="${escAttr(cc.toUpperCase())}" title="${escAttr(cc.toUpperCase())}" loading="lazy" `
    + `width="21" height="14" onerror="this.remove()">`;
}
// Flag for a match-history nickname via the roster (nicknames don't carry a country themselves).
// Currently unused — flags are shown only in the profile modal and on the Teams page.
function flagForName(name, roster) {
  const rp = roster && roster[String(name || '').trim().toLowerCase()];
  return rp ? flagHTML(countryCode(rp)) : '';
}

// Map a match-history nickname → its team-roster player entry (for avatars in the
// profile modal, which only knows nicknames). Case-insensitive, built per current tournament.
function rosterByName() {
  const map = {};
  for (const team of curTeams()) {
    for (const p of (team.players || [])) {
      const key = (p.droid || '').trim().toLowerCase();
      if (key && !map[key]) map[key] = p;
    }
  }
  return map;
}

function playerNameHTML(name, roster) {
  const clean = String(name || '');
  const rp = roster && roster[clean.trim().toLowerCase()];
  const av = rp ? avatarURL(rp) : '';
  const initial = clean.trim().charAt(0).toUpperCase() || '?';
  const avHTML = av
    ? `<span class="player-mini-av" style="background-image:url('${escAttr(av)}')"></span>`
    : `<span class="player-mini-av">${escAttr(initial)}</span>`;
  return `<span class="player-cell">${avHTML}<span class="player-cell-name">${escAttr(clean)}</span></span>`;
}

function renderTeams() {
  const t = curT();
  const titleEl = document.getElementById('teams-title');
  const body = document.getElementById('teams-body');
  if (!body) return;
  if (titleEl && t) titleEl.innerHTML = tournamentNameHTML(t.name) + ' <span style="color:var(--muted);font-weight:600;">— Teams</span>';
  if (!t) { body.innerHTML = noTournamentHTML(); return; }
  const teams = curTeams();
  const canEdit = adminVisible();

  let html = '<div class="teams-grid">';
  for (const team of teams) {
    const players = team.players || [];
    html += `<div class="team-card">
      <div class="team-card-head">
        <span class="team-name">${escAttr(team.name)}</span>
        ${(() => {
          const seed = (team.seed != null ? String(team.seed) : '').trim();
          if (seed) return `<span class="team-count team-seed">Seed #${escAttr(seed)}</span>`;
          return canEdit ? `<span class="team-count team-seed-empty">No seed</span>` : '';
        })()}
        ${canEdit ? `<button class="team-edit-btn" onclick="openTeamEditor('${escJsAttr(team.id)}')">Edit</button>
          <button class="team-edit-btn team-del-btn" onclick="deleteTeam('${escJsAttr(team.id)}')">✕</button>` : ''}
      </div>
      <div class="team-players">`;
    if (!players.length) {
      html += `<div class="team-empty">No players yet.</div>`;
    } else {
      for (const p of players) {
        const avUrl = avatarURL(p);
        const av = avUrl ? `style="background-image:url('${escAttr(avUrl)}')"` : '';
        const profUrl = profileURL(p);
        const nameHtml = profUrl
          ? `<a class="pl-droid" href="${escAttr(profUrl)}" target="_blank" rel="noopener">${escAttr(p.droid || '—')}</a>`
          : `<span class="pl-droid">${escAttr(p.droid || '—')}</span>`;
        const flag = flagHTML(countryCode(p), 'pl-flag');
        html += `<div class="team-player">
          <div class="pl-avatar" ${av}></div>
          <div class="pl-info">
            <div class="pl-top">${flag}${nameHtml}${p.rank ? `<span class="pl-rank">#${escAttr(String(p.rank))}</span>` : ''}</div>
            ${p.discord ? `<div class="pl-discord">${escAttr(p.discord)}</div>` : ''}
          </div>
        </div>`;
      }
    }
    html += `</div></div>`;
  }
  if (!teams.length && !canEdit) {
    html += `<div class="empty"><b>No teams yet</b><p>Reveal Admin (add <code>#admin</code> to the URL) to add teams.</p></div>`;
  }
  if (canEdit) {
    html += `<div class="team-add-card" onclick="openTeamEditor(null)">＋ Add Team</div>`;
  }
  html += '</div>';
  body.innerHTML = html;
}

// ---- team editor modal ----
let teamDraft = null;

function openTeamEditor(id) {
  const t = curT();
  if (!t) return;
  if (!t.teams) t.teams = [];
  if (id) {
    const team = t.teams.find(x => x.id === id);
    if (!team) return;
    teamDraft = { id: team.id, name: team.name, seed: team.seed || '', players: (team.players || []).map(p => ({ ...p })) };
    document.getElementById('team-modal-title').textContent = 'Edit Team';
  } else {
    teamDraft = { id: null, name: '', seed: '', players: [{ droid: '', uid: '', discord: '', avatar: '', rank: '', country: '', profile: '' }] };
    document.getElementById('team-modal-title').textContent = 'New Team';
  }
  document.getElementById('team-name-input').value = teamDraft.name;
  document.getElementById('team-seed-input').value = teamDraft.seed || '';
  renderPlayerRows();
  document.getElementById('team-modal').classList.add('show');
}

function renderPlayerRows() {
  const c = document.getElementById('team-players-edit');
  c.innerHTML = (teamDraft.players || []).map((p, i) => {
    const prevUrl = avatarURL(p);
    const prev = prevUrl ? `style="background-image:url('${escAttr(prevUrl)}')"` : '';
    return `
    <div class="tp-edit-row" data-i="${i}">
      <div class="tp-e-prev" ${prev}></div>
      <input class="tp-e-droid" placeholder="osu!droid username" value="${escAttr(p.droid || '')}">
      <input class="tp-e-uid" placeholder="player ID" value="${escAttr(p.uid || '')}" oninput="onUidInput(${i})">
      <button class="tp-e-fetch" onclick="fetchDroidProfile(${i})" title="Fetch username + rank + country from player ID">Fetch</button>
      <input class="tp-e-rank" placeholder="dpp rank" value="${escAttr(p.rank || '')}">
      <input class="tp-e-country" placeholder="Country (PL)" maxlength="2" value="${escAttr(p.country || '')}" oninput="onCountryInput(${i})">
      <span class="tp-e-flag" data-i="${i}">${flagHTML(countryCode(p))}</span>
      <input class="tp-e-discord" placeholder="Discord username" value="${escAttr(p.discord || '')}">
      <input class="tp-e-avatar" placeholder="Avatar URL (override, optional)" value="${escAttr(p.avatar || '')}">
      <input class="tp-e-profile" placeholder="Profile URL (override, optional)" value="${escAttr(p.profile || '')}">
      <button class="tp-e-del" onclick="removePlayerRow(${i})" title="Remove">✕</button>
      <div class="tp-e-status" data-i="${i}"></div>
    </div>`;
  }).join('') || '<div style="font-size:12px;color:var(--muted);">No players yet — add one below.</div>';
}

// Live flag preview as the country code is typed.
function onCountryInput(i) {
  const row = document.querySelector(`#team-players-edit .tp-edit-row[data-i="${i}"]`);
  if (!row) return;
  const cc = row.querySelector('.tp-e-country').value.trim();
  const flag = row.querySelector('.tp-e-flag');
  if (flag) flag.innerHTML = flagHTML(cc);
}

// Live avatar preview as the player ID is typed (no fetch, just the deterministic URL).
function onUidInput(i) {
  const row = document.querySelector(`#team-players-edit .tp-edit-row[data-i="${i}"]`);
  if (!row) return;
  const uid = row.querySelector('.tp-e-uid').value.trim();
  const ovr = row.querySelector('.tp-e-avatar').value.trim();
  const prev = row.querySelector('.tp-e-prev');
  const url = ovr || (/^\d+$/.test(uid) ? `https://osudroid.moe/user/avatar/${uid}.png` : '');
  prev.style.backgroundImage = url ? `url('${url}')` : '';
}

// Fetch username + PP rank from osudroid.moe by player ID.
// The profile page sends no CORS header, so we read it through a CORS proxy and
// scrape the server-rendered HTML.
//
// PROXY_BASE: your own Cloudflare Worker (see droid-proxy-worker.js). When set, it is
// tried FIRST and is reliable. Paste your worker URL here, e.g.
//   const PROXY_BASE = 'https://droid-proxy.mailvigre.workers.dev';
// Leave '' to rely only on the flaky public proxies below.
const PROXY_BASE = 'https://droid-proxy.mailvigre.workers.dev';

// Public fallbacks (used when PROXY_BASE is empty or down). Often rate-limited/offline.
const CORS_PROXIES = [
  enc => ({ url: 'https://api.allorigins.win/get?url=' + enc, json: true }),
  enc => ({ url: 'https://corsproxy.io/?url=' + enc }),
  enc => ({ url: 'https://api.codetabs.com/v1/proxy?quest=' + enc }),
  enc => ({ url: 'https://thingproxy.freeboard.io/fetch/' + decodeURIComponent(enc) }),
];

function looksLikeProfileHTML(html) {
  return html && html.length > 500 && !/^error code:/i.test(html.trim());
}

async function fetchProfileHTML(uid) {
  // 1) Your own worker first (stable): /?uid=<id>
  if (PROXY_BASE) {
    try {
      const r = await fetch(PROXY_BASE.replace(/\/+$/, '') + '/?uid=' + encodeURIComponent(uid));
      if (r.ok) { const html = await r.text(); if (looksLikeProfileHTML(html)) return html; }
    } catch (_) { /* fall through to public proxies */ }
  }
  // 2) Public proxies as fallback
  const target = `https://osudroid.moe/profile.php?uid=${uid}`;
  const enc = encodeURIComponent(target);
  for (const make of CORS_PROXIES) {
    const { url, json } = make(enc);
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const html = json ? ((await r.json()).contents || '') : await r.text();
      if (looksLikeProfileHTML(html)) return html;
    } catch (_) { /* try next proxy */ }
  }
  return '';
}

async function fetchDroidProfile(i) {
  const row = document.querySelector(`#team-players-edit .tp-edit-row[data-i="${i}"]`);
  if (!row) return;
  const uid = row.querySelector('.tp-e-uid').value.trim();
  const status = row.querySelector('.tp-e-status');
  if (!/^\d+$/.test(uid)) { status.textContent = 'Enter a numeric player ID first.'; status.className = 'tp-e-status err'; return; }

  status.textContent = 'Fetching…'; status.className = 'tp-e-status';
  try {
    const html = await fetchProfileHTML(uid);
    if (!html) throw new Error('all proxies unavailable — try again or fill in manually');

    const info = parseDroidProfile(html, uid);
    if (!info.name) throw new Error('player not found (check the ID)');

    const dn = row.querySelector('.tp-e-droid');
    const rk = row.querySelector('.tp-e-rank');
    const cy = row.querySelector('.tp-e-country');
    dn.value = info.name;
    if (info.ppRank) rk.value = info.ppRank;
    // Only fill country if the field is empty, so a manual override isn't clobbered.
    if (info.country && cy && !cy.value.trim()) { cy.value = info.country; onCountryInput(i); }
    onUidInput(i);
    const bits = [info.name];
    if (info.ppRank) bits.push('PP rank #' + info.ppRank);
    if (info.country) bits.push(info.country);
    status.textContent = '✓ ' + bits.join(' · '); status.className = 'tp-e-status ok';
  } catch (e) {
    status.textContent = 'Error: ' + e.message + '.';
    status.className = 'tp-e-status err';
  }
}

// Scrape username + PP rank from the profile.php HTML.
// Header markup: "<a ...>Willumina</a> ... uid ‹ 173730 ›" and "PP Rank: <a># 23</a>".
function parseDroidProfile(html, uid) {
  let name = '';
  // The username anchor sits right before the "uid ‹ <id> ›" anchor.
  const anchors = [...html.matchAll(/<a[^>]*>([^<]*)<\/a>/g)].map(m => m[1].trim());
  const uidIdx = anchors.findIndex(a => a.replace(/[^\d]/g, '') === uid && /uid/i.test(a));
  if (uidIdx > 0) name = anchors[uidIdx - 1].trim();
  // Fallback: first non-empty anchor that isn't the uid/Profile/menu boilerplate.
  if (!name) {
    name = anchors.find(a => a && !/^uid|Profile$|Login|Register|#/.test(a)) || '';
  }
  let ppRank = '';
  const m = html.match(/PP\s*Rank:\s*<a>\s*#?\s*([0-9,]+)/i);
  if (m) ppRank = m[1].replace(/,/g, '');
  // Country: the profile's Technical Analysis lists "Location: PL" (2-letter code).
  // Allow any tags/whitespace/colons between the label and the code (table cells etc.),
  // and require an exact 2-letter token so a full country name isn't half-matched.
  let country = '';
  const cm = html.match(/Location[\s:]*(?:<[^>]*>\s*)*\b([A-Za-z]{2})\b/i);
  if (cm) country = cm[1].toUpperCase();
  return { name, ppRank, country };
}

function readPlayerRows() {
  return [...document.querySelectorAll('#team-players-edit .tp-edit-row')].map(r => ({
    droid: r.querySelector('.tp-e-droid').value.trim(),
    uid: r.querySelector('.tp-e-uid').value.trim(),
    rank: r.querySelector('.tp-e-rank').value.trim(),
    country: r.querySelector('.tp-e-country').value.trim().toUpperCase(),
    discord: r.querySelector('.tp-e-discord').value.trim(),
    avatar: r.querySelector('.tp-e-avatar').value.trim(),
    profile: r.querySelector('.tp-e-profile').value.trim()
  })).filter(p => p.droid || p.discord || p.avatar || p.rank || p.uid || p.country);
}

function addPlayerRow() {
  teamDraft.players = readPlayerRows();
  teamDraft.players.push({ droid: '', uid: '', discord: '', avatar: '', rank: '', country: '', profile: '' });
  renderPlayerRows();
}

function removePlayerRow(i) {
  teamDraft.players = readPlayerRows();
  teamDraft.players.splice(i, 1);
  renderPlayerRows();
}

function saveTeamEditor() {
  const t = curT();
  if (!t || !teamDraft) return;
  if (!t.teams) t.teams = [];
  const name = document.getElementById('team-name-input').value.trim() || 'Team';
  const seed = document.getElementById('team-seed-input').value.trim();
  const players = readPlayerRows();
  if (teamDraft.id) {
    const team = t.teams.find(x => x.id === teamDraft.id);
    if (team) { team.name = name; team.seed = seed; team.players = players; }
  } else {
    t.teams.push({ id: 'tm' + Date.now() + Math.floor(Math.random() * 1000), name, seed, players });
  }
  if (!saveState()) { alert('Storage full — could not save.'); return; }
  closeTeamEditor();
  renderTeams();
}

function deleteTeam(id) {
  const t = curT();
  if (!t || !t.teams) return;
  const team = t.teams.find(x => x.id === id);
  if (!confirm(`Delete team "${team ? team.name : ''}"?`)) return;
  t.teams = t.teams.filter(x => x.id !== id);
  saveState();
  renderTeams();
}

function closeTeamEditor() { document.getElementById('team-modal').classList.remove('show'); teamDraft = null; }
function handleTeamOverlayClick(e) { if (e.target === document.getElementById('team-modal')) closeTeamEditor(); }

function saveChallonge() {
  const t = admT();
  const st = document.getElementById('challonge-status');
  if (!t) { st.textContent = 'Select a tournament first.'; st.className = 'fetch-status err'; return; }
  const raw = document.getElementById('challonge-input').value;
  const slug = parseChallongeSlug(raw);
  if (!slug) { st.textContent = 'Could not read a tournament slug.'; st.className = 'fetch-status err'; return; }
  t.challongeSlug = slug;
  saveState();
  st.textContent = `Saved: ${slug}`; st.className = 'fetch-status ok';
  if (state.page === 'bracket') renderBracket();
}

function fillChallongeField() {
  const t = admT();
  const ci = document.getElementById('challonge-input');
  if (ci) ci.value = (t && t.challongeSlug) ? `https://challonge.com/${t.challongeSlug}` : '';
}

function parseChallongeSlug(raw) {
  if (!raw) return '';
  raw = raw.trim();
  const m = raw.match(/challonge\.com\/([A-Za-z0-9_]+)/);
  if (m) return m[1];
  const s = raw.match(/([A-Za-z0-9_]+)\s*$/);
  return s ? s[1] : '';
}

// ==================== CUSTOM BRACKET ENGINE ====================
const BYE = '__BYE__';

function stageLabel(stage) {
  if (stage === 'ALL') return 'All Stages';
  return STAGE_NAMES[stage] || stage || 'this stage';
}

function bracketOf(t) {
  if (!t.bracket || typeof t.bracket !== 'object') t.bracket = {};
  const b = t.bracket;
  if (b.type !== 'single' && b.type !== 'double') b.type = 'double';
  if (![4, 8, 16, 32].includes(b.size)) b.size = 8;
  if (!Array.isArray(b.participants)) b.participants = [];
  if (!b.scores || typeof b.scores !== 'object') b.scores = {};
  if (!b.slots || typeof b.slots !== 'object') b.slots = {}; // manual slot overrides: { matchKey: [name0, name1] }
  return b;
}

// Round-title helpers
function seRoundTitle(r, k) {
  if (r === k) return 'Final';
  if (r === k - 1) return 'Semifinals';
  if (r === k - 2) return 'Quarterfinals';
  return 'Round ' + r;
}
function wbRoundTitle(r, k) {
  if (r === k) return 'Winners Final';
  if (r === k - 1) return 'Winners Semifinals';
  return 'Winners Round ' + r;
}

// Build the full bracket structure from t.bracket, resolving participants + winners.
function buildBracket(t) {
  const b = bracketOf(t);
  const size = b.size, k = Math.round(Math.log2(size)), scores = b.scores;
  const parts = [];
  for (let i = 0; i < size; i++) parts.push((b.participants[i] || '').trim());

  function decide(m) {
    const real1 = m.p1 && m.p1 !== BYE, real2 = m.p2 && m.p2 !== BYE;
    // BYE auto-advance
    if (m.p1 === BYE && real2) { m.winner = m.p2; m.loser = ''; m.decided = true; return; }
    if (m.p2 === BYE && real1) { m.winner = m.p1; m.loser = ''; m.decided = true; return; }
    const sc = scores[m.key];
    if (sc && real1 && real2) {
      const s1 = Number(sc[0]), s2 = Number(sc[1]);
      if (sc[0] !== '' && sc[1] !== '' && !isNaN(s1) && !isNaN(s2)) {
        m.s1 = s1; m.s2 = s2;
        if (s1 !== s2) {
          if (s1 > s2) { m.winner = m.p1; m.loser = m.p2; }
          else { m.winner = m.p2; m.loser = m.p1; }
          m.decided = true; return;
        }
      }
    }
    m.winner = ''; m.loser = ''; m.decided = false;
  }
  // mk: build a match. auto1/auto2 = computed feed; manual slot overrides (b.slots) take precedence.
  const slots = b.slots || {};
  const mk = (key, p1, p2) => {
    const m = { key, auto1: p1 || '', auto2: p2 || '' };
    const ov = slots[key];
    m.p1 = (ov && ov[0]) ? ov[0] : m.auto1;
    m.p2 = (ov && ov[1]) ? ov[1] : m.auto2;
    decide(m);
    return m;
  };

  // WINNERS — pair participants in listed order (line 1 vs 2, 3 vs 4, ...)
  const winners = [];
  const w1 = [];
  for (let i = 0; i < size / 2; i++) {
    const a = parts[2 * i] || '', bb = parts[2 * i + 1] || '';
    const p1 = a !== '' ? a : (bb !== '' ? BYE : '');
    const p2 = bb !== '' ? bb : (a !== '' ? BYE : '');
    w1.push(mk(`W-1-${i}`, p1, p2));
  }
  winners.push(w1);
  for (let r = 2; r <= k; r++) {
    const prev = winners[r - 2], cur = [];
    for (let i = 0; i < prev.length / 2; i++) cur.push(mk(`W-${r}-${i}`, prev[2 * i].winner, prev[2 * i + 1].winner));
    winners.push(cur);
  }

  if (b.type === 'single') return { type: 'single', size, k, winners, losers: [], grand: null };

  // LOSERS (double elimination)
  const losers = [];
  let prevW = [];
  { // LB round 1 — losers of WR1 paired
    const wr1 = winners[0], cur = [];
    for (let i = 0; i < wr1.length / 2; i++) cur.push(mk(`L-1-${i}`, wr1[2 * i].loser, wr1[2 * i + 1].loser));
    losers.push(cur); prevW = cur;
  }
  for (let r = 2; r <= k; r++) {
    // major round: previous LB winners vs losers dropping from WR r.
    // Standard anti-rematch seeding: drop the WB losers in REVERSED order so a team
    // doesn't immediately replay the opponent that just knocked it down (manual
    // overrides via b.slots can still adjust any pairing afterwards).
    const wr = winners[r - 1], cur = [];
    const drops = wr.map(m => m.loser);
    if (drops.length > 1) drops.reverse();
    for (let i = 0; i < prevW.length; i++) cur.push(mk(`L-maj-${r}-${i}`, prevW[i].winner, drops[i]));
    losers.push(cur); prevW = cur;
    // minor round: halve the survivors (skip after the final major round)
    if (r < k) {
      const cur2 = [];
      for (let i = 0; i < prevW.length / 2; i++) cur2.push(mk(`L-min-${r}-${i}`, prevW[2 * i].winner, prevW[2 * i + 1].winner));
      losers.push(cur2); prevW = cur2;
    }
  }

  // GRAND FINAL
  const wbFinal = winners[k - 1][0];
  const lbChamp = prevW[0];
  const grand = mk('GF', wbFinal.winner, lbChamp.winner);
  const needsReset = grand.decided && grand.winner && lbChamp.winner && grand.winner === lbChamp.winner;
  const grandReset = needsReset ? mk('GFR', wbFinal.winner, lbChamp.winner) : null;

  return { type: 'double', size, k, winners, losers, grand, grandReset };
}

function bracketChampion(data) {
  if (data.type === 'double') {
    if (data.grandReset) return data.grandReset.winner || '';
    if (data.grand && data.grand.decided) return data.grand.winner || '';
    return '';
  }
  const last = data.winners[data.winners.length - 1];
  return last && last[0] ? last[0].winner : '';
}

function cbName(n) { return n === BYE ? 'BYE' : (n && n !== '' ? escAttr(n) : 'TBD'); }

function bracketMatchHTML(m) {
  const slot = (name, isWin, score) => {
    const tbd = !name || name === '';
    return `<div class="cb-slot${isWin ? ' cb-win' : ''}${tbd ? ' cb-tbd' : ''}">`
      + `<span class="cb-name">${cbName(name)}</span>`
      + `<span class="cb-score">${score == null ? '' : score}</span></div>`;
  };
  const w1 = m.decided && m.winner !== '' && m.winner === m.p1;
  const w2 = m.decided && m.winner !== '' && m.winner === m.p2;
  return `<div class="cb-match">${slot(m.p1, w1, m.s1)}${slot(m.p2, w2, m.s2)}</div>`;
}

function bracketSectionHTML(name, rounds, extraClass='') {
  const roundMatchesHTML = (matches, hasNext) => {
    if (!hasNext) return matches.map(bracketMatchHTML).join('');
    const chunks = [];
    for (let i = 0; i < matches.length; i += 2) {
      const pair = matches.slice(i, i + 2).map(bracketMatchHTML).join('');
      chunks.push(`<div class="cb-pair">${pair}</div>`);
    }
    return chunks.join('');
  };
  const cols = rounds.map((r, idx) => `<div class="cb-round">
      <div class="cb-round-title">${r.title}</div>
      <div class="cb-round-matches">${roundMatchesHTML(r.matches, idx < rounds.length - 1)}</div>
    </div>`).join('');
  return `<div class="cb-section${extraClass ? ' ' + extraClass : ''}"><div class="cb-section-title">${name}</div>`
    + `<div class="cb-rounds"><svg class="cb-lines" aria-hidden="true"></svg>${cols}</div></div>`;
}

function renderBracket() {
  const t = curT();
  const c = document.getElementById('bracket-body');
  const link = document.getElementById('bracket-open-link');
  const titleEl = document.getElementById('bracket-title');
  if (titleEl && t) titleEl.innerHTML = `${tournamentNameHTML(t.name)} <span style="color:var(--muted);font-weight:600;">— Bracket</span>`;

  // Challonge link button (optional, external)
  const slug = t ? (t.challongeSlug || '') : '';
  if (link) {
    if (slug) { link.style.display = ''; link.href = `https://challonge.com/${slug}`; }
    else link.style.display = 'none';
  }

  if (!t) { c.innerHTML = `<div class="bracket-empty">Select a tournament first.</div>`; return; }
  const b = bracketOf(t);
  if (b.participants.filter(x => (x || '').trim()).length < 2) {
    c.innerHTML = `<div class="bracket-empty">
      <b style="font-size:16px;color:var(--text);">Bracket not set up yet</b>
      <p style="margin-top:8px;">Open Admin → <b>Bracket</b>, choose a format/size, list participants and press Generate.</p>
    </div>`;
    return;
  }

  const data = buildBracket(t);
  const wbRounds = data.winners.map((ms, idx) => ({
    title: data.type === 'single' ? seRoundTitle(idx + 1, data.k) : wbRoundTitle(idx + 1, data.k),
    matches: ms
  }));
  let html = bracketSectionHTML(data.type === 'single' ? 'Bracket' : 'Winners Bracket', wbRounds);
  if (data.type === 'double') {
    const lbRounds = data.losers.map((ms, idx) => ({
      title: idx + 1 === data.losers.length ? 'Losers Final' : 'Losers Round ' + (idx + 1),
      matches: ms
    }));
    const gfMatches = [{ title: 'Grand Final', matches: [data.grand] }];
    if (data.grandReset) gfMatches.push({ title: 'Bracket Reset', matches: [data.grandReset] });
    const winnersHTML = bracketSectionHTML('Winners Bracket', wbRounds);
    const gfHTML = bracketSectionHTML('Grand Final', gfMatches, 'gf-side');
    html = `<div class="cb-topline">${winnersHTML}${gfHTML}</div>` + bracketSectionHTML('Losers Bracket', lbRounds);
  }
  const podiumHTML = bracketPodiumHTML(data);
  c.innerHTML = `${podiumHTML}<div class="cb-wrap">${html}</div>`;
  drawBracketLines();
}

// Final standings (top 3) derived from the finished bracket.
function bracketPodium(data) {
  const first = bracketChampion(data);
  if (!first) return null;                 // no champion yet -> no podium
  let second = '', third = '';
  if (data.type === 'double') {
    const gf = (data.grandReset && data.grandReset.decided) ? data.grandReset : data.grand;
    if (gf && gf.decided) second = gf.loser || '';
    const lf = (data.losers && data.losers.length) ? data.losers[data.losers.length - 1][0] : null;
    if (lf && lf.decided) third = lf.loser || '';
  } else {
    const finalM = data.winners[data.winners.length - 1][0];
    if (finalM && finalM.decided) second = finalM.loser || '';
    // single elim has no 3rd-place match -> both semifinal losers share 3rd
    const sf = data.winners.length >= 2 ? data.winners[data.winners.length - 2] : null;
    if (sf) third = sf.map(m => (m.decided ? m.loser : '')).filter(x => x && x !== BYE).join(' / ');
  }
  return { first, second, third };
}

function bracketPodiumHTML(data) {
  const p = bracketPodium(data);
  if (!p || !p.first) return '';
  const place = { 1: '1st', 2: '2nd', 3: '3rd' };
  const tier = (rank, name, cls) => {
    if (!name || name === BYE) return '';
    const badge = rank === 1 ? svgIcon('trophy') : String(rank);
    return `<div class="cb-pod ${cls}">
      <span class="cb-pod-badge">${badge}</span>
      <span class="cb-pod-meta">
        <span class="cb-pod-place">${place[rank]}</span>
        <span class="cb-pod-name" title="${escAttr(name)}">${escAttr(name)}</span>
      </span>
    </div>`;
  };
  const first = tier(1, p.first, 'cb-pod-1');
  if (!first) return '';
  const rest = tier(2, p.second, 'cb-pod-2') + tier(3, p.third, 'cb-pod-3');
  return `<div class="cb-podium">
    <div class="cb-podium-title">Final Standings</div>
    <div class="cb-podium-row">${first}${rest}</div>
  </div>`;
}

// ---- Bracket connector lines (SVG overlay computed from real match positions) ----
// Measure real match positions and (re)draw every connector overlay. Cheap enough
// to call on any layout change; the .cb-lines SVGs are absolute overlays, so redrawing
// never changes .cb-wrap's size (no ResizeObserver feedback loop).
function drawBracketLinesNow() {
  const wrap = document.querySelector('#bracket-body .cb-wrap');
  if (!wrap || wrap.getClientRects().length === 0) return;   // not laid out / hidden
  wrap.querySelectorAll('.cb-section').forEach(sec => {
    const rounds = sec.querySelector('.cb-rounds');
    const svg = sec.querySelector('.cb-lines');
    if (rounds && svg) drawSectionConnectors(rounds, svg);
  });
  const top = wrap.querySelector('.cb-topline');
  if (top) drawToplineConnectors(top);          // Winners Final -> Grand Final
}

function drawBracketLines() {
  if (!drawBracketLines._bound) {
    window.addEventListener('resize', () => { if (state.page === 'bracket') drawBracketLines(); });
    // Web fonts change text metrics after first paint → box positions shift. Redraw once ready.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (state.page === 'bracket') drawBracketLines(); });
    drawBracketLines._bound = true;
  }
  const draw = () => {
    drawBracketLinesNow();
    // Observe the current wrap so browser zoom / reflow / late layout re-triggers a redraw.
    // Re-observe each render because renderBracket replaces the .cb-wrap element.
    const wrap = document.querySelector('#bracket-body .cb-wrap');
    if (wrap && typeof ResizeObserver === 'function') {
      if (!drawBracketLines._ro) {
        drawBracketLines._ro = new ResizeObserver(() => {
          if (state.page !== 'bracket') return;
          clearTimeout(drawBracketLines._rot);
          drawBracketLines._rot = setTimeout(drawBracketLinesNow, 50);
        });
      }
      drawBracketLines._ro.disconnect();
      drawBracketLines._ro.observe(wrap);
    }
  };
  // Wait two frames so fonts/layout settle before measuring (single rAF sometimes fires
  // mid-layout, which is what made a few connectors land off-target).
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(draw));
  else draw();
}

function cbAnchor(el, base, side) {
  const r = el.getBoundingClientRect();
  // Round to whole pixels so an even-width stroke stays crisp and lands on the box centre.
  return {
    x: Math.round((side === 'right' ? r.right : r.left) - base.left),
    y: Math.round(r.top + r.height / 2 - base.top)
  };
}

function cbLinePath(svg, d) {
  if (!d) return;
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d.trim());
  p.setAttribute('class', 'cb-line');
  svg.appendChild(p);
}

// One elbow: N sources (right edge) -> one target (left edge).
function cbElbow(svg, base, sources, target) {
  const t = cbAnchor(target, base, 'left');
  const srcs = sources.map(s => cbAnchor(s, base, 'right'));
  if (!srcs.length) return;
  const srcX = Math.max(...srcs.map(s => s.x));
  const midX = Math.round(srcX + (t.x - srcX) / 2);
  const ys = srcs.map(s => s.y).concat(t.y);
  let d = '';
  srcs.forEach(s => { d += `M ${s.x} ${s.y} H ${midX} `; });   // stub out of each source
  d += `M ${midX} ${Math.min(...ys)} V ${Math.max(...ys)} `;   // vertical spine
  d += `M ${midX} ${t.y} H ${t.x} `;                           // into the target
  cbLinePath(svg, d);
}

function drawSectionConnectors(rounds, svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const base = rounds.getBoundingClientRect();
  const cols = [...rounds.querySelectorAll('.cb-round')];
  for (let r = 1; r < cols.length; r++) {
    const prev = [...cols[r - 1].querySelectorAll('.cb-match')];
    const cur = [...cols[r].querySelectorAll('.cb-match')];
    if (!prev.length || !cur.length) continue;
    const ratio = prev.length / cur.length;   // 2 = standard merge, 1 = carry-over (LB major round)
    cur.forEach((tm, i) => {
      let sources;
      if (ratio === 2) sources = [prev[2 * i], prev[2 * i + 1]];
      else if (ratio === 1) sources = [prev[i]];
      else return;                            // unexpected shape -> skip rather than draw garbage
      cbElbow(svg, base, sources.filter(Boolean), tm);
    });
  }
}

function drawToplineConnectors(top) {
  let svg = top.querySelector(':scope > .cb-topline-lines');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cb-lines cb-topline-lines');
    svg.setAttribute('aria-hidden', 'true');
    top.insertBefore(svg, top.firstChild);
  }
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const wb = top.querySelector('.cb-section:not(.gf-side)');
  const gf = top.querySelector('.cb-section.gf-side');
  if (!wb || !gf) return;
  const wbFinal = [...wb.querySelectorAll('.cb-round:last-child .cb-match')].pop();
  const gfFirst = gf.querySelector('.cb-round .cb-match');
  if (!wbFinal || !gfFirst) return;
  const base = top.getBoundingClientRect();
  const s = cbAnchor(wbFinal, base, 'right');
  const t = cbAnchor(gfFirst, base, 'left');
  const midX = Math.round(s.x + (t.x - s.x) / 2);
  cbLinePath(svg, `M ${s.x} ${s.y} H ${midX} V ${t.y} H ${t.x}`);
}

// ---- Bracket admin editor ----
function fillBracketFields() {
  const t = admT(); if (!t) return;
  const b = bracketOf(t);
  const ty = document.getElementById('bracket-type'); if (ty) ty.value = b.type;
  const sz = document.getElementById('bracket-size'); if (sz) sz.value = String(b.size);
  const pa = document.getElementById('bracket-participants');
  if (pa) pa.value = (b.participants || []).filter((x, i) => i < b.size).join('\n');
  renderBracketScoreEditor();
}

function saveBracketSetup() {
  const t = admT(); if (!t) return;
  const b = bracketOf(t);
  b.type = document.getElementById('bracket-type').value === 'single' ? 'single' : 'double';
  b.size = parseInt(document.getElementById('bracket-size').value, 10) || 8;
  const lines = document.getElementById('bracket-participants').value.split('\n').map(s => s.trim());
  b.participants = lines.slice(0, b.size);
  while (b.participants.length < b.size) b.participants.push('');
  saveState();
  const st = document.getElementById('bracket-setup-status');
  if (st) { st.textContent = 'Bracket generated.'; st.className = 'fetch-status ok'; }
  renderBracketScoreEditor();
  if (state.page === 'bracket') renderBracket();
}

function renderBracketScoreEditor() {
  const host = document.getElementById('bracket-score-editor'); if (!host) return;
  const t = admT(); if (!t) { host.innerHTML = ''; return; }
  const b = bracketOf(t);
  if (b.participants.filter(x => (x || '').trim()).length < 2) {
    host.innerHTML = `<div class="field-label">Add at least 2 participants and press Generate to enter scores.</div>`;
    return;
  }
  const data = buildBracket(t);
  const block = (title, matches) => `<div class="bk-ed-round"><div class="bk-ed-rtitle">${title}</div>${matches.map(bkScoreRowHTML).join('')}</div>`;
  let h = '';
  data.winners.forEach((ms, idx) => { h += block(data.type === 'single' ? seRoundTitle(idx + 1, data.k) : wbRoundTitle(idx + 1, data.k), ms); });
  if (data.type === 'double') {
    data.losers.forEach((ms, idx) => { h += block(idx + 1 === data.losers.length ? 'Losers Final' : 'Losers Round ' + (idx + 1), ms); });
    h += block('Grand Final', [data.grand]);
    if (data.grandReset) h += block('Bracket Reset', [data.grandReset]);
  }
  host.innerHTML = h;
}

// A participant slot in the editor: dropdown (auto / pick any participant / BYE) to manually override pairings.
function bkSlotSelect(m, idx) {
  const t = admT(), b = bracketOf(t);
  const ov = b.slots[m.key] || ['', ''];
  const cur = ov[idx] || '';
  const autoName = idx === 0 ? m.auto1 : m.auto2;
  const autoLabel = autoName === BYE ? 'auto: BYE' : (autoName ? 'auto: ' + autoName : 'auto (TBD)');
  const parts = b.participants.map(x => (x || '').trim()).filter(Boolean);
  let opts = `<option value=""${cur === '' ? ' selected' : ''}>${escAttr(autoLabel)}</option>`;
  for (const p of parts) opts += `<option value="${escAttr(p)}"${cur === p ? ' selected' : ''}>${escAttr(p)}</option>`;
  opts += `<option value="${BYE}"${cur === BYE ? ' selected' : ''}>BYE</option>`;
  const cls = 'bk-ed-sel' + (cur ? ' bk-ed-sel-ov' : '') + (idx === 1 ? ' bk-ed-sel-r' : '');
  return `<select class="${cls}" onchange="setBracketSlot('${m.key}',${idx},this.value)">${opts}</select>`;
}

function bkScoreRowHTML(m) {
  const t = admT(), b = bracketOf(t);
  const sc = b.scores[m.key] || ['', ''];
  const playable = m.p1 && m.p1 !== BYE && m.p2 && m.p2 !== BYE;
  const inp = (i) => `<input type="number" class="bk-ed-score" value="${escAttr(String(sc[i] == null ? '' : sc[i]))}"`
    + `${playable ? '' : ' disabled'} onchange="setBracketScore('${m.key}',${i},this.value)" />`;
  return `<div class="bk-ed-row">
    ${bkSlotSelect(m, 0)}
    ${inp(0)}<span class="bk-ed-dash">–</span>${inp(1)}
    ${bkSlotSelect(m, 1)}
  </div>`;
}

function setBracketScore(key, idx, val) {
  const t = admT(); if (!t) return;
  const b = bracketOf(t);
  if (!b.scores[key]) b.scores[key] = ['', ''];
  b.scores[key][idx] = val === '' ? '' : val;
  if (b.scores[key][0] === '' && b.scores[key][1] === '') delete b.scores[key];
  saveState();
  renderBracketScoreEditor();          // names advance live
  if (state.page === 'bracket') renderBracket();
}

function setBracketSlot(key, idx, val) {
  const t = admT(); if (!t) return;
  const b = bracketOf(t);
  if (!b.slots[key]) b.slots[key] = ['', ''];
  b.slots[key][idx] = val || '';
  if (b.slots[key][0] === '' && b.slots[key][1] === '') delete b.slots[key];
  saveState();
  renderBracketScoreEditor();          // pairings + downstream advance live
  if (state.page === 'bracket') renderBracket();
}

function setLbSort(key) {
  if (state.lbSort.key === key) {
    state.lbSort.dir = state.lbSort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    state.lbSort.key = key;
    state.lbSort.dir = key === 'player' ? 'asc' : 'desc';
  }
  saveState();
  renderLeaderboard();
}

// ==================== HELPERS ====================
function slotClass(slot) {
  if (!slot) return 's-xx';
  const u = slot.toUpperCase();
  if (u.startsWith('NM')) return 's-nm';
  if (u.startsWith('HD')) return 's-hd';
  if (u.startsWith('HR')) return 's-hr';
  if (u.startsWith('DT')) return 's-dt';
  if (u.startsWith('FL')) return 's-fl';
  if (u.startsWith('TB')) return 's-tb';
  if (u.startsWith('PR')) return 's-pr';
  if (u.startsWith('FM')) return 's-fm';
  return 's-xx';
}

function modPills(mods) {
  if (!mods.length) return '<span class="mp mp-NM">NM</span>';
  return mods.map(m => {
    const c = ['NM','HD','HR','DT','NC','FL','PR','FM','EZ'].includes(m)?'mp-'+m:'mp-XX';
    return `<span class="mp ${c}">${escAttr(m)}</span>`;
  }).join('');
}

function accCls(acc) {
  const a = Number(acc);
  if (!Number.isFinite(a)) return 'am';
  if (a >= 98) return 'ah';   // high
  if (a >= 95) return 'am';   // mid
  return 'al';                // low
}

function removeMap(key) {
  const t = admT();
  if (!t) return;
  const sd = getStageData(t, state.adminStage);
  sd.mapOrder = sd.mapOrder.filter(k => k !== key);
  delete sd.slotOverrides[key];
  saveState();
  renderAdminMapOrder();
  renderAll();
}

function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function safeURL(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw, window.location.href);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch (e) {
    return '';
  }
}

function escJsAttr(s) {
  return String(s)
    .replace(/\\/g,'\\\\')
    .replace(/'/g,'\\u0027')
    .replace(/\r/g,'\\r')
    .replace(/\n/g,'\\n')
    .replace(/&/g,'&amp;')
    .replace(/"/g,'&quot;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

// ==================== PLAYER PROFILE ====================
function openProfile(name) {
  const t = curT();
  if (!t) return;
  const entries = collectStageMaps(t).filter(e => !e.info._empty);

  const scores = [];
  for (const {sd, key, info} of entries) {
    const slot = getSlot(sd, key, info.mapName) || '??';
    const displayName = info.mapName.replace(/\[(?:NM|HD|HR|DT|NC|FM|PR|FL|TB|EZ)\d*\]\s*/i,'').trim();
    for (const p of getPlayerScores(info)) {
      if (p.userName === name) {
        const mods = (p.playMod||[]).map(m=>m.acronym).filter(m=>m!=='V2');
        scores.push({ slot, map: displayName, score: p.score, acc: p.accuracy*100, mods, match: p._matchName || info.matchName || '' });
      }
    }
  }

  if (!scores.length) return;

  const totalScore = scores.reduce((s,x)=>s+x.score,0);
  const avgScore = Math.round(totalScore / scores.length);
  const avgAcc = scores.reduce((s,x)=>s+x.acc,0) / scores.length;
  const best = scores.reduce((m,x)=>x.score>m.score?x:m, scores[0]);

  // Most-played mod: count each actual mod the player used across their scores
  // (a no-mod play counts as NM). The single most frequent mod is the "Top Mod".
  const modCount = {};
  scores.forEach(s => {
    const ms = (s.mods && s.mods.length) ? s.mods : ['NM'];
    ms.forEach(mod => { modCount[mod] = (modCount[mod] || 0) + 1; });
  });
  const favMod = Object.entries(modCount).sort((a,b)=>b[1]-a[1])[0]?.[0] || '—';

  // Match the match-history nickname against the team roster to pull a real avatar + profile link.
  const rp = rosterByName()[name.trim().toLowerCase()];
  const avEl = document.getElementById('profile-avatar');
  const avUrl = rp ? avatarURL(rp) : '';
  if (avUrl) {
    avEl.textContent = '';
    avEl.style.backgroundImage = `url('${avUrl}')`;
    avEl.classList.add('has-img');
  } else {
    avEl.style.backgroundImage = '';
    avEl.classList.remove('has-img');
    avEl.textContent = name.charAt(0).toUpperCase();
  }
  const profUrl = rp ? profileURL(rp) : '';
  const nameFlag = rp ? flagHTML(countryCode(rp), 'profile-flag') : '';
  document.getElementById('profile-name').innerHTML = nameFlag + (profUrl
    ? `<a href="${escAttr(profUrl)}" target="_blank" rel="noopener" class="profile-name-link">${escAttr(name)}</a>`
    : escAttr(name));
  document.getElementById('profile-stage').textContent = `${t.name} · ${stageLabel(state.currentStage)} · ${scores.length} map${scores.length>1?'s':''} played`;

  let body = `<div class="profile-stats">
    <div class="pstat"><div class="pstat-val" data-count="${avgScore}">0</div><div class="pstat-lbl">Avg Score</div></div>
    <div class="pstat"><div class="pstat-val">${avgAcc.toFixed(2)}%</div><div class="pstat-lbl">Avg Acc</div></div>
    <div class="pstat"><div class="pstat-val" data-count="${best.score}">0</div><div class="pstat-lbl">Best Score</div></div>
    <div class="pstat"><div class="pstat-val">${favMod}</div><div class="pstat-lbl">Top Mod</div></div>
  </div>
  <div class="profile-section-title">Scores in ${escAttr(stageLabel(state.currentStage))}</div>
  <table class="profile-scores"><thead><tr>
    <th style="width:48px;">Slot</th><th>Map</th>
    <th class="r" style="width:110px;">Score</th>
    <th class="r" style="width:80px;">Acc</th>
    <th class="r" style="width:90px;">Mods</th>
  </tr></thead><tbody>`;

  scores.sort((a,b)=>b.score-a.score).forEach((s,i)=>{
    const delay = Math.min(i*0.04, 0.4);
    body += `<tr style="animation-delay:${delay}s">
      <td><span class="slot-badge ${slotClass(s.slot)}" style="font-size:10px;padding:2px 6px;">${s.slot}</span></td>
      <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;" title="${escAttr(s.map)}">${s.map}</td>
      <td class="r">${s.score.toLocaleString()}</td>
      <td class="r">${s.acc.toFixed(2)}%</td>
      <td class="r">${modPills(s.mods)}</td>
    </tr>`;
  });

  body += '</tbody></table>';
  document.getElementById('profile-body').innerHTML = body;
  document.getElementById('profile-modal').classList.add('show');
  animateCounts(document.getElementById('profile-body'));
}

function closeProfile() { document.getElementById('profile-modal').classList.remove('show'); }
function handleProfileOverlayClick(e) {
  if (e.target === document.getElementById('profile-modal')) closeProfile();
}

// ==================== ADMIN PASSWORD ====================
// The admin password is verified server-side by the Cloudflare Worker (see
// verifyAdminPassword / the /auth route). Nothing sensitive — no password, no
// hash — is stored in this public file. To change the password, update the
// ADMIN_SECRET value in the Worker's environment variables.

// The Admin button stays hidden until the user visits the page with #admin
// in the URL. This keeps admin controls invisible to ordinary visitors.
function revealAdminIfRequested() {
  if (location.hash.toLowerCase() === '#admin') {
    const b1 = document.getElementById('admin-toggle-btn');
    if (b1) b1.style.display = '';
  }
}
window.addEventListener('hashchange', revealAdminIfRequested);
revealAdminIfRequested();

function refreshAdminPanel() {
  buildAdminStagePills();
  renderAdminTournaments();
  fillTournamentInfoFields();
  buildAdminStageVisibility();
  renderAdminMatchList();
  renderAdminMapOrder();
  fillChallongeField();
  renderStorageUsage();
  const lp = document.getElementById('logo-preview');
  if (lp) { if (state.logo) { lp.src = state.logo; lp.classList.add('show'); } else { lp.classList.remove('show'); } }
  const sp = document.getElementById('splashbg-preview');
  if (sp) { if (state.splashBg) { sp.style.backgroundImage = `url('${state.splashBg}')`; sp.classList.add('show'); } else { sp.style.backgroundImage = ''; sp.classList.remove('show'); } }
}

// ---- storage usage panel (admin → Danger) ----
// Shows total state size vs the ~5MB localStorage quota, plus a per-item breakdown
// of the embedded base64 images so it's obvious what to shrink when full.
function renderStorageUsage() {
  const el = document.getElementById('storage-usage');
  if (!el) return;
  const kb = s => Math.round((s || '').length / 1024);
  const total = kb(JSON.stringify(state));
  const LIMIT = 5000; // ≈ localStorage quota in KB
  const pct = Math.min(100, Math.round(total / LIMIT * 100));

  // collect embedded images: site-wide + per tournament
  const items = [];
  if (state.logo) items.push({ label: 'Site logo', size: kb(state.logo) });
  if (state.splashBg) items.push({ label: 'Splash background', size: kb(state.splashBg) });
  for (const t of state.tournaments) {
    if (t.banner) items.push({ label: `Banner — ${t.name}`, size: kb(t.banner) });
    // match data can be big too (per-tournament, everything except the banner)
    const dataSize = kb(JSON.stringify(t)) - kb(t.banner || '');
    items.push({ label: `Data — ${t.name} (matches, teams, mappool…)`, size: dataSize });
  }
  items.sort((a, b) => b.size - a.size);

  const over = total > LIMIT;
  const barCls = over ? 'err' : (pct > 80 ? 'warn' : '');
  const rows = items.map(it => `<div class="su-row">
    <span class="su-label" title="${escAttr(it.label)}">${escAttr(it.label)}</span>
    <span class="su-size">${it.size.toLocaleString()} KB</span>
  </div>`).join('');

  el.innerHTML = `
    <div class="su-bar"><div class="su-fill ${barCls}" style="width:${pct}%"></div></div>
    <div class="su-total ${over ? 'err' : ''}">${total.toLocaleString()} / ~${LIMIT.toLocaleString()} KB${over ? ' — over the local limit! Offline cache is not saving.' : ''}</div>
    <div class="su-list">${rows}</div>`;
}

async function toggleAdmin() {
  const ov = document.getElementById('admin-overlay');
  const btn = document.getElementById('admin-toggle-btn');
  const isOpen = ov.classList.contains('show');
  if (isOpen) {
    ov.classList.remove('show');
    btn.classList.remove('active');
    // refresh public views so admin-only controls (e.g. the in-match add-score form) appear
    applyPage();
    return;
  }
  const input = prompt('Enter admin password:');
  if (input === null) return;
  // verify the password against the Worker — nothing sensitive lives in this file
  const check = await verifyAdminPassword(input);
  if (check === 'unreachable') {
    alert('Cannot reach the server to verify the password. Check your connection and try again.');
    return;
  }
  if (!check) { alert('Wrong password.'); return; }
  adminUnlocked = true;
  // keep the plaintext (this device only) so it can authorize remote pushes
  adminSecret = input;
  try { localStorage.setItem('odt_admin_secret', input); } catch (e) {}
  // stamp a fresh timestamp so this device's data (incl. pre-sync local data)
  // is treated as canonical and propagates to other devices
  state.updatedAt = Date.now();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  pushRemote();   // seed/refresh the shared copy now that we can write
  ov.classList.add('show');
  btn.classList.add('active');
  switchAdminTab(adminTab);
  // edit the tournament that's currently open (or first)
  state.adminTournamentId = state.currentTournamentId || (state.tournaments[0] && state.tournaments[0].id);
  state.adminStage = state.currentStage;
  refreshAdminPanel();
  // re-render the public page behind the drawer so admin-only controls
  // (＋ Add Tournament, team Edit buttons, map ✕) appear now that we're unlocked
  applyPage();
}

// ==================== KICK OFF (after ALL top-level consts are initialized) ====================
// Full init lives here, not near the top of the file: readStateFromURL needs VIEWS,
// renderBracket needs BYE, setupSplashVideo needs SPLASH_* — all consts declared
// throughout the file. Running any of this earlier hits the temporal dead zone.
loadState();
ensureSeed();
readStateFromURL();
renderBrand();
buildAdminStagePills();
buildAdminStageVisibility();
buildEmptySlotGrid();
applyPage();
renderAll();
setupSplashVideo();
syncFromRemote();   // pull shared data from the Worker; falls back to local cache
