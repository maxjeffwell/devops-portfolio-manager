const express = require('express');
const router = express.Router();
const axios = require('axios');
const { validators } = require('../middleware/validation');

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:30090';

// Query Prometheus
router.get('/query', validators.prometheus.query, async (req, res) => {
  try {
    const { query, time } = req.query;
    const response = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
      params: { query, time }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Query range
router.get('/query_range', validators.prometheus.queryRange, async (req, res) => {
  try {
    const { query, start, end, step } = req.query;
    const response = await axios.get(`${PROMETHEUS_URL}/api/v1/query_range`, {
      params: { query, start, end, step }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get application metrics
router.get('/metrics/:namespace/:deployment', validators.prometheus.getMetrics, async (req, res) => {
  try {
    const { namespace, deployment } = req.params;

    // CPU usage
    const cpuQuery = `sum(rate(container_cpu_usage_seconds_total{namespace="${namespace}",pod=~"${deployment}.*"}[5m])) by (pod)`;
    const cpuResponse = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
      params: { query: cpuQuery }
    });

    // Memory usage
    const memQuery = `sum(container_memory_working_set_bytes{namespace="${namespace}",pod=~"${deployment}.*"}) by (pod)`;
    const memResponse = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
      params: { query: memQuery }
    });

    res.json({
      cpu: cpuResponse.data.data.result,
      memory: memResponse.data.data.result
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get cluster overview metrics
router.get('/cluster/overview', async (req, res) => {
  try {
    const queries = {
      totalNodes: 'count(kube_node_info)',
      totalPods: 'count(kube_pod_info)',
      cpuUsage: 'sum(rate(node_cpu_seconds_total{mode!="idle"}[5m]))',
      memoryUsage: 'sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)'
    };

    const results = {};
    for (const [key, query] of Object.entries(queries)) {
      const response = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
        params: { query }
      });
      results[key] = response.data.data.result[0]?.value[1] || '0';
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
