import { useMemo, useState } from 'react';

import CampaignTable from './CampaignTable';
import Drawer from './Drawer';
import { Answer, Curve, Kpis, Quality, Reality } from './Panels';
import { withActions } from './rows';
import type { AnyRow } from './rows';
import type { DashboardData } from '../lib/payload';

export default function Dashboard({ data }: { data: DashboardData }) {
  const [selected, setSelected] = useState<AnyRow | null>(null);

  // Fold the per-campaign action record onto every row so the sort and filter
  // machinery treats it like any other column.
  const days = useMemo(() => withActions(data.campaigns, data.actions), [data]);
  const recurring = useMemo(() => withActions(data.recurring, data.actions), [data]);

  return (
    <section>
      <Answer totals={data.totals} meta={data.meta} />
      <Kpis data={data} />
      <Curve curve={data.curve} />
      <Reality totals={data.totals} meta={data.meta} />
      <CampaignTable
        days={days}
        recurring={recurring}
        diagnoses={data.diagnoses}
        totalDays={data.totals.days}
        onOpen={setSelected}
      />
      <Quality checks={data.quality} invariants={data.invariants} />
      <Drawer row={selected} data={data} onClose={() => setSelected(null)} />
    </section>
  );
}
