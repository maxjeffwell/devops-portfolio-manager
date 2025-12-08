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
 * Simple cache with TTL support
 */
class Cache {
  constructor() {
    this.cache = new Map();
  }

  set(key, value, ttlMs) {
    const expiresAt = Date.now() + ttlMs;
    this.cache.set(key, { value, expiresAt });
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  clear(keyPrefix = null) {
    if (keyPrefix) {
      // Clear entries matching prefix
      for (const key of this.cache.keys()) {
        if (key.startsWith(keyPrefix)) {
          this.cache.delete(key);
        }
      }
    } else {
      // Clear all
      this.cache.clear();
    }
  }
}

const cache = new Cache();

// Cache TTL configurations (in milliseconds)
const CACHE_TTL = {
  APPLICATIONS: 5 * 60 * 1000,     // 5 minutes - static data
  HELM_RELEASES: 2 * 60 * 1000,    // 2 minutes - semi-static
  GITHUB_WORKFLOWS: 5 * 60 * 1000, // 5 minutes - static
  GITHUB_RUNS: 30 * 1000,          // 30 seconds - frequently updated
  PROMETHEUS: 15 * 1000,           // 15 seconds - real-time metrics
};

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
 * Make cached API request
 */
async function makeCachedRequest(cacheKey, ttl, requestFn) {
  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - make request
  const result = await requestFn();

  // Cache the result
  cache.set(cacheKey, result, ttl);

  return result;
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
    return makeCachedRequest(
      'applications',
      CACHE_TTL.APPLICATIONS,
      () => makeRequest(`${API_BASE}/api/applications`)
    );
  },

  async getApplication(id) {
    return makeRequest(`${API_BASE}/api/applications/${id}`);
  },

  // ArgoCD (optional service - returns Result)
  async getArgoCDApplications() {
    return makeCachedRequest(
      'argocd:applications',
      CACHE_TTL.APPLICATIONS,
      async () => {
        const result = await makeOptionalRequest(
          'ArgoCD',
          `${API_BASE}/api/argocd/applications`
        );
        return result.unwrapOr([]);
      }
    );
  },

  async getArgoCDApplication(name) {
    return makeRequest(`${API_BASE}/api/argocd/applications/${name}`);
  },

  async syncArgoCDApplication(name) {
    // Clear cache after sync action
    cache.clear('argocd:');
    return makeRequest(`${API_BASE}/api/argocd/applications/${name}/sync`, {
      method: 'POST'
    });
  },

  // Helm (optional service - returns Result)
  async getHelmReleases() {
    return makeCachedRequest(
      'helm:releases',
      CACHE_TTL.HELM_RELEASES,
      async () => {
        const result = await makeOptionalRequest(
          'Helm',
          `${API_BASE}/api/helm/releases`
        );
        return result.unwrapOr([]);
      }
    );
  },

  async getHelmRelease(namespace, name) {
    return makeRequest(`${API_BASE}/api/helm/releases/${namespace}/${name}`);
  },

  async rollbackHelmRelease(namespace, name, revision = null) {
    // Clear cache after rollback action
    cache.clear('helm:');
    return makeRequest(`${API_BASE}/api/helm/releases/${namespace}/${name}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ revision })
    });
  },

  // GitHub (optional service - returns Result)
  async getGitHubWorkflows() {
    return makeCachedRequest(
      'github:workflows',
      CACHE_TTL.GITHUB_WORKFLOWS,
      async () => {
        const result = await makeOptionalRequest(
          'GitHub',
          `${API_BASE}/api/github/workflows`
        );
        return result.unwrapOr({ workflows: [] });
      }
    );
  },

  async getRecentRuns() {
    return makeCachedRequest(
      'github:runs:recent',
      CACHE_TTL.GITHUB_RUNS,
      async () => {
        const result = await makeOptionalRequest(
          'GitHub',
          `${API_BASE}/api/github/runs/recent`
        );
        return result.unwrapOr({ workflow_runs: [] });
      }
    );
  },

  async triggerWorkflow(workflowId, ref = 'main', inputs = {}) {
    // Clear cache after workflow trigger
    cache.clear('github:runs');
    return makeRequest(`${API_BASE}/api/github/workflows/${workflowId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref, inputs })
    });
  },

  // Prometheus (optional service - returns Result)
  async queryPrometheus(query, time = null) {
    const params = new URLSearchParams({ query });
    if (time) params.append('time', time);

    const cacheKey = `prometheus:query:${query}:${time || 'now'}`;

    return makeCachedRequest(
      cacheKey,
      CACHE_TTL.PROMETHEUS,
      async () => {
        const result = await makeOptionalRequest(
          'Prometheus',
          `${API_BASE}/api/prometheus/query?${params}`
        );
        return result.unwrapOr({ data: { result: [] } });
      }
    );
  },

  async getMetrics(namespace, deployment) {
    const cacheKey = `prometheus:metrics:${namespace}:${deployment}`;

    return makeCachedRequest(
      cacheKey,
      CACHE_TTL.PROMETHEUS,
      async () => {
        const result = await makeOptionalRequest(
          'Prometheus',
          `${API_BASE}/api/prometheus/metrics/${namespace}/${deployment}`
        );
        return result.unwrapOr({ cpu: [], memory: [] });
      }
    );
  },

  async getClusterOverview() {
    return makeCachedRequest(
      'prometheus:cluster:overview',
      CACHE_TTL.PROMETHEUS,
      async () => {
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
    );
  },

  // Cache management
  clearCache(prefix = null) {
    cache.clear(prefix);
  }
};
