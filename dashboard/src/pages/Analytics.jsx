import MetabaseDashboard from '../components/MetabaseDashboard';
import MetabaseQuestion from '../components/MetabaseQuestion';
import './Analytics.css';

function Analytics() {
  // Example: You can pass parameters to filter dashboards/questions
  // const dashboardParams = { environment: 'production', date_range: 'last-7-days' };

  return (
    <div className="analytics-page">
      <div className="page-header">
        <h1>Analytics & Metrics</h1>
        <p className="page-description">
          Monitor your DevOps metrics, deployment statistics, and system health
        </p>
      </div>

      <div className="analytics-grid">
        {/* Example: Embed a full dashboard */}
        <div className="analytics-section full-width">
          <MetabaseDashboard
            dashboardId={1}
            title="DevOps Overview Dashboard"
            height="700px"
          />
        </div>

        {/* Example: Embed individual questions/charts side by side */}
        <div className="analytics-section">
          <MetabaseQuestion
            questionId={1}
            title="Deployment Frequency"
            height="350px"
          />
        </div>

        <div className="analytics-section">
          <MetabaseQuestion
            questionId={2}
            title="Success Rate"
            height="350px"
          />
        </div>

        <div className="analytics-section">
          <MetabaseQuestion
            questionId={3}
            title="Mean Time to Recovery"
            height="350px"
          />
        </div>

        <div className="analytics-section">
          <MetabaseQuestion
            questionId={4}
            title="Active Applications"
            height="350px"
          />
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
