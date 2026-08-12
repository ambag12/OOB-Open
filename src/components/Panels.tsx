import { hrs, money, money2, nf, nf1, pct } from '../format';
import type { DashboardData, QualityCheck } from '../lib/payload';

type Totals = DashboardData['totals'];
type Meta = DashboardData['meta'];

/** "A typical campaign's day" -- the headline the whole report exists to give. */
export function Answer({ totals: t, meta: m }: { totals: Totals; meta: Meta }) {
  const a = t.avg_day;
  const day = t.days > 1 ? 'day' : `day (${m.dates[0]})`;

  const segs = (
    [
      ['running', a.running, '#16a34a', 'Running'],
      ['out', a.out, '#dc2626', 'Out of budget'],
      ['paused', a.paused, '#9ca3af', 'Paused'],
      ['na', a.na, '#e5e7eb', 'Not yet created'],
    ] as const
  ).filter(([, v]) => v > 0.01);

  return (
    <div className="answer panel">
      <h2>A typical campaign&rsquo;s day</h2>
      <p className="lede">
        On an average {day}, one of your campaigns spends <b className="run">{hrs(a.running)}</b>{' '}
        able to run &mdash; and <b className="out">{hrs(a.out)}</b> shut off because it hit its
        daily budget.
        {a.paused > 0.05 && ` A further ${hrs(a.paused)} it was paused, which costs nothing.`}
      </p>

      <div className="daybar">
        {segs.map(([key, v, color, label]) => (
          <span
            key={key}
            style={{ width: `${(v / 24) * 100}%`, background: color }}
            title={`${label}: ${hrs(v)}`}
          >
            {v / 24 > 0.13 ? hrs(v) : ''}
          </span>
        ))}
      </div>
      <div className="daykeys">
        {segs.map(([key, v, color, label]) => (
          <div key={key}>
            <i className="sw" style={{ background: color }} />
            {label} <b>{hrs(v)}</b>
          </div>
        ))}
      </div>

      <p className="sub" id="answer-account">
        Across all {nf.format(t.distinct)} campaigns that is{' '}
        <b>{nf1.format(t.per_day.out_hours)} campaign-hours of lost opportunity every single day</b>
        .
        {t.priced < t.campaigns ? (
          <>
            {' '}
            Priced across only the {nf.format(t.priced)} campaigns whose budget appears in the
            export, that is {money.format(t.per_day.lost_spend)} of spend you could not place per
            day — the true figure is higher, since {nf.format(t.campaigns - t.priced)} campaigns
            have no budget to price against.
          </>
        ) : (
          <>
            {' '}
            That works out at {money.format(t.per_day.lost_spend)} of spend you could not place per
            day.
          </>
        )}
      </p>
    </div>
  );
}

function Kpi({
  label,
  value,
  note,
  alarm,
}: {
  label: string;
  value: string;
  note: string;
  alarm?: boolean;
}) {
  return (
    <div className={`kpi${alarm ? ' alarm' : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="note">{note}</div>
    </div>
  );
}

export function Kpis({ data }: { data: DashboardData }) {
  const t = data.totals;
  const m = data.meta;
  const unit = t.days > 1 ? 'campaign-days' : 'campaigns';
  const stale = (data.action_summary as { untouched?: number }).untouched ?? 0;

  return (
    <div className="kpis">
      <Kpi
        label="Campaigns scored"
        value={nf.format(t.distinct)}
        note={
          t.days > 1
            ? `${nf.format(t.campaigns)} campaign-days over ${t.days} days`
            : 'had budget-state changes'
        }
      />
      <Kpi
        label="Lost hours per day"
        value={nf1.format(t.per_day.out_hours)}
        note="campaign-hours shut off, account-wide"
        alarm
      />
      <Kpi
        label="Average campaign runs"
        value={hrs(t.avg_day.running)}
        note="of 24 h — then it hits its budget"
      />
      <Kpi
        label="Lose over 12 h a day"
        value={nf.format(t.over_12h)}
        note={`${unit} more than half the day dark`}
        alarm
      />
      <Kpi
        label="Ended the day out"
        value={nf.format(t.ended_oob)}
        note={t.campaigns ? `${Math.round((100 * t.ended_oob) / t.campaigns)}% of ${unit}` : ''}
        alarm
      />
      <Kpi
        label="Repeat outages"
        value={nf.format(t.flapping)}
        note={`${unit} with 3 or more outages`}
      />
      <Kpi
        label="Lost spend per day"
        value={money.format(t.per_day.lost_spend)}
        note={`only ${nf.format(t.priced)} of ${nf.format(t.campaigns)} ${unit} priced`}
      />
      <Kpi
        label="Lost sales per day"
        value={money.format(t.per_day.lost_sales)}
        note={`ROAS ${m.roas.toFixed(2)} × ${Math.round(m.haircut * 100)}% haircut`}
      />
      <Kpi
        label="No action taken"
        value={nf.format(stale)}
        note={`campaigns untouched across all ${t.days} day(s)`}
        alarm
      />
    </div>
  );
}

export function Curve({ curve }: { curve: number[] }) {
  const max = Math.max(...curve, 1);
  // Hour 0 is excluded from the peak: every budget resets at midnight, so it
  // is always the trough and would never be the interesting answer anyway.
  const afterMidnight = curve.slice(1);
  const peakValue = Math.max(...afterMidnight);
  const peak = curve.indexOf(peakValue);

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Starvation through the day</h2>
          <p className="sub">
            Share of scored campaigns out of budget during each hour. Budgets reset at midnight,
            then coverage decays as campaigns exhaust their cap — peaking at{' '}
            {nf1.format(peakValue)}% around {String(peak).padStart(2, '0')}:00.
          </p>
        </div>
      </div>
      <div className="curve">
        {curve.map((v, h) => (
          <div
            className="bar"
            key={h}
            title={`${String(h).padStart(2, '0')}:00 — ${v}% of campaigns out of budget`}
          >
            <span className="pct">{v >= 10 ? Math.round(v) : ''}</span>
            <div className="fill" style={{ height: `${(v / max) * 100}%` }} />
            <span className="hour">{String(h).padStart(2, '0')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Reality({ totals: t, meta: m }: { totals: Totals; meta: Meta }) {
  const share = m.actual_spend ? t.lost_spend / m.actual_spend : null;
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Reality check</h2>
          <p className="sub">
            Modelled loss against the spend Amazon actually reported. If these ever approach each
            other, the model is wrong &mdash; not the account.
          </p>
        </div>
      </div>
      <div className="reality">
        <div>
          <div className="k">Modelled lost spend</div>
          <div className="v">{money2.format(t.lost_spend)}</div>
        </div>
        <div>
          <div className="k">Actual account spend</div>
          <div className="v">{money2.format(m.actual_spend)}</div>
        </div>
        <div>
          <div className="k">Lost as share of actual</div>
          <div className="v">{share === null ? '—' : pct(share)}</div>
        </div>
        <div>
          <div className="k">Guardrails</div>
          <div className="v" style={{ fontSize: 13, fontWeight: 500 }}>
            {t.capped} hit the {m.cap_multiple}× budget cap, {t.unreliable} unpriced for too little
            in-budget time
          </div>
        </div>
      </div>
    </div>
  );
}

const BADGE = { ok: 'OK', review: 'Review', fail: 'Fail' } as const;

export function Quality({
  checks,
  invariants,
}: {
  checks: QualityCheck[];
  invariants: DashboardData['invariants'];
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Data quality</h2>
          <p className="sub">
            Everything that could change how much you trust the numbers above.
          </p>
        </div>
      </div>
      <div className="quality">
        {checks.map((c, i) => (
          <div className={`qrow q-${c.status}`} key={i}>
            <span className="badge">{BADGE[c.status]}</span>
            <div>
              <strong>{c.name}</strong>
            </div>
            <div className="qval">{c.value}</div>
            <div className="qnote">{c.note}</div>
          </div>
        ))}

        {invariants.failed.length ? (
          <div className="qrow q-fail">
            <span className="badge">Fail</span>
            <div>
              <strong>Internal consistency</strong>
            </div>
            <div className="qval">{invariants.failed.length} failed</div>
            <div className="qnote">{invariants.failed.join(' | ')}</div>
          </div>
        ) : (
          <div className="qrow q-ok">
            <span className="badge">OK</span>
            <div>
              <strong>Internal consistency</strong>
            </div>
            <div className="qval">{nf.format(invariants.checked)} campaigns</div>
            <div className="qnote">
              For every campaign the minutes in budget, out of budget, paused and not-yet-created
              sum to exactly 1440, the episode durations sum to the out-of-budget total, and the
              hourly buckets agree with both — so the chart and the table cannot tell different
              stories.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
