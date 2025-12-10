import { useState, useEffect } from 'react';
import ApplicationCard from '../components/ApplicationCard';
import { api } from '../services/api';
import './Applications.css';

export default function Applications() {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncMessage, setSyncMessage] = useState(null);

  useEffect(() => {
    async function loadApplications() {
      try {
        setLoading(true);

        // Fetch all data in parallel
        const [apps, argoCDApps, helmReleases] = await Promise.all([
          api.getApplications(),
          api.getArgoCDApplications(),
          api.getHelmReleases()
        ]);

        // Merge status data
        const releasesList = Array.isArray(helmReleases) ? helmReleases : [];
        const argoList = argoCDApps?.items || [];

        const appsList = Array.isArray(apps) ? apps : [];
        const appsWithStatus = appsList.map(app => {
          // Find matching ArgoCD app
          const argoCDApp = argoList.find(
            item => item.metadata?.name === app.argocdApp
          );

          // Find matching Helm release
          const helmRelease = releasesList.find(
            release => release.name === app.helmChart && release.namespace === app.namespace
          );

          return {
            ...app,
            argoCDStatus: argoCDApp?.status?.health?.status || null,
            argoCDSyncStatus: argoCDApp?.status?.sync?.status || null,
            helmStatus: helmRelease?.status || null,
            helmRevision: helmRelease?.revision || null,
            lastUpdated: argoCDApp?.status?.reconciledAt || helmRelease?.updated || null
          };
        });

        setApplications(appsWithStatus);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    loadApplications();
    const interval = setInterval(loadApplications, 15000); // Update every 15 seconds
    return () => clearInterval(interval);
  }, []);

  const handleSync = async (app) => {
    try {
      setSyncMessage({ type: 'info', text: `Syncing ${app.name}...` });

      // Trigger ArgoCD sync
      await api.syncArgoCDApplication(app.argocdApp);

      setSyncMessage({ type: 'success', text: `Successfully synced ${app.name}` });

      // Reload applications after 2 seconds to show updated status
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    } catch (err) {
      setSyncMessage({
        type: 'error',
        text: `Failed to sync ${app.name}: ${err.message}`
      });
    }

    // Clear message after 5 seconds
    setTimeout(() => {
      setSyncMessage(null);
    }, 5000);
  };

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Loading applications...</p>
      </div>
    );
  }

  if (error) {
    return <div className="error-container">Error: {error}</div>;
  }

  return (
    <div className="applications-page">
      {syncMessage && (
        <div className={`sync-notification ${syncMessage.type}`}>
          {syncMessage.text}
        </div>
      )}

      <div className="page-header">
        <h1>Applications</h1>
        <p className="page-subtitle">
          {applications.length} portfolio applications
        </p>
      </div>

      <div className="applications-grid">
        {applications.map((app) => (
          <ApplicationCard key={app.id} app={app} onSync={handleSync} />
        ))}
      </div>
    </div>
  );
}
