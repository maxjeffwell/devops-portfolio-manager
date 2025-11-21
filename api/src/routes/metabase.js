const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const METABASE_SITE_URL = process.env.METABASE_SITE_URL || 'http://localhost:3333';
const METABASE_SECRET_KEY = process.env.METABASE_SECRET_KEY;

/**
 * Generate a signed JWT token for Metabase embedding
 * @param {Object} payload - The embedding payload (resource info, params, etc.)
 * @returns {String} Signed JWT token
 */
function generateMetabaseToken(payload) {
  if (!METABASE_SECRET_KEY) {
    throw new Error('METABASE_SECRET_KEY is not configured');
  }

  return jwt.sign(
    payload,
    METABASE_SECRET_KEY,
    { algorithm: 'HS256' }
  );
}

/**
 * GET /api/metabase/config
 * Returns Metabase configuration for the frontend
 */
router.get('/config', (req, res) => {
  res.json({
    siteUrl: METABASE_SITE_URL,
    configured: !!METABASE_SECRET_KEY
  });
});

/**
 * POST /api/metabase/embed-token/dashboard/:dashboardId
 * Generate an embed token for a specific dashboard
 * Body: { params: { ... } } - Optional parameters to pass to the dashboard
 */
router.post('/embed-token/dashboard/:dashboardId', (req, res) => {
  try {
    const { dashboardId } = req.params;
    const { params = {} } = req.body;

    const payload = {
      resource: { dashboard: parseInt(dashboardId) },
      params: params,
      exp: Math.round(Date.now() / 1000) + (10 * 60) // Token expires in 10 minutes
    };

    const token = generateMetabaseToken(payload);

    res.json({
      token,
      iframeUrl: `${METABASE_SITE_URL}/embed/dashboard/${token}#bordered=true&titled=true`
    });
  } catch (error) {
    console.error('Error generating dashboard embed token:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/metabase/embed-token/question/:questionId
 * Generate an embed token for a specific question
 * Body: { params: { ... } } - Optional parameters to pass to the question
 */
router.post('/embed-token/question/:questionId', (req, res) => {
  try {
    const { questionId } = req.params;
    const { params = {} } = req.body;

    const payload = {
      resource: { question: parseInt(questionId) },
      params: params,
      exp: Math.round(Date.now() / 1000) + (10 * 60) // Token expires in 10 minutes
    };

    const token = generateMetabaseToken(payload);

    res.json({
      token,
      iframeUrl: `${METABASE_SITE_URL}/embed/question/${token}#bordered=true&titled=true`
    });
  } catch (error) {
    console.error('Error generating question embed token:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/metabase/embed-token/sdk
 * Generate an embed token for the Metabase SDK (full SDK embedding)
 * Body: { user: { ... }, permissions: [ ... ] } - User context and permissions
 */
router.post('/embed-token/sdk', (req, res) => {
  try {
    const { user = {}, permissions = [] } = req.body;

    const payload = {
      iss: 'devops-portfolio-manager',
      sub: user.id || 'anonymous',
      email: user.email,
      first_name: user.firstName,
      last_name: user.lastName,
      groups: user.groups || [],
      permissions: permissions,
      exp: Math.round(Date.now() / 1000) + (60 * 60) // Token expires in 1 hour
    };

    const token = generateMetabaseToken(payload);

    res.json({ token });
  } catch (error) {
    console.error('Error generating SDK embed token:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
