const express = require('express');
const router = express.Router();
const axios = require('axios');

const GITHUB_API = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'maxjeffwell';
const GITHUB_REPO = process.env.GITHUB_REPO || 'devops-portfolio-manager';

// Get workflow runs
router.get('/workflows/:workflow_id/runs', async (req, res) => {
  try {
    const { workflow_id } = req.params;
    const response = await axios.get(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflow_id}/runs`,
      {
        headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {}
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all workflows
router.get('/workflows', async (req, res) => {
  try {
    const response = await axios.get(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows`,
      {
        headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {}
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger workflow
router.post('/workflows/:workflow_id/dispatches', async (req, res) => {
  try {
    const { workflow_id } = req.params;
    const { ref, inputs } = req.body;

    if (!GITHUB_TOKEN) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    const response = await axios.post(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflow_id}/dispatches`,
      { ref: ref || 'main', inputs },
      {
        headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
      }
    );
    res.json({ success: true, status: response.status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent workflow runs (all)
router.get('/runs/recent', async (req, res) => {
  try {
    const response = await axios.get(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs`,
      {
        headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {},
        params: { per_page: 10 }
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
