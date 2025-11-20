const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:31256';

export const api = {
  // Applications
  async getApplications() {
    const response = await fetch(`${API_BASE}/api/applications`);
    if (!response.ok) throw new Error('Failed to fetch applications');
    return response.json();
  },

  async getApplication(id) {
    const response = await fetch(`${API_BASE}/api/applications/${id}`);
    if (!response.ok) throw new Error('Failed to fetch application');
    return response.json();
  },

  // ArgoCD
  async getArgoCDApplications() {
    try {
      const response = await fetch(`${API_BASE}/api/argocd/applications`);
      if (!response.ok) return [];
      return response.json();
    } catch (error) {
      console.error('ArgoCD not available:', error);
      return [];
    }
  },

  async getArgoCDApplication(name) {
    const response = await fetch(`${API_BASE}/api/argocd/applications/${name}`);
    if (!response.ok) throw new Error('Failed to fetch ArgoCD application');
    return response.json();
  },

  async syncArgoCDApplication(name) {
    const response = await fetch(`${API_BASE}/api/argocd/applications/${name}/sync`, {
      method: 'POST'
    });
    if (!response.ok) throw new Error('Failed to sync application');
    return response.json();
  },

  // Helm
  async getHelmReleases() {
    try {
      const response = await fetch(`${API_BASE}/api/helm/releases`);
      if (!response.ok) return [];
      return response.json();
    } catch (error) {
      console.error('Helm not available:', error);
      return [];
    }
  },

  async getHelmRelease(namespace, name) {
    const response = await fetch(`${API_BASE}/api/helm/releases/${namespace}/${name}`);
    if (!response.ok) throw new Error('Failed to fetch release');
    return response.json();
  },

  // GitHub
  async getGitHubWorkflows() {
    try {
      const response = await fetch(`${API_BASE}/api/github/workflows`);
      if (!response.ok) return { workflows: [] };
      return response.json();
    } catch (error) {
      console.error('GitHub not available:', error);
      return { workflows: [] };
    }
  },

  async getRecentRuns() {
    try {
      const response = await fetch(`${API_BASE}/api/github/runs/recent`);
      if (!response.ok) return { workflow_runs: [] };
      return response.json();
    } catch (error) {
      console.error('GitHub not available:', error);
      return { workflow_runs: [] };
    }
  }
};
