import { useState, useEffect } from 'react';
import ApplicationCard from '../components/ApplicationCard';
import { api } from '../services/api';
import './Applications.css';

export default function Applications() {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
        const appsWithStatus = apps.map(app => {
          // Find matching ArgoCD app
          const argoCDApp = argoCDApps.items?.find(
            item => item.metadata?.name === app.argocdApp
          );

          // Find matching Helm release
          const helmRelease = helmReleases?.find(
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
      <div className="page-header">
        <h1>Applications</h1>
        <p className="page-subtitle">
          {applications.length} portfolio applications
        </p>
      </div>

      <div className="applications-grid">
        {applications.map((app) => (
          <ApplicationCard key={app.id} app={app} />
        ))}
      </div>
    </div>
  );
}
