import { ArrowUpRight, Check, Clock, Lightning, LockOpen, Pause, Play } from '@phosphor-icons/react';
import { useMemo } from 'react';
import type { Scene, ScheduledEvent } from '../shared/scene.ts';
import type { InspectionSnapshot } from './physics/types.ts';
import './timeline.css';

const timeFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 });
function ActionIcon({ action }: { action: ScheduledEvent['action'] }) {
  if (action.kind === 'launch') return <ArrowUpRight size={20} weight="bold" />;
  if (action.kind === 'release') return <LockOpen size={20} />;
  if (action.kind === 'impulse') return <Lightning size={20} />;
  return action.enabled ? <Play size={20} weight="fill" /> : <Pause size={20} weight="fill" />;
}
function actionTarget(event: ScheduledEvent, scene: Scene): string {
  const action = event.action;
  const bodyId = action.kind === 'load' ? scene.loads[action.loadIndex] : action.bodyId;
  if (typeof bodyId === 'string') return scene.bodies.find(body => body.id === bodyId)?.label ?? bodyId;
  if (bodyId && 'bodyId' in bodyId) return scene.bodies.find(body => body.id === bodyId.bodyId)?.label ?? bodyId.bodyId;
  return 'Gravity';
}

export default function SceneTimeline({ scene, snapshot }: { scene: Scene; snapshot: InspectionSnapshot | null }) {
  const events = useMemo(() => [...scene.events].sort((a, b) => a.at - b.at), [scene]);
  const details = useMemo(() => new Map(scene.events.map(event => {
    const action = event.action;
    const body = action.kind === 'launch' ? scene.bodies.find(body => body.id === action.bodyId) : null;
    const launch = action.kind === 'launch' && body?.mass != null
      ? { mass: body.mass, speed: Math.hypot(...action.velocity), relative: action.frame === 'body' } : null;
    return [event.id, { target: actionTarget(event, scene), launch }] as const;
  })), [scene]);
  const observations = useMemo(() => new Map(snapshot?.events?.map(event => [event.id, event]) ?? []), [snapshot?.events]);
  const inventories = useMemo(() => (snapshot?.entities ?? []).flatMap(entity => {
    const mass = entity.properties.find(property => property.label === 'Loaded mass')?.value;
    const waiting = entity.properties.find(property => property.label === 'Carried objects')?.value;
    return typeof mass === 'number' && typeof waiting === 'number' ? [{ id: entity.id, label: entity.label, mass, waiting }] : [];
  }), [snapshot]);
  if (events.length === 0) return null;
  const completed = events.filter(event => observations.get(event.id)?.status === 'completed').length;
  const next = events.find(event => observations.get(event.id)?.status !== 'completed');
  const lastTime = events.at(-1)!.at;
  const time = snapshot?.time ?? 0;
  const progress = lastTime > 0 ? Math.min(1, time / lastTime) : completed === events.length ? 1 : 0;
  return (
    <section className="panel-section scene-timeline" aria-labelledby="timeline-title">
      <header className="scene-timeline__heading">
        <div><Clock size={17} aria-hidden="true" /><h2 id="timeline-title">Planned actions</h2></div>
        <span aria-live="polite">{completed} / {events.length} done</span>
      </header>
      <div className="scene-timeline__rail" aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></div>
      <ol className="scene-timeline__events" tabIndex={0} aria-label="Scheduled actions in time order">
        {events.map(event => {
          const observation = observations.get(event.id);
          const done = observation?.status === 'completed';
          const isNext = event.id === next?.id;
          const detail = details.get(event.id);
          const target = detail?.target;
          const launch = detail?.launch;
          return (
            <li key={event.id} className={`timeline-event${done ? ' is-complete' : ''}${isNext ? ' is-next' : ''}`} aria-current={isNext ? 'step' : undefined}>
              <div className="timeline-event__time"><time dateTime={`PT${event.at}S`} title={`${event.at} seconds`}>{timeFormat.format(event.at)} s</time><span>{done ? <Check size={15} weight="bold" aria-label="Completed" /> : isNext ? 'Next' : 'Later'}</span></div>
              <span className="timeline-event__icon" aria-hidden="true"><ActionIcon action={event.action} /></span>
              <strong title={event.label}>{event.label}</strong>
              <small title={launch ? `${target}: ${launch.mass} kg; ${launch.speed} m/s${launch.relative ? ' relative to launcher' : ''}` : target}>{launch ? `${timeFormat.format(launch.mass)} kg · ${timeFormat.format(launch.speed)} m/s` : target}</small>
              {done && typeof observation?.firedAt === 'number' ? <span className="visually-hidden">Executed at {timeFormat.format(observation.firedAt)} seconds</span> : null}
            </li>
          );
        })}
      </ol>
      {inventories.length > 0 ? <div className="timeline-inventories">{inventories.map(inventory => (
        <span key={inventory.id}><strong title={inventory.label}>{inventory.label}</strong>{timeFormat.format(inventory.mass)} kg loaded<span>{inventory.waiting} waiting</span></span>
      ))}</div> : null}
      <p>{completed === events.length ? 'All planned actions have happened. Motion continues.' : time === 0 ? 'These happen at the listed times after you press Run.' : next ? <>Next at <strong>{timeFormat.format(next.at)} s</strong></> : null}</p>
    </section>
  );
}
