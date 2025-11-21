import { StaticDashboard, StaticQuestion } from '@metabase/embedding-sdk-react';
import './Analytics.css';

function Analytics() {
  // KPI data - these would come from your API in production
  const kpis = [
    {
      title: 'Deployments Today',
      value: '24',
      change: '+15.3%',
      icon: '🚀',
      color: '#3b82f6',
      bgColor: '#eff6ff',
    },
    {
      title: 'Success Rate',
      value: '98.5%',
      change: '+2.1%',
      icon: '✓',
      color: '#10b981',
      bgColor: '#f0fdf4',
    },
    {
      title: 'Avg Deploy Time',
      value: '4.2m',
      change: '-12.5%',
      icon: '⚡',
      color: '#f59e0b',
      bgColor: '#fffbeb',
    },
    {
      title: 'Active Pipelines',
      value: '18',
      change: '+3',
      icon: '⚙️',
      color: '#8b5cf6',
      bgColor: '#faf5ff',
    },
  ];

  return (
    <div className="analytics-page">
      {/* Header */}
      <div className="page-header">
        <h1>DevOps Analytics & Metrics</h1>
        <p className="page-description">
          Monitor deployments, track CI/CD performance, and gain insights into your development workflow
        </p>
      </div>

      {/* KPI Cards */}
      <div className="kpi-grid">
        {kpis.map((kpi, index) => (
          <div key={index} className="kpi-card" style={{ borderLeftColor: kpi.color }}>
            <div className="kpi-icon" style={{ backgroundColor: kpi.bgColor }}>
              {kpi.icon}
            </div>
            <div className="kpi-content">
              <div className="kpi-title">{kpi.title}</div>
              <div className="kpi-value" style={{ color: kpi.color }}>{kpi.value}</div>
              <div className={`kpi-change ${kpi.change.startsWith('+') || kpi.change.startsWith('-') ?
                (kpi.change.startsWith('+') ? 'positive' : 'negative') : 'neutral'}`}>
                {kpi.change} from last week
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Main Dashboard */}
      <div className="analytics-grid">
        <div className="analytics-section full-width">
          <div className="metabase-wrapper">
            <h2 className="section-title">DevOps Overview Dashboard</h2>
            <div className="metabase-content" style={{ height: '700px' }}>
              <StaticDashboard
                dashboardId={1}
                withTitle
                withDownloads
              />
            </div>
          </div>
        </div>

        {/* Charts Grid */}
        <div className="analytics-section">
          <div className="metabase-wrapper">
            <h3 className="section-title">Deployment Frequency</h3>
            <div className="metabase-content" style={{ height: '350px' }}>
              <StaticQuestion
                questionId={1}
                withTitle
              />
            </div>
          </div>
        </div>

        <div className="analytics-section">
          <div className="metabase-wrapper">
            <h3 className="section-title">Success Rate</h3>
            <div className="metabase-content" style={{ height: '350px' }}>
              <StaticQuestion
                questionId={2}
                withTitle
              />
            </div>
          </div>
        </div>

        <div className="analytics-section">
          <div className="metabase-wrapper">
            <h3 className="section-title">Mean Time to Recovery</h3>
            <div className="metabase-content" style={{ height: '350px' }}>
              <StaticQuestion
                questionId={3}
                withTitle
              />
            </div>
          </div>
        </div>

        <div className="analytics-section">
          <div className="metabase-wrapper">
            <h3 className="section-title">Active Applications</h3>
            <div className="metabase-content" style={{ height: '350px' }}>
              <StaticQuestion
                questionId={4}
                withTitle
              />
            </div>
          </div>
        </div>
      </div>

      <div className="analytics-info">
        <h3>How to customize this page:</h3>
        <ol>
          <li>
            <strong>Get your Dashboard/Question IDs:</strong> In Metabase, go to the dashboard or question you want to embed,
            and look at the URL. For example, <code>/dashboard/5</code> means the dashboard ID is <code>5</code>.
          </li>
          <li>
            <strong>Enable embedding:</strong> In Metabase, go to the dashboard/question settings and enable "Embedding".
          </li>
          <li>
            <strong>Get your secret key:</strong> In Metabase Settings → Embedding, copy the "Embedding secret key" and
            add it to your API <code>.env</code> file as <code>METABASE_SECRET_KEY</code>.
          </li>
          <li>
            <strong>Update the IDs:</strong> Replace the example <code>dashboardId</code> and <code>questionId</code> props
            in this file with your actual IDs.
          </li>
        </ol>
      </div>
    </div>
  );
}

export default Analytics;
