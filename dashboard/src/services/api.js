import {
  APIError,
  ServiceUnavailableError,
  Result,
  handleResponse,
  safeAPICall,
  logError
} from '../utils/errors';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:31256';

/**
 * Make API request with proper error handling
 */
async function makeRequest(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });

    return await handleResponse(response);
  } catch (error) {
    // Network error or fetch failed
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new APIError('Unable to connect to API server', 0, {
        url,
        originalError: error.message
      });
    }
    throw error;
  }
}

/**
 * Make API request for optional services (returns Result instead of throwing)
 */
async function makeOptionalRequest(serviceName, url, options = {}) {
  return safeAPICall(
    async () => {
      try {
        return await makeRequest(url, options);
      } catch (error) {
        // Wrap as ServiceUnavailableError for optional services
        if (error instanceof APIError && error.isServiceUnavailable()) {
          throw new ServiceUnavailableError(serviceName, {
            url,
            statusCode: error.statusCode,
            originalMessage: error.message
          });
        }
        throw error;
      }
    },
    {
      onError: (error) => {
        logError(`${serviceName} API`, error, { url });
      }
    }
  );
}

export const api = {
  // Applications (required service - throws on error)
  async getApplications() {
    return makeRequest(`${API_BASE}/api/applications`);
  },

  async getApplication(id) {
    return makeRequest(`${API_BASE}/api/applications/${id}`);
  },

  // ArgoCD (optional service - returns Result)
  async getArgoCDApplications() {
    const result = await makeOptionalRequest(
      'ArgoCD',
      `${API_BASE}/api/argocd/applications`
    );

    // Return empty array for UI compatibility, but log the error
    return result.unwrapOr([]);
  },

  async getArgoCDApplication(name) {
    return makeRequest(`${API_BASE}/api/argocd/applications/${name}`);
  },

  async syncArgoCDApplication(name) {
    return makeRequest(`${API_BASE}/api/argocd/applications/${name}/sync`, {
      method: 'POST'
    });
  },

  // Helm (optional service - returns Result)
  async getHelmReleases() {
    const result = await makeOptionalRequest(
      'Helm',
      `${API_BASE}/api/helm/releases`
    );

    return result.unwrapOr([]);
  },

  async getHelmRelease(namespace, name) {
    return makeRequest(`${API_BASE}/api/helm/releases/${namespace}/${name}`);
  },

  async rollbackHelmRelease(namespace, name, revision = null) {
    return makeRequest(`${API_BASE}/api/helm/releases/${namespace}/${name}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ revision })
    });
  },

  // GitHub (optional service - returns Result)
  async getGitHubWorkflows() {
    const result = await makeOptionalRequest(
      'GitHub',
      `${API_BASE}/api/github/workflows`
    );

    return result.unwrapOr({ workflows: [] });
  },

  async getRecentRuns() {
    const result = await makeOptionalRequest(
      'GitHub',
      `${API_BASE}/api/github/runs/recent`
    );

    return result.unwrapOr({ workflow_runs: [] });
  },

  async triggerWorkflow(workflowId, ref = 'main', inputs = {}) {
    return makeRequest(`${API_BASE}/api/github/workflows/${workflowId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref, inputs })
    });
  },

  // Prometheus (optional service - returns Result)
  async queryPrometheus(query, time = null) {
    const params = new URLSearchParams({ query });
    if (time) params.append('time', time);

    const result = await makeOptionalRequest(
      'Prometheus',
      `${API_BASE}/api/prometheus/query?${params}`
    );

    return result.unwrapOr({ data: { result: [] } });
  },

  async getMetrics(namespace, deployment) {
    const result = await makeOptionalRequest(
      'Prometheus',
      `${API_BASE}/api/prometheus/metrics/${namespace}/${deployment}`
    );

    return result.unwrapOr({ cpu: [], memory: [] });
  },

  async getClusterOverview() {
    const result = await makeOptionalRequest(
      'Prometheus',
      `${API_BASE}/api/prometheus/cluster/overview`
    );

    return result.unwrapOr({
      totalNodes: '0',
      totalPods: '0',
      cpuUsage: '0',
      memoryUsage: '0'
    });
  }
};
