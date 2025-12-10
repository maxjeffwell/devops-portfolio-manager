import { useState, useEffect } from 'react';
import { api } from '../services/api';
import WorkflowCard from '../components/WorkflowCard';
import PipelineTimeline from '../components/PipelineTimeline';
import './Pipelines.css';

export default function Pipelines() {
  const [workflows, setWorkflows] = useState([]);
  const [recentRuns, setRecentRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    async function loadPipelineData() {
      try {
        setLoading(true);

        const [workflowsData, runsData] = await Promise.all([
          api.getGitHubWorkflows(),
          api.getRecentRuns()
        ]);

        setWorkflows(workflowsData?.workflows || []);
        setRecentRuns(runsData?.workflow_runs || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    loadPipelineData();
    const interval = setInterval(loadPipelineData, 30000); // Update every 30 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Loading CI/CD pipelines...</p>
      </div>
    );
  }

  if (error) {
    return <div className="error-container">Error: {error}</div>;
  }

  const successfulRuns = (recentRuns || []).filter(r => r.conclusion === 'success').length;
  const failedRuns = (recentRuns || []).filter(r => r.conclusion === 'failure').length;
  const inProgressRuns = (recentRuns || []).filter(r => r.status === 'in_progress').length;

  return (
    <div className="pipelines-page">
      <div className="page-header">
        <h1>CI/CD Pipelines</h1>
        <p className="page-subtitle">
          Automated builds, tests, and deployments
        </p>
      </div>

      {/* Stats Overview */}
      <div className="pipeline-stats">
        <div className="stat-card">
          <div className="stat-icon success">✓</div>
          <div className="stat-info">
            <div className="stat-value">{successfulRuns}</div>
            <div className="stat-label">Successful</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon failure">✗</div>
          <div className="stat-info">
            <div className="stat-value">{failedRuns}</div>
            <div className="stat-label">Failed</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon running">●</div>
          <div className="stat-info">
            <div className="stat-value">{inProgressRuns}</div>
            <div className="stat-label">Running</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">⚙</div>
          <div className="stat-info">
            <div className="stat-value">{workflows.length}</div>
            <div className="stat-label">Workflows</div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="pipeline-tabs">
        <button
          className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button
          className={`tab ${activeTab === 'workflows' ? 'active' : ''}`}
          onClick={() => setActiveTab('workflows')}
        >
          Workflows
        </button>
        <button
          className={`tab ${activeTab === 'timeline' ? 'active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          Timeline
        </button>
      </div>

      {/* Tab Content */}
      <div className="tab-content">
        {activeTab === 'overview' && (
          <div className="overview-section">
            <h2>Recent Pipeline Runs</h2>
            <div className="runs-list">
              {recentRuns.slice(0, 10).map((run) => (
                <div key={run.id} className="run-item">
                  <div className="run-status">
                    <span className={`status-dot ${run.status} ${run.conclusion || ''}`}></span>
                  </div>
                  <div className="run-info">
                    <div className="run-name">{run.name}</div>
                    <div className="run-meta">
                      <span className="run-branch">{run.head_branch}</span>
                      <span className="run-commit">{run.head_sha?.substring(0, 7)}</span>
                      <span className="run-time">{new Date(run.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="run-conclusion">
                    <span className={`badge ${run.conclusion || run.status}`}>
                      {run.conclusion || run.status}
                    </span>
                  </div>
                  <div className="run-duration">
                    {run.updated_at && run.created_at && (
                      <span>{Math.round((new Date(run.updated_at) - new Date(run.created_at)) / 1000)}s</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'workflows' && (
          <div className="workflows-section">
            <h2>GitHub Actions Workflows</h2>
            <div className="workflows-grid">
              {workflows.map((workflow) => (
                <WorkflowCard key={workflow.id} workflow={workflow} />
              ))}
            </div>
            {workflows.length === 0 && (
              <div className="empty-state">
                <p>No workflows configured</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'timeline' && (
          <div className="timeline-section">
            <h2>Pipeline Activity Timeline</h2>
            <PipelineTimeline runs={recentRuns} />
          </div>
        )}
      </div>
    </div>
  );
}
