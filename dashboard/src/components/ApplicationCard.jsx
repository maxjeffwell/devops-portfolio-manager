import { useState } from 'react';
import PropTypes from 'prop-types';
import './ApplicationCard.css';

export default function ApplicationCard({ app, onSync }) {
  const [syncing, setSyncing] = useState(false);

  const getStatusColor = (status) => {
    if (!status) return 'var(--status-unknown)';
    const s = status.toLowerCase();
    if (s.includes('healthy') || s.includes('running')) return 'var(--status-healthy)';
    if (s.includes('degraded') || s.includes('error')) return 'var(--status-degraded)';
    if (s.includes('progressing')) return 'var(--status-progressing)';
    return 'var(--status-unknown)';
  };

  const handleSync = async () => {
    if (syncing) return;

    setSyncing(true);
    try {
      await onSync(app);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="app-card">
      <div className="app-card-header">
        <div className="app-icon">
          {app.name.substring(0, 2).toUpperCase()}
        </div>
        <div className="app-info">
          <h3 className="app-name">{app.name}</h3>
          <p className="app-description">{app.description}</p>
        </div>
      </div>

      <div className="app-card-body">
        <div className="app-meta">
          <div className="meta-item">
            <span className="meta-label">Namespace:</span>
            <span className="meta-value">{app.namespace}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Helm Chart:</span>
            <span className="meta-value">{app.helmChart}</span>
          </div>
          {app.argoCDSyncStatus && (
            <div className="meta-item">
              <span className="meta-label">Sync Status:</span>
              <span className="meta-value">{app.argoCDSyncStatus}</span>
            </div>
          )}
        </div>

        <div className="app-status">
          <span
            className="status-badge"
            style={{ backgroundColor: getStatusColor(app.argoCDStatus || app.status) }}
          >
            {app.argoCDStatus || app.status || 'Unknown'}
          </span>
        </div>
      </div>

      <div className="app-card-footer">
        <button
          className={`sync-button ${syncing ? 'syncing' : ''}`}
          onClick={handleSync}
          disabled={syncing}
        >
          {syncing ? (
            <>
              <span className="sync-icon spinning">↻</span>
              Syncing...
            </>
          ) : (
            <>
              <span className="sync-icon">↻</span>
              Sync
            </>
          )}
        </button>
        <a
          href={`https://github.com/${app.github.owner}/${app.github.repo}`}
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

ApplicationCard.propTypes = {
  app: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string.isRequired,
    description: PropTypes.string,
    namespace: PropTypes.string.isRequired,
    helmChart: PropTypes.string.isRequired,
    argoCDSyncStatus: PropTypes.string,
    argoCDStatus: PropTypes.string,
    status: PropTypes.string,
    github: PropTypes.shape({
      owner: PropTypes.string.isRequired,
      repo: PropTypes.string.isRequired,
    }).isRequired,
  }).isRequired,
  onSync: PropTypes.func.isRequired,
};
