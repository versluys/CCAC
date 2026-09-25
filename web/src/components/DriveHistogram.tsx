/**
 * Households by drive time.
 *
 * The question this answers is the one the committee keeps asking in words:
 * if we move here, how many families are close and how many are a long way
 * out? A cumulative "46% within 20 minutes" hides the shape — it cannot tell
 * you whether the rest are at 25 minutes or at 70. These are exclusive
 * buckets, so the tail is visible.
 *
 * Form: horizontal bars. The bands are an ordered magnitude, the panel is
 * narrow, and the band labels read better beside the bars than under them.
 * Colour is sequential over one hue because drive time is a magnitude rather
 * than an identity, with the over-an-hour bucket in a status colour: that
 * household is out of reach, not merely further along the scale. Every bar is
 * directly labelled, so identity never rests on colour alone, and a table view
 * is available for anyone the colours fail.
 */

import { useMemo, useState } from 'react';

export interface Bucket {
  label: string;
  from: number;
  to: number | null;
  count: number;
  colorVar: string;
}

interface Props {
  /** Drive minutes per household. Nulls are counted as unreachable. */
  minutes: (number | null)[];
  total: number;
  source: 'osrm' | 'proxy' | null;
  subject: string;
  bands?: number[];
}

export function bucketise(minutes: (number | null)[], bands: number[]): Bucket[] {
  const edges = [...bands].sort((a, b) => a - b);
  const vars = ['--drive-1', '--drive-2', '--drive-3', '--drive-4'];
  const out: Bucket[] = [];
  let lower = 0;
  edges.forEach((edge, i) => {
    out.push({
      label: i === 0 ? `≤ ${edge}` : `${lower}–${edge}`,
      from: lower,
      to: edge,
      count: minutes.filter((m): m is number => m != null && m > lower && m <= edge).length,
      colorVar: vars[Math.min(i, vars.length - 1)],
    });
    lower = edge;
  });
  out.push({
    label: `> ${lower}`,
    from: lower,
    to: null,
    count: minutes.filter((m): m is number => m != null && m > lower).length,
    colorVar: '--drive-over',
  });
  return out;
}

export default function DriveHistogram({
  minutes, total, source, subject, bands = [15, 30, 45, 60],
}: Props) {
  const [asTable, setAsTable] = useState(false);
  const buckets = useMemo(() => bucketise(minutes, bands), [minutes, bands]);
  const unreachable = minutes.filter((m) => m == null).length;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  return (
    <div className="histo">
      <div className="histo-head">
        <h4>Households by drive</h4>
        <span className="src">{source === 'proxy' ? 'estimated' : source === 'osrm' ? 'routed' : ''}</span>
      </div>

      {asTable ? (
        <table>
          <caption className="tiny" style={{ captionSide: 'top', textAlign: 'left' }}>
            Households by drive time to {subject}
          </caption>
          <thead>
            <tr><th scope="col">Minutes</th><th scope="col" className="num">Households</th><th scope="col" className="num">Share</th></tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.label}>
                <th scope="row" style={{ fontWeight: 400 }}>{b.label}</th>
                <td className="num">{b.count}</td>
                <td className="num">{pct(b.count)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div role="img" aria-label={
          `Households by drive time to ${subject}: `
          + buckets.map((b) => `${b.label} minutes, ${b.count} households`).join('; ')
        }>
          {buckets.map((b) => (
            <div className="histo-row" key={b.label} title={`${b.label} min — ${b.count} of ${total} households (${pct(b.count)}%)`}>
              <span className="band">{b.label}</span>
              <div className="histo-track">
                <div
                  className="histo-bar"
                  style={{
                    width: `${(b.count / max) * 100}%`,
                    background: `var(${b.colorVar})`,
                  }}
                />
              </div>
              <span className="val">{b.count} · {pct(b.count)}%</span>
            </div>
          ))}
        </div>
      )}

      <div className="histo-foot">
        {total} household{total === 1 ? '' : 's'} to {subject}.
        {unreachable > 0 && ` ${unreachable} could not be routed.`}
        {source === 'proxy' && ' Straight-line estimate, not a drive time.'}
        {' '}
        <button className="histo-toggle" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'show chart' : 'show table'}
        </button>
      </div>
    </div>
  );
}
