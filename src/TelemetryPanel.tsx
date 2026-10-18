import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { InspectionSnapshot, Observation } from './physics/types.ts';
import './telemetry.css';

const MAX_SAMPLES = 4000;
const METRICS = {
  height: { label: 'Height', unit: 'm' },
  speed: { label: 'Speed', unit: 'm/s' },
  energy: { label: 'Kinetic energy', unit: 'J' },
} as const;
type Metric = keyof typeof METRICS;
type BodyValues = { id: string; label: string; color: string; height: number | null; speed: number; energy: number | null };
type Sample = { time: number; bodies: Map<string, BodyValues> };
type ChartSeries = { id: string; label: string; color: string; latestValue: number; values: (number | null)[]; path: string };
type TickScale = { min: number; max: number; ticks: number[] };
type ChartModel = {
  width: number;
  height: number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  xTicks: number[];
  yTicks: number[];
  series: ChartSeries[];
};

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  return magnitude < 0.001 || magnitude >= 10000 ? value.toExponential(3) : NUMBER_FORMAT.format(value);
}


function vector3(value: Observation['value'] | undefined): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value;
  return typeof x === 'number' && Number.isFinite(x)
    && typeof y === 'number' && Number.isFinite(y)
    && typeof z === 'number' && Number.isFinite(z)
    ? [x, y, z]
    : null;
}


function sampleSnapshot(snapshot: InspectionSnapshot): Sample {
  const bodies = new Map<string, BodyValues>();
  for (const entity of snapshot.entities) {
    // Fixed supports never move; plotting them adds flat zero lines.
    if (entity.kind !== 'body' || entity.properties.some(property => property.label === 'Motion' && property.value === 'fixed')) continue;
    const velocity = vector3(entity.properties.find(property => property.label === 'Velocity')?.value);
    if (!velocity) continue;
    const position = vector3(entity.properties.find(property => property.label === 'Position')?.value);
    const energy = entity.properties.find(property => property.label === 'Translational kinetic energy')?.value;
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
    if (!Number.isFinite(speed)) continue;
    bodies.set(entity.id, {
      id: entity.id,
      label: entity.label,
      color: entity.color,
      height: position?.[2] ?? null,
      speed,
      energy: typeof energy === 'number' && Number.isFinite(energy) ? energy : null,
    });
  }
  return { time: snapshot.time, bodies };
}


function niceScale(minimum: number, maximum: number): TickScale {
  const range = maximum - minimum || 1;
  const rawStep = range / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const fraction = rawStep / magnitude;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
  const min = Math.floor(minimum / step) * step;
  const max = Math.ceil(maximum / step) * step;
  const count = Math.min(8, Math.max(2, Math.round((max - min) / step) + 1));
  const ticks = Array.from({ length: count }, (_, index) => Number((min + step * index).toPrecision(12)));
  return { min, max: max > min ? max : min + step, ticks };
}

function downsampleIndices(values: (number | null)[], pointLimit: number): number[] {
  const validCount = values.reduce<number>((count, value) => count + (value === null ? 0 : 1), 0);
  if (validCount <= pointLimit) return values.flatMap((value, index) => value === null ? [] : [index]);

  const bucketCount = Math.max(1, Math.floor(pointLimit / 4));
  const selected = new Set<number>();
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * values.length / bucketCount);
    const end = Math.floor((bucket + 1) * values.length / bucketCount);
    let first = -1;
    let last = -1;
    let minimum = -1;
    let maximum = -1;
    for (let index = start; index < end; index += 1) {
      const value = values[index];
      if (value === null || value === undefined) continue;
      if (first < 0) first = index;
      last = index;
      if (minimum < 0 || value < values[minimum]!) minimum = index;
      if (maximum < 0 || value > values[maximum]!) maximum = index;
    }
    if (first >= 0) {
      selected.add(first);
      selected.add(minimum);
      selected.add(maximum);
      selected.add(last);
    }
  }
  return Array.from(selected).sort((left, right) => left - right);
}

function makePath(samples: Sample[], values: (number | null)[], chart: Omit<ChartModel, 'series'>, pointLimit: number): string {
  const indices = downsampleIndices(values, pointLimit);
  let path = '';
  let previous = -1;
  for (const index of indices) {
    const value = values[index];
    if (value === null || value === undefined) continue;
    let gap = false;
    for (let skipped = previous + 1; previous >= 0 && skipped < index; skipped += 1) {
      if (values[skipped] === null) {
        gap = true;
        break;
      }
    }
    const x = chart.plotLeft + (samples[index]!.time - chart.xMin) / (chart.xMax - chart.xMin) * chart.plotWidth;
    const y = chart.plotTop + (chart.yMax - value) / (chart.yMax - chart.yMin) * chart.plotHeight;
    path += `${previous < 0 || gap ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `;
    previous = index;
  }
  return path.trim();
}

function createChart(samples: Sample[], metric: Metric, size: { width: number; height: number }): ChartModel {
  const plotLeft = 48;
  const plotTop = 22;
  const plotWidth = Math.max(1, size.width - plotLeft - 12);
  const plotHeight = Math.max(1, size.height - plotTop - 34);
  const xMin = samples[0]!.time;
  const xMax = samples[samples.length - 1]!.time;
  const latestBodies = Array.from(samples[samples.length - 1]!.bodies.values());
  const rawSeries = latestBodies.flatMap(body => {
    const latestValue = body[metric];
    if (latestValue === null) return [];
    const values = samples.map(sample => {
      const value = sample.bodies.get(body.id);
      return value ? value[metric] : null;
    });
    return [{ id: body.id, label: body.label, color: body.color, latestValue, values }];
  });

  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const series of rawSeries) {
    for (const value of series.values) {
      if (value === null) continue;
      dataMin = Math.min(dataMin, value);
      dataMax = Math.max(dataMax, value);
    }
  }
  if (dataMin === Infinity) {
    dataMin = 0;
    dataMax = 1;
  } else {
    const range = dataMax - dataMin;
    const padding = range === 0 ? Math.max(Math.abs(dataMin) * 0.05, 1) : range * 0.05;
    dataMin -= padding;
    dataMax += padding;
    if (metric !== 'height' && dataMin >= 0) dataMin = Math.max(0, dataMin);
  }
  const yScale = niceScale(dataMin, dataMax);
  const xTicks = niceScale(xMin, xMax).ticks.filter(tick => tick >= xMin - 1e-9 && tick <= xMax + 1e-9);
  const base = {
    width: size.width,
    height: size.height,
    plotLeft,
    plotTop,
    plotWidth,
    plotHeight,
    xMin,
    xMax,
    yMin: yScale.min,
    yMax: yScale.max,
    xTicks,
    yTicks: yScale.ticks,
  };
  const pointLimit = Math.max(2, Math.floor(plotWidth));
  const series = rawSeries.map(item => ({
    ...item,
    path: makePath(samples, item.values, base, pointLimit),
  }));
  return { ...base, series };
}

function nearestSampleIndex(samples: Sample[], time: number): number {
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle]!.time < time) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  return time - samples[low - 1]!.time <= samples[low]!.time - time ? low - 1 : low;
}

export default function TelemetryPanel({ experimentId, snapshot }: {
  experimentId: number | null;
  snapshot: InspectionSnapshot | null;
}) {
  const samplesRef = useRef<Sample[]>([]);
  const lastExperimentId = useRef(experimentId);
  const plotRef = useRef<HTMLDivElement>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [metric, setMetric] = useState<Metric>('height');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [plotSize, setPlotSize] = useState({ width: 640, height: 220 });

  useEffect(() => {
    const changedExperiment = lastExperimentId.current !== experimentId;
    lastExperimentId.current = experimentId;
    let current = changedExperiment ? [] : samplesRef.current;
    let last: Sample | undefined = current[current.length - 1];
    let resetSelection = changedExperiment;

    if (experimentId !== null && snapshot && Number.isFinite(snapshot.time)) {
      if (last && snapshot.time < last.time) {
        current = [];
        last = undefined;
        resetSelection = true;
      }
      if (!last || snapshot.time > last.time) {
        const start = Math.max(0, current.length - MAX_SAMPLES + 1);
        current = [...current.slice(start), sampleSnapshot(snapshot)];
      }
    }

    if (current !== samplesRef.current) {
      samplesRef.current = current;
      setSamples(current);
    }
    if (resetSelection) setActiveIndex(null);
  }, [experimentId, snapshot]);

  useEffect(() => {
    const node = plotRef.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (!bounds) return;
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      setPlotSize(current => current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const chart = useMemo(
    () => samples.length >= 2 ? createChart(samples, metric, plotSize) : null,
    [samples, metric, plotSize],
  );
  const selectedSample = activeIndex === null ? null : samples[activeIndex] ?? null;

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!chart) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const viewX = (event.clientX - rect.left) / rect.width * chart.width;
    const fraction = Math.max(0, Math.min(1, (viewX - chart.plotLeft) / chart.plotWidth));
    const time = chart.xMin + fraction * (chart.xMax - chart.xMin);
    const nextIndex = nearestSampleIndex(samples, time);
    setActiveIndex(current => current === nextIndex ? current : nextIndex);
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (samples.length < 2) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowLeft') nextIndex = activeIndex === null ? samples.length - 1 : Math.max(0, activeIndex - 1);
    else if (event.key === 'ArrowRight') nextIndex = activeIndex === null ? 0 : Math.min(samples.length - 1, activeIndex + 1);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = samples.length - 1;
    else if (event.key === 'Escape') {
      setActiveIndex(null);
      return;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      setActiveIndex(nextIndex);
    }
  }

  return (
    <section className="telemetry-panel" aria-labelledby="telemetry-title">
      <header className="telemetry__header">
        <div>
          <h2 id="telemetry-title">Motion over time</h2>
          <p>Solver samples, about 20 per second. Brief impacts can fall between samples.</p>
        </div>
        <div className="telemetry__metrics" role="group" aria-label="Measurement">
          {(Object.keys(METRICS) as Metric[]).map(key => (
            <button
              type="button"
              key={key}
              aria-pressed={metric === key}
              onClick={() => setMetric(key)}
            >
              {METRICS[key].label}
            </button>
          ))}
        </div>
      </header>
      <div className="telemetry__plot" ref={plotRef} onPointerLeave={() => setActiveIndex(null)}>
        {samples.length < 2 ? (
          <p className="telemetry__empty">Press Run to record height, speed and energy for each moving body.</p>
        ) : chart && chart.series.length === 0 ? (
          <p className="telemetry__empty">No body exposes this measurement.</p>
        ) : chart ? (
          <>
            <svg
              className="telemetry__chart"
              role="img"
              aria-label={`${METRICS[metric].label} (${METRICS[metric].unit}) from ${formatNumber(chart.xMin)} to ${formatNumber(chart.xMax)} s for ${chart.series.length} bodies. Focus the chart and use the left or right arrow keys to inspect samples.`}
              tabIndex={0}
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              onPointerMove={handlePointerMove}
              onKeyDown={handleKeyDown}
              onBlur={() => setActiveIndex(null)}
            >
              <g className="telemetry__grid" aria-hidden="true">
                {chart.yTicks.map(tick => {
                  const y = chart.plotTop + (chart.yMax - tick) / (chart.yMax - chart.yMin) * chart.plotHeight;
                  return (
                    <g key={`y-${tick}`}>
                      <line x1={chart.plotLeft} x2={chart.width - 12} y1={y} y2={y} />
                      <text x={chart.plotLeft - 8} y={y + 3} textAnchor="end">{formatNumber(tick)}</text>
                    </g>
                  );
                })}
                {chart.xTicks.map((tick, index) => {
                  const x = chart.plotLeft + (tick - chart.xMin) / (chart.xMax - chart.xMin) * chart.plotWidth;
                  return (
                    <g key={`x-${index}`}>
                      <line x1={x} x2={x} y1={chart.plotTop} y2={chart.plotTop + chart.plotHeight} />
                      <text x={x} y={chart.height - 17} textAnchor={x - chart.plotLeft < 16 ? 'start' : chart.plotLeft + chart.plotWidth - x < 16 ? 'end' : 'middle'}>{formatNumber(tick)}</text>
                    </g>
                  );
                })}
                <text className="telemetry__axis-title" x={chart.plotLeft} y={12}>{METRICS[metric].label} ({METRICS[metric].unit})</text>
                <text className="telemetry__axis-title" x={chart.plotLeft + chart.plotWidth / 2} y={chart.height - 3} textAnchor="middle">Time (s)</text>
              </g>
              {chart.series.map(series => (
                <path
                  key={series.id}
                  className="telemetry__line"
                  d={series.path}
                  stroke={series.color}
                />
              ))}
              {selectedSample && activeIndex !== null ? (() => {
                const x = chart.plotLeft + (selectedSample.time - chart.xMin) / (chart.xMax - chart.xMin) * chart.plotWidth;
                return (
                  <g className="telemetry__selection" aria-hidden="true">
                    <line x1={x} x2={x} y1={chart.plotTop} y2={chart.plotTop + chart.plotHeight} />
                    {chart.series.map(series => {
                      const value = series.values[activeIndex];
                      if (value === null || value === undefined) return null;
                      const y = chart.plotTop + (chart.yMax - value) / (chart.yMax - chart.yMin) * chart.plotHeight;
                      return <circle key={series.id} cx={x} cy={y} r={3.5} stroke={series.color} />;
                    })}
                  </g>
                );
              })() : null}
            </svg>
            {selectedSample && activeIndex !== null ? (
              <div className="telemetry__readout">
                <p>t = {formatNumber(selectedSample.time)} s</p>
                <ul>
                  {chart.series.map(series => {
                    const value = series.values[activeIndex];
                    return value === null || value === undefined ? null : (
                      <li key={series.id}>
                        <span aria-hidden="true" style={{ backgroundColor: series.color }} />
                        {series.label}: {formatNumber(value)} {METRICS[metric].unit}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {chart && chart.series.length > 0 ? (
        <ul className="telemetry__legend" aria-label="Latest body measurements">
          {chart.series.map(series => (
            <li key={series.id}>
              <span aria-hidden="true" style={{ backgroundColor: series.color }} />
              <span>{series.label}: {formatNumber(series.latestValue)} {METRICS[metric].unit}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
