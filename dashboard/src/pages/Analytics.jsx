import React, { useState, useEffect } from 'react';
import './Analytics.css';

function Analytics() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchMetrics();
  }, []);

  // Format workflow name - extract friendly name from path if needed
  const formatWorkflowName = (name) => {
    // If name looks like a file path (.github/workflows/...), extract friendly name
    if (name.includes('.github/workflows/') || name.includes('.yml') || name.includes('.yaml')) {
      // Extract filename without extension
      const filename = name.split('/').pop().replace(/\.(yml|yaml)$/, '');
      // Convert kebab-case or snake_case to Title Case
      return filename
        .split(/[-_]/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }
    return name;
  };

  const fetchMetrics = async () => {
    try {
      setLoading(true);
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5001';
      const response = await fetch(`${apiUrl}/api/analytics/metrics`);

      if (!response.ok) {
        throw new Error('Failed to fetch metrics');
      }

      const data = await response.json();
      setMetrics(data);
      setError(null);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching metrics:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="analytics-container">
        <h1>DevOps Analytics</h1>
        <div className="loading">Loading metrics...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="analytics-container">
        <h1>DevOps Analytics</h1>
        <div className="error">
          <h3>Error loading metrics</h3>
          <p>{error}</p>
          <button onClick={fetchMetrics} className="retry-button">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="analytics-container">
        <h1>DevOps Analytics</h1>
        <div className="no-data">No metrics data available</div>
      </div>
    );
  }

  return (
    <div className="analytics-container">
      <div className="analytics-header">
        <h1>DevOps Analytics</h1>
        <div className="period-info">
          <span>Period: {metrics.period}</span>
          <button onClick={fetchMetrics} className="refresh-button">
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="metrics-grid">
        {/* Pipeline Success Rate */}
        <div className="metric-card primary">
          <div className="metric-icon">✓</div>
          <div className="metric-content">
            <h3>Pipeline Success Rate</h3>
            <div className="metric-value">
              {metrics.pipelineSuccessRate}%
            </div>
            <div className="metric-details">
              {metrics.successfulRuns} successful / {metrics.totalRuns} total runs
            </div>
          </div>
        </div>

        {/* Pipeline Duration */}
        <div className="metric-card">
          <div className="metric-icon">⏱</div>
          <div className="metric-content">
            <h3>Pipeline Duration</h3>
            <div className="metric-value">
              {metrics.avgDuration}h
            </div>
            <div className="metric-details">
              Median: {metrics.medianDuration}h | Max: {metrics.maxDuration}h
            </div>
          </div>
        </div>

        {/* Deployment Frequency */}
        <div className="metric-card">
          <div className="metric-icon">🚀</div>
          <div className="metric-content">
            <h3>Deployment Frequency</h3>
            <div className="metric-value">
              {metrics.deploymentFrequency}/day
            </div>
            <div className="metric-details">
              {metrics.totalDeployments} deployments in {metrics.period}
            </div>
          </div>
        </div>

        {/* Lead Time for Changes */}
        <div className="metric-card">
          <div className="metric-icon">📈</div>
          <div className="metric-content">
            <h3>Lead Time for Changes</h3>
            <div className="metric-value">
              {metrics.leadTimeForChanges}h
            </div>
            <div className="metric-details">
              Time from commit to deployment
            </div>
          </div>
        </div>

        {/* Change Failure Rate */}
        <div className="metric-card warning">
          <div className="metric-icon">⚠</div>
          <div className="metric-content">
            <h3>Change Failure Rate</h3>
            <div className="metric-value">
              {metrics.changeFailureRate}%
            </div>
            <div className="metric-details">
              Percentage of deployments causing failures
            </div>
          </div>
        </div>

        {/* Mean Time to Recovery */}
        <div className="metric-card">
          <div className="metric-icon">🔧</div>
          <div className="metric-content">
            <h3>Mean Time to Recovery (MTTR)</h3>
            <div className="metric-value">
              {metrics.mttr}h
            </div>
            <div className="metric-details">
              Average time to fix production failures
            </div>
          </div>
        </div>
      </div>

      {/* Workflow Breakdown */}
      {metrics.workflowStats && Object.keys(metrics.workflowStats).length > 0 && (
        <div className="workflow-breakdown">
          <h2>Workflow Breakdown</h2>
          <div className="workflow-grid">
            {Object.entries(metrics.workflowStats).map(([name, stats]) => (
              <div key={name} className="workflow-card">
                <h4>{formatWorkflowName(name)}</h4>
                <div className="workflow-stats">
                  <div className="stat">
                    <span className="stat-label">Total Runs:</span>
                    <span className="stat-value">{stats.total}</span>
                  </div>
                  <div className="stat success">
                    <span className="stat-label">Successful:</span>
                    <span className="stat-value">{stats.successful}</span>
                  </div>
                  <div className="stat failed">
                    <span className="stat-label">Failed:</span>
                    <span className="stat-value">{stats.failed}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Success Rate:</span>
                    <span className="stat-value">
                      {((stats.successful / stats.total) * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="last-updated">
        Last updated: {new Date(metrics.lastUpdated).toLocaleString()}
      </div>
    </div>
  );
}

export default Analytics;
