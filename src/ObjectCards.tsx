import { CaretRight, Clock } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import type { EntityObservation, InspectionSnapshot, Observation } from './physics/types.ts';

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });
const FRIENDLY_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const SMALL_FORMAT = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 });

// Exact values for "All values".
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  return magnitude < 0.001 || magnitude >= 10000
    ? value.toExponential(3)
    : NUMBER_FORMAT.format(value);
}

// Readable values for the summary rows. Solver noise below 0.1 mm or 0.1 mm/s reads as 0.
function formatFriendly(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude < 1e-4) return '0';
  if (magnitude < 0.01) return SMALL_FORMAT.format(value);
  if (magnitude >= 100000) return value.toExponential(2);
  return FRIENDLY_FORMAT.format(value);
}

function formatValue(value: Observation['value']): string {
  if (Array.isArray(value)) return `[${value.map(formatNumber).join(', ')}]`;
  return typeof value === 'number' ? formatNumber(value) : displayText(value);
}

function displayText(value: string): string {
  return value.replace(/[—–]/g, '-').replace(/·/g, ' ');
}

function property(entity: EntityObservation, label: string): Observation | undefined {
  return entity.properties.find(item => item.label === label);
}

function vector(entity: EntityObservation, label: string): number[] | null {
  const value = property(entity, label)?.value;
  return Array.isArray(value) && value.length === 3 ? value : null;
}

function isFixed(entity: EntityObservation): boolean {
  return entity.kind === 'body' && property(entity, 'Motion')?.value === 'fixed';
}

function waitingActivity(entity: EntityObservation): string | null {
  const activity = property(entity, 'Activity')?.value;
  return activity === 'Waiting for launch' || activity === 'Waiting for release' ? activity : null;
}

type Metric = { label: string; value: string; unit?: string };

function keyMetrics(entity: EntityObservation): Metric[] {
  if (entity.kind === 'body' && !isFixed(entity)) {
    const metrics: Metric[] = [];
    const velocity = vector(entity, 'Velocity');
    const position = vector(entity, 'Position');
    const mass = property(entity, 'Mass')?.value;
    const energy = property(entity, 'Translational kinetic energy')?.value;
    if (velocity) metrics.push({ label: 'Speed', value: formatFriendly(Math.hypot(...velocity)), unit: 'm/s' });
    if (position) metrics.push({ label: 'Height', value: formatFriendly(position[2]!), unit: 'm' });
    if (typeof mass === 'number') metrics.push({ label: 'Mass', value: formatFriendly(mass), unit: 'kg' });
    if (typeof energy === 'number') metrics.push({ label: 'Kinetic energy', value: formatFriendly(energy), unit: 'J' });
    return metrics;
  }
  const labels = isFixed(entity)
    ? ['Shape', 'Radius', 'Full side lengths', 'Target restitution', 'Sliding friction coefficient']
    : ['Length', 'Tension', 'Axial force', 'Extension', 'Rest length'];
  return labels.flatMap(label => {
    const item = property(entity, label);
    if (!item) return [];
    const value = typeof item.value === 'number' ? formatFriendly(item.value)
      : Array.isArray(item.value) ? item.value.map(formatFriendly).join(' × ') : displayText(item.value);
    return [{ label: label === 'Target restitution' ? 'Bounciness' : label === 'Sliding friction coefficient' ? 'Friction' : label === 'Full side lengths' ? 'Size' : label, value, unit: item.unit }];
  });
}

// One short value shown at the end of a collapsed row.
function rowValue(entity: EntityObservation): string {
  if (waitingActivity(entity)) return 'Waiting';
  if (isFixed(entity)) return 'Fixed';
  if (entity.kind === 'body') {
    const velocity = vector(entity, 'Velocity');
    return velocity ? `${formatFriendly(Math.hypot(...velocity))} m/s` : '';
  }
  const force = property(entity, 'Tension') ?? property(entity, 'Axial force');
  if (force && typeof force.value === 'number') return `${formatFriendly(force.value)} ${force.unit ?? 'N'}`;
  const length = property(entity, 'Length');
  return length && typeof length.value === 'number' ? `${formatFriendly(length.value)} m` : '';
}

function PropertyRows({ properties }: { properties: Observation[] }) {
  return (
    <dl className="property-list">
      {properties.map((item, index) => (
        <div className="property-row" key={`${item.label}-${index}`}>
          <dt>{displayText(item.label)}{item.unit ? <span className="property-unit"> ({displayText(item.unit)})</span> : null}</dt>
          <dd>{formatValue(item.value)}</dd>
          {item.note ? <dd className="property-note">{displayText(item.note)}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

function ObjectRow({ entity, selected, canSelect, onSelect }: { entity: EntityObservation; selected: boolean; canSelect: boolean; onSelect: (id: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const expanded = selected || open;
  const waiting = waitingActivity(entity);
  const metrics = waiting ? [] : keyMetrics(entity);
  const toggle = () => {
    if (canSelect) onSelect(selected ? null : entity.id);
    else setOpen(current => !current);
  };
  return (
    <li id={`object-${entity.id}`} data-entity-id={entity.id} className={`object-row${expanded ? ' is-open' : ''}${selected ? ' is-selected' : ''}`}>
      <button className="object-row__summary object-select" type="button" onClick={toggle} aria-expanded={expanded} aria-pressed={canSelect ? selected : undefined} title={canSelect ? 'Select in the scene' : undefined}>
        <span className="object-row__swatch" style={{ backgroundColor: entity.color }} aria-hidden="true" />
        <span className="object-row__name">{displayText(entity.label)}</span>
        <span className="object-row__value">{rowValue(entity)}</span>
        <CaretRight className="object-row__caret" size={12} weight="bold" aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="object-row__details">
          {waiting ? <p className="object-row__activity"><Clock size={14} aria-hidden="true" />{waiting}. It starts when you press Run.</p> : null}
          {metrics.length > 0 ? (
            <dl className="metric-grid">
              {metrics.map(metric => (
                <div key={metric.label}>
                  <dt>{metric.label}</dt>
                  <dd>{metric.value}{metric.unit ? <small> {metric.unit}</small> : null}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {entity.properties.length > 0 ? (
            <details className="object-details" onToggle={event => setAllOpen(event.currentTarget.open)}>
              <summary>All values</summary>
              {allOpen ? <PropertyRows properties={entity.properties} /> : null}
            </details>
          ) : <p className="object-row__empty">No values are available for this item.</p>}
        </div>
      ) : null}
    </li>
  );
}

type Group = { key: string; label: string; entities: EntityObservation[] };

// Identical fixed parts ("Loop panel 01" to "Loop panel 32") collapse into one group.
function groupSupports(entities: EntityObservation[]): (EntityObservation | Group)[] {
  const byBase = new Map<string, EntityObservation[]>();
  for (const entity of entities) {
    const base = entity.label.replace(/[\s_-]*\d+$/, '').trim() || entity.label;
    byBase.set(base, [...(byBase.get(base) ?? []), entity]);
  }
  return [...byBase.entries()].flatMap(([label, members]): (EntityObservation | Group)[] =>
    members.length >= 3 ? [{ key: `group-${label}`, label, entities: members }] : members);
}

function SupportGroup({ group, selectedEntityId, selectableEntities, onSelectEntity }: {
  group: Group;
  selectedEntityId: string | null;
  selectableEntities: ReadonlySet<string>;
  onSelectEntity: (id: string | null) => void;
}) {
  const containsSelection = group.entities.some(entity => entity.id === selectedEntityId);
  const [open, setOpen] = useState(false);
  const expanded = open || containsSelection;
  return (
    <li className={`object-group${expanded ? ' is-open' : ''}`}>
      <button className="object-row__summary" type="button" aria-expanded={expanded} onClick={() => setOpen(current => !current)}>
        <span className="object-row__swatch" style={{ backgroundColor: group.entities[0]!.color }} aria-hidden="true" />
        <span className="object-row__name">{displayText(group.label)} <span className="object-group__count">× {group.entities.length}</span></span>
        <span className="object-row__value">Fixed</span>
        <CaretRight className="object-row__caret" size={12} weight="bold" aria-hidden="true" />
      </button>
      {expanded ? (
        <ul className="object-list object-list--nested">
          {group.entities.map(entity => <ObjectRow entity={entity} selected={entity.id === selectedEntityId} canSelect={selectableEntities.has(entity.id)} onSelect={onSelectEntity} key={entity.id} />)}
        </ul>
      ) : null}
    </li>
  );
}

export default function ObjectCards({ snapshot, hasExperiment, selectedEntityId, selectableEntities, onSelectEntity }: {
  snapshot: InspectionSnapshot | null;
  hasExperiment: boolean;
  selectedEntityId: string | null;
  selectableEntities: ReadonlySet<string>;
  onSelectEntity: (id: string | null) => void;
}) {
  const sections = useMemo(() => {
    const entities = snapshot?.entities ?? [];
    return {
      moving: entities.filter(entity => entity.kind === 'body' && !isFixed(entity)),
      links: entities.filter(entity => entity.kind !== 'body'),
      supports: groupSupports(entities.filter(isFixed)),
      count: entities.length,
    };
  }, [snapshot]);

  useEffect(() => {
    if (!selectedEntityId) return;
    const frame = requestAnimationFrame(() => document.getElementById(`object-${selectedEntityId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [selectedEntityId]);

  const rows = (entities: EntityObservation[]) => entities.map(entity => (
    <ObjectRow entity={entity} selected={entity.id === selectedEntityId} canSelect={selectableEntities.has(entity.id)} onSelect={onSelectEntity} key={entity.id} />
  ));

  return (
    <section className="panel-section inspector-section" aria-labelledby="inspector-title">
      <div className="section-heading">
        <h2 id="inspector-title">Objects</h2>
        {snapshot ? <span className="section-heading__meta">at {formatFriendly(snapshot.time)} s</span> : null}
      </div>
      {sections.count > 0 ? (
        <>
          {sections.moving.length > 0 ? <ul className="object-list" aria-label="Moving objects">{rows(sections.moving)}</ul> : null}
          {sections.links.length > 0 ? <>
            <h3 className="object-list__title">Connections</h3>
            <ul className="object-list" aria-label="Connections">{rows(sections.links)}</ul>
          </> : null}
          {sections.supports.length > 0 ? <>
            <h3 className="object-list__title">Fixed parts</h3>
            <ul className="object-list" aria-label="Fixed parts">
              {sections.supports.map(item => 'entities' in item
                ? <SupportGroup group={item} selectedEntityId={selectedEntityId} selectableEntities={selectableEntities} onSelectEntity={onSelectEntity} key={item.key} />
                : <ObjectRow entity={item} selected={item.id === selectedEntityId} canSelect={selectableEntities.has(item.id)} onSelect={onSelectEntity} key={item.id} />)}
            </ul>
          </> : null}
        </>
      ) : (
        <p className="inspector-empty" role="status">
          {hasExperiment ? 'Values appear when the preview is ready.' : 'Objects in the experiment will be listed here.'}
        </p>
      )}
    </section>
  );
}
