let allData = {}; // slotKey -> { mapName, slot, slotType, scores: [{player, score, acc, mods, matchName}] }

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
  return 's-xx';
}

function extractSlot(mapName) {
  const m = mapName.match(/\[([A-Z]{1,3}\d*)\]/i);
  return m ? m[1].toUpperCase() : null;
}

function slotSortKey(slot) {
  if (!slot) return 999;
  const order = ['NM','HD','HR','DT','FL','PR','TB'];
  const type = slot.replace(/\d+$/, '');
  const num = parseInt(slot.replace(/^[A-Z]+/i, '')) || 0;
  const ti = order.indexOf(type.toUpperCase());
  return (ti === -1 ? 50 : ti) * 100 + num;
}

function modPills(mods) {
  if (!mods || !mods.length) return '<span class="mod-pill mod-NM">NM</span>';
  return mods.filter(m => m !== 'V2').map(m => {
    const cls = ['NM','HD','HR','DT','FL','PR','EZ'].includes(m) ? 'mod-' + m : 'mod-XX';
    return `<span class="mod-pill ${cls}">${m}</span>`;
  }).join('') || '<span class="mod-pill mod-NM">NM</span>';
}

function accClass(acc) {
  if (acc >= 98) return 'acc-high';
  if (acc >= 95) return 'acc-mid';
  return 'acc-low';
}

async function loadMatches() {
  const raw = document.getElementById('urls-input').value.trim();
  if (!raw) { setStatus('Enter at least one URL.', 'err'); return; }

  const urls = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  const ids = urls.map(u => {
    const m = u.match(/[?&]id=(\d+)/) || u.match(/^(\d+)$/);
    return m ? m[1] : null;
  }).filter(Boolean);

  if (!ids.length) { setStatus('No valid match IDs found.', 'err'); return; }

  document.getElementById('load-btn').disabled = true;
  allData = {};

  let loaded = 0;
  let errors = 0;

  for (const id of ids) {
    setStatus(`Loading ${loaded + errors + 1}/${ids.length}...`);
    try {
      const resp = await fetch(`https://osudroid.kansenindex.dev/api/tournament/getrooms_history?id=${id}`);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      processMatch(data, id);
      loaded++;
    } catch(e) {
      errors++;
      console.warn('Failed to load match', id, e.message);
    }
  }

  document.getElementById('load-btn').disabled = false;

  if (loaded === 0) {
    setStatus('Failed to load any matches. CORS error — use bookmarklet version.', 'err');
    return;
  }

  setStatus(`Loaded ${loaded} match${loaded > 1 ? 'es' : ''}${errors ? `, ${errors} failed` : ''}.`, 'ok');
  document.getElementById('tabs').style.display = 'flex';
  renderMappoolStats();
  renderLeaderboard();
}

function processMatch(data, id) {
  const matchName = data.name || `Match #${id}`;
  const sessions = data.sessions || [];

  for (const session of sessions) {
    const slot = extractSlot(session.mapName);
    const key = slot || session.mapName;

    if (!allData[key]) {
      allData[key] = {
        mapName: session.mapName,
        slot: slot,
        slotType: slot ? slot.replace(/\d+$/, '').toUpperCase() : 'XX',
        scores: []
      };
    }

    const players = (session.scores || []).filter(s =>
      s.team !== null && !(s.score === 0 && !s.isAlive)
    );

    for (const p of players) {
      const mods = (p.playMod || []).map(m => m.acronym).filter(m => m !== 'V2');
      allData[key].scores.push({
        player: p.userName,
        score: p.score,
        acc: parseFloat((p.accuracy * 100).toFixed(2)),
        mods: mods,
        matchName: matchName
      });
    }
  }
}

function renderMappoolStats() {
  const keys = Object.keys(allData).sort((a, b) => slotSortKey(allData[a].slot) - slotSortKey(allData[b].slot));

  if (!keys.length) {
    document.getElementById('tab-mappool').innerHTML = '<div class="empty">No data found.</div>';
    return;
  }

  const summary = buildSummary();
  let html = `<div class="summary-bar">
    <div class="summary-item"><div class="summary-val">${summary.matches}</div><div class="summary-lbl">Matches</div></div>
    <div class="summary-item"><div class="summary-val">${summary.maps}</div><div class="summary-lbl">Maps Played</div></div>
    <div class="summary-item"><div class="summary-val">${summary.players}</div><div class="summary-lbl">Players</div></div>
    <div class="summary-item"><div class="summary-val">${summary.scores}</div><div class="summary-lbl">Total Scores</div></div>
  </div>`;

  html += '<div class="mappool-grid">';

  for (const key of keys) {
    const d = allData[key];
    const sc = [...d.scores].sort((a, b) => b.score - a.score);
    const avgScore = sc.length ? Math.round(sc.reduce((s, x) => s + x.score, 0) / sc.length) : 0;
    const avgAcc = sc.length ? (sc.reduce((s, x) => s + x.acc, 0) / sc.length).toFixed(2) : '0.00';
    const topScore = sc[0]?.score || 0;
    const cls = slotClass(d.slot);
    const displayName = d.mapName.replace(/\[[A-Z]{1,3}\d*\]\s*/i, '').trim();

    html += `<div class="map-card">
      <div class="map-card-header">
        <span class="slot-badge ${cls}">${d.slot || '??'}</span>
        <span class="map-title" title="${d.mapName}">${displayName}</span>
      </div>
      <div class="map-stats">
        <div class="stat-item"><div class="stat-val">${avgScore.toLocaleString()}</div><div class="stat-lbl">Avg Score</div></div>
        <div class="stat-item"><div class="stat-val">${avgAcc}%</div><div class="stat-lbl">Avg Acc</div></div>
        <div class="stat-item"><div class="stat-val">${sc.length}</div><div class="stat-lbl">Scores</div></div>
      </div>
      <div class="map-players">`;

    sc.slice(0, 5).forEach((s, i) => {
      const rankCls = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
      html += `<div class="top-player">
        <span class="top-rank ${rankCls}">#${i+1}</span>
        <span class="top-name">${s.player}</span>
        <span class="top-score">${s.score.toLocaleString()}</span>
        <span class="top-acc ${accClass(s.acc)}">${s.acc}%</span>
        <span class="top-mods">${modPills(s.mods)}</span>
      </div>`;
    });

    html += `</div></div>`;
  }

  html += '</div>';
  document.getElementById('tab-mappool').innerHTML = html;
}

function renderLeaderboard() {
  const keys = Object.keys(allData).sort((a, b) => slotSortKey(allData[a].slot) - slotSortKey(allData[b].slot));

  if (!keys.length) {
    document.getElementById('tab-leaderboard').innerHTML = '<div class="empty">No data found.</div>';
    return;
  }

  let html = '';

  for (const key of keys) {
    const d = allData[key];
    const sc = [...d.scores].sort((a, b) => b.score - a.score);
    const cls = slotClass(d.slot);
    const displayName = d.mapName.replace(/\[[A-Z]{1,3}\d*\]\s*/i, '').trim();

    html += `<div class="lb-section">
      <div class="lb-header">
        <span class="slot-badge lb-slot ${cls}">${d.slot || '??'}</span>
        <span class="lb-mapname">${displayName}</span>
      </div>
      <table class="lb-table">
        <thead><tr>
          <th>#</th>
          <th>Player</th>
          <th class="r">Score</th>
          <th class="r">Accuracy</th>
          <th class="r">Mods</th>
          <th class="r">Match</th>
        </tr></thead>
        <tbody>`;

    sc.forEach((s, i) => {
      const rankCls = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
      html += `<tr>
        <td class="rank-cell ${rankCls}">${i+1}</td>
        <td class="player-cell">${s.player}</td>
        <td class="score-cell">${s.score.toLocaleString()}</td>
        <td class="acc-cell ${accClass(s.acc)}">${s.acc}%</td>
        <td class="mods-cell">${modPills(s.mods)}</td>
        <td class="match-cell">${s.matchName}</td>
      </tr>`;
    });

    html += `</tbody></table></div>`;
  }

  document.getElementById('tab-leaderboard').innerHTML = html;
}

function buildSummary() {
  const matchNames = new Set();
  const playerNames = new Set();
  let totalScores = 0;
  for (const d of Object.values(allData)) {
    for (const s of d.scores) {
      matchNames.add(s.matchName);
      playerNames.add(s.player);
      totalScores++;
    }
  }
  return {
    matches: matchNames.size,
    maps: Object.keys(allData).length,
    players: playerNames.size,
    scores: totalScores
  };
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => {
    t.classList.toggle('active', ['mappool','leaderboard'][i] === name);
  });
  document.getElementById('tab-mappool').classList.toggle('show', name === 'mappool');
  document.getElementById('tab-leaderboard').classList.toggle('show', name === 'leaderboard');
}

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.className = 'status' + (type ? ' ' + type : '');
  el.textContent = msg;
}