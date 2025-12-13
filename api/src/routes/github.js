const express = require('express');
const router = express.Router();
const axios = require('axios');
const { validators } = require('../middleware/validation');

const GITHUB_API = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'maxjeffwell';

// Multiple repos to monitor
const REPOS = [
  { name: 'devops-portfolio-manager', displayName: 'PodRick' },
  { name: 'portfolio-orchestration-platform', displayName: 'POP' },
  { name: 'k8s-multi-tenant-platform', displayName: 'TenantFlow' },
  { name: 'microservices-platform', displayName: 'Vertex Platform' }
];

// Get workflow runs for a specific workflow
router.get('/workflows/:workflow_id/runs', validators.github.getWorkflowRuns, async (req, res) => {
  try {
    const { workflow_id } = req.params;
    const { repo } = req.query; // repo param to specify which repo
    
    if (!repo) {
      return res.status(400).json({ error: 'repo query parameter required' });
    }

    const response = await axios.get(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${repo}/actions/workflows/${workflow_id}/runs`,
      {
        headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {}
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all workflows from all repos
router.get('/workflows', async (req, res) => {
  try {
    const allWorkflows = [];
    
    for (const repo of REPOS) {
      try {
        const response = await axios.get(
          `${GITHUB_API}/repos/${GITHUB_OWNER}/${repo.name}/actions/workflows`,
          {
            headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {}
          }
        );
        
        // Add repo context to each workflow
        const workflowsWithRepo = response.data.workflows.map(workflow => ({
          ...workflow,
          repo: repo.name,
          repo_display_name: repo.displayName
        }));
        
        allWorkflows.push(...workflowsWithRepo);
      } catch (error) {
        console.error(`Error fetching workflows for ${repo.name}:`, error.message);
        // Continue with other repos even if one fails
      }
    }
    
    res.json({ workflows: allWorkflows, total_count: allWorkflows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger workflow
router.post('/workflows/:workflow_id/dispatches', validators.github.triggerWorkflow, async (req, res) => {
  try {
    const { workflow_id } = req.params;
    const { ref, inputs, repo } = req.body;

    if (!repo) {
      return res.status(400).json({ error: 'repo field required in request body' });
    }

    if (!GITHUB_TOKEN) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    const response = await axios.post(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${repo}/actions/workflows/${workflow_id}/dispatches`,
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

// Get recent workflow runs from all repos
router.get('/runs/recent', async (req, res) => {
  try {
    const allRuns = [];
    
    for (const repo of REPOS) {
      try {
        const response = await axios.get(
          `${GITHUB_API}/repos/${GITHUB_OWNER}/${repo.name}/actions/runs`,
          {
            headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {},
            params: { per_page: 5 } // Get 5 most recent from each repo
          }
        );
        
        // Add repo context to each run
        const runsWithRepo = response.data.workflow_runs.map(run => ({
          ...run,
          repo: repo.name,
          repo_display_name: repo.displayName
        }));
        
        allRuns.push(...runsWithRepo);
      } catch (error) {
        console.error(`Error fetching runs for ${repo.name}:`, error.message);
        // Continue with other repos
      }
    }
    
    // Sort by created_at descending and take top 10
    allRuns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const recentRuns = allRuns.slice(0, 10);
    
    res.json({ workflow_runs: recentRuns, total_count: recentRuns.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
