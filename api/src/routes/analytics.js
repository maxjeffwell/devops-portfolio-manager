const express = require('express');
const router = express.Router();
const axios = require('axios');

const GITHUB_API = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'maxjeffwell';
const GITHUB_REPO = process.env.GITHUB_REPO || 'devops-portfolio-manager';

// Helper function to calculate time difference in hours
function getHoursDiff(start, end) {
  return (new Date(end) - new Date(start)) / (1000 * 60 * 60);
}

// Helper function to calculate median
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Get comprehensive DevOps metrics
router.get('/metrics', async (req, res) => {
  try {
    // Fetch workflow runs from the last 30 days
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const response = await axios.get(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs`,
      {
        headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {},
        params: {
          per_page: 100,
          created: `>=${since.toISOString()}`
        }
      }
    );

    const runs = response.data.workflow_runs;

    if (runs.length === 0) {
      return res.json({
        pipelineSuccessRate: 0,
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        avgDuration: 0,
        maxDuration: 0,
        medianDuration: 0,
        deploymentFrequency: 0,
        leadTimeForChanges: 0,
        changeFailureRate: 0,
        mttr: 0,
        period: '30 days',
        message: 'No workflow runs found in the last 30 days'
      });
    }

    // Calculate Pipeline Success Rate
    const successful = runs.filter(r => r.conclusion === 'success').length;
    const failed = runs.filter(r => r.conclusion === 'failure').length;
    const pipelineSuccessRate = (successful / runs.length * 100).toFixed(2);

    // Calculate Pipeline Duration metrics
    const durations = runs
      .filter(r => r.run_started_at && r.updated_at)
      .map(r => getHoursDiff(r.run_started_at, r.updated_at));

    const avgDuration = durations.length > 0
      ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)
      : 0;
    const maxDuration = durations.length > 0
      ? Math.max(...durations).toFixed(2)
      : 0;
    const medianDuration = durations.length > 0
      ? median(durations).toFixed(2)
      : 0;

    // Calculate Deployment Frequency (deployments per day)
    const deploymentRuns = runs.filter(r =>
      r.name && (
        r.name.toLowerCase().includes('deploy') ||
        r.name.toLowerCase().includes('release')
      )
    );
    const deploymentFrequency = (deploymentRuns.length / 30).toFixed(2);

    // Calculate Lead Time for Changes (average time from commit to deployment)
    const deploymentSuccessful = deploymentRuns.filter(r => r.conclusion === 'success');
    const leadTimes = deploymentSuccessful
      .filter(r => r.run_started_at && r.updated_at)
      .map(r => getHoursDiff(r.run_started_at, r.updated_at));

    const leadTimeForChanges = leadTimes.length > 0
      ? (leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length).toFixed(2)
      : 0;

    // Calculate Change Failure Rate
    const deploymentFailed = deploymentRuns.filter(r => r.conclusion === 'failure').length;
    const changeFailureRate = deploymentRuns.length > 0
      ? (deploymentFailed / deploymentRuns.length * 100).toFixed(2)
      : 0;

    // Calculate Mean Time to Recovery (MTTR)
    // Find failed runs and their subsequent successful runs
    const sortedRuns = runs.sort((a, b) =>
      new Date(a.created_at) - new Date(b.created_at)
    );

    const recoveryTimes = [];
    for (let i = 0; i < sortedRuns.length - 1; i++) {
      if (sortedRuns[i].conclusion === 'failure') {
        // Find next successful run of same workflow
        for (let j = i + 1; j < sortedRuns.length; j++) {
          if (sortedRuns[j].workflow_id === sortedRuns[i].workflow_id &&
              sortedRuns[j].conclusion === 'success') {
            recoveryTimes.push(
              getHoursDiff(sortedRuns[i].updated_at, sortedRuns[j].updated_at)
            );
            break;
          }
        }
      }
    }

    const mttr = recoveryTimes.length > 0
      ? (recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length).toFixed(2)
      : 0;

    // Workflows breakdown
    const workflowStats = {};
    runs.forEach(run => {
      const name = run.name || 'Unknown';
      if (!workflowStats[name]) {
        workflowStats[name] = {
          total: 0,
          successful: 0,
          failed: 0
        };
      }
      workflowStats[name].total++;
      if (run.conclusion === 'success') workflowStats[name].successful++;
      if (run.conclusion === 'failure') workflowStats[name].failed++;
    });

    res.json({
      // Core DORA metrics
      pipelineSuccessRate: parseFloat(pipelineSuccessRate),
      totalRuns: runs.length,
      successfulRuns: successful,
      failedRuns: failed,

      // Duration metrics
      avgDuration: parseFloat(avgDuration),
      maxDuration: parseFloat(maxDuration),
      medianDuration: parseFloat(medianDuration),

      // Deployment metrics
      deploymentFrequency: parseFloat(deploymentFrequency),
      totalDeployments: deploymentRuns.length,
      successfulDeployments: deploymentSuccessful.length,

      // Quality metrics
      leadTimeForChanges: parseFloat(leadTimeForChanges),
      changeFailureRate: parseFloat(changeFailureRate),
      mttr: parseFloat(mttr),

      // Breakdown
      workflowStats,

      period: '30 days',
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({
      error: error.message,
      message: 'Failed to fetch analytics data'
    });
  }
});

// Get workflow-specific metrics
router.get('/workflows/:workflow_name/metrics', async (req, res) => {
  try {
    const { workflow_name } = req.params;

    const since = new Date();
    since.setDate(since.getDate() - 30);

    const response = await axios.get(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs`,
      {
        headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {},
        params: {
          per_page: 100,
          created: `>=${since.toISOString()}`
        }
      }
    );

    const runs = response.data.workflow_runs.filter(r =>
      r.name === workflow_name
    );

    if (runs.length === 0) {
      return res.json({
        workflow: workflow_name,
        totalRuns: 0,
        message: 'No runs found for this workflow in the last 30 days'
      });
    }

    const successful = runs.filter(r => r.conclusion === 'success').length;
    const failed = runs.filter(r => r.conclusion === 'failure').length;

    const durations = runs
      .filter(r => r.run_started_at && r.updated_at)
      .map(r => getHoursDiff(r.run_started_at, r.updated_at));

    res.json({
      workflow: workflow_name,
      totalRuns: runs.length,
      successfulRuns: successful,
      failedRuns: failed,
      successRate: (successful / runs.length * 100).toFixed(2),
      avgDuration: durations.length > 0
        ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)
        : 0,
      medianDuration: durations.length > 0
        ? median(durations).toFixed(2)
        : 0,
      recentRuns: runs.slice(0, 10).map(r => ({
        id: r.id,
        conclusion: r.conclusion,
        createdAt: r.created_at,
        duration: r.run_started_at && r.updated_at
          ? getHoursDiff(r.run_started_at, r.updated_at).toFixed(2)
          : null
      }))
    });

  } catch (error) {
    console.error('Error fetching workflow metrics:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

module.exports = router;
