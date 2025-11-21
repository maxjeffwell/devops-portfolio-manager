import { useEffect, useState } from 'react';
import './MetabaseDashboard.css';

/**
 * MetabaseDashboard Component
 * Embeds a Metabase dashboard using an iframe
 *
 * Props:
 * - dashboardId: The ID of the Metabase dashboard to embed
 * - params: Optional parameters to pass to the dashboard
 * - title: Optional title for the dashboard
 * - height: Optional height for the iframe (default: 600px)
 */
function MetabaseDashboard({ dashboardId, params = {}, title, height = '600px' }) {
  const [iframeUrl, setIframeUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchEmbedToken = async () => {
      try {
        setLoading(true);
        setError(null);

        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5001';
        const response = await fetch(`${apiUrl}/api/metabase/embed-token/dashboard/${dashboardId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ params }),
        });

        if (!response.ok) {
          throw new Error('Failed to fetch embed token');
        }

        const data = await response.json();
        setIframeUrl(data.iframeUrl);
      } catch (err) {
        console.error('Error fetching Metabase embed token:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    if (dashboardId) {
      fetchEmbedToken();
    }
  }, [dashboardId, JSON.stringify(params)]);

  if (loading) {
    return (
      <div className="metabase-container">
        <div className="metabase-loading">
          <div className="spinner"></div>
          <p>Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="metabase-container">
        <div className="metabase-error">
          <h3>Error Loading Dashboard</h3>
          <p>{error}</p>
          <p className="error-hint">
            Make sure Metabase is running and the METABASE_SECRET_KEY is configured in the API.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="metabase-container">
      {title && <h2 className="metabase-title">{title}</h2>}
      <iframe
        src={iframeUrl}
        frameBorder="0"
        width="100%"
        height={height}
        allowTransparency
        className="metabase-iframe"
        title={title || `Dashboard ${dashboardId}`}
      ></iframe>
    </div>
  );
}

export default MetabaseDashboard;
