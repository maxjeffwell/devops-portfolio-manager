const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { promisify } = require('util');
const { validators } = require('../middleware/validation');

const execAsync = promisify(exec);

// Get all Helm releases
router.get('/releases', async (req, res) => {
  try {
    const { stdout } = await execAsync('helm list -A -o json');
    res.json(JSON.parse(stdout));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific release
router.get('/releases/:namespace/:name', validators.helm.getRelease, async (req, res) => {
  try {
    const { namespace, name } = req.params;
    const { stdout } = await execAsync(`helm get all ${name} -n ${namespace} -o json`);
    res.json(JSON.parse(stdout));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get release history
router.get('/releases/:namespace/:name/history', validators.helm.getReleaseHistory, async (req, res) => {
  try {
    const { namespace, name } = req.params;
    const { stdout } = await execAsync(`helm history ${name} -n ${namespace} -o json`);
    res.json(JSON.parse(stdout));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rollback release
router.post('/releases/:namespace/:name/rollback', validators.helm.rollbackRelease, async (req, res) => {
  try {
    const { namespace, name } = req.params;
    const { revision } = req.body;
    const revisionArg = revision ? revision : '';
    const { stdout } = await execAsync(`helm rollback ${name} ${revisionArg} -n ${namespace}`);
    res.json({ success: true, message: stdout });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get release values
router.get('/releases/:namespace/:name/values', validators.helm.getReleaseValues, async (req, res) => {
  try {
    const { namespace, name } = req.params;
    const { stdout } = await execAsync(`helm get values ${name} -n ${namespace} -o json`);
    res.json(JSON.parse(stdout));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
