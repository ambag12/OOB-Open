import { useEffect } from 'react';

import { ACT_LABEL, BUDGET_SOURCE_TEXT, hrs, money2, nf1, nf2 } from '../format';
import type { ActionRow, CampaignRow, DashboardData, EpisodeRow } from '../lib/payload';
import { isGroupRow } from './rows';
import type { AnyRow, DayRow, GroupRow } from './rows';

interface Props {
  row: AnyRow | null;
  data: DashboardData;
  onClose: () => void;
}

export default function Drawer({ row, data, onClose }: Props) {
  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [row, onClose]);

  if (!row) return null;
  const act = data.actions[row.c];

  return (
    <>
      <aside className="drawer" aria-label="Campaign detail">
        <div className="drawer-head">
          <div>
            <h2>{row.c}</h2>
            <p className="sub">
              {isGroupRow(row) ? (
                <>
                  {row.obs} days · {row.dx} · ran out on {row.out} of {row.obs} days · trend{' '}
                  {row.trend}
                </>
              ) : (
                <>
                  {row.d} · {row.dx} · confidence: {row.cf.replace('_', ' ')}
                  {row.un ? ` (±${nf2.format(row.un)} h from a repaired gap)` : ''}
                </>
              )}
              {act && (
                <>
                  {' · '}
                  <b className={act.unt ? 'act-stale-text' : ''}>{act.sum}</b>
                </>
              )}
            </p>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div>
          {isGroupRow(row) ? (
            <CampaignBody r={row} data={data} />
          ) : (
            <DayBody c={row} data={data} />
          )}
          <ActionSection act={act} data={data} />
        </div>
      </aside>
      <div className="scrim" onClick={onClose} />
    </>
  );
}

function Cell({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="k">{k}</div>
      <div className="v">{children}</div>
    </div>
  );
}

const EPISODE_NOTE = (
  <p className="sub" style={{ marginTop: 8 }}>
    Duration is wall-clock. <b>Billable</b> excludes any minutes the campaign was paused during the
    outage — a paused campaign forgoes nothing to its budget, so only billable minutes count as
    lost. &ldquo;Same&rdquo; means it was never paused.
  </p>
);

function EpisodeTable({ eps }: { eps: EpisodeRow[] }) {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>#</th>
          <th>Start</th>
          <th>End</th>
          <th>Duration</th>
          <th>Billable</th>
        </tr>
      </thead>
      <tbody>
        {eps.map((e) => (
          <tr key={e.i}>
            <td style={{ textAlign: 'left' }}>{e.i}</td>
            <td>{e.s}</td>
            <td>{e.e}</td>
            <td className="dur">{hrs(e.m / 60)}</td>
            <td className="dur">
              {e.a === e.m ? <span className="muted">same</span> : hrs(e.a / 60)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Day-by-day view of one campaign: the answer to "what happened each day?" */
function CampaignBody({ r, data }: { r: GroupRow; data: DashboardData }) {
  const m = data.meta;
  const days = data.campaigns
    .filter((c) => c.c === r.c)
    .sort((a, b) => a.d.localeCompare(b.d));
  const worst = days.find((d) => d.d === r.wd);

  return (
    <>
      <div className="dgrid">
        <Cell k="Runs per day">
          <span style={{ color: 'var(--green)' }}>{hrs(r.runs)}</span>
        </Cell>
        <Cell k="Lost per day">
          <span style={{ color: 'var(--red)' }}>{hrs(r.mean)}</span>
        </Cell>
        <Cell k="Worst day">
          {hrs(r.max)}
          <div className="k" style={{ marginTop: 2 }}>
            {r.wd}
          </div>
        </Cell>
        <Cell k="Days it ran out">
          {r.out} of {r.obs}
        </Cell>
        <Cell k="Longest run of bad days">{r.smax}</Cell>
        <Cell k="Total lost">{hrs(r.tot)}</Cell>
        <Cell k="Outages">{r.eps}</Cell>
        <Cell k="Chronic score">{nf1.format(r.score)}</Cell>
      </div>

      <h3>Day by day</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>Date</th>
            <th>Runs</th>
            <th>
              Lost
              <br />
              <small>billable</small>
            </th>
            <th>Paused</th>
            <th>% lost</th>
            <th>Outages</th>
            <th>1st out</th>
            <th>Timeline 0&rarr;24h</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr
              key={d.d}
              style={
                d.d === r.wd
                  ? { background: 'color-mix(in srgb,var(--red) 8%,transparent)' }
                  : undefined
              }
            >
              <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{d.d}</td>
              <td className="dur" style={{ color: 'var(--green)' }}>
                {hrs(d.ib)}
              </td>
              <td className="dur" style={{ color: 'var(--red)', fontWeight: 600 }}>
                {hrs(d.ob)}
              </td>
              <td className="dur muted">{d.pa > 0.005 ? hrs(d.pa) : '—'}</td>
              <td>{Math.round(d.sh * 100)}%</td>
              <td>{d.em}</td>
              <td>{d.f || '—'}</td>
              <td style={{ width: 190, paddingRight: 0 }}>
                <div
                  className="strip"
                  style={{ backgroundImage: d.g, margin: 0, width: '100%' }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="axis" style={{ marginLeft: 'auto', width: 190 }}>
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>

      <h3>Money</h3>
      <div className="dgrid">
        <Cell k="Lost spend / day">{r.lostd == null ? '—' : money2.format(r.lostd)}</Cell>
        <Cell k="Lost spend total">{r.lost == null ? '—' : money2.format(r.lost)}</Cell>
        <Cell k="Lost sales total">{r.lsa == null ? '—' : money2.format(r.lsa)}</Cell>
      </div>
      <p className="sub">
        {r.lostd == null
          ? 'No daily budget for this campaign appears in the export, so there is no honest way ' +
            'to price it. Add a performance report to fill this in.'
          : `Priced from the budget observed in the export, at ROAS ${m.roas.toFixed(2)} with a ` +
            `${Math.round(m.haircut * 100)}% haircut.`}
      </p>

      {worst && (
        <>
          <h3>Worst day in detail &mdash; {r.wd}</h3>
          <EpisodeTable eps={worst.eps} />
          {EPISODE_NOTE}
        </>
      )}
    </>
  );
}

function DayBody({ c, data }: { c: DayRow | CampaignRow; data: DashboardData }) {
  const m = data.meta;
  return (
    <>
      <div className="dgrid">
        <Cell k="Runs per day">
          <span style={{ color: 'var(--green)' }}>{hrs(c.ib)}</span>
        </Cell>
        <Cell k="Lost per day">
          <span style={{ color: 'var(--red)' }}>{hrs(c.ob)}</span>
        </Cell>
        <Cell k="% of day lost">{Math.round(c.sh * 100)}%</Cell>
        <Cell k="Paused">{hrs(c.pa)}</Cell>
        <Cell k="First ran out">{c.f || '—'}</Cell>
        <Cell k="Recovered">{c.l || (c.cl ? 'never' : '—')}</Cell>
        <Cell k="Budget-cap hits">{c.er}</Cell>
        <Cell k="Distinct outages">{c.em}</Cell>
      </div>

      <h3>Timeline</h3>
      <div className="dstrip" style={{ backgroundImage: c.g }} />
      <div className="axis">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>

      <h3>Money</h3>
      <div className="dgrid">
        <Cell k="Daily budget">{c.bg == null ? '—' : money2.format(c.bg)}</Cell>
        <Cell k="Spend rate">{c.rt == null ? '—' : money2.format(c.rt) + '/h'}</Cell>
        <Cell k="Lost spend">{c.ls == null ? '—' : money2.format(c.ls)}</Cell>
        <Cell k="Lost sales">{c.lsa == null ? '—' : money2.format(c.lsa)}</Cell>
      </div>
      <p className="sub">
        Budget {BUDGET_SOURCE_TEXT[c.bs]}.
        {c.cap &&
          ` Lost spend hit the ${m.cap_multiple}× cap, so the true figure could be higher — or ` +
            'demand simply was not there.'}
        {c.ls == null &&
          c.bs === 'unknown' &&
          ' Without an observed budget there is no honest way to price this campaign, so ' +
            'nothing is shown rather than a zero. Add a performance report to fill it in.'}
      </p>

      <h3>Outages ({c.eps.length})</h3>
      <EpisodeTable eps={c.eps} />
      {EPISODE_NOTE}
    </>
  );
}

/** "What has anyone actually done to this campaign?" */
function ActionSection({ act, data }: { act: ActionRow | undefined; data: DashboardData }) {
  if (!act) return null;
  const win = act.win || data.totals.days;
  const plural = win === 1 ? 'day' : 'days';
  const dates = data.meta.dates;

  if (act.unt) {
    return (
      <>
        <h3>Last action</h3>
        <div className="act-none">
          <strong>
            No action taken in the entire {win}-{plural} analysis period.
          </strong>
          <p>
            No budget, bid, placement, bidding-strategy, targeting or status change was recorded
            for this campaign between {dates[0]} and {dates[dates.length - 1]}. Amazon&rsquo;s own
            out-of-budget switching is not counted as an action — that is the pacing engine, not a
            person.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h3>Last action</h3>
      <div className="act-yes">
        <strong>{act.sum}</strong>
        <p>
          {act.label || ''} &mdash; {act.at || ''}. {act.n} change{act.n === 1 ? '' : 's'} in the{' '}
          {win}-{plural} window across{' '}
          {act.cats.map((c) => ACT_LABEL[c] || c).join(', ') || 'no categories'}.
        </p>
      </div>
      {act.recent.length > 0 && (
        <>
          <table className="grid act-log">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>When</th>
                <th style={{ textAlign: 'left' }}>Type</th>
                <th style={{ textAlign: 'left' }}>What changed</th>
              </tr>
            </thead>
            <tbody>
              {act.recent.map((r, i) => (
                <tr key={i}>
                  <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{r[0]}</td>
                  <td style={{ textAlign: 'left' }}>
                    <span className={`pill act-${r[1]}`}>{ACT_LABEL[r[1]] || r[1]}</span>
                  </td>
                  <td style={{ textAlign: 'left' }}>{r[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {act.n > act.recent.length && (
            <p className="sub" style={{ marginTop: 6 }}>
              Showing the {act.recent.length} most recent of {act.n} changes.
            </p>
          )}
        </>
      )}
    </>
  );
}
