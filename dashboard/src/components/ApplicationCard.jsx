import { useState } from 'react';
import PropTypes from 'prop-types';
import './ApplicationCard.css';

export default function ApplicationCard({ app, onSync }) {
  const [syncing, setSyncing] = useState(false);

  const getStatusColor = (status) => {
    if (!status) return 'var(--status-unknown)';
    const s = status.toLowerCase();
    if (s.includes('healthy') || s.includes('running') || s.includes('deployed')) return 'var(--status-healthy)';
    if (s.includes('degraded') || s.includes('error') || s.includes('failed')) return 'var(--status-degraded)';
    if (s.includes('progressing') || s.includes('pending')) return 'var(--status-progressing)';
    return 'var(--status-unknown)';
  };

  const getDisplayStatus = () => {
    return app.argoCDStatus || 'Unknown';
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
            <span className="meta-label">ArgoCD App:</span>
            <span className="meta-value">{app.argocdApp}</span>
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
            style={{ backgroundColor: getStatusColor(getDisplayStatus()) }}
          >
            {getDisplayStatus()}
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
          href={app.github ? `https://github.com/${app.github.owner}/${app.github.repo}` : '#'}
          target="_blank"
          rel="noopener noreferrer"
          className={`github-link ${!app.github ? 'disabled' : ''}`}
          onClick={(e) => !app.github && e.preventDefault()}
        >
          {app.github ? 'View on GitHub →' : 'No GitHub Info'}
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
    argocdApp: PropTypes.string.isRequired,
    argoCDSyncStatus: PropTypes.string,
    argoCDStatus: PropTypes.string,
    github: PropTypes.shape({
      owner: PropTypes.string,
      repo: PropTypes.string,
    }),
  }).isRequired,
  onSync: PropTypes.func.isRequired,
};
