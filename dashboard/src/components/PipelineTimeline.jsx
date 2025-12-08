import PropTypes from 'prop-types';
import './PipelineTimeline.css';

export default function PipelineTimeline({ runs }) {
  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  };

  const getDuration = (createdAt, updatedAt) => {
    if (!updatedAt || !createdAt) return null;
    const durationMs = new Date(updatedAt) - new Date(createdAt);
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const getStatusIcon = (status, conclusion) => {
    if (status === 'in_progress') return '●';
    if (status === 'queued') return '○';
    if (conclusion === 'success') return '✓';
    if (conclusion === 'failure') return '✗';
    if (conclusion === 'cancelled') return '⊘';
    return '?';
  };

  return (
    <div className="pipeline-timeline">
      {runs.length === 0 && (
        <div className="empty-timeline">
          <p>No pipeline runs found</p>
        </div>
      )}

      {runs.map((run, index) => (
        <div key={run.id} className="timeline-item">
          <div className="timeline-marker">
            <div className={`timeline-dot ${run.status} ${run.conclusion || ''}`}>
              {getStatusIcon(run.status, run.conclusion)}
            </div>
            {index < runs.length - 1 && <div className="timeline-line"></div>}
          </div>

          <div className="timeline-content">
            <div className="timeline-header">
              <div className="timeline-title">
                <h3>{run.name}</h3>
                <span className={`timeline-badge ${run.conclusion || run.status}`}>
                  {run.conclusion || run.status}
                </span>
              </div>
              <div className="timeline-time">{formatDate(run.created_at)}</div>
            </div>

            <div className="timeline-body">
              <div className="timeline-meta">
                <div className="timeline-meta-item">
                  <span className="meta-icon">⎇</span>
                  <span className="meta-text">{run.head_branch}</span>
                </div>
                <div className="timeline-meta-item">
                  <span className="meta-icon">#</span>
                  <span className="meta-text">{run.head_sha?.substring(0, 7)}</span>
                </div>
                {run.actor && (
                  <div className="timeline-meta-item">
                    <span className="meta-icon">@</span>
                    <span className="meta-text">{run.actor.login}</span>
                  </div>
                )}
                {run.event && (
                  <div className="timeline-meta-item">
                    <span className="meta-icon">⚡</span>
                    <span className="meta-text">{run.event}</span>
                  </div>
                )}
              </div>

              {run.updated_at && run.created_at && (
                <div className="timeline-duration">
                  Duration: {getDuration(run.created_at, run.updated_at)}
                </div>
              )}

              {run.html_url && (
                <a
                  href={run.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="timeline-link"
                >
                  View details →
                </a>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

PipelineTimeline.propTypes = {
  runs: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.number.isRequired,
      name: PropTypes.string.isRequired,
      status: PropTypes.string.isRequired,
      conclusion: PropTypes.string,
      created_at: PropTypes.string.isRequired,
      updated_at: PropTypes.string,
      head_branch: PropTypes.string.isRequired,
      head_sha: PropTypes.string,
      actor: PropTypes.shape({
        login: PropTypes.string.isRequired,
      }),
      event: PropTypes.string,
      html_url: PropTypes.string,
    })
  ).isRequired,
};
