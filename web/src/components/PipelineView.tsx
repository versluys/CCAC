/** Kanban by status. Moving a card is the same PATCH the drawer makes. */

import type { Candidate, Status } from '../types';
import { CAPACITY_LABEL, STATUS_LABEL, STATUS_ORDER } from '../types';

interface Props {
  candidates: Candidate[];
  onSelect: (id: string) => void;
  onMove: (id: string, status: Status) => void;
  busy: boolean;
}

export default function PipelineView({ candidates, onSelect, onMove, busy }: Props) {
  if (candidates.length === 0) {
    return (
      <div className="empty">
        Nothing in the pipeline yet. Run <code>scripts/churches.py</code>, or add a
        candidate by hand from the map.
      </div>
    );
  }
  return (
    <div className="kanban">
      {STATUS_ORDER.map((status) => {
        const inColumn = candidates.filter((c) => c.status === status);
        return (
          <div className="column" key={status}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/plain');
              if (id && !busy) onMove(id, status);
            }}>
            <h3>{STATUS_LABEL[status]} <span>{inColumn.length}</span></h3>
            {inColumn.map((c) => (
              <div className="card" key={c.id} draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', c.id)}
                onClick={() => onSelect(c.id)}>
                <div className="n">{c.name}</div>
                <div className="m">
                  <span>score {c.fit_score}</span>
                  <span>{CAPACITY_LABEL[c.capacity_est]}{!c.capacity_confirmed ? ' est.' : ''}</span>
                  {c.distance_mi_from_center != null && <span>{c.distance_mi_from_center.toFixed(1)} mi</span>}
                  {c.transfer_overlap === 'yes' && <span className="badge caution">rector first</span>}
                </div>
              </div>
            ))}
            {inColumn.length === 0 && <div className="tiny">—</div>}
          </div>
        );
      })}
    </div>
  );
}
