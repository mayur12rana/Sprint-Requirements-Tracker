/* Sprint Requirements Dashboard — add-ons (Load Requirements, Affected Area by Team,
   light-theme guard, live visitor counter). Loaded by index.html; keep in the same folder. */

/* ════════════════════════════════════════════════════════════════════
   Feature Progress → "Load Requirements"
   Loads every child item (Requirement / Change Request / …) mapped under
   each feature and shows them as a "Child Items" panel below the feature
   row. Self-contained: it only reads featureProgressData and never changes
   feature data, AHA data, AHA status updates or the TFS update popup.
   Task calculations mirror the Feature Lookup tool so numbers match.
   ════════════════════════════════════════════════════════════════════ */
window._fpReq = {
  state: 'idle',          // idle | loading | ready | error
  collapsed: false,
  error: '',
  progress: '',
  dataRef: null,          // featureProgressData array the cache belongs to
  cache: {},              // fid -> { children:[], featureAreaPath, iterNames:[] }
  childTaskMap: {},       // childId -> [taskIds]
  taskLookup: {},         // taskId -> task
  iter: {},               // fid -> iteration filter
  sort: {},               // fid -> { col, dir }
  closed: new Set(),      // fids whose Child Items panel is collapsed
  statusSel: null,        // null = all requirement statuses, else Set of selected statuses
  sel: {},                // fid -> Set(childId) checked in that feature's Child Items table
  shownIds: {},           // fid -> [childId] currently visible in that table
  allowed: {},            // "project|type" -> { states:[], statuses:[{v,l}] } (cached picklists)
  area: {},               // fid -> child Area Path filter ('all' or full path)
  reqIter: {}             // fid -> child Iteration Path filter ('all' or full path)
};

function _fpReqStatusOf(c) {
  const v = (c.fields['Casepoint.TFS.CustomFields.Status'] || '').trim();
  return v || '-';
}

function _fpReqEsc(v) {
  return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* Reset when the Feature Progress data was reloaded (new area / iteration). */
function _fpReqCheckStale() {
  const S = window._fpReq;
  if (S.dataRef !== featureProgressData) {
    S.state = 'idle'; S.collapsed = false; S.error = ''; S.progress = '';
    S.dataRef = featureProgressData;
    S.cache = {}; S.childTaskMap = {}; S.taskLookup = {}; S.iter = {}; S.sort = {}; S.closed = new Set(); S.statusSel = null; S.sel = {}; S.shownIds = {}; S.area = {}; S.reqIter = {};
    const tbl = document.getElementById('featureProgressTable');
    if (tbl) tbl.classList.remove('fp-req-collapsed');
  }
}

function _fpReqSyncBtn() {
  const btn = document.getElementById('fpReqToggleBtn');
  if (!btn) return;
  _fpReqCheckStale();
  const S = window._fpReq;
  const content = document.getElementById('featureProgressContent');
  const allowed = typeof hasPermission === 'function' && hasPermission('loadRequirements');
  const show = allowed && content && content.style.display !== 'none' && Array.isArray(featureProgressData) && featureProgressData.length > 0;
  btn.style.display = show ? 'inline-block' : 'none';
  btn.disabled = S.state === 'loading';
  if (S.state === 'loading')      btn.textContent = '⏳ Loading requirements…' + (S.progress ? ' ' + S.progress : '');
  else if (S.state === 'error')   btn.textContent = '🔁 Retry Requirements';
  else if (S.state === 'ready')   btn.textContent = _fpReqAllClosed() ? '📂 Expand All Requirements' : '📁 Collapse All Requirements';
  else                            btn.textContent = '📋 Load Requirements';
  const tbl = document.getElementById('featureProgressTable');
  if (tbl) tbl.classList.remove('fp-req-collapsed');
  const fw = document.getElementById('fpReqStatusFilterWrap');
  if (fw) {
    const showFilter = show && S.state === 'ready' && !_fpReqAllClosed();
    fw.style.display = showFilter ? '' : 'none';
    if (!showFilter) {
      const dd = fw.querySelector('.fp-multiselect-dropdown');
      if (dd) dd.classList.remove('open');
      const b = fw.querySelector('.fp-multiselect-btn');
      if (b) b.classList.remove('open');
    }
  }
}

/* Re-render the main table but keep any expanded AHA rows open. */
function _fpReqRerender() {
  const open = [...document.querySelectorAll('#featureProgressTableBody .fp-child-row.visible')].map(r => r.id.slice(4));
  renderFeatureProgressTable();
  if (window._fpReq.state !== 'idle' && _fpReqAhaOn()) return;   // _fpReqAfterRender handled it
  open.forEach(id => {
    const r = document.getElementById('fpc-' + id);
    const b = document.getElementById('fpx-' + id);
    if (r) r.classList.add('visible');
    if (b) b.classList.add('expanded');
  });
}

async function toggleFpRequirements() {
  if (typeof hasPermission === 'function' && !hasPermission('loadRequirements')) return;
  _fpReqCheckStale();
  const S = window._fpReq;
  if (S.state === 'loading') return;
  if (S.state === 'ready') {
    _fpReqSetAll(_fpReqAllClosed());
    return;
  }
  // idle or error → load
  S.state = 'loading'; S.collapsed = false; S.error = ''; S.progress = '';
  _fpReqSyncBtn();
  _fpReqRerender();               // inserts "Loading…" rows under every feature
  const dataRef = featureProgressData;
  try {
    await _fpReqFetch(dataRef);
    if (dataRef !== featureProgressData) return;   // data reloaded meanwhile
    S.state = 'ready';
    S.statusSel = null;
    _fpReqBuildStatusFilter();
  } catch (e) {
    if (dataRef !== featureProgressData) return;
    console.error('[FP Requirements] load error:', e);
    S.state = 'error';
    S.error = e && e.message ? e.message : String(e);
  }
  S.progress = '';
  _fpReqRefreshPanels();
  _fpReqSyncBtn();
}

function _fpReqSetProgress(txt) {
  window._fpReq.progress = txt;
  _fpReqSyncBtn();
}

async function _fpReqFetch(list) {
  const S = window._fpReq;
  const ids = list.map(f => f.id);
  if (!ids.length) return;

  _fpReqSetProgress('(1/3)');
  const feats = await batchFetchWithRelations(ids);
  if (!feats.length) throw new Error('Could not read feature links from TFS.');
  const childMap = {};
  const allChild = new Set();
  feats.forEach(ft => {
    const c = (ft.relations || [])
      .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Forward')
      .map(r => parseInt(r.url.split('/').pop(), 10))
      .filter(n => !isNaN(n));
    childMap[ft.id] = c;
    c.forEach(x => allChild.add(x));
  });

  _fpReqSetProgress('(2/3)');
  const children = allChild.size ? await batchFetchWithRelations([...allChild]) : [];
  const childLookup = {};
  const taskIds = new Set();
  const childTaskMap = {};
  children.forEach(c => {
    childLookup[c.id] = c;
    const t = (c.relations || [])
      .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Forward')
      .map(r => r.url.split('/').pop());
    childTaskMap[c.id] = t;
    t.forEach(x => taskIds.add(x));
  });

  _fpReqSetProgress('(3/3)');
  let tasks = taskIds.size ? await batchFetchWorkItems([...taskIds], [
    'System.Id','System.WorkItemType','System.AreaPath','System.IterationPath','System.Reason',
    'Microsoft.VSTS.Common.Discipline','Microsoft.VSTS.Scheduling.OriginalEstimate',
    'Microsoft.VSTS.Scheduling.RemainingWork','Microsoft.VSTS.Scheduling.CompletedWork'
  ]) : [];
  tasks = tasks.filter(t => t.fields['System.WorkItemType'] === 'Task');
  const taskLookup = {};
  tasks.forEach(t => { taskLookup[t.id] = t; });

  const cache = {};
  list.forEach(f => {
    const kids = (childMap[f.id] || []).map(id => childLookup[id]).filter(Boolean);
    const iterNames = new Set();
    kids.forEach(c => (childTaskMap[c.id] || []).forEach(tid => {
      const t = taskLookup[tid];
      if (!t) return;
      const ip = (t.fields['System.IterationPath'] || '').split('\\').pop().trim();
      if (ip && ip.toLowerCase() !== 'casepointara') iterNames.add(ip);
    }));
    cache[f.id] = {
      children: kids,
      featureAreaPath: (f.areaPath || '').toLowerCase().trim(),
      iterNames: [...iterNames].sort()
    };
  });
  S.cache = cache; S.childTaskMap = childTaskMap; S.taskLookup = taskLookup;
}

/* Same rules as the Feature Lookup "Child Items" table. */
function _fpReqCompute(entry, iterFilter) {
  const S = window._fpReq;
  const excludedDisc = ['analysis', 'user experience', 'user education'];
  const excludedActual = ['user experience', 'user education'];
  const includedPlanned = ['development', 'analysis', 'test'];
  const tot = { orig: 0, rem: 0, comp: 0, plan: 0, cdev: 0, act: 0 };
  const rows = entry.children.map(c => {
    const tIds = S.childTaskMap[c.id] || [];
    const r = { c, tasks: tIds.length, orig: 0, rem: 0, comp: 0, plan: 0, cdev: 0, act: 0 };
    tIds.forEach(tid => {
      const task = S.taskLookup[tid];
      if (!task) return;
      const disc = (task.fields['Microsoft.VSTS.Common.Discipline'] || '').toLowerCase().trim();
      const iterLeaf = (task.fields['System.IterationPath'] || '').split('\\').pop().trim();
      const reason = (task.fields['System.Reason'] || '').toLowerCase().trim();
      const taskArea = (task.fields['System.AreaPath'] || '').toLowerCase().trim();
      const isRoot = iterLeaf.toLowerCase() === 'casepointara';
      const isRejected = reason === 'rejected';
      if (iterFilter !== 'all' && iterLeaf !== iterFilter) return;
      const orig = task.fields['Microsoft.VSTS.Scheduling.OriginalEstimate'] || 0;
      const rem  = task.fields['Microsoft.VSTS.Scheduling.RemainingWork'] || 0;
      const comp = task.fields['Microsoft.VSTS.Scheduling.CompletedWork'] || 0;
      r.orig += orig; r.rem += rem; r.comp += comp;
      if (!excludedActual.includes(disc) && !isRoot && !isRejected) r.act += comp;
      if (includedPlanned.includes(disc) && !isRoot && !isRejected) r.plan += orig;
      if (!excludedDisc.includes(disc) && !isRoot && !isRejected && taskArea === entry.featureAreaPath) r.cdev += comp;
    });
    Object.keys(tot).forEach(k => { tot[k] += r[k]; });
    return r;
  });
  return { rows, tot };
}

function _fpReqSortRows(rows, s) {
  if (!s || !s.col) return rows;
  const dir = s.dir === 'asc' ? 1 : -1;
  const F = r => r.c.fields;
  const get = {
    id: r => r.c.id,
    title: r => (F(r)['System.Title'] || '').toLowerCase(),
    type: r => (F(r)['System.WorkItemType'] || '').toLowerCase(),
    state: r => (F(r)['System.State'] || '').toLowerCase(),
    status: r => (F(r)['Casepoint.TFS.CustomFields.Status'] || '').toLowerCase(),
    assigned: r => (F(r)['System.AssignedTo']?.displayName || '').toLowerCase(),
    area: r => (F(r)['System.AreaPath'] || '').toLowerCase(),
    iteration: r => (F(r)['System.IterationPath'] || '').toLowerCase(),
    size: r => F(r)['Microsoft.VSTS.Scheduling.Size'] || 0,
    tasks: r => r.tasks, origEst: r => r.orig, rem: r => r.rem, comp: r => r.comp,
    taskPlan: r => r.plan, taskCDev: r => r.cdev, taskACmp: r => r.act
  }[s.col];
  if (!get) return rows;
  return [...rows].sort((a, b) => {
    const va = get(a), vb = get(b);
    if (typeof va === 'string') return va < vb ? -dir : va > vb ? dir : 0;
    return ((va || 0) - (vb || 0)) * dir;
  });
}

function _fpReqPanelInner(fid) {
  const S = window._fpReq;
  if (S.state === 'loading') return `<div class="fp-req-panel"><div class="fp-req-msg">⏳ Loading child items…</div></div>`;
  if (S.state === 'error')   return `<div class="fp-req-panel"><div class="fp-req-msg err">❌ Could not load child items: ${_fpReqEsc(S.error)}. Use “Retry Requirements” above.</div></div>`;
  const entry = S.cache[fid];
  if (!entry) return `<div class="fp-req-panel"><div class="fp-req-msg">Child items for this feature were not loaded.</div></div>`;

  let iterFilter = S.iter[fid] || 'all';
  if (iterFilter !== 'all' && !entry.iterNames.includes(iterFilter)) iterFilter = 'all';
  const allCount = entry.children.length;
  // Child item Area / Iteration options (from this feature's own child items)
  const areaOpts = [...new Set(entry.children.map(c => c.fields['System.AreaPath'] || '').filter(Boolean))].sort();
  const reqIterOpts = [...new Set(entry.children.map(c => c.fields['System.IterationPath'] || '').filter(Boolean))].sort();
  let areaF = S.area[fid] || 'all';
  if (areaF !== 'all' && !areaOpts.includes(areaF)) areaF = 'all';
  let reqIterF = S.reqIter[fid] || 'all';
  if (reqIterF !== 'all' && !reqIterOpts.includes(reqIterF)) reqIterF = 'all';
  const shown = entry.children.filter(c =>
    (!S.statusSel || S.statusSel.has(_fpReqStatusOf(c))) &&
    (areaF === 'all' || (c.fields['System.AreaPath'] || '') === areaF) &&
    (reqIterF === 'all' || (c.fields['System.IterationPath'] || '') === reqIterF));
  const anyFilter = !!S.statusSel || areaF !== 'all' || reqIterF !== 'all';
  const { rows, tot } = _fpReqCompute({ ...entry, children: shown }, iterFilter);
  const sc = S.sort[fid] || {};
  const sorted = _fpReqSortRows(rows, sc);
  const si = col => sc.col === col ? (sc.dir === 'asc' ? ' ▲' : ' ▼') : '';

  const leaf = v => String(v).split('\\').pop();
  const mkSel = (label, aria, cur, opts, fn, cls) => `<label class="fp-req-flt${cls ? ' ' + cls : ''}"><span>${label}</span><select class="fp-req-iter" aria-label="${aria}" onchange="${fn}(${fid}, this.value)">
<option value="all"${cur === 'all' ? ' selected' : ''}>All</option>
${opts.map(o => `<option value="${_fpReqEsc(o)}" title="${_fpReqEsc(o)}"${cur === o ? ' selected' : ''}>${_fpReqEsc(leaf(o))}</option>`).join('')}
</select></label>`;
  const areaSel = areaOpts.length > 1 || areaF !== 'all' ? mkSel('Area', 'Filter child items by area', areaF, areaOpts, 'onFpReqAreaChange', areaF !== 'all' ? 'on' : '') : '';
  const reqIterSel = reqIterOpts.length > 1 || reqIterF !== 'all' ? mkSel('Iteration', 'Filter child items by iteration', reqIterF, reqIterOpts, 'onFpReqReqIterChange', reqIterF !== 'all' ? 'on' : '') : '';
  const taskSel = entry.iterNames.length
    ? `<label class="fp-req-flt${iterFilter !== 'all' ? ' on' : ''}"><span>Task Sprint</span><select class="fp-req-iter" aria-label="Filter task hours by task sprint" onchange="onFpReqIterChange(${fid}, this.value)">
<option value="all"${iterFilter === 'all' ? ' selected' : ''}>All</option>
${entry.iterNames.map(n => `<option value="${_fpReqEsc(n)}"${iterFilter === n ? ' selected' : ''}>${_fpReqEsc(n)}</option>`).join('')}
</select></label>` : '';
  const clearBtn = (areaF !== 'all' || reqIterF !== 'all' || iterFilter !== 'all')
    ? `<button type="button" class="fp-req-clr" onclick="clearFpReqPanelFilters(${fid})" title="Clear this feature's Area / Iteration / Task Sprint filters">✕ Clear</button>` : '';
  const iterSel = `<div class="fp-req-flts">${areaSel}${reqIterSel}${taskSel}${clearBtn}</div>`;

  S.shownIds[fid] = shown.map(c => c.id);
  const selSet = S.sel[fid] || (S.sel[fid] = new Set());
  const selCount = S.shownIds[fid].filter(id => selSet.has(id)).length;
  const canUpdate = _fpReqCanUpdate();
  const updBtn = (canUpdate && shown.length)
    ? `<button type="button" class="fp-req-updbtn" id="fpru-${fid}" onclick="openFpReqUpdate(${fid})" ${selCount ? '' : 'disabled'} title="Update State / Status of the selected child items in TFS">✏️ Update State / Status${selCount ? ' (' + selCount + ')' : ''}</button>`
    : '';
  let html = `<div class="fp-req-panel">
<div class="fp-req-hdr"><div class="fp-req-hdr-left"><span class="fp-req-title">📋 Child Items (${anyFilter ? shown.length + ' of ' + allCount : allCount})</span>${updBtn}</div>${iterSel}</div>`;

  if (!allCount) {
    return html + `<div class="fp-req-msg">No child items are mapped to this feature.</div></div>`;
  }
  if (!shown.length) {
    return html + `<div class="fp-req-msg">No child items match the selected filters.</div></div>`;
  }

  const th = (col, label, cls) => `<th class="${cls || ''}" onclick="sortFpReq(${fid}, '${col}')">${label}${si(col)}</th>`;
  const allSel = selCount > 0 && selCount === shown.length;
  const chkHead = canUpdate
    ? `<th class="c fp-req-chkc" onclick="event.stopPropagation()"><input type="checkbox" id="fprsa-${fid}" aria-label="Select all child items" ${allSel ? 'checked' : ''} onchange="fpReqSelectAll(${fid}, this.checked)"></th>`
    : '';
  html += `<div class="fp-req-scroll"><table class="fp-req-tbl"><thead><tr>
${chkHead}${th('id','ID')}${th('title','Title')}${th('type','Type','c')}${th('state','State','c')}${th('status','Status','c')}
${th('assigned','Assigned')}${th('area','Area')}${th('iteration','Iteration')}${th('size','Size','r')}${th('tasks','Tasks','c')}
${th('origEst','Orig Est','r')}${th('rem','Rem','r')}${th('comp','Comp','r')}
${th('taskPlan','Task Plan','r')}${th('taskCDev','Task CDev','r')}${th('taskACmp','Task ACmp','r')}
</tr></thead><tbody>`;

  sorted.forEach(r => {
    const cf = r.c.fields;
    const proj = cf['System.TeamProject'] || project;
    const title = cf['System.Title'] || '';
    const assigned = cf['System.AssignedTo']?.displayName || '-';
    const state = cf['System.State'] || '';
    const status = cf['Casepoint.TFS.CustomFields.Status'] || '-';
    const chkCell = canUpdate
      ? `<td class="c fp-req-chkc"><input type="checkbox" class="fp-req-chk" data-fid="${fid}" data-cid="${r.c.id}" aria-label="Select ${r.c.id}" ${selSet.has(r.c.id) ? 'checked' : ''} onchange="fpReqSelectOne(${fid}, ${r.c.id}, this.checked)"></td>`
      : '';
    html += `<tr${selSet.has(r.c.id) ? ' class="fp-req-selrow"' : ''}>
${chkCell}<td><a href="${tfsUrl}/${encodeURIComponent(proj)}/_workitems/edit/${r.c.id}" target="_blank" class="wi-link">${r.c.id}</a></td>
<td class="fp-req-ttl" title="${_fpReqEsc(title)}">${_fpReqEsc(title)}</td>
<td class="c">${_fpReqEsc(cf['System.WorkItemType'] || '')}</td>
<td class="c"><span class="fp-state-pill ${getStatePillClass(state)}">${_fpReqEsc(state)}</span></td>
<td class="c"><span class="fp-status-pill ${getStatusPillClass(status)}" title="${_fpReqEsc(status)}">${_fpReqEsc(status)}</span></td>
<td class="fp-req-asg" title="${_fpReqEsc(assigned)}">${_fpReqEsc(assigned)}</td>
<td class="area" title="${_fpReqEsc(cf['System.AreaPath'] || '')}">${_fpReqEsc((cf['System.AreaPath'] || '').split('\\').pop())}</td>
<td class="iter" title="${_fpReqEsc(cf['System.IterationPath'] || '')}">${_fpReqEsc((cf['System.IterationPath'] || '').split('\\').pop())}</td>
<td class="r">${cf['Microsoft.VSTS.Scheduling.Size'] || 0}</td>
<td class="c">${r.tasks}</td>
<td class="r v">${fmtH(r.orig)}h</td>
<td class="r v">${fmtH(r.rem)}h</td>
<td class="r v">${fmtH(r.comp)}h</td>
<td class="r tp">${fmtH(r.plan)}h</td>
<td class="r tc">${fmtH(r.cdev)}h</td>
<td class="r ta">${fmtH(r.act)}h</td>
</tr>`;
  });

  html += `<tr class="fp-req-tot">
<td colspan="${canUpdate ? 11 : 10}" class="r v">Totals${(() => { const p = []; if (areaF !== 'all') p.push(leaf(areaF)); if (reqIterF !== 'all') p.push(leaf(reqIterF)); if (iterFilter !== 'all') p.push('task sprint ' + iterFilter); return p.length ? ' (' + _fpReqEsc(p.join(' · ')) + ')' : ''; })()}:</td>
<td class="r v">${fmtH(tot.orig)}h</td>
<td class="r v">${fmtH(tot.rem)}h</td>
<td class="r v">${fmtH(tot.comp)}h</td>
<td class="r tp">${fmtH(tot.plan)}h</td>
<td class="r tc">${fmtH(tot.cdev)}h</td>
<td class="r ta">${fmtH(tot.act)}h</td>
</tr></tbody></table></div></div>`;
  return html;
}

/* Show / hide permission-controlled features for the signed-in user (called from applyTabPermissions). */
function applyFeaturePermissions() {
  const can = k => typeof hasPermission === 'function' && hasPermission(k);
  // Sprint Planning → Affected Area Requirement by Team
  const blk = document.getElementById('piatBlock');
  if (blk) blk.style.display = can('affectedAreaByTeam') ? '' : 'none';
  // Feature Progress → Load Requirements (drop any loaded panels if access was removed)
  const S = window._fpReq;
  if (!can('loadRequirements') && S && S.state !== 'idle') {
    S.dataRef = null; _fpReqCheckStale();
    if (typeof renderFeatureProgressTable === 'function' && Array.isArray(featureProgressData) && featureProgressData.length) renderFeatureProgressTable();
  }
  _fpReqSyncBtn();
}

/* Called from renderFeatureProgressTable for every feature row. */
function _fpReqRow(f) {
  _fpReqCheckStale();
  if (window._fpReq.state === 'idle') return '';
  const head = document.querySelector('#featureProgressTable thead tr');
  const cols = head ? head.children.length : 16;
  const hidden = window._fpReq.closed.has(f.id) ? ' is-hidden' : '';
  return `<tr class="fp-req-row${hidden}" id="fprr-${f.id}"><td class="fp-req-cell" colspan="${cols}"><div class="fp-req-outer" id="fprp-${f.id}">${_fpReqPanelInner(f.id)}</div></td></tr>`;
}

function _fpReqRefreshPanels() {
  document.querySelectorAll('#featureProgressTableBody [id^="fprp-"]').forEach(el => {
    const fid = parseInt(el.id.slice(5), 10);
    el.innerHTML = _fpReqPanelInner(fid);
  });
}

function _fpReqRefreshOne(fid) {
  const el = document.getElementById('fprp-' + fid);
  if (el) el.innerHTML = _fpReqPanelInner(fid);
}

/* Chevron shown in the feature row's ID cell once requirements are loaded. */
function _fpReqAhaOn() {
  return !!(document.getElementById('ahaToggleCb')?.checked);
}

function _fpReqRowBtn(fid) {
  if (window._fpReq.state === 'idle') return '';
  if (_fpReqAhaOn()) return '';   // AHA's own ▶ in the first column controls both panels
  const open = !window._fpReq.closed.has(fid);
  return `<button type="button" class="fp-req-rowbtn${open ? ' open' : ''}" id="fprb-${fid}" aria-expanded="${open}" aria-controls="fprr-${fid}" onclick="toggleFpReqFeature(${fid})" title="${open ? 'Collapse' : 'Expand'} requirements">▶</button>`;
}

function _fpReqApplyOne(fid) {
  const open = !window._fpReq.closed.has(fid);
  const row = document.getElementById('fprr-' + fid);
  const btn = document.getElementById('fprb-' + fid);
  if (row) row.classList.toggle('is-hidden', !open);
  if (btn) {
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.title = (open ? 'Collapse' : 'Expand') + ' requirements';
  }
  if (_fpReqAhaOn()) {
    const ar = document.getElementById('fpc-' + fid);
    const ab = document.getElementById('fpx-' + fid);
    if (ar) ar.classList.toggle('visible', open);
    if (ab) ab.classList.toggle('expanded', open);
  }
}

/* AHA ▶ clicked: keep the requirements row in step (only once requirements are loaded). */
function _fpReqOnAhaToggle(fid, open) {
  const S = window._fpReq;
  if (S.state === 'idle') return;
  if (open) S.closed.delete(fid); else S.closed.add(fid);
  _fpReqApplyOne(fid);
  _fpReqSyncBtn();
}

/* After a table re-render, open/close AHA rows to match the requirement state. */
function _fpReqAfterRender() {
  if (window._fpReq.state === 'idle' || !_fpReqAhaOn()) return;
  (featureProgressData || []).forEach(f => _fpReqApplyOne(f.id));
}

/* Feature-level collapse / expand. */
function toggleFpReqFeature(fid) {
  const S = window._fpReq;
  if (S.closed.has(fid)) S.closed.delete(fid); else S.closed.add(fid);
  _fpReqApplyOne(fid);
  _fpReqSyncBtn();
}

/* Header button (after load): collapse all / expand all features. */
function _fpReqSetAll(open) {
  const S = window._fpReq;
  (featureProgressData || []).forEach(f => { if (open) S.closed.delete(f.id); else S.closed.add(f.id); });
  (featureProgressData || []).forEach(f => _fpReqApplyOne(f.id));
  _fpReqSyncBtn();
}

function _fpReqAllClosed() {
  const S = window._fpReq;
  return (featureProgressData || []).length > 0 && featureProgressData.every(f => S.closed.has(f.id));
}


/* ════════ Child item selection + State / Status update ════════ */
function _fpReqCanUpdate() {
  return typeof currentUserRole !== 'undefined' && ['admin', 'super_admin', 'pdm'].includes(currentUserRole);
}

function _fpReqSelUI(fid) {
  const S = window._fpReq;
  const set = S.sel[fid] || new Set();
  const shown = S.shownIds[fid] || [];
  const n = shown.filter(id => set.has(id)).length;
  const btn = document.getElementById('fpru-' + fid);
  if (btn) { btn.disabled = n === 0; btn.textContent = '✏️ Update State / Status' + (n ? ' (' + n + ')' : ''); }
  const all = document.getElementById('fprsa-' + fid);
  if (all) { all.checked = n > 0 && n === shown.length; all.indeterminate = n > 0 && n < shown.length; }
  document.querySelectorAll('#fprp-' + fid + ' .fp-req-chk').forEach(cb => {
    const tr = cb.closest('tr');
    if (tr) tr.classList.toggle('fp-req-selrow', cb.checked);
  });
}

function fpReqSelectOne(fid, cid, checked) {
  const S = window._fpReq;
  const set = S.sel[fid] || (S.sel[fid] = new Set());
  if (checked) set.add(cid); else set.delete(cid);
  _fpReqSelUI(fid);
}

function fpReqSelectAll(fid, checked) {
  const S = window._fpReq;
  const set = S.sel[fid] || (S.sel[fid] = new Set());
  (S.shownIds[fid] || []).forEach(id => { if (checked) set.add(id); else set.delete(id); });
  document.querySelectorAll('#fprp-' + fid + ' .fp-req-chk').forEach(cb => { cb.checked = checked; });
  _fpReqSelUI(fid);
}

/* Allowed State / Status values per work item type (TFS picklists, with safe fallbacks). */
async function _fpReqAllowedFor(proj, type) {
  const S = window._fpReq;
  const key = proj + '|' + type;
  if (S.allowed[key]) return S.allowed[key];
  const out = { states: [], statuses: [], fromTfs: false };
  const base = `${tfsUrl}/${encodeURIComponent(proj)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}`;
  try {
    const r = await apiFetch(`${base}/states?api-version=5.0-preview.1`);
    if (r.ok) { const d = await r.json(); out.states = (d.value || []).map(x => x.name).filter(Boolean); }
  } catch (e) { /* fall back below */ }
  try {
    const r = await apiFetch(`${base}/fields/Casepoint.TFS.CustomFields.Status?$expand=allowedValues&api-version=5.0`);
    if (r.ok) { const d = await r.json(); out.statuses = (d.allowedValues || []).map(v => ({ v, l: v })); out.fromTfs = out.statuses.length > 0; }
  } catch (e) { /* fall back below */ }
  if (!out.states.length) out.states = ['Proposed', 'Active', 'Resolved', 'Closed'];
  if (!out.statuses.length) {
    out.statuses = (window.DEFAULT_FEATURE_STATUSES || []).map(l => ({ v: (window._tfsStatusValue ? window._tfsStatusValue(l) : l), l }));
  }
  S.allowed[key] = out;
  return out;
}

function _fpReqModal() {
  let m = document.getElementById('fpReqUpdModal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'fpReqUpdModal';
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  m.setAttribute('aria-labelledby', 'fpReqUpdTitle');
  m.innerHTML = `<div class="fpru-box">
<div class="fpru-head"><div><h3 id="fpReqUpdTitle">✏️ Update State / Status</h3><p id="fpReqUpdSub"></p></div>
<button type="button" class="fpru-x" onclick="closeFpReqUpdate()" aria-label="Close">✕</button></div>
<div class="fpru-body" id="fpReqUpdBody"></div>
<div class="fpru-foot" id="fpReqUpdFoot"></div></div>`;
  m.addEventListener('click', e => { if (e.target === m && !window._fpReqUpdBusy) closeFpReqUpdate(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && m.classList.contains('open') && !window._fpReqUpdBusy) closeFpReqUpdate(); });
  document.body.appendChild(m);
  return m;
}

async function openFpReqUpdate(fid) {
  if (!_fpReqCanUpdate()) { alert('⚠️ Only Admin, Super Admin and PDM can update child items.'); return; }
  const S = window._fpReq;
  const entry = S.cache[fid];
  const set = S.sel[fid] || new Set();
  const items = entry ? entry.children.filter(c => set.has(c.id) && (S.shownIds[fid] || []).includes(c.id)) : [];
  if (!items.length) return;
  const feat = (featureProgressData || []).find(f => f.id === fid);
  const m = _fpReqModal();
  window._fpReqUpd = { fid, items };
  document.getElementById('fpReqUpdSub').textContent = `${items.length} selected child item${items.length > 1 ? 's' : ''} of feature #${fid}${feat ? ' — ' + feat.title : ''}`;
  document.getElementById('fpReqUpdBody').innerHTML = '<div class="fpru-msg">⏳ Loading allowed State and Status values…</div>';
  document.getElementById('fpReqUpdFoot').innerHTML = `<button type="button" class="fpru-btn sec" onclick="closeFpReqUpdate()">Cancel</button>`;
  m.classList.add('open');

  // union of allowed values across the selected work item types
  const combos = [...new Set(items.map(c => (c.fields['System.TeamProject'] || project) + '|' + (c.fields['System.WorkItemType'] || '')))];
  const lists = await Promise.all(combos.map(k => { const [pj, ty] = k.split('|'); return _fpReqAllowedFor(pj, ty); }));
  if (!window._fpReqUpd || window._fpReqUpd.fid !== fid) return;
  const states = [...new Set(lists.flatMap(l => l.states))];
  const stMap = new Map();
  lists.forEach(l => l.statuses.forEach(o => { if (!stMap.has(o.v)) stMap.set(o.v, o.l); }));
  items.forEach(c => { const v = c.fields['Casepoint.TFS.CustomFields.Status']; if (v && !stMap.has(v)) stMap.set(v, v); });
  const ordered = window._orderFeatureStatuses ? window._orderFeatureStatuses([...stMap.values()]) : [...stMap.values()];
  const statusOpts = ordered.map(l => [...stMap.entries()].find(([, lab]) => lab === l)).filter(Boolean);
  const typesTxt = [...new Set(items.map(c => c.fields['System.WorkItemType'] || ''))].join(', ');

  const rows = items.map(c => {
    const st = c.fields['System.State'] || '';
    const su = c.fields['Casepoint.TFS.CustomFields.Status'] || '-';
    return `<tr id="fpru-row-${c.id}"><td>${c.id}</td><td class="fpru-ttl" title="${_fpReqEsc(c.fields['System.Title'] || '')}">${_fpReqEsc(c.fields['System.Title'] || '')}</td>
<td>${_fpReqEsc(c.fields['System.WorkItemType'] || '')}</td>
<td><span class="fp-state-pill ${getStatePillClass(st)}">${_fpReqEsc(st)}</span></td>
<td><span class="fp-status-pill ${getStatusPillClass(su)}">${_fpReqEsc(su)}</span></td>
<td class="fpru-res" id="fpru-res-${c.id}"></td></tr>`;
  }).join('');

  document.getElementById('fpReqUpdBody').innerHTML = `
<div class="fpru-form">
<label>New State<select id="fpReqUpdState"><option value="">Keep current state</option>${states.map(v => `<option value="${_fpReqEsc(v)}">${_fpReqEsc(v)}</option>`).join('')}</select></label>
<label>New Status<select id="fpReqUpdStatus"><option value="">Keep current status</option>${statusOpts.map(([v, l]) => `<option value="${_fpReqEsc(v)}">${_fpReqEsc(l)}</option>`).join('')}</select></label>
</div>
<div class="fpru-note">Applies to all ${items.length} selected item${items.length > 1 ? 's' : ''} (${_fpReqEsc(typesTxt)}). Items already at the chosen value are skipped. TFS workflow rules still apply, so an invalid transition is reported per item.</div>
<div class="fpru-scroll"><table class="fpru-tbl"><thead><tr><th>ID</th><th>Title</th><th>Type</th><th>Current State</th><th>Current Status</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  document.getElementById('fpReqUpdFoot').innerHTML = `<button type="button" class="fpru-btn sec" onclick="closeFpReqUpdate()">Cancel</button>
<button type="button" class="fpru-btn pri" id="fpReqUpdGo" onclick="confirmFpReqUpdate()">✅ Update ${items.length} item${items.length > 1 ? 's' : ''}</button>`;
  const first = document.getElementById('fpReqUpdState'); if (first) first.focus();
}

function closeFpReqUpdate() {
  const m = document.getElementById('fpReqUpdModal');
  if (m) m.classList.remove('open');
  const u = window._fpReqUpd;
  window._fpReqUpd = null;
  if (u && u.done) {
    const set = window._fpReq.sel[u.fid];
    if (set) (u.okIds || []).forEach(id => set.delete(id));
    _fpReqAfterUpdate(u.fid);
  }
  if (u) { const b = document.getElementById('fpru-' + u.fid); if (b) b.focus(); }
}

async function confirmFpReqUpdate() {
  const u = window._fpReqUpd;
  if (!u) return;
  const newState = document.getElementById('fpReqUpdState').value;
  const newStatus = document.getElementById('fpReqUpdStatus').value;
  if (!newState && !newStatus) {
    document.querySelector('#fpReqUpdModal .fpru-note').innerHTML = '<b class="fpru-warn">Choose a new State or a new Status first.</b>';
    return;
  }
  const go = document.getElementById('fpReqUpdGo');
  const selects = document.querySelectorAll('#fpReqUpdModal select');
  selects.forEach(sl => sl.disabled = true);
  window._fpReqUpdBusy = true;
  let ok = 0, skipped = 0, failed = 0;
  const doneIds = [];
  for (let i = 0; i < u.items.length; i++) {
    const c = u.items[i];
    const res = document.getElementById('fpru-res-' + c.id);
    if (go) { go.disabled = true; go.textContent = `⏳ ${i + 1}/${u.items.length}…`; }
    const patch = [];
    if (newState && newState !== c.fields['System.State']) patch.push({ op: 'replace', path: '/fields/System.State', value: newState });
    if (newStatus && newStatus !== c.fields['Casepoint.TFS.CustomFields.Status']) patch.push({ op: 'replace', path: '/fields/Casepoint.TFS.CustomFields.Status', value: newStatus });
    if (!patch.length) { skipped++; doneIds.push(c.id); if (res) res.innerHTML = '<span class="fpru-skip">Already set</span>'; continue; }
    try {
      const resp = await fetch(`${tfsUrl}/_apis/wit/workitems/${c.id}?api-version=5.0`, {
        method: 'PATCH',
        headers: { ...config.headers, 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(patch)
      });
      apiCallCount++;
      const cnt = document.getElementById('apiCallCount'); if (cnt) cnt.textContent = apiCallCount;
      if (!resp.ok) {
        const txt = await resp.text();
        let msg = txt; try { msg = JSON.parse(txt).message || txt; } catch (e) {}
        throw new Error(msg);
      }
      const upd = await resp.json().catch(() => null);
      const uf = (upd && upd.fields) || {};
      c.fields['System.State'] = uf['System.State'] || (newState || c.fields['System.State']);
      if (newStatus || uf['Casepoint.TFS.CustomFields.Status'] !== undefined) {
        c.fields['Casepoint.TFS.CustomFields.Status'] = uf['Casepoint.TFS.CustomFields.Status'] !== undefined ? uf['Casepoint.TFS.CustomFields.Status'] : newStatus;
      }
      if (uf['System.Reason']) c.fields['System.Reason'] = uf['System.Reason'];
      ok++;
      doneIds.push(c.id);
      if (res) res.innerHTML = '<span class="fpru-ok">✅ Updated</span>';
      const row = document.getElementById('fpru-row-' + c.id);
      if (row) {
        const st = c.fields['System.State'] || '', su = c.fields['Casepoint.TFS.CustomFields.Status'] || '-';
        row.children[3].innerHTML = `<span class="fp-state-pill ${getStatePillClass(st)}">${_fpReqEsc(st)}</span>`;
        row.children[4].innerHTML = `<span class="fp-status-pill ${getStatusPillClass(su)}">${_fpReqEsc(su)}</span>`;
      }
    } catch (e) {
      failed++;
      console.error('[FP Requirements] update', c.id, e);
      if (res) res.innerHTML = `<span class="fpru-err" title="${_fpReqEsc(e.message)}">❌ ${_fpReqEsc(String(e.message).slice(0, 140))}</span>`;
    }
  }
  window._fpReqUpdBusy = false;
  u.done = true;
  u.okIds = doneIds;
  const note = document.querySelector('#fpReqUpdModal .fpru-note');
  if (note) note.innerHTML = `<b class="${failed ? 'fpru-warn' : 'fpru-okt'}">${ok} updated${skipped ? ', ' + skipped + ' already set' : ''}${failed ? ', ' + failed + ' failed (see Result column)' : ''}.</b>`;
  document.getElementById('fpReqUpdFoot').innerHTML = `<button type="button" class="fpru-btn pri" onclick="closeFpReqUpdate()">Close</button>`;
  const cb = document.querySelector('#fpReqUpdFoot .fpru-btn'); if (cb) cb.focus();
}

/* Refresh the panel + status filter after an update; successfully updated items are unselected. */
function _fpReqAfterUpdate(fid) {
  const S = window._fpReq;
  // Rebuild Requirement Status options; keep existing choices, auto-include new statuses
  const before = new Set([...document.querySelectorAll('#fpReqStatusDropdown .fp-multiselect-item:not(.select-all) input')].map(cb => cb.value));
  const prevSel = S.statusSel ? new Set(S.statusSel) : null;
  _fpReqBuildStatusFilter();
  if (prevSel) {
    const now = [...document.querySelectorAll('#fpReqStatusDropdown .fp-multiselect-item:not(.select-all) input')];
    now.forEach(cb => { cb.checked = prevSel.has(cb.value) || !before.has(cb.value); });
    fpReqStatusItem();
  } else {
    _fpReqRefreshPanels();
  }
  _fpReqSelUI(fid);
}

/* ── Requirement Status filter (multi-select, after Tags) ── */
function _fpReqBuildStatusFilter() {
  const S = window._fpReq;
  const box = document.getElementById('fpReqStatusDropdown');
  if (!box) return;
  const set = new Set();
  Object.values(S.cache).forEach(e => e.children.forEach(c => set.add(_fpReqStatusOf(c))));
  const opts = [...set].sort((a, b) => a === '-' ? 1 : b === '-' ? -1 : a.localeCompare(b));
  const dd = box.querySelector('.fp-multiselect-dropdown');
  if (!dd) return;
  let html = `<label class="fp-multiselect-item select-all"><input type="checkbox" checked onchange="fpReqStatusAll(this.checked)"> Select All</label>`;
  opts.forEach(o => {
    html += `<label class="fp-multiselect-item"><input type="checkbox" value="${_fpReqEsc(o)}" checked onchange="fpReqStatusItem()"> ${o === '-' ? '(No status)' : _fpReqEsc(o)}</label>`;
  });
  if (!opts.length) html = `<div class="fp-multiselect-item" style="cursor:default">No requirements loaded</div>`;
  dd.innerHTML = html;
  _fpReqStatusLabel();
}

function _fpReqStatusLabel() {
  const S = window._fpReq;
  const btn = document.querySelector('#fpReqStatusDropdown .fp-multiselect-btn');
  if (!btn) return;
  if (!S.statusSel) btn.textContent = 'All Statuses';
  else if (S.statusSel.size === 0) btn.textContent = 'None selected';
  else if (S.statusSel.size === 1) { const v = [...S.statusSel][0]; btn.textContent = v === '-' ? '(No status)' : v; }
  else btn.textContent = S.statusSel.size + ' statuses';
}

function fpReqStatusAll(checked) {
  document.querySelectorAll('#fpReqStatusDropdown .fp-multiselect-item:not(.select-all) input[type="checkbox"]').forEach(cb => { cb.checked = checked; });
  fpReqStatusItem();
}

function fpReqStatusItem() {
  const S = window._fpReq;
  const cbs = [...document.querySelectorAll('#fpReqStatusDropdown .fp-multiselect-item:not(.select-all) input[type="checkbox"]')];
  const sel = cbs.filter(cb => cb.checked).map(cb => cb.value);
  S.statusSel = sel.length === cbs.length ? null : new Set(sel);
  const all = document.querySelector('#fpReqStatusDropdown .select-all input');
  if (all) { all.checked = sel.length === cbs.length; all.indeterminate = sel.length > 0 && sel.length < cbs.length; }
  _fpReqStatusLabel();
  _fpReqRefreshPanels();
}

function onFpReqAreaChange(fid, val) {
  window._fpReq.area[fid] = val;
  _fpReqRefreshOne(fid);
}

function onFpReqReqIterChange(fid, val) {
  window._fpReq.reqIter[fid] = val;
  _fpReqRefreshOne(fid);
}

function clearFpReqPanelFilters(fid) {
  const S = window._fpReq;
  S.area[fid] = 'all'; S.reqIter[fid] = 'all'; S.iter[fid] = 'all';
  _fpReqRefreshOne(fid);
}

function onFpReqIterChange(fid, val) {
  window._fpReq.iter[fid] = val;
  _fpReqRefreshOne(fid);
}

function sortFpReq(fid, col) {
  const S = window._fpReq;
  const cur = S.sort[fid] || { col: null, dir: 'asc' };
  if (cur.col === col) cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
  else { cur.col = col; cur.dir = ['id','title','type','state','status','assigned','area','iteration'].includes(col) ? 'asc' : 'desc'; }
  S.sort[fid] = cur;
  _fpReqRefreshOne(fid);
}

/* ═══ Affected Area Requirement by Team (Affect To) — ported from PI_requirements_by_team.html ═══
   Self-contained: own IDs (piat*), own storage key, no TFS calls, no shared globals. */
(function () {
  const $ = id => document.getElementById(id);
  if (!$("piatBlock")) return;
  const DEFAULT_HEADERS = ["Discussion Status","Iteration","Requirements","Requested By","Need to Plan?","Reasons for not to be given as affected","Consider","Affect To","Category","IS Team Category","Code Changes in DTC","Affect to CGCE Migration","Affect to ARM Migration","Contact Person","Comments","Total No. of Software Licenses / Machines","Estimate Date to complete","Feature ID"];
  const STOP = new Set(["team","teams","the","and"]);
  const STORE_KEY = "pi-affect-raw";
  const pureTitle = s => (s || "").replace(/^\s*(change\s*request|requirement|cr|req)\s*[#:]?\s*\d+\s*[:\-–—.]*\s*/i, "").trim();
  let rows = [], sections = [];

  // ---------- TSV parsing (handles Excel's quoted multi-line cells) ----------
  function parseTSV(text) {
    const out = []; let row = [], cell = "", i = 0, q = false;
    text = text.replace(/\r\n?/g, "\n");
    while (i < text.length) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i+1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
        cell += c; i++; continue;
      }
      if (c === '"' && cell === "") { q = true; i++; continue; }
      if (c === "\t") { row.push(cell); cell = ""; i++; continue; }
      if (c === "\n") { row.push(cell); out.push(row); row = []; cell = ""; i++; continue; }
      cell += c; i++;
    }
    if (cell !== "" || row.length) { row.push(cell); out.push(row); }
    return out;
  }
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const hnorm = s => clean(s).toLowerCase().replace(/\s/g, "");

  function keyFor(h) {
    const n = hnorm(h);
    if (n === "affectto") return "affect";
    if (n.startsWith("requirement")) return "req";
    if (n.startsWith("iteration")) return "iter";
    if (n.startsWith("requestedby")) return "by";
    if (n === "consider") return "consider";
    if (n === "category") return "category";
    if (n.startsWith("contact")) return "contact";
    if (n.startsWith("featureid") || n === "feature") return "feature";
    if (n.startsWith("discussion")) return "status";
    return null;
  }
  const isHeader = r => r.some(c => hnorm(c) === "affectto") && r.some(c => hnorm(c).startsWith("requirement"));

  function load(text) {
    const grid = parseTSV(text);
    rows = []; sections = [];
    let headers = null, map = null, pendingTitle = null, secIdx = -1;
    const startSection = (title) => { secIdx++; sections.push(title || ("Section " + (secIdx + 1))); };
    const buildMap = hs => { const m = {}; hs.forEach((h, i) => { const k = keyFor(h); if (k && m[k] === undefined) m[k] = i; }); return m; };

    for (const r of grid) {
      const filled = r.filter(c => clean(c) !== "");
      if (!filled.length) continue;
      if (isHeader(r)) {
        headers = r.map(clean); map = buildMap(headers);
        startSection(pendingTitle); pendingTitle = null; continue;
      }
      if (filled.length === 1 && clean(filled[0]).length > 3 && !/^(yes|no|partial)$/i.test(clean(filled[0]))) {
        pendingTitle = clean(filled[0]).replace(/\s*:\s*$/, ""); continue;
      }
      if (!headers) { headers = DEFAULT_HEADERS.slice(); map = buildMap(headers); startSection(pendingTitle); pendingTitle = null; }
      if (pendingTitle) { startSection(pendingTitle); pendingTitle = null; }
      const get = k => map[k] !== undefined ? clean(r[map[k]]) : "";
      if (!get("req") && !get("affect")) continue;
      if (filled.length < 2) continue;
      const all = headers.map((h, i) => [h || ("Column " + (i + 1)), clean(r[i])]);
      for (let i = headers.length; i < r.length; i++) if (clean(r[i])) all.push(["Column " + (i + 1), clean(r[i])]);
      rows.push({
        sec: secIdx, iter: get("iter"), req: get("req"), by: get("by"), consider: get("consider"),
        affect: get("affect"), category: get("category"), contact: get("contact"), feature: get("feature"),
        all, tokens: splitTeams(get("affect"))
      });
    }
    try { localStorage.setItem(STORE_KEY, text); } catch (e) {}
    $("piatLoadStatus").textContent = rows.length
      ? `Loaded ${rows.length} requirements in ${sections.length} section${sections.length === 1 ? "" : "s"}.`
      : "No requirement rows found. Include the header row with “Requirements” and “Affect To”.";
    if (matchOn) {   // new sheet → previous match no longer applies
      matchOn = false; matchInfo = null;
      $("piatMatchBar").hidden = true; $("piatOnlyMissing").checked = false;
      $("piatMatchBtn").textContent = "🔍 Match with Requirements List";
    }
    renderGrid(text);
    buildSectionSelect(); buildChips(); applyDefaultTeams(); render();
  }

  // ---------- Pasted data grid ----------
  const GRID_MAX_ROWS = 1000;
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const colName = n => { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = LETTERS[m] + s; n = Math.floor((n - 1) / 26); } return s; };
  function renderGrid(text) {
    const box = $("piatGrid");
    const grid = text ? parseTSV(text).filter(r => r.some(c => clean(c) !== "")) : [];
    box.classList.toggle("has-data", grid.length > 0);
    if (!grid.length) {
      box.innerHTML = '<div class="piat-grid-empty"><b>📋 Click here and press Ctrl+V</b><span>In Excel, select the rows including the header row (Discussion Status, Iteration, Requirements … Affect To …) and copy them.</span></div>';
      return;
    }
    const cols = Math.max(...grid.map(r => r.length));
    const shown = grid.slice(0, GRID_MAX_ROWS);
    let h = '<table class="piat-grid"><thead><tr><th class="rn" scope="col"></th>';
    for (let c = 0; c < cols; c++) h += `<th scope="col">${colName(c)}</th>`;
    h += '</tr></thead><tbody>';
    shown.forEach((r, i) => {
      const filled = r.filter(c => clean(c) !== "").length;
      const cls = isHeader(r) ? "hdr" : (filled === 1 && clean(r.find(c => clean(c) !== "")).length > 3 ? "sec" : "");
      h += `<tr${cls ? ' class="' + cls + '"' : ''}><th class="rn" scope="row">${i + 1}</th>`;
      for (let c = 0; c < cols; c++) { const v = r[c] || ""; h += `<td title="${esc(v)}">${esc(clean(v))}</td>`; }
      h += '</tr>';
    });
    h += '</tbody></table>';
    if (grid.length > GRID_MAX_ROWS) h += `<div class="piat-grid-note">Showing the first ${GRID_MAX_ROWS} of ${grid.length} rows. All rows are used for filtering.</div>`;
    box.innerHTML = h;
  }

  // Default team selection on load: every "Affect To" value that starts with the word "All"
  function applyDefaultTeams() {
    const seen = new Set(), picks = [];
    rows.forEach(r => r.tokens.forEach(t => {
      const key = words(t.text).join(" ");
      if (t.w[0] === "all" && !seen.has(key)) { seen.add(key); picks.push(t.text); }
    }));
    $("piatTeam").value = picks.join(", ");
  }

  // ---------- Team matching ----------
  const words = s => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter(w => w && !STOP.has(w)).map(w => w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  function splitTeams(s) {
    return s.split(/[,;\/\n]+/).map(clean).filter(Boolean).map(t => ({ text: t, w: words(t) }));
  }
  const isAllTeams = tok => tok.w.length === 1 && tok.w[0] === "all";
  function tokenMatches(tok, termW, partial) {
    if (!termW.length) return false;
    return termW.every(q => tok.w.some(w => partial ? w.includes(q) : w === q));
  }
  function terms() { return $("piatTeam").value.split(",").map(words).filter(w => w.length); }

  // ---------- UI ----------
  function buildSectionSelect() {
    const sel = $("piatSecSel"); sel.innerHTML = '<option value="">All sections</option>';
    sections.forEach((s, i) => { const o = document.createElement("option"); o.value = i; o.textContent = s; sel.appendChild(o); });
  }
  function buildChips() {
    const counts = new Map();
    rows.forEach(r => r.tokens.forEach(t => { const k = t.text; counts.set(k, (counts.get(k) || 0) + 1); }));
    const merged = new Map();
    for (const [k, n] of counts) { const key = words(k).join(" "); if (!key) continue;
      const cur = merged.get(key); if (cur) cur.n += n; else merged.set(key, { label: k, n }); }
    const list = [...merged.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }));
    const box = $("piatChips"); box.innerHTML = "";
    list.forEach(({ label, n }) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "piat-chip"; b.dataset.label = label;
      b.innerHTML = esc(label) + "<small>" + n + "</small>";
      b.addEventListener("click", () => toggleChip(label));
      box.appendChild(b);
    });
    syncChips();
  }
  function toggleChip(label) {
    const parts = $("piatTeam").value.split(",").map(clean).filter(Boolean);
    const key = words(label).join(" ");
    const idx = parts.findIndex(p => words(p).join(" ") === key);
    if (idx >= 0) parts.splice(idx, 1); else parts.push(label);
    $("piatTeam").value = parts.join(", "); render();
  }
  function syncChips() {
    const active = new Set($("piatTeam").value.split(",").map(p => words(p).join(" ")));
    document.querySelectorAll("#piatChips .piat-chip").forEach(c => {
      const on = active.has(words(c.dataset.label).join(" "));
      c.classList.toggle("on", on); c.setAttribute("aria-pressed", String(on));
    });
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let sortState = { col: null, dir: "asc" };   // col: "req" | "title" | null

  // ---------- Match with Requirements List (Affected Area) ----------
  let matchOn = false, matchInfo = null;
  const normTitle = s => (s || "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/^\s*affected\s*area\s*[:\-–—]*\s*/i, "")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const leadId = s => { const m = (s || "").match(/^\s*(?:change\s*request|requirement|cr|req)?\s*[#:]?\s*(\d{5,})/i); return m ? m[1] : ""; };

  function affectedAreaReqs() {
    const list = (typeof requirements !== "undefined" && Array.isArray(requirements)) ? requirements : [];
    return list.filter(r => r.isAffectedArea);   // same rule as the Requirements List "Affected Area" tab
  }

  function matchRow(r, tfs) {
    const t = normTitle(pureTitle(r.req) || r.req);
    const id = leadId(r.req);
    if (id && tfs.ids.has(id)) return true;
    if (!t) return false;
    if (tfs.titles.has(t)) return true;
    // TFS titles often carry an extra prefix such as "Affected Area - Implement - …": allow containment
    if (t.length >= 12) for (const x of tfs.list) { if (x.includes(t) || (x.length >= 12 && t.includes(x))) return true; }
    if (id) for (const x of tfs.raw) { if (x.includes(id)) return true; }
    return false;
  }

  function runMatch() {
    if (!rows.length) { toast("Load the PI sheet first"); return; }
    const aa = affectedAreaReqs();
    if (!aa.length) {
      toast((typeof requirements !== "undefined" && requirements.length) ? "No Affected Area requirements in the Requirements List" : "Load the Sprint Planning data first (Requirements List is empty)");
      return;
    }
    const tfs = { titles: new Set(), list: [], ids: new Set(), raw: [] };
    aa.forEach(q => {
      const title = q.fields && q.fields["System.Title"] || "";
      const n = normTitle(title);
      if (n) { tfs.titles.add(n); tfs.list.push(n); }
      tfs.ids.add(String(q.id));
      tfs.raw.push(title);
    });
    let hit = 0, miss = 0;
    rows.forEach(r => { r.match = matchRow(r, tfs); r.match ? hit++ : miss++; });
    matchOn = true;
    matchInfo = { tfsCount: aa.length, hit, miss };
    $("piatMatchBar").hidden = false;
    $("piatMatchSummary").innerHTML = `Compared with <b>${aa.length}</b> Affected Area requirement${aa.length === 1 ? "" : "s"} in the Requirements List: <b class="ok">${hit} matched</b>, <b class="miss">${miss} not matched</b> (highlighted in red).`;
    $("piatMatchBtn").textContent = "🔁 Re-run match";
    render();
  }

  function clearMatch() {
    matchOn = false; matchInfo = null;
    rows.forEach(r => { delete r.match; });
    $("piatMatchBar").hidden = true;
    $("piatOnlyMissing").checked = false;
    $("piatMatchBtn").textContent = "🔍 Match with Requirements List";
    render();
  }

  let current = [];
  function render() {
    syncChips();
    const t = terms(), partial = $("piatPartial").checked, incAll = $("piatIncAll").checked;
    const sec = $("piatSecSel").value, con = $("piatConSel").value, q = clean($("piatQ").value).toLowerCase();
    current = [];
    for (const r of rows) {
      if (sec !== "" && String(r.sec) !== sec) continue;
      if (con) { const c = r.consider.toLowerCase().replace(/[-_]/g, " "); if (con === "deliverable" ? c !== "deliverable" : !c.startsWith("non")) continue; }
      if (q && !r.req.toLowerCase().includes(q) && !r.feature.toLowerCase().includes(q)) continue;
      if (matchOn && $("piatOnlyMissing").checked && r.match) continue;
      let hits = new Set(), viaAll = false;
      if (t.length) {
        r.tokens.forEach((tok, i) => { if (t.some(tw => tokenMatches(tok, tw, partial))) hits.add(i); });
        if (!hits.size && incAll && r.tokens.some(isAllTeams)) viaAll = true;
        if (!hits.size && !viaAll) continue;
      }
      current.push({ r, hits, viaAll });
    }
    if (sortState.col) {
      const val = sortState.col === "title" ? (r => pureTitle(r.req)) : (r => r.req);
      current.sort((a, b) => {
        const c = val(a.r).localeCompare(val(b.r), undefined, { sensitivity: "base", numeric: true });
        return sortState.dir === "asc" ? c : -c;
      });
    }
    [["req", "piatReqTh", "piatSortArrow"], ["title", "piatTitleTh", "piatTitleArrow"]].forEach(([col, th, ar]) => {
      const on = sortState.col === col;
      $(ar).textContent = on ? (sortState.dir === "asc" ? "▲" : "▼") : "↕";
      $(th).setAttribute("aria-sort", on ? (sortState.dir === "asc" ? "ascending" : "descending") : "none");
    });
    const tb = $("piatTbody"); tb.innerHTML = "";
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="9" class="piat-empty">Paste your sheet above and choose Load data.</td></tr>'; }
    else if (!current.length && matchOn && $("piatOnlyMissing").checked) { tb.innerHTML = '<tr><td colspan="9" class="piat-empty">Every requirement shown matches the Requirements List (Affected Area).</td></tr>'; }
    else if (!current.length) { tb.innerHTML = '<tr><td colspan="9" class="piat-empty">No requirements affect this team. Check the spelling, try Partial word match, or pick a team from the list above.</td></tr>'; }
    const frag = document.createDocumentFragment();
    current.forEach(({ r, hits, viaAll }) => {
      const tr = document.createElement("tr"); tr.className = "piat-data piat-s" + Math.min(r.sec, 2) + (matchOn && r.match === false ? " piat-nomatch" : "");
      const affect = r.tokens.length
        ? r.tokens.map((tok, i) => hits.has(i) ? "<mark>" + esc(tok.text) + "</mark>" : esc(tok.text)).join(", ")
        : esc(r.affect);
      const c = r.consider.toLowerCase();
      const conCls = c.startsWith("non") ? "piat-nondeliv" : c === "deliverable" ? "piat-deliv" : "";
      tr.innerHTML = `<td>${esc(r.iter)}</td><td class="piat-req">${esc(r.req)}${matchOn && r.match === false ? '<span class="piat-miss-badge" title="No matching title in the Requirements List (Affected Area)">Not in TFS</span>' : ""}</td>
        <td>${esc(r.by)}</td><td class="${conCls}">${esc(r.consider)}</td>
        <td>${affect}${viaAll ? '<span class="piat-all-badge">All teams</span>' : ""}</td>
        <td>${esc(r.category)}</td><td>${esc(r.contact)}</td><td>${esc(r.feature)}</td><td class="piat-title">${esc(pureTitle(r.req))}</td>`;
      tr.tabIndex = 0; tr.title = "Show all columns"; tr.setAttribute("aria-expanded", "false");
      const toggle = () => {
        const nx = tr.nextElementSibling;
        if (nx && nx.classList.contains("piat-detail")) { nx.remove(); tr.setAttribute("aria-expanded", "false"); return; }
        const d = document.createElement("tr"); d.className = "piat-detail";
        d.innerHTML = '<td colspan="9"><dl class="piat-kv">' + r.all.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") + "</dl></td>";
        tr.after(d); tr.setAttribute("aria-expanded", "true");
      };
      tr.addEventListener("click", toggle);
      tr.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      frag.appendChild(tr);
    });
    tb.appendChild(frag);
    const allN = current.filter(x => x.viaAll).length;
    $("piatCount").innerHTML = `${current.length} requirement${current.length === 1 ? "" : "s"}` +
      (rows.length ? ` <span>of ${rows.length}${allN ? `, including ${allN} marked for all teams` : ""}</span>` : "");
  }

  function toast(msg) { const t = $("piatToast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove("show"), 1800); }
  function copyResults() {
    if (!current.length) { toast("Nothing to copy yet"); return; }
    const hs = []; current.forEach(({ r }) => r.all.forEach(([k]) => { if (!hs.includes(k)) hs.push(k); }));
    const cellOut = v => /[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    const lines = [[...hs, "Title", ...(matchOn ? ["In Requirements List (Affected Area)"] : [])].join("\t")];
    current.forEach(({ r }) => { const m = new Map(r.all); lines.push([...hs.map(h => m.get(h) || ""), pureTitle(r.req), ...(matchOn ? [r.match ? "Yes" : "No"] : [])].map(cellOut).join("\t")); });
    const text = lines.join("\n");
    const fallback = () => { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("Copied " + current.length + " rows. Paste into Excel."); } catch (e) { toast("Copy was blocked by the browser"); } ta.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast("Copied " + current.length + " rows. Paste into Excel."), fallback);
    else fallback();
  }

  // Show / Hide, like the Requirements List block above it
  $("piatToggleBtn").addEventListener("click", () => {
    const c = $("piatContent"), b = $("piatToggleBtn");
    const open = c.hidden;
    c.hidden = !open;
    b.textContent = open ? "👥 Hide" : "👥 Show";
    b.setAttribute("aria-expanded", String(open));
  });

  const loadText = text => { $("piatRaw").value = text; load(text); };
  $("piatLoadBtn").addEventListener("click", () => load($("piatRaw").value));
  $("piatRaw").addEventListener("paste", () => setTimeout(() => load($("piatRaw").value), 0));
  // Paste straight onto the grid (Ctrl+V while it has focus)
  $("piatGrid").addEventListener("paste", e => {
    const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
    if (!text) return;
    e.preventDefault();
    loadText(text);
  });
  $("piatGrid").addEventListener("click", () => $("piatGrid").focus());
  $("piatPasteBtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { toast("Clipboard is empty"); return; }
      loadText(text);
    } catch (e) {
      $("piatGrid").focus();
      toast("Browser blocked clipboard access — press Ctrl+V on the grid");
    }
  });
  $("piatTextBtn").addEventListener("click", () => {
    const ta = $("piatRaw"), btn = $("piatTextBtn"), toText = ta.hidden;
    ta.hidden = !toText; $("piatGrid").hidden = toText; $("piatLoadBtn").hidden = !toText;
    btn.textContent = toText ? "▦ Show grid" : "✎ Edit as text";
    btn.setAttribute("aria-pressed", String(toText));
    if (toText) ta.focus(); else { renderGrid(ta.value); $("piatGrid").focus(); }
  });
  $("piatClearBtn").addEventListener("click", () => { $("piatRaw").value = ""; rows = []; sections = []; try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    $("piatTeam").value = "";
    if (matchOn) clearMatch();
    $("piatLoadStatus").textContent = "No data loaded yet."; renderGrid(""); buildSectionSelect(); buildChips(); render(); });
  ["piatTeam", "piatQ"].forEach(id => $(id).addEventListener("input", render));
  ["piatIncAll", "piatPartial", "piatSecSel", "piatConSel"].forEach(id => $(id).addEventListener("change", render));
  // Column sorting: click Requirement or Title → ascending ▲ → descending ▼ → sheet order ↕
  const cycleSort = col => {
    if (sortState.col !== col) sortState = { col, dir: "asc" };
    else if (sortState.dir === "asc") sortState.dir = "desc";
    else sortState = { col: null, dir: "asc" };
    render();
  };
  $("piatReqSort").addEventListener("click", () => cycleSort("req"));
  $("piatTitleSort").addEventListener("click", () => cycleSort("title"));
  $("piatMatchBtn").addEventListener("click", runMatch);
  $("piatMatchClear").addEventListener("click", clearMatch);
  $("piatOnlyMissing").addEventListener("change", render);
  $("piatCopyBtn").addEventListener("click", copyResults);

  let saved = null; try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
  if (saved) { $("piatRaw").value = saved; load(saved); } else { renderGrid(""); render(); }
})();

/* ═══ Light theme contrast guard ═══
   Only acts when <body> has .light-theme. Checks each button's real (computed) background
   and text colour and, when they are unreadable, adds an lt-* class that fixes the text
   colour within the same colour family. Also evens out font sizes inside each table.
   It never changes inline styles, so dark theme is untouched; removing .light-theme
   removes all effects. */
(function () {
  const BTN_SEL = 'button, .btn, .table-tab, .tab-btn, a.tm-open-btn, input[type="button"], input[type="submit"]';
  const INK = ['lt-ink-white','lt-ink-slate','lt-ink-red','lt-ink-orange','lt-ink-amber','lt-ink-green','lt-ink-teal','lt-ink-blue','lt-ink-indigo','lt-ink-purple','lt-ink-pink','lt-surface','lt-tint-border'];

  // ---------- colour helpers (pure) ----------
  const parseColors = str => {
    const out = []; const re = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s\/]+([\d.]+%?))?\s*\)/g; let m;
    while ((m = re.exec(str || ''))) {
      let a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      out.push({ r: +m[1], g: +m[2], b: +m[3], a });
    }
    return out;
  };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (x, y) => { const a = lum(x), b = lum(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  const blend = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const hsl = ({ r, g, b }) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0;
    if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    return { h, s, l }; };
  const chroma = ({ r, g, b }) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  const inkFor = c => { const { h } = hsl(c); if (chroma(c) < 0.16) return 'lt-ink-slate';
    if (h < 12 || h >= 345) return 'lt-ink-red'; if (h < 38) return 'lt-ink-orange'; if (h < 55) return 'lt-ink-amber';
    if (h < 165) return 'lt-ink-green'; if (h < 200) return 'lt-ink-teal'; if (h < 225) return 'lt-ink-blue';
    if (h < 260) return 'lt-ink-indigo'; if (h < 290) return 'lt-ink-purple'; return 'lt-ink-pink'; };
  const avg = list => { if (!list.length) return null; const t = list.reduce((s, c) => ({ r: s.r + c.r, g: s.g + c.g, b: s.b + c.b, a: s.a + c.a }), { r: 0, g: 0, b: 0, a: 0 }); const n = list.length; return { r: t.r / n, g: t.g / n, b: t.b / n, a: t.a / n }; };
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };

  // Decide which class (if any) a control needs. bgOwn: own bg (may be translucent / null), under: what is behind it, text: text colour
  function decide(bgOwn, under, text) {
    const eff = bgOwn && bgOwn.a > 0.04 ? blend(bgOwn, under) : under;
    const e = hsl(eff);
    // a near-black slate/grey surface on a light page = leaked dark-theme style
    if (bgOwn && bgOwn.a > 0.6 && lum(eff) < 0.06 && e.l < 0.22 && (chroma(eff) < 0.1 || (e.h >= 195 && e.h <= 232 && e.s < 0.55))) return ['lt-surface'];
    // solid coloured button (gradient/fill) showing dark text → its intended white text
    if (bgOwn && bgOwn.a > 0.6 && chroma(eff) >= 0.25 && lum(eff) < 0.42 && lum(text) < 0.2 && contrast(WHITE, eff) >= 2.4) return ['lt-ink-white'];
    if (contrast(text, eff) >= 3) return [];
    if (lum(eff) > 0.4) {   // light / pale background → dark ink of the same colour family
      const tinted = bgOwn && bgOwn.a > 0.04 && chroma(bgOwn) >= 0.12;
      const ink = tinted ? inkFor(bgOwn) : inkFor(text);
      return tinted && bgOwn.a < 0.6 ? [ink, 'lt-tint-border'] : [ink];
    }
    return ['lt-ink-white'];  // dark / saturated background → white text
  }

  // ---------- DOM ----------
  const isLight = () => document.body && document.body.classList.contains('light-theme');
  function ownBg(cs) {
    const solid = parseColors(cs.backgroundColor)[0];
    if (solid && solid.a > 0.04) return solid;
    const g = parseColors(cs.backgroundImage);
    return g.length ? avg(g) : null;
  }
  function underBg(el) {
    let cur = el.parentElement, depth = 0; const layers = [];
    while (cur && depth < 12) {
      const c = ownBg(getComputedStyle(cur));
      if (c && c.a > 0.04) { layers.push(c); if (c.a >= 0.95) break; }
      cur = cur.parentElement; depth++;
    }
    let base = WHITE; for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return base;
  }
  function fixControl(el) {
    INK.forEach(c => el.classList.remove(c));
    if (!isLight() || el.disabled) return;   // disabled buttons are dimmed on purpose
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const text = parseColors(cs.color)[0]; if (!text) return;
    const add = decide(ownBg(cs), underBg(el), text);
    add.forEach(c => el.classList.add(c));
  }
  function modeSize(cells) {
    const n = {}; let best = null, bc = 0;
    cells.forEach(c => { const v = getComputedStyle(c).fontSize; n[v] = (n[v] || 0) + 1; if (n[v] > bc) { bc = n[v]; best = v; } });
    return best;
  }
  function fixTable(t) {
    if (!isLight()) return;
    if (t.closest('[contenteditable="true"]')) return;
    t.classList.remove('lt-fs', 'lt-fs-h');
    const tds = []; const body = t.tBodies; 
    for (let b = 0; b < body.length && tds.length < 240; b++) for (const tr of body[b].rows) { for (const td of tr.cells) if (td.tagName === 'TD') tds.push(td); if (tds.length >= 240) break; }
    if (tds.length >= 4) { const m = modeSize(tds); if (m) { t.style.setProperty('--lt-fs-td', m); t.classList.add('lt-fs'); } }
    const ths = t.tHead ? [...t.tHead.querySelectorAll(':scope > tr > th')] : [];
    if (ths.length >= 3) { const m = modeSize(ths); if (m) { t.style.setProperty('--lt-fs-th', m); t.classList.add('lt-fs-h'); } }
  }
  function clearAll() {
    document.querySelectorAll('.' + INK.join(',.')).forEach(el => INK.forEach(c => el.classList.remove(c)));
    document.querySelectorAll('table.lt-fs, table.lt-fs-h').forEach(t => t.classList.remove('lt-fs', 'lt-fs-h'));
  }

  // ---------- scheduling ----------
  let pending = new Set(), full = false, raf = 0, obs = null;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };
  function run() {
    raf = 0;
    if (obs) obs.disconnect();
    try {
      if (!isLight()) { if (full) clearAll(); }
      else {
        const roots = full ? [document.body] : [...pending].filter(n => n.isConnected);
        const ctrls = new Set(), tables = new Set();
        roots.forEach(r => {
          if (r.nodeType !== 1) return;
          if (r.matches(BTN_SEL)) ctrls.add(r);
          r.querySelectorAll(BTN_SEL).forEach(e => ctrls.add(e));
          const pt = r.closest('table'); if (pt) tables.add(pt);
          if (r.tagName === 'TABLE') tables.add(r);
          r.querySelectorAll('table').forEach(e => tables.add(e));
          const pb = r.closest(BTN_SEL); if (pb) ctrls.add(pb);
        });
        ctrls.forEach(fixControl);
        tables.forEach(fixTable);
      }
    } catch (e) { console.warn('[light-theme guard]', e); }
    pending.clear(); full = false;
    if (obs) { obs.takeRecords(); start(); }
  }
  function start() {
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'disabled', 'hidden'] });
  }
  function init() {
    obs = new MutationObserver(recs => {
      for (const r of recs) {
        if (r.target === document.body && r.attributeName === 'class') { full = true; continue; }
        if (r.type === 'childList') { r.addedNodes.forEach(n => { if (n.nodeType === 1) pending.add(n); else if (n.parentElement) pending.add(n.parentElement); }); if (r.target.nodeType === 1) pending.add(r.target); }
        else pending.add(r.target);
      }
      if (pending.size > 400) { full = true; pending.clear(); }
      schedule();
    });
    start();
    full = true; schedule();
    // hover/focus colours come from CSS, so re-check the control on those events
    ['mouseover', 'mouseout', 'focusin', 'focusout'].forEach(ev => document.addEventListener(ev, e => {
      if (!isLight()) return; const b = e.target.closest && e.target.closest(BTN_SEL); if (b) { pending.add(b); schedule(); }
    }, true));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window._ltGuard = { decide, parseColors, contrast };   // exposed for testing
})();

/* ═══ Live Visitor Counter ═══
   Every visitor connects (so everyone is counted); only super_admin sees the number.
   Server: live-visitor-counter on Render. URL is configurable in allowed_users.json → "liveVisitorWsUrl"
   ("" turns the counter off). Never reloads the page; reconnects quietly with growing delays. */
(function () {
  const DEFAULT_WS_URL = 'wss://live-visitor-counter-e9jp.onrender.com/ws';
  const cfg = (typeof ALLOWED_USERS_DATA !== 'undefined' && ALLOWED_USERS_DATA) || {};
  const baseUrl = Object.prototype.hasOwnProperty.call(cfg, 'liveVisitorWsUrl') ? String(cfg.liveVisitorWsUrl || '').trim() : DEFAULT_WS_URL;

  let canSee = false, ws = null, retryMs = 5000, retryTimer = null, wakeTimer = null, keepAlive = null, everConnected = false;
  const lbl = () => document.getElementById('hdrLiveVisitors');
  const out = () => document.getElementById('hdrLiveVisitorsCount');

  function show(text, dim, title) {
    const o = out(); if (!o) return;
    o.textContent = text;
    o.classList.toggle('lv-dim', !!dim);
    const l = lbl(); if (l) l.title = title || 'Live visitors on this dashboard right now';
  }

  // Called from applyTabPermissions / access-denied path
  window.applyLiveVisitorVisibility = function (visible) {
    canSee = !!visible && !!baseUrl;
    const l = lbl(); if (l) l.hidden = !canSee;
  };

  // one id per browser, so several tabs count as one visitor
  function visitorId() {
    const KEY = 'liveVisitorId';
    let id = null;
    try { id = localStorage.getItem(KEY); } catch (e) {}
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
      try { localStorage.setItem(KEY, id); } catch (e) {}
    }
    return id;
  }

  function scheduleReconnect() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 60000);
  }

  function connect() {
    clearTimeout(retryTimer); clearTimeout(wakeTimer); clearInterval(keepAlive);
    if (!baseUrl || typeof WebSocket === 'undefined') { show('Off', true); return; }
    show(everConnected ? 'Reconnecting…' : 'Connecting…', true);
    // Render free tier sleeps when idle; the first connection can take ~50 s
    wakeTimer = setTimeout(() => show('Waking up…', true, 'The counter server is starting (free tier). This can take up to a minute.'), 6000);
    let sock;
    try {
      sock = new WebSocket(baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'vid=' + encodeURIComponent(visitorId()));
    } catch (e) { show('Unavailable', true); scheduleReconnect(); return; }
    ws = sock;
    sock.addEventListener('open', function () {
      everConnected = true; retryMs = 5000; clearTimeout(wakeTimer);
      show('…', true);
      keepAlive = setInterval(() => { try { if (sock.readyState === 1) sock.send('ping'); } catch (e) {} }, 25000);
    });
    sock.addEventListener('message', function (ev) {
      let d = null;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (!d || typeof d.activeVisitors !== 'number') return;
      const tabs = typeof d.activeConnections === 'number' ? d.activeConnections : d.activeVisitors;
      show(String(d.activeVisitors), false, `${d.activeVisitors} visitor${d.activeVisitors === 1 ? '' : 's'} right now (${tabs} open tab${tabs === 1 ? '' : 's'})`);
    });
    // a failed connection is followed by 'close', which handles the retry
    sock.addEventListener('error', function () {});
    sock.addEventListener('close', function () {
      clearTimeout(wakeTimer); clearInterval(keepAlive);
      if (ws !== sock) return;
      ws = null;
      show('Unavailable', true, 'Counter server not reachable — retrying automatically');
      scheduleReconnect();
    });
  }

  // reconnect promptly when the network or the tab comes back
  window.addEventListener('online', () => { if (!ws) { retryMs = 5000; connect(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !ws) { retryMs = 5000; connect(); } });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect); else connect();
})();
