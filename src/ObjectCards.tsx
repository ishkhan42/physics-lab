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
  return typeof value === 'number' ? formatNumber(value) : displayText(value);
}

function displayText(value: string): string {
  return value.replace(/[—–]/g, '-').replace(/·/g, ' ');
}

function primaryProperties(entity: EntityObservation): Observation[] {
  if (entity.kind === 'body') {
    const fixed = entity.properties.some(property => property.label === 'Motion' && property.value === 'fixed');
    if (fixed) {
      return entity.properties.filter(property =>
        ['Shape', 'Radius', 'Full side lengths', 'Radius / cylindrical length', 'Semiaxes', 'Visible half-widths', 'Geometry',
          'Target restitution', 'Static friction coefficient', 'Sliding friction coefficient', 'Torsional friction length', 'Rolling friction length'].includes(property.label),
      );
    }
    return ['Position', 'Velocity', 'Mass', 'Speed'].flatMap(label => {
      const property = entity.properties.find(item => item.label === label);
      return property ? [property] : [];
    });
  }
  return entity.properties.filter(property =>
    property.label === 'Length' || /tension|axial force|force/i.test(property.label),
  );
}

function FeaturedValue({ value }: { value: Observation['value'] }) {
  if (Array.isArray(value) && value.length === 3) {
    return (
      <span className="vector-value">
        {value.map((component, index) => (
          <span key={index}><i>{'xyz'[index]}</i>{formatNumber(component)}</span>
        ))}
      </span>
    );
  }
  return <>{formatValue(value)}</>;
}

function PropertyRows({ properties, featured = false }: { properties: Observation[]; featured?: boolean }) {
  return (
    <dl className={`property-list${featured ? ' property-list--featured' : ''}`}>
      {properties.map((property, index) => (
        <div className={`property-row${featured && Array.isArray(property.value) && property.value.length === 3 ? ' property-row--vector' : ''}`} key={`${property.label}-${index}`}>
          <dt>{displayText(property.label)}{property.unit ? <span className="property-unit"> ({displayText(property.unit)})</span> : null}</dt>
          <dd>{featured ? <FeaturedValue value={property.value} /> : formatValue(property.value)}</dd>
          {property.note ? <dd className="property-note">{displayText(property.note)}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

function ObjectCard({ entity }: { entity: EntityObservation }) {
  const primary = primaryProperties(entity);
  const remaining = entity.properties.filter(property => !primary.includes(property));
  const fixed = entity.kind === 'body' && entity.properties.some(property => property.label === 'Motion' && property.value === 'fixed');
  return (
    <article className={`object-card${fixed ? ' object-card--support' : ''}`} aria-label={`${fixed ? 'Fixed support' : ENTITY_LABELS[entity.kind]}: ${displayText(entity.label)}`} title={`ID ${entity.id}`}>
      <header className="object-card__header">
        <span className="object-card__swatch" style={{ backgroundColor: entity.color }} aria-hidden="true" />
        <h3>{displayText(entity.label)}</h3>
        <span className="object-card__kind">{fixed ? 'Fixed support' : ENTITY_LABELS[entity.kind]}</span>
      </header>
      {primary.length > 0 ? <PropertyRows properties={primary} featured /> : null}
      {entity.properties.length === 0 ? <p className="object-card__empty">No properties are exposed for this item.</p> : null}
      {entity.properties.length > 0 && primary.length === 0 ? <p className="object-card__empty">No length or force values are exposed.</p> : null}
      {remaining.length > 0 ? (
        <details className="object-details">
          <summary>More properties ({remaining.length})</summary>
          <PropertyRows properties={remaining} />
        </details>
      ) : null}
    </article>
  );
}

export default function ObjectCards({ snapshot, hasExperiment }: {
  snapshot: InspectionSnapshot | null;
  hasExperiment: boolean;
}) {
  const entities = snapshot ? [...snapshot.entities].sort((left, right) => {
    const leftFixed = left.kind === 'body' && left.properties.some(property => property.label === 'Motion' && property.value === 'fixed');
    const rightFixed = right.kind === 'body' && right.properties.some(property => property.label === 'Motion' && property.value === 'fixed');
    const leftOrder = left.kind !== 'body' ? 1 : leftFixed ? 2 : 0;
    const rightOrder = right.kind !== 'body' ? 1 : rightFixed ? 2 : 0;
    return leftOrder - rightOrder;
  }) : [];
  return (
    <section className="inspector-section" aria-labelledby="inspector-title">
      <div className="section-heading inspector-heading">
        <h2 id="inspector-title">Objects{entities.length > 0 ? <span className="inspector-count">{entities.length}</span> : null}</h2>
        {snapshot ? <span className="inspector-time">t = {formatNumber(snapshot.time)} s</span> : null}
      </div>
      {entities.length > 0 ? (
        <div className="object-grid">
          {entities.map(entity => <ObjectCard entity={entity} key={entity.id} />)}
        </div>
      ) : (
        <div className="inspector-empty" role="status">
          {hasExperiment
            ? 'Native values will appear when the preview is ready.'
            : 'Describe an experiment to see its bodies, connections, and supports here.'}
        </div>
      )}
    </section>
  );
}
