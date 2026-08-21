'use strict';

const $ = (id) => document.getElementById(id);
const ROW_H = 34;

const state = {
  data: null,
  view: [],
  sort: { key: 'sv', dir: -1 },
  search: '',
  diagnoses: new Set(),
  pricedOnly: false,
  staleOnly: false,
  mode: 'campaign',   // 'campaign' (one row per campaign) | 'day'
  settings: { roas: '', haircut: 0.7, cap: 3, merge_gap: 5 },
  files: [],
};

const nf = new Intl.NumberFormat('en-US');
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const pct = (v) => (v * 100).toFixed(1) + '%';

const DX_CLASS = {
  'Structurally underfunded': 'dx-under',
  'Exhausts early': 'dx-early',
  'Pacing thrash': 'dx-thrash',
  'Evening cap': 'dx-evening',
  'Intermittent': 'dx-inter',
  'Healthy': 'dx-healthy',
  'Mostly paused': 'dx-paused',
};

function stage(name) {
  for (const s of ['upload', 'loading', 'error', 'dash']) $('stage-' + s).hidden = s !== name;
  const showing = name === 'dash';
  for (const b of ['btn-csv', 'btn-xlsx', 'btn-reset', 'btn-settings']) $(b).hidden = !showing;
}

function fail(message) {
  $('error-text').textContent = message;
  stage('error');
}

// ------------------------------------------------------------------ uploads

function renderFileList() {
  const ul = $('filelist');
  ul.innerHTML = '';
  for (const f of state.files) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="tag">${f.kind === 'perf' ? 'performance' : 'history'}</span>
                    <span>${escapeHtml(f.name)}</span><span class="ok">ready</span>`;
    ul.appendChild(li);
  }
  $('btn-analyze').hidden = !state.files.some((f) => f.kind === 'history');
}

async function upload(file, kind) {
  // FormData rather than a raw body: the filename travels in the part header,
  // so no X-Filename escaping, and the server can stream it to disk instead of
  // holding the whole thing in memory.
  const form = new FormData();
  form.append('file', file);
  form.append('kind', kind);
  const res = await A.api('/api/upload', { method: 'POST', body: form });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
  state.files.push({ name: file.name, kind });
  renderFileList();
}

async function acceptFiles(list, kind) {
  const files = [...list].filter((f) => /\.(xlsx|xlsm|csv|tsv)$/i.test(f.name) && !f.name.startsWith('~$'));
  if (!files.length) {
    fail('Those files are not Excel or CSV exports. Look for amazon-ads-history_*.xlsx.');
    return;
  }
  try {
    for (const f of files) await upload(f, kind);
  } catch (err) {
    fail(String(err.message || err));
  }
}

// ----------------------------------------------------------------- analysis

async function analyze() {
  stage('loading');
  const steps = ['Reading the export…', 'Reconstructing budget timelines…',
                 'Measuring outages…', 'Pricing lost opportunity…'];
  let i = 0;
  const tick = setInterval(() => { $('loading-text').textContent = steps[++i % steps.length]; }, 900);
  try {
    const res = await A.api('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.settings),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Analysis failed');
    state.data = json;
    state.diagnoses.clear();
    // Show the panel before rendering: the row virtualiser measures the table's
    // height, and a hidden element measures zero.
    stage('dash');
    render();
  } catch (err) {
    fail(String(err.message || err));
  } finally {
    clearInterval(tick);
  }
}

// ------------------------------------------------------------------- render

function render() {
  const d = state.data;
  const m = d.meta, t = d.totals;
  const span = m.dates.length > 1 ? `${m.dates[0]} to ${m.dates.at(-1)}` : m.dates[0];
  $('subtitle').textContent =
    `${m.account} · ${m.marketplace} · ${span} · ${m.files.length} export(s)`;

  // Fold the per-campaign action record onto every row so the existing sort
  // and filter machinery treats it like any other column.
  const acts = d.actions || {};
  const blank = { sum: 'not observed', ds: null, unt: false, n: 0, label: '' };
  for (const row of d.campaigns) Object.assign(row, { act: acts[row.c] || blank });
  for (const row of d.recurring) Object.assign(row, { act: acts[row.c] || blank });
  for (const row of [...d.campaigns, ...d.recurring]) {
    row.ds = row.act.unt ? Infinity : row.act.ds;   // untouched sorts to the top
    row.unt = row.act.unt;
  }

  // A file that could not be read must never disappear quietly.
  const skipped = d.skipped || [];
  $('skipped').hidden = skipped.length === 0;
  $('skipped-list').innerHTML = skipped.map((line) => {
    const cut = line.indexOf(': ');
    const name = cut > 0 ? line.slice(0, cut) : 'A file';
    const why = cut > 0 ? line.slice(cut + 2) : line;
    return `<div><b>${escapeHtml(name)}</b>${escapeHtml(why)}</div>`;
  }).join('');

  $('grain').hidden = t.days < 2;
  renderAnswer(t, m);
  renderKpis(t, m);
  renderCurve(d.curve, t);
  renderReality(t, m);
  renderChips();
  renderQuality(d.quality, d.invariants);
  applyFilters();
}

/** Durations read as "45min" / "2h 31min", never as decimal hours. */
function hrs(v) {
  if (v == null) return '—';
  const total = Math.round(v * 60);
  const h = Math.floor(total / 60), m = total % 60;
  if (h === 0) return `${m}min`;
  return m ? `${h}h ${m}min` : `${h}h`;
}

function renderAnswer(t, m) {
  const a = t.avg_day;
  const day = t.days > 1 ? 'day' : `day (${m.dates[0]})`;

  $('answer-lede').innerHTML =
    `On an average ${day}, one of your campaigns spends <b class="run">${hrs(a.running)}</b> ` +
    `able to run &mdash; and <b class="out">${hrs(a.out)}</b> shut off because it hit its daily budget.` +
    (a.paused > 0.05 ? ` A further ${hrs(a.paused)} it was paused, which costs nothing.` : '');

  // Same four values as TRACK_COLOR in ppcbudget/payload.py -- the day bar and
  // the timeline strips have to agree.
  const segs = [
    ['running', a.running, '#0f9a74', 'Running'],
    ['out', a.out, '#f2542d', 'Out of budget'],
    ['paused', a.paused, '#9aa6ad', 'Paused'],
    ['na', a.na, '#cbdbd4', 'Not yet created'],
  ].filter(([, v]) => v > 0.01);

  // The two recessive states are pale enough that the default white label
  // disappears on them, so those segments get dark text instead.
  $('daybar').innerHTML = segs.map(([key, v, color, label]) =>
    `<span class="${key === 'na' || key === 'paused' ? 'on-pale' : ''}"
           style="width:${(v / 24) * 100}%;background:${color}"
           title="${label}: ${hrs(v)}">${(v / 24) > 0.13 ? hrs(v) : ''}</span>`).join('');
  $('daykeys').innerHTML = segs.map(([, v, color, label]) =>
    `<div><i class="sw" style="background:${color}"></i>${label} <b>${hrs(v)}</b></div>`).join('');

  const perDay = t.per_day;
  const priced = t.priced < t.campaigns
    ? ` Priced across only the ${nf.format(t.priced)} campaigns whose budget appears in the export, that is ` +
      `${money.format(perDay.lost_spend)} of spend you could not place per day` +
      ` — the true figure is higher, since ${nf.format(t.campaigns - t.priced)} campaigns have no budget to price against.`
    : ` That works out at ${money.format(perDay.lost_spend)} of spend you could not place per day.`;

  $('answer-account').innerHTML =
    `Across all ${nf.format(t.distinct)} campaigns that is <b>${nf1.format(perDay.out_hours)} campaign-hours ` +
    `of lost opportunity every single day</b>.${priced}`;
}

function kpi(label, value, note, alarm) {
  return `<div class="kpi${alarm ? ' alarm' : ''}">
            <div class="label">${label}</div>
            <div class="value">${value}</div>
            <div class="note">${note}</div>
          </div>`;
}

function renderKpis(t, m) {
  const unit = t.days > 1 ? 'campaign-days' : 'campaigns';
  $('kpis').innerHTML = [
    kpi('Campaigns scored', nf.format(t.distinct),
        t.days > 1 ? `${nf.format(t.campaigns)} campaign-days over ${t.days} days`
                   : 'had budget-state changes'),
    kpi('Lost hours per day', nf1.format(t.per_day.out_hours),
        'campaign-hours shut off, account-wide', true),
    kpi('Average campaign runs', hrs(t.avg_day.running), `of 24 h — then it hits its budget`),
    kpi('Lose over 12 h a day', nf.format(t.over_12h), `${unit} more than half the day dark`, true),
    kpi('Ended the day out', nf.format(t.ended_oob),
        t.campaigns ? `${Math.round(100 * t.ended_oob / t.campaigns)}% of ${unit}` : '', true),
    kpi('Repeat outages', nf.format(t.flapping), `${unit} with 3 or more outages`),
    kpi('Lost spend per day', money.format(t.per_day.lost_spend),
        `only ${nf.format(t.priced)} of ${nf.format(t.campaigns)} ${unit} priced`),
    kpi('Lost sales per day', money.format(t.per_day.lost_sales),
        `ROAS ${m.roas.toFixed(2)} × ${Math.round(m.haircut * 100)}% haircut`),
    kpi('No action taken', nf.format((state.data.action_summary || {}).untouched || 0),
        `campaigns untouched across all ${t.days} day(s)`, true),
  ].join('');
}

function renderCurve(curve, t) {
  const max = Math.max(...curve, 1);
  const peak = curve.indexOf(Math.max(...curve.slice(1)));
  $('curve-sub').textContent =
    `Share of scored campaigns out of budget during each hour. Budgets reset at midnight, then ` +
    `coverage decays as campaigns exhaust their cap — peaking at ${nf1.format(Math.max(...curve.slice(1)))}% around ${String(peak).padStart(2, '0')}:00.`;
  $('curve').innerHTML = curve.map((v, h) => `
    <div class="bar" title="${String(h).padStart(2, '0')}:00 — ${v}% of campaigns out of budget">
      <span class="pct">${v >= 10 ? Math.round(v) : ''}</span>
      <div class="fill" style="height:${(v / max) * 100}%"></div>
      <span class="hour">${String(h).padStart(2, '0')}</span>
    </div>`).join('');
}

function renderReality(t, m) {
  const share = m.actual_spend ? t.lost_spend / m.actual_spend : null;
  $('reality').innerHTML = `
    <div><div class="k">Modelled lost spend</div><div class="v">${money2.format(t.lost_spend)}</div></div>
    <div><div class="k">Actual account spend</div><div class="v">${money2.format(m.actual_spend)}</div></div>
    <div><div class="k">Lost as share of actual</div><div class="v">${share === null ? '—' : pct(share)}</div></div>
    <div><div class="k">Guardrails</div><div class="v" style="font-size:13px;font-weight:500">
      ${t.capped} hit the ${m.cap_multiple}× budget cap, ${t.unreliable} unpriced for too little in-budget time
    </div></div>`;
}

function renderChips() {
  const counts = {};
  const src = (state.mode === 'campaign' && state.data.totals.days > 1)
    ? state.data.recurring : state.data.campaigns;
  for (const c of src) counts[c.dx] = (counts[c.dx] || 0) + 1;
  const order = ['Structurally underfunded', 'Exhausts early', 'Pacing thrash', 'Evening cap',
                 'Intermittent', 'Healthy', 'Mostly paused'];
  const names = state.data.diagnoses.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
  $('chips').innerHTML = names.map((n) => `
    <button class="chip" data-dx="${escapeHtml(n)}" aria-pressed="${state.diagnoses.has(n)}">
      ${escapeHtml(n)}<span class="n">${counts[n] || 0}</span>
    </button>`).join('');
}

function renderQuality(checks, invariants) {
  const rows = checks.map((c) => `
    <div class="qrow q-${c.status}">
      <span class="badge">${c.status === 'ok' ? 'OK' : c.status === 'review' ? 'Review' : 'Fail'}</span>
      <div><strong>${escapeHtml(c.name)}</strong></div>
      <div class="qval">${escapeHtml(c.value)}</div>
      <div class="qnote">${escapeHtml(c.note)}</div>
    </div>`);
  const inv = invariants && invariants.failed.length
    ? `<div class="qrow q-fail"><span class="badge">Fail</span>
       <div><strong>Internal consistency</strong></div>
       <div class="qval">${invariants.failed.length} failed</div>
       <div class="qnote">${escapeHtml(invariants.failed.join(' | '))}</div></div>`
    : `<div class="qrow q-ok"><span class="badge">OK</span>
       <div><strong>Internal consistency</strong></div>
       <div class="qval">${nf.format(invariants ? invariants.checked : 0)} campaigns</div>
       <div class="qnote">For every campaign the minutes in budget, out of budget, paused and
       not-yet-created sum to exactly 1440, the episode durations sum to the out-of-budget total,
       and the hourly buckets agree with both — so the chart and the table cannot tell
       different stories.</div></div>`;
  $('quality').innerHTML = rows.join('') + inv;
}


// -------------------------------------------------------------------- table

const BASE_COLUMNS = [
  { key: 'c', label: 'Campaign', cls: 'name' },
  { key: 'ib', label: 'Runs h/day', cls: 'num' },
  { key: 'ob', label: 'Lost h/day', cls: 'num' },
  { key: 'sh', label: '% day lost', cls: 'num' },
  { key: 'em', label: 'Outages', cls: 'num' },
  { key: 'f', label: '1st out', cls: 'num' },
  { key: null, label: 'Timeline 0→24h', cls: 'strip-h' },
  { key: 'ls', label: 'Lost spend', cls: 'num' },
  { key: 'sv', label: 'Severity', cls: 'num' },
  { key: 'dx', label: 'Diagnosis', cls: 'dx' },
  { key: 'ds', label: 'Last action', cls: 'act' },
];

// One row per campaign, averaged across the days loaded. This is the default
// once there is more than one day: eight rows of the same campaign is noise.
const GROUP_COLUMNS = [
  { key: 'c', label: 'Campaign', cls: 'name' },
  { key: 'out', label: 'Days out', cls: 'num' },
  { key: 'runs', label: 'Runs h/day', cls: 'num' },
  { key: 'mean', label: 'Lost h/day', cls: 'num' },
  { key: 'max', label: 'Worst day', cls: 'num' },
  { key: 'eps', label: 'Outages', cls: 'num' },
  { key: null, label: 'Lost h by day', cls: 'strip-h' },
  { key: 'slope', label: 'Trend', cls: 'trendcell' },
  { key: 'lostd', label: 'Lost $/day', cls: 'num' },
  { key: 'score', label: 'Chronic', cls: 'num' },
  { key: 'dx', label: 'Diagnosis', cls: 'dx' },
  { key: 'ds', label: 'Last action', cls: 'act' },
];

let COLUMNS = BASE_COLUMNS;

function setColumns(mode, multi) {
  const wrap = document.querySelector('.tablewrap');
  if (mode === 'campaign' && multi) {
    COLUMNS = GROUP_COLUMNS;
  } else {
    COLUMNS = multi
      ? [BASE_COLUMNS[0], { key: 'd', label: 'Date', cls: 'date' }, ...BASE_COLUMNS.slice(1)]
      : BASE_COLUMNS;
  }
  wrap.classList.toggle('grouped', mode === 'campaign' && multi);
  wrap.classList.toggle('multi', mode === 'day' && multi);
}

/** Colour for a day: nothing lost is the in-budget green, and everything above
 *  that rides one warm ramp. A single hue getting steadily darker, rather than
 *  the yellow-orange-red rainbow it replaced -- with one hue, "worse" is
 *  readable from the depth of the colour alone. */
function heatColor(lostHours, eligibleHours) {
  const f = eligibleHours > 0 ? Math.min(1, lostHours / eligibleHours) : 0;
  if (f <= 0.005) return '#0f9a74';
  const ramp = ['#fdece7', '#fbd7cd', '#f9bfae', '#f7a58c', '#f4886a',
                '#f2542d', '#d8431f', '#b53617', '#8f2810'];
  return ramp[Math.min(ramp.length - 1, Math.floor(f * ramp.length))];
}

function dayHeat(series, dates) {
  return `<div class="dayheat">${series.map((v, i) =>
    `<i style="background:${heatColor(v, 24)}" title="${dates[i]}: ${hrs(v)} lost"></i>`).join('')}</div>`;
}

function renderHead() {
  $('thead').innerHTML = COLUMNS.map((c, i) => {
    const sorted = c.key && state.sort.key === c.key;
    const arrow = sorted ? (state.sort.dir === -1 ? ' ↓' : ' ↑') : '';
    return `<div class="${c.cls === 'num' ? 'num' : ''}${sorted ? ' sorted' : ''}"
              data-col="${i}">${c.label}${arrow}</div>`;
  }).join('');
}

function applyFilters() {
  const q = state.search.toLowerCase();
  const days = state.data.totals.days;
  const grouped = state.mode === 'campaign' && days > 1;
  const source = grouped ? state.data.recurring : state.data.campaigns;
  const lostKey = grouped ? 'lostd' : 'ls';

  state.view = source.filter((c) => {
    if (q && !c.c.toLowerCase().includes(q)) return false;
    if (state.diagnoses.size && !state.diagnoses.has(c.dx)) return false;
    if (state.pricedOnly && c[lostKey] == null) return false;
    if (state.staleOnly && !c.unt) return false;
    return true;
  });

  // Sort key may not exist in the other grain; fall back to its default.
  let { key, dir } = state.sort;
  if (!COLUMNS.some((col) => col.key === key)) {
    key = grouped ? 'score' : 'sv';
    dir = -1;
    state.sort = { key, dir };
  }
  state.view.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;          // unpriced/unknown always sink
    if (y == null) return -1;
    if (typeof x === 'string') return dir * x.localeCompare(y);
    return dir * (x - y);
  });

  const total = source.length;
  const hours = state.view.reduce((s, c) => s + (grouped ? c.tot : c.ob), 0);
  const noun = grouped ? 'campaigns' : (days > 1 ? 'campaign-days' : 'campaigns');
  $('table-title').textContent = state.view.length === total
    ? `All ${nf.format(total)} ${noun}` + (grouped ? ` across ${days} days` : '')
    : `${nf.format(state.view.length)} of ${nf.format(total)} ${noun}`;
  $('table-sub').innerHTML = grouped
    ? `One row per campaign, averaged over ${days} days. <b>Runs h/day</b> is how long it could ` +
      `actually spend; <b>Lost h/day</b> is how long it sat shut off after hitting its budget. ` +
      `The strip shows one cell per day, newest right. This selection loses ` +
      `${nf1.format(hours)} campaign-hours in total. <b>Click any row for the day-by-day breakdown.</b>`
    : `<b>Runs h/day</b> is how long the campaign could actually spend; <b>Lost h/day</b> is how long ` +
      `it sat shut off after hitting its budget. Together with paused time they make up the 24-hour day. ` +
      `This selection loses ${nf1.format(hours)} campaign-hours. Click any row for its timeline and outages.`;

  setColumns(state.mode, days > 1);
  renderHead();
  $('spacer').style.height = (state.view.length * ROW_H) + 'px';
  $('tbody').scrollTop = 0;
  drawRows(true);
}

let lastWindow = '';

function drawRows(force) {
  const body = $('tbody'), rows = $('rows');
  if (!state.view.length) {
    rows.innerHTML = '<div class="empty">No campaigns match those filters.</div>';
    lastWindow = '';
    return;
  }
  const multiDay = state.data.totals.days > 1;
  const top = body.scrollTop;
  // Fall back to a sensible window if the panel has not been laid out yet.
  const viewportH = body.clientHeight || 620;
  const first = Math.max(0, Math.floor(top / ROW_H) - 6);
  const last = Math.min(state.view.length, Math.ceil((top + viewportH) / ROW_H) + 6);

  // Scrolling within the already-rendered window needs no DOM work.
  const key = first + ':' + last;
  if (!force && key === lastWindow) return;
  lastWindow = key;

  const grouped = state.mode === 'campaign' && multiDay;
  let html = '';
  for (let i = first; i < last; i++) {
    const c = state.view[i];
    html += `<div class="row" style="top:${i * ROW_H}px" data-i="${i}">`
      + (grouped ? groupCells(c) : dayCells(c, multiDay))
      + '</div>';
  }
  rows.innerHTML = html;
}

function dayCells(c, multiDay) {
  const lost = c.ls == null
    ? `<span class="unpriced">no budget</span>`
    : money.format(c.ls) + (c.cap ? ' *' : '');
  return `
    <div class="name" title="${escapeHtml(c.c)}">${escapeHtml(c.c)}</div>
    ${multiDay ? `<div class="date">${c.d}</div>` : ''}
    <div class="num run dur">${hrs(c.ib)}</div>
    <div class="num out dur">${hrs(c.ob)}</div>
    <div class="num">${Math.round(c.sh * 100)}%</div>
    <div class="num">${c.em}${c.er !== c.em ? `<span class="muted"> /${c.er}</span>` : ''}</div>
    <div class="num">${c.f || '—'}</div>
    <div><div class="strip" style="background-image:${c.g}"></div></div>
    <div class="num">${lost}</div>
    <div class="num">${nf1.format(c.sv)}</div>
    <div class="dx"><span class="pill ${DX_CLASS[c.dx] || ''}">${escapeHtml(c.dx)}</span></div>
    <div class="act">${c.unt ? `<span class="stale">${escapeHtml(c.act.sum)}</span>` : `<span class="fresh" title="${escapeHtml(c.act.label || '')}">${escapeHtml(c.act.sum)}</span>`}</div>`;
}

function groupCells(r) {
  const lost = r.lostd == null
    ? `<span class="unpriced">no budget</span>`
    : money.format(r.lostd);
  const trendCls = r.trend === 'worsening' ? 'trend-worse'
    : r.trend === 'improving' ? 'trend-better' : 'muted';
  return `
    <div class="name" title="${escapeHtml(r.c)}">${escapeHtml(r.c)}</div>
    <div class="num">${r.out}<span class="muted">/${r.obs}</span></div>
    <div class="num run dur">${hrs(r.runs)}</div>
    <div class="num out dur">${hrs(r.mean)}</div>
    <div class="num dur">${hrs(r.max)}</div>
    <div class="num">${r.eps}</div>
    <div>${dayHeat(r.series, r.dates)}</div>
    <div class="trendcell ${trendCls}">${r.trend}</div>
    <div class="num">${lost}</div>
    <div class="num">${nf1.format(r.score)}</div>
    <div class="dx"><span class="pill ${DX_CLASS[r.dx] || ''}">${escapeHtml(r.dx)}</span></div>
    <div class="act">${r.unt ? `<span class="stale">${escapeHtml(r.act.sum)}</span>` : `<span class="fresh" title="${escapeHtml(r.act.label || '')}">${escapeHtml(r.act.sum)}</span>`}</div>`;
}

// ------------------------------------------------------------------- drawer


const ACT_LABEL = {
  budget: 'Budget', placement: 'Placement', strategy: 'Strategy', bid: 'Bid',
  targeting: 'Targeting', structure: 'Structure', status: 'Status', portfolio: 'Portfolio',
};

/** "What has anyone actually done to this campaign?" -- shown in the drawer. */
function actionSection(name) {
  const a = (state.data.actions || {})[name];
  if (!a) return '';
  const win = a.win || state.data.totals.days;
  const plural = win === 1 ? 'day' : 'days';

  if (a.unt) {
    return `<h3>Last action</h3>
      <div class="act-none">
        <strong>No action taken in the entire ${win}-${plural} analysis period.</strong>
        <p>No budget, bid, placement, bidding-strategy, targeting or status change was
        recorded for this campaign between ${state.data.meta.dates[0]} and
        ${state.data.meta.dates.at(-1)}. Amazon's own out-of-budget switching is not counted
        as an action — that is the pacing engine, not a person.</p>
      </div>`;
  }

  const rows = (a.recent || []).map((r) => `
    <tr>
      <td style="text-align:left;white-space:nowrap">${escapeHtml(r[0])}</td>
      <td style="text-align:left"><span class="pill act-${escapeHtml(r[1])}">${ACT_LABEL[r[1]] || r[1]}</span></td>
      <td style="text-align:left">${escapeHtml(r[2])}</td>
    </tr>`).join('');

  return `<h3>Last action</h3>
    <div class="act-yes">
      <strong>${escapeHtml(a.sum)}</strong>
      <p>${escapeHtml(a.label || '')} &mdash; ${escapeHtml(a.at || '')}.
      ${a.n} change${a.n === 1 ? '' : 's'} in the ${win}-${plural} window across
      ${(a.cats || []).map((c) => ACT_LABEL[c] || c).join(', ') || 'no categories'}.</p>
    </div>
    ${rows ? `<table class="grid act-log">
      <thead><tr><th style="text-align:left">When</th><th style="text-align:left">Type</th>
      <th style="text-align:left">What changed</th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${a.n > (a.recent || []).length
        ? `<p class="sub" style="margin-top:6px">Showing the ${a.recent.length} most recent of ${a.n} changes.</p>` : ''}` : ''}`;
}

/** Day-by-day view of one campaign: the answer to "what happened each day?" */
function openCampaignDrawer(r) {
  const m = state.data.meta;
  const days = state.data.campaigns
    .filter((c) => c.c === r.c)
    .sort((a, b) => a.d.localeCompare(b.d));

  $('drawer-title').textContent = r.c;
  const ract = (state.data.actions || {})[r.c];
  $('drawer-sub').innerHTML =
    `${r.obs} days · ${escapeHtml(r.dx)} · ran out on ${r.out} of ${r.obs} days · trend ${r.trend}`
    + (ract ? ` · <b class="${ract.unt ? 'act-stale-text' : ''}">${escapeHtml(ract.sum)}</b>` : '');

  const cell = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const worst = days.find((d) => d.d === r.wd);

  $('drawer-body').innerHTML = `
    <div class="dgrid">
      ${cell('Runs per day', `<span style="color:var(--green)">${hrs(r.runs)}</span>`)}
      ${cell('Lost per day', `<span style="color:var(--red)">${hrs(r.mean)}</span>`)}
      ${cell('Worst day', `${hrs(r.max)}<div class="k" style="margin-top:2px">${r.wd}</div>`)}
      ${cell('Days it ran out', `${r.out} of ${r.obs}`)}
      ${cell('Longest run of bad days', `${r.smax}`)}
      ${cell('Total lost', hrs(r.tot))}
      ${cell('Outages', r.eps)}
      ${cell('Chronic score', nf1.format(r.score))}
    </div>

    <h3>Day by day</h3>
    <table class="grid">
      <thead><tr>
        <th>Date</th><th>Runs</th><th>Lost<br><small>billable</small></th><th>Paused</th><th>% lost</th>
        <th>Outages</th><th>1st out</th><th>Timeline 0&rarr;24h</th>
      </tr></thead>
      <tbody>${days.map((d) => `
        <tr${d.d === r.wd ? ' style="background:color-mix(in srgb,var(--red) 8%,transparent)"' : ''}>
          <td style="text-align:left;white-space:nowrap">${d.d}</td>
          <td class="dur" style="color:var(--green)">${hrs(d.ib)}</td>
          <td class="dur" style="color:var(--red);font-weight:600">${hrs(d.ob)}</td>
          <td class="dur muted">${d.pa > 0.005 ? hrs(d.pa) : '—'}</td>
          <td>${Math.round(d.sh * 100)}%</td>
          <td>${d.em}</td>
          <td>${d.f || '—'}</td>
          <td style="width:190px;padding-right:0">
            <div class="strip" style="background-image:${d.g};margin:0;width:100%"></div>
          </td>
        </tr>`).join('')}</tbody>
    </table>
    <div class="axis" style="margin-left:auto;width:190px"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>

    <h3>Money</h3>
    <div class="dgrid">
      ${cell('Lost spend / day', r.lostd == null ? '—' : money2.format(r.lostd))}
      ${cell('Lost spend total', r.lost == null ? '—' : money2.format(r.lost))}
      ${cell('Lost sales total', r.lsa == null ? '—' : money2.format(r.lsa))}
    </div>
    <p class="sub">${r.lostd == null
      ? 'No daily budget for this campaign appears in the export, so there is no honest way to price it. Add a performance report to fill this in.'
      : `Priced from the budget observed in the export, at ROAS ${m.roas.toFixed(2)} with a ${Math.round(m.haircut * 100)}% haircut.`}</p>

    ${worst ? `<h3>Worst day in detail &mdash; ${r.wd}</h3>
      <table class="grid">
        <thead><tr><th>#</th><th>Start</th><th>End</th><th>Duration</th><th>Billable</th></tr></thead>
        <tbody>${worst.eps.map((e) => `<tr>
          <td style="text-align:left">${e.i}</td><td>${e.s}</td><td>${e.e}</td>
          <td class="dur">${hrs(e.m / 60)}</td>
          <td class="dur">${e.a === e.m ? '<span class="muted">same</span>' : hrs(e.a / 60)}</td>
        </tr>`).join('')}</tbody>
      </table>
      <p class="sub" style="margin-top:8px">Duration is wall-clock. <b>Billable</b> excludes any
      minutes the campaign was paused during the outage &mdash; a paused campaign forgoes nothing
      to its budget, so only billable minutes count as lost. "Same" means it was never paused.</p>` : ''}

    ${actionSection(r.c)}`;

  $('drawer').hidden = false;
  $('scrim').hidden = false;
}

function openDrawer(c) {
  const m = state.data.meta;
  $('drawer-title').textContent = c.c;
  const cact = (state.data.actions || {})[c.c];
  $('drawer-sub').innerHTML =
    `${c.d} · ${escapeHtml(c.dx)} · confidence: ${c.cf.replace('_', ' ')}` +
    (c.un ? ` (±${nf2.format(c.un)} h from a repaired gap)` : '') +
    (cact ? ` · <b class="${cact.unt ? 'act-stale-text' : ''}">${escapeHtml(cact.sum)}</b>` : '');

  const cell = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const budget = c.bg == null ? '—' : money2.format(c.bg);
  const src = { daily_budget_event: 'from a budget change', budget_rule: 'from a budget rule',
                perf_report: 'from the performance report', unknown: 'not in the export' }[c.bs];

  $('drawer-body').innerHTML = `
    <div class="dgrid">
      ${cell('Runs per day', `<span style="color:var(--green)">${hrs(c.ib)}</span>`)}
      ${cell('Lost per day', `<span style="color:var(--red)">${hrs(c.ob)}</span>`)}
      ${cell('% of day lost', Math.round(c.sh * 100) + '%')}
      ${cell('Paused', hrs(c.pa))}
      ${cell('First ran out', c.f || '—')}
      ${cell('Recovered', c.l || (c.cl ? 'never' : '—'))}
      ${cell('Budget-cap hits', c.er)}
      ${cell('Distinct outages', c.em)}
    </div>

    <h3>Timeline</h3>
    <div class="dstrip" style="background-image:${c.g}"></div>
    <div class="axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>

    <h3>Money</h3>
    <div class="dgrid">
      ${cell('Daily budget', budget)}
      ${cell('Spend rate', c.rt == null ? '—' : money2.format(c.rt) + '/h')}
      ${cell('Lost spend', c.ls == null ? '—' : money2.format(c.ls))}
      ${cell('Lost sales', c.lsa == null ? '—' : money2.format(c.lsa))}
    </div>
    <p class="sub">Budget ${src}.${c.cap ? ` Lost spend hit the ${m.cap_multiple}× cap, so the true figure could be higher — or demand simply was not there.` : ''}
    ${c.ls == null && c.bs === 'unknown' ? ' Without an observed budget there is no honest way to price this campaign, so nothing is shown rather than a zero. Add a performance report to fill it in.' : ''}</p>

    <h3>Outages (${c.eps.length})</h3>
    <table class="grid">
      <thead><tr><th>#</th><th>Start</th><th>End</th><th>Duration</th><th>Billable</th></tr></thead>
      <tbody>${c.eps.map((e) => `<tr>
        <td style="text-align:left">${e.i}</td><td>${e.s}</td><td>${e.e}</td>
        <td class="dur">${hrs(e.m / 60)}</td>
        <td class="dur">${e.a === e.m ? '<span class="muted">same</span>' : hrs(e.a / 60)}</td>
      </tr>`).join('')}</tbody>
    </table>
    <p class="sub" style="margin-top:8px">Duration is wall-clock. <b>Billable</b> excludes any
    minutes the campaign was paused during the outage — a paused campaign forgoes nothing to its
    budget, so only billable minutes count as lost. "Same" means it was never paused.</p>

    ${actionSection(c.c)}`;

  $('drawer').hidden = false;
  $('scrim').hidden = false;
}

function closeDrawer() { $('drawer').hidden = true; $('scrim').hidden = true; }

// -------------------------------------------------------------------- utils

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// -------------------------------------------------------------------- wiring

const dz = $('dropzone');
['dragenter', 'dragover'].forEach((e) =>
  dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((e) =>
  dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (ev) => acceptFiles(ev.dataTransfer.files, 'history'));
dz.addEventListener('click', () => $('file-input').click());
dz.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $('file-input').click(); }
});
$('pick').addEventListener('click', (ev) => { ev.stopPropagation(); $('file-input').click(); });
$('file-input').addEventListener('change', (ev) => acceptFiles(ev.target.files, 'history'));
$('pick-perf').addEventListener('click', () => $('perf-input').click());
$('perf-input').addEventListener('change', (ev) => acceptFiles(ev.target.files, 'perf'));

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('btn-analyze').addEventListener('click', analyze);
$('btn-error-back').addEventListener('click', () => stage(state.data ? 'dash' : 'upload'));

$('btn-signout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.replace('/login');
});

$('btn-reset').addEventListener('click', async () => {
  await A.api('/api/clear', { method: 'POST' });
  state.data = null; state.files = []; state.diagnoses.clear();
  state.search = ''; $('search').value = ''; state.pricedOnly = false; $('only-priced').checked = false;
  state.staleOnly = false; $('only-stale').checked = false;
  renderFileList();
  stage('upload');
});

// Fetched rather than navigated to, so a refusal renders in the UI instead of
// dumping JSON into a new tab. The session cookie rides along either way.
async function download(format) {
  const res = await A.api('/api/export?format=' + format);
  if (!res.ok) {
    fail((await res.json().catch(() => ({}))).error || 'That export failed.');
    return;
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name ? name[1] : 'ppc-budget-report.' + format;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a later tick: Safari has not finished reading it synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

$('btn-csv').addEventListener('click', () => download('csv'));
$('btn-xlsx').addEventListener('click', () => download('xlsx'));

$('search').addEventListener('input', (ev) => { state.search = ev.target.value; applyFilters(); });
$('only-priced').addEventListener('change', (ev) => { state.pricedOnly = ev.target.checked; applyFilters(); });
$('only-stale').addEventListener('change', (ev) => { state.staleOnly = ev.target.checked; applyFilters(); });

$('chips').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  if (!chip) return;
  const dx = chip.dataset.dx;
  const on = !state.diagnoses.has(dx);
  on ? state.diagnoses.add(dx) : state.diagnoses.delete(dx);
  // Toggle in place rather than re-rendering: the counts never change, and
  // replacing the node would detach the element mid-click.
  chip.setAttribute('aria-pressed', String(on));
  applyFilters();
});

$('thead').addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-col]');
  if (!el) return;
  const col = COLUMNS[+el.dataset.col];
  if (!col.key) return;
  state.sort = state.sort.key === col.key
    ? { key: col.key, dir: -state.sort.dir }
    : { key: col.key, dir: col.key === 'c' || col.key === 'dx' || col.key === 'f' ? 1 : -1 };
  applyFilters();
});

// Synchronous: rendering ~30 rows is sub-millisecond, and rAF does not fire in a
// backgrounded tab, which would leave the table frozen mid-scroll.
$('tbody').addEventListener('scroll', () => drawRows(), { passive: true });
window.addEventListener('resize', () => { if (state.data) drawRows(true); });
$('rows').addEventListener('click', (ev) => {
  const row = ev.target.closest('.row');
  if (!row) return;
  const item = state.view[+row.dataset.i];
  const grouped = state.mode === 'campaign' && state.data.totals.days > 1;
  grouped ? openCampaignDrawer(item) : openDrawer(item);
});

$('grain').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-mode]');
  if (!btn || btn.dataset.mode === state.mode) return;
  state.mode = btn.dataset.mode;
  for (const b of $('grain').querySelectorAll('[data-mode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  }
  applyFilters();
});

$('drawer-close').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeDrawer(); });

$('btn-settings').addEventListener('click', () => {
  $('set-roas').value = state.settings.roas;
  $('set-haircut').value = state.settings.haircut;
  $('set-cap').value = state.settings.cap;
  $('set-gap').value = state.settings.merge_gap;
  $('settings').showModal();
});
$('settings').addEventListener('close', (ev) => {
  if ($('settings').returnValue !== 'apply') return;
  state.settings = {
    roas: $('set-roas').value ? Number($('set-roas').value) : '',
    haircut: Number($('set-haircut').value),
    cap: Number($('set-cap').value),
    merge_gap: Number($('set-gap').value),
  };
  analyze();
});

// Pick up whatever this account already has loaded. Routed through A.api so an
// expired session redirects to the sign-in page rather than silently rendering
// an empty dashboard.
A.api('/api/state').then((r) => r.json()).then((s) => {
  if (s.mode === 'local') {
    const note = $('upload-note');
    if (note) {
      note.textContent = 'Everything stays on this machine. Nothing is uploaded anywhere.';
    }
  } else if (s.user) {
    $('btn-signout').hidden = false;
    $('whoami').textContent = s.user.name || s.user.email;
    $('whoami').title = s.user.email;
    $('link-admin').hidden = !s.user.is_admin;
  }
  state.files = s.history.map((n) => ({ name: n, kind: 'history' }));
  if (s.perf) state.files.push({ name: s.perf, kind: 'perf' });
  renderFileList();
  if (state.files.some((f) => f.kind === 'history')) analyze();
}).catch(() => {});
