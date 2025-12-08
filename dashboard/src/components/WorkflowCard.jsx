import PropTypes from 'prop-types';
import './WorkflowCard.css';

export default function WorkflowCard({ workflow }) {
  const getWorkflowIcon = (name) => {
    const nameLower = name.toLowerCase();
    if (nameLower.includes('build')) return '🔨';
    if (nameLower.includes('test')) return '✓';
    if (nameLower.includes('deploy')) return '🚀';
    if (nameLower.includes('ci') || nameLower.includes('cd')) return '⚙';
    return '📋';
  };

  return (
    <div className="workflow-card">
      <div className="workflow-header">
        <div className="workflow-icon">
          {getWorkflowIcon(workflow.name)}
        </div>
        <div className="workflow-info">
          <div className="workflow-name">{workflow.name}</div>
          <div className="workflow-path">{workflow.path}</div>
        </div>
      </div>

      <div className="workflow-body">
        <div className="workflow-meta">
          <div className="meta-item">
            <span className="meta-label">State:</span>
            <span className={`meta-value state ${workflow.state}`}>
              {workflow.state}
            </span>
          </div>
          {workflow.badge_url && (
            <div className="meta-item">
              <span className="meta-label">ID:</span>
              <span className="meta-value">{workflow.id}</span>
            </div>
          )}
        </div>

        {workflow.badge_url && (
          <div className="workflow-badge">
            <img src={workflow.badge_url} alt={`${workflow.name} badge`} />
          </div>
        )}
      </div>

      <div className="workflow-footer">
        <a
          href={workflow.html_url}
          target="_blank"
          rel="noopener noreferrer"
          className="github-link"
        >
          View on GitHub →
        </a>
      </div>
    </div>
  );
}

WorkflowCard.propTypes = {
  workflow: PropTypes.shape({
    id: PropTypes.number.isRequired,
    name: PropTypes.string.isRequired,
    path: PropTypes.string.isRequired,
    state: PropTypes.string.isRequired,
    badge_url: PropTypes.string,
    html_url: PropTypes.string.isRequired,
  }).isRequired,
};
