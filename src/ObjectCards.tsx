import type { EntityObservation, InspectionSnapshot, Observation } from './physics/types.ts';

const ENTITY_LABELS: Record<EntityObservation['kind'], string> = {
  body: 'Body',
  tendon: 'Tendon',
  connection: 'Connection',
};
const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  return magnitude < 0.001 || magnitude >= 10000
    ? value.toExponential(3)
    : NUMBER_FORMAT.format(value);
}

function formatValue(value: Observation['value']): string {
  if (Array.isArray(value)) return `[${value.map(formatNumber).join(', ')}]`;
  return typeof value === 'number' ? formatNumber(value) : value;
}

function ObjectCard({ entity }: { entity: EntityObservation }) {
  return (
    <article className="object-card">
      <header className="object-card__header">
        <span className="object-card__swatch" style={{ backgroundColor: entity.color }} aria-hidden="true" />
        <div className="object-card__title">
          <span className="object-card__kind">{ENTITY_LABELS[entity.kind]}</span>
          <h3>{entity.label}</h3>
        </div>
        <code className="object-card__id">{entity.id}</code>
      </header>
      {entity.properties.length > 0 ? (
        <dl className="property-list">
          {entity.properties.map((property, index) => (
            <div className="property-row" key={`${property.label}-${index}`}>
              <dt>{property.label}{property.unit ? <span className="property-unit"> · {property.unit}</span> : null}</dt>
              <dd>{formatValue(property.value)}</dd>
              {property.note ? <dd className="property-note">{property.note}</dd> : null}
            </div>
          ))}
        </dl>
      ) : (
        <p className="object-card__empty">No additional properties are exposed for this item.</p>
      )}
    </article>
  );
}

export default function ObjectCards({ snapshot, hasExperiment }: {
  snapshot: InspectionSnapshot | null;
  hasExperiment: boolean;
}) {
  return (
    <section className="inspector-section" aria-labelledby="inspector-title">
      <div className="section-heading inspector-heading">
        <div>
          <p className="eyebrow">Read-only inspection</p>
          <h2 id="inspector-title">Object cards</h2>
        </div>
        {snapshot ? <span className="inspector-time">t = {formatNumber(snapshot.time)} s</span> : null}
      </div>
      {snapshot && snapshot.entities.length > 0 ? (
        <div className="object-grid">
          {snapshot.entities.map(entity => <ObjectCard entity={entity} key={entity.id} />)}
        </div>
      ) : (
        <div className="inspector-empty" role="status">
          {hasExperiment
            ? 'The model is preparing. Native values will appear here when a preview is ready.'
            : 'No objects yet. Describe an experiment above to assemble a real mechanics model.'}
        </div>
      )}
    </section>
  );
}
