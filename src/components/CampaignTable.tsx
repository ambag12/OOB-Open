import { useEffect, useMemo, useRef, useState } from 'react';

import { DX_CLASS, DX_ORDER, heatColor, hrs, money, nf, nf1 } from '../format';
import { isGroupRow } from './rows';
import type { AnyRow, DayRow, GroupRow } from './rows';

const ROW_H = 34;
/** Rows kept rendered above and below the viewport so a fast flick stays filled. */
const OVERSCAN = 6;

interface Column {
  key: string | null;
  label: string;
  cls: string;
}

const BASE_COLUMNS: Column[] = [
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
const GROUP_COLUMNS: Column[] = [
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

const DATE_COLUMN: Column = { key: 'd', label: 'Date', cls: 'date' };

interface Sort {
  key: string;
  dir: 1 | -1;
}

interface Props {
  days: DayRow[];
  recurring: GroupRow[];
  diagnoses: string[];
  totalDays: number;
  onOpen: (row: AnyRow) => void;
}

export default function CampaignTable({ days, recurring, diagnoses, totalDays, onOpen }: Props) {
  const multi = totalDays > 1;
  const [mode, setMode] = useState<'campaign' | 'day'>('campaign');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [pricedOnly, setPricedOnly] = useState(false);
  const [staleOnly, setStaleOnly] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: 'sv', dir: -1 });

  const grouped = mode === 'campaign' && multi;
  const source: AnyRow[] = grouped ? recurring : days;
  const columns = grouped
    ? GROUP_COLUMNS
    : multi
      ? [BASE_COLUMNS[0], DATE_COLUMN, ...BASE_COLUMNS.slice(1)]
      : BASE_COLUMNS;

  // The sort key may not exist in the other grain; fall back to its default.
  // Kept as two primitives, not an object, so the memo below is not rebuilt on
  // every render -- which would reset the scroll position on every render too.
  const known = columns.some((c) => c.key === sort.key);
  const sortKey = known ? sort.key : grouped ? 'score' : 'sv';
  const sortDir: 1 | -1 = known ? sort.dir : -1;

  const view = useMemo(() => {
    const q = search.toLowerCase();
    const lostKey = grouped ? 'lostd' : 'ls';
    const rows = source.filter((c) => {
      if (q && !c.c.toLowerCase().includes(q)) return false;
      if (picked.size && !picked.has(c.dx)) return false;
      if (pricedOnly && (c as unknown as Record<string, unknown>)[lostKey] == null) return false;
      if (staleOnly && !c.unt) return false;
      return true;
    });

    return rows.sort((a, b) => {
      const x = (a as unknown as Record<string, unknown>)[sortKey];
      const y = (b as unknown as Record<string, unknown>)[sortKey];
      if (x === y) return 0;
      if (x == null && y == null) return 0;
      if (x == null) return 1; // unpriced/unknown always sink
      if (y == null) return -1;
      if (typeof x === 'string') return sortDir * x.localeCompare(String(y));
      return sortDir * (Number(x) - Number(y));
    });
  }, [source, search, picked, pricedOnly, staleOnly, sortKey, sortDir, grouped]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const row of source) c[row.dx] = (c[row.dx] || 0) + 1;
    return c;
  }, [source]);

  // ------------------------------------------------------------ virtualiser
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(620);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight || 620);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new selection starts at the top; scrolling within one does not.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [search, picked, pricedOnly, staleOnly, mode, sortKey, sortDir]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(view.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const visible = view.slice(first, last);

  // ---------------------------------------------------------------- copy
  const total = source.length;
  const lostHours = view.reduce((s, c) => s + (isGroupRow(c) ? c.tot : c.ob), 0);
  const noun = grouped ? 'campaigns' : multi ? 'campaign-days' : 'campaigns';
  const title =
    view.length === total
      ? `All ${nf.format(total)} ${noun}` + (grouped ? ` across ${totalDays} days` : '')
      : `${nf.format(view.length)} of ${nf.format(total)} ${noun}`;

  const chipNames = [...diagnoses].sort((a, b) => DX_ORDER.indexOf(a) - DX_ORDER.indexOf(b));

  const onHeaderClick = (col: Column) => {
    if (!col.key) return;
    setSort(
      sortKey === col.key
        ? { key: col.key, dir: (-sortDir as 1 | -1) }
        : {
            key: col.key,
            dir: col.key === 'c' || col.key === 'dx' || col.key === 'f' ? 1 : -1,
          },
    );
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="sub">
            {grouped ? (
              <>
                One row per campaign, averaged over {totalDays} days. <b>Runs h/day</b> is how long
                it could actually spend; <b>Lost h/day</b> is how long it sat shut off after
                hitting its budget. The strip shows one cell per day, newest right. This selection
                loses {nf1.format(lostHours)} campaign-hours in total.{' '}
                <b>Click any row for the day-by-day breakdown.</b>
              </>
            ) : (
              <>
                <b>Runs h/day</b> is how long the campaign could actually spend;{' '}
                <b>Lost h/day</b> is how long it sat shut off after hitting its budget. Together
                with paused time they make up the 24-hour day. This selection loses{' '}
                {nf1.format(lostHours)} campaign-hours. Click any row for its timeline and outages.
              </>
            )}
          </p>
        </div>
        <div className="controls">
          {multi && (
            <div className="segmented" role="group" aria-label="Row grain">
              <button
                aria-pressed={mode === 'campaign'}
                onClick={() => setMode('campaign')}
              >
                One row per campaign
              </button>
              <button aria-pressed={mode === 'day'} onClick={() => setMode('day')}>
                One row per day
              </button>
            </div>
          )}
          <input
            type="search"
            placeholder="Filter by campaign name…"
            aria-label="Filter by campaign name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={pricedOnly}
              onChange={(e) => setPricedOnly(e.target.checked)}
            />{' '}
            Priced only
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={staleOnly}
              onChange={(e) => setStaleOnly(e.target.checked)}
            />{' '}
            No action taken
          </label>
        </div>
      </div>

      <div className="chips">
        {chipNames.map((n) => (
          <button
            className="chip"
            key={n}
            aria-pressed={picked.has(n)}
            onClick={() =>
              setPicked((prev) => {
                const next = new Set(prev);
                if (next.has(n)) next.delete(n);
                else next.add(n);
                return next;
              })
            }
          >
            {n}
            <span className="n">{counts[n] || 0}</span>
          </button>
        ))}
      </div>

      <div className={`tablewrap${grouped ? ' grouped' : multi ? ' multi' : ''}`}>
        <div className="thead">
          {columns.map((c, i) => {
            const sorted = c.key !== null && sortKey === c.key;
            return (
              <div
                key={i}
                className={`${c.cls === 'num' ? 'num' : ''}${sorted ? ' sorted' : ''}`}
                onClick={() => onHeaderClick(c)}
              >
                {c.label}
                {sorted ? (sortDir === -1 ? ' ↓' : ' ↑') : ''}
              </div>
            );
          })}
        </div>
        <div
          className="tbody"
          ref={bodyRef}
          tabIndex={0}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div className="spacer" style={{ height: view.length * ROW_H }} />
          <div className="rows">
            {view.length === 0 ? (
              <div className="empty">No campaigns match those filters.</div>
            ) : (
              visible.map((row, i) => (
                <div
                  className="row"
                  key={`${row.c}-${isGroupRow(row) ? 'g' : row.d}`}
                  style={{ top: (first + i) * ROW_H }}
                  onClick={() => onOpen(row)}
                >
                  {isGroupRow(row) ? <GroupCells r={row} /> : <DayCells c={row} multi={multi} />}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <p className="legend">
        <span>
          <i className="sw" style={{ background: '#16a34a' }} />
          In budget
        </span>
        <span>
          <i className="sw" style={{ background: '#dc2626' }} />
          Out of budget
        </span>
        <span>
          <i className="sw" style={{ background: '#9ca3af' }} />
          Paused
        </span>
        <span>
          <i className="sw" style={{ background: '#e5e7eb' }} />
          Not yet created
        </span>
        <span className="muted">Timeline runs midnight to midnight, left to right.</span>
      </p>
    </div>
  );
}

function ActionCell({ row }: { row: AnyRow }) {
  return (
    <div className="act">
      {row.unt ? (
        <span className="stale">{row.act.sum}</span>
      ) : (
        <span className="fresh" title={row.act.label || ''}>
          {row.act.sum}
        </span>
      )}
    </div>
  );
}

function DayCells({ c, multi }: { c: DayRow; multi: boolean }) {
  return (
    <>
      <div className="name" title={c.c}>
        {c.c}
      </div>
      {multi && <div className="date">{c.d}</div>}
      <div className="num run dur">{hrs(c.ib)}</div>
      <div className="num out dur">{hrs(c.ob)}</div>
      <div className="num">{Math.round(c.sh * 100)}%</div>
      <div className="num">
        {c.em}
        {c.er !== c.em && <span className="muted"> /{c.er}</span>}
      </div>
      <div className="num">{c.f || '—'}</div>
      <div>
        <div className="strip" style={{ backgroundImage: c.g }} />
      </div>
      <div className="num">
        {c.ls == null ? (
          <span className="unpriced">no budget</span>
        ) : (
          money.format(c.ls) + (c.cap ? ' *' : '')
        )}
      </div>
      <div className="num">{nf1.format(c.sv)}</div>
      <div className="dx">
        <span className={`pill ${DX_CLASS[c.dx] || ''}`}>{c.dx}</span>
      </div>
      <ActionCell row={c} />
    </>
  );
}

function GroupCells({ r }: { r: GroupRow }) {
  const trendCls =
    r.trend === 'worsening' ? 'trend-worse' : r.trend === 'improving' ? 'trend-better' : 'muted';
  return (
    <>
      <div className="name" title={r.c}>
        {r.c}
      </div>
      <div className="num">
        {r.out}
        <span className="muted">/{r.obs}</span>
      </div>
      <div className="num run dur">{hrs(r.runs)}</div>
      <div className="num out dur">{hrs(r.mean)}</div>
      <div className="num dur">{hrs(r.max)}</div>
      <div className="num">{r.eps}</div>
      <div>
        <div className="dayheat">
          {r.series.map((v, i) => (
            <i
              key={i}
              style={{ background: heatColor(v, 24) }}
              title={`${r.dates[i]}: ${hrs(v)} lost`}
            />
          ))}
        </div>
      </div>
      <div className={`trendcell ${trendCls}`}>{r.trend}</div>
      <div className="num">
        {r.lostd == null ? <span className="unpriced">no budget</span> : money.format(r.lostd)}
      </div>
      <div className="num">{nf1.format(r.score)}</div>
      <div className="dx">
        <span className={`pill ${DX_CLASS[r.dx] || ''}`}>{r.dx}</span>
      </div>
      <ActionCell row={r} />
    </>
  );
}
