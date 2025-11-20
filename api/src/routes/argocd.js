const express = require('express');
const router = express.Router();
const axios = require('axios');

const ARGOCD_API = `https://${process.env.ARGOCD_SERVER || 'localhost:30443'}/api/v1`;

// Get ArgoCD auth token
async function getArgoCDToken() {
  try {
    const response = await axios.post(
      `https://${process.env.ARGOCD_SERVER || 'localhost:30443'}/api/v1/session`,
      {
        username: process.env.ARGOCD_USERNAME,
        password: process.env.ARGOCD_PASSWORD
      },
      { httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false }) }
    );
    return response.data.token;
  } catch (error) {
    console.error('ArgoCD auth error:', error.message);
    throw error;
  }
}

// Get all applications
router.get('/applications', async (req, res) => {
  try {
    const token = await getArgoCDToken();
    const response = await axios.get(`${ARGOCD_API}/applications`, {
      headers: { 'Authorization': `Bearer ${token}` },
      httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false })
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific application
router.get('/applications/:name', async (req, res) => {
  try {
    const token = await getArgoCDToken();
    const response = await axios.get(`${ARGOCD_API}/applications/${req.params.name}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false })
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sync application
router.post('/applications/:name/sync', async (req, res) => {
  try {
    const token = await getArgoCDToken();
    const response = await axios.post(
      `${ARGOCD_API}/applications/${req.params.name}/sync`,
      { prune: false, dryRun: false },
      {
        headers: { 'Authorization': `Bearer ${token}` },
        httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false })
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get application history
router.get('/applications/:name/history', async (req, res) => {
  try {
    const token = await getArgoCDToken();
    const response = await axios.get(`${ARGOCD_API}/applications/${req.params.name}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      httpsAgent: new (require('https')).Agent({ rejectUnauthorized: false })
    });
    res.json(response.data.status.history || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
