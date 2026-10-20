import type { EntityObservation, InspectionSnapshot, Observation } from './types.ts';

const ENTITY_COLUMNS = ['index', 'id', 'label', 'kind', 'color'] as const;

export type ObservationDescriptor = Omit<Observation, 'value'>;
export type ModelEntityRow = [index: number, id: string, label: string, kind: EntityObservation['kind'], color: string, ...values: Observation['value'][]];

export interface EntityTable {
  entityColumns: typeof ENTITY_COLUMNS;
  observationColumns: ObservationDescriptor[];
  rows: ModelEntityRow[];
}

export interface CompactInspection extends Omit<InspectionSnapshot, 'entities'> {
  entityTables: EntityTable[];
}

export interface ModelTable {
  columns: string[];
  rows: unknown[][];
}


export function compactInspection(snapshot: InspectionSnapshot): CompactInspection {
  const { entities, ...inspection } = snapshot;
  const entityTables: EntityTable[] = [];
  const tables = new Map<string, EntityTable>();
  for (const [index, entity] of entities.entries()) {
    const observationColumns = entity.properties.map(({ value: _value, ...descriptor }) => descriptor);
    const signature = JSON.stringify(observationColumns);
    let table = tables.get(signature);
    if (!table) {
      table = { entityColumns: ENTITY_COLUMNS, observationColumns, rows: [] };
      entityTables.push(table);
      tables.set(signature, table);
    }
    table.rows.push([
      index, entity.id, entity.label, entity.kind, entity.color,
      ...entity.properties.map(property => property.value),
    ]);
  }
  return { ...inspection, entityTables };
}

export function toModelTable(records: readonly object[]): ModelTable {
  const columns = records.length ? Object.keys(records[0]!) : [];
  const expectedKeys = new Set(columns);
  const rows = records.map(record => {
    const keys = Object.keys(record);
    if (keys.length !== columns.length || keys.some(key => !expectedKeys.has(key))) {
      throw new Error('Cannot compact records with different enumerable keys.');
    }
    const values = record as Record<string, unknown>;
    return columns.map(column => values[column]);
  });
  return { columns, rows };
}
