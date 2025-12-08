const express = require('express');
const router = express.Router();
const configLoader = require('../config/config-loader');
const { validators } = require('../middleware/validation');

/**
 * Load applications configuration from external YAML file
 * @returns {Array} Array of application configurations
 */
const getApplications = () => {
  try {
    const config = configLoader.loadConfig('applications.yaml');
    return config.applications;
  } catch (error) {
    console.error('Error loading applications configuration:', error.message);
    throw new Error(`Failed to load applications configuration: ${error.message}`);
  }
};

// Get all applications
router.get('/', (req, res, next) => {
  try {
    const applications = getApplications();
    res.json(applications);
  } catch (error) {
    next(error);
  }
});

// Get specific application
router.get('/:id', validators.applications.getApplication, (req, res, next) => {
  try {
    const applications = getApplications();
    const app = applications.find(a => a.id === req.params.id);

    if (!app) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json(app);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
