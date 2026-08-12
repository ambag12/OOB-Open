import type { ActionRow, CampaignRow, RecurringRow } from '../lib/payload';

/** The action record folded onto a row so sorting treats it like any column. */
export interface WithAction {
  act: ActionRow;
  /** Untouched campaigns carry Infinity so they sort to the top of "Last action". */
  ds: number | null;
  unt: boolean;
}

export type DayRow = CampaignRow & WithAction;
export type GroupRow = RecurringRow & WithAction;
export type AnyRow = DayRow | GroupRow;

export const BLANK_ACTION: ActionRow = {
  sum: 'not observed',
  ds: null,
  at: null,
  cat: null,
  label: '',
  n: 0,
  cats: [],
  unt: false,
  win: 0,
  recent: [],
};

export function withActions<T extends CampaignRow | RecurringRow>(
  rows: T[],
  actions: Record<string, ActionRow>,
): (T & WithAction)[] {
  return rows.map((row) => {
    const act = actions[row.c] ?? BLANK_ACTION;
    return { ...row, act, ds: act.unt ? Infinity : act.ds, unt: act.unt };
  });
}

export const isGroupRow = (row: AnyRow): row is GroupRow => 'obs' in row;
