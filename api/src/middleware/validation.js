const { validationResult, param, query, body } = require('express-validator');

/**
 * Validation middleware for API endpoints
 * Provides reusable validation schemas and error handling
 */

/**
 * Handle validation errors
 * Returns 400 with detailed error messages if validation fails
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(err => ({
        field: err.path || err.param,
        message: err.msg,
        value: err.value
      }))
    });
  }
  next();
};

/**
 * Common validation rules
 */
const validations = {
  // Kubernetes resource name validation (RFC 1123 subdomain)
  // Must consist of lower case alphanumeric characters, '-' or '.'
  // Must start and end with an alphanumeric character
  k8sResourceName: (field) => {
    return param(field)
      .trim()
      .notEmpty().withMessage(`${field} is required`)
      .isLength({ min: 1, max: 253 }).withMessage(`${field} must be between 1 and 253 characters`)
      .matches(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/)
      .withMessage(`${field} must be a valid Kubernetes resource name (lowercase alphanumeric, '-' or '.')`)
      .customSanitizer(value => value.toLowerCase().trim());
  },

  // Kubernetes namespace validation
  namespace: () => {
    return param('namespace')
      .trim()
      .notEmpty().withMessage('namespace is required')
      .isLength({ min: 1, max: 63 }).withMessage('namespace must be between 1 and 63 characters')
      .matches(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
      .withMessage('namespace must be a valid Kubernetes namespace (lowercase alphanumeric and hyphens)')
      .customSanitizer(value => value.toLowerCase().trim());
  },

  // Application/deployment name validation
  applicationName: () => {
    return validations.k8sResourceName('name');
  },

  // ArgoCD application name validation
  argocdAppName: () => {
    return validations.k8sResourceName('name');
  },

  // Prometheus query validation
  prometheusQuery: () => {
    return query('query')
      .trim()
      .notEmpty().withMessage('query is required')
      .isLength({ max: 10000 }).withMessage('query is too long (max 10000 characters)')
      .customSanitizer(value => value.trim());
  },

  // Prometheus time parameter (Unix timestamp or RFC3339)
  prometheusTime: () => {
    return query('time')
      .optional()
      .custom((value) => {
        // Allow Unix timestamp (seconds) or RFC3339 format
        if (!/^\d+(\.\d+)?$/.test(value) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
          throw new Error('time must be a Unix timestamp or RFC3339 format');
        }
        return true;
      });
  },

  // Prometheus timestamp range validation
  prometheusTimeRange: () => {
    return [
      query('start')
        .notEmpty().withMessage('start time is required')
        .custom((value) => {
          if (!/^\d+(\.\d+)?$/.test(value) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
            throw new Error('start must be a Unix timestamp or RFC3339 format');
          }
          return true;
        }),
      query('end')
        .notEmpty().withMessage('end time is required')
        .custom((value) => {
          if (!/^\d+(\.\d+)?$/.test(value) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
            throw new Error('end must be a Unix timestamp or RFC3339 format');
          }
          return true;
        }),
      query('step')
        .optional()
        .matches(/^\d+[smhdwy]?$/).withMessage('step must be a valid duration (e.g., 15s, 5m, 1h)')
    ];
  },

  // GitHub workflow ID validation
  workflowId: () => {
    return param('workflow_id')
      .trim()
      .notEmpty().withMessage('workflow_id is required')
      .custom((value) => {
        // Allow numeric IDs or workflow file names
        if (!/^\d+$/.test(value) && !/^[\w-]+\.ya?ml$/.test(value)) {
          throw new Error('workflow_id must be a numeric ID or workflow filename (e.g., deploy.yml)');
        }
        return true;
      })
      .customSanitizer(value => value.trim());
  },

  // GitHub ref (branch/tag) validation
  githubRef: () => {
    return body('ref')
      .optional()
      .trim()
      .isLength({ min: 1, max: 255 }).withMessage('ref must be between 1 and 255 characters')
      .matches(/^[a-zA-Z0-9/_.-]+$/).withMessage('ref contains invalid characters')
      .customSanitizer(value => value.trim());
  },

  // GitHub workflow inputs validation
  workflowInputs: () => {
    return body('inputs')
      .optional()
      .isObject().withMessage('inputs must be an object')
      .custom((value) => {
        // Validate that all keys and values are strings
        if (value && typeof value === 'object') {
          for (const [key, val] of Object.entries(value)) {
            if (typeof key !== 'string' || (val !== null && typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean')) {
              throw new Error('inputs must be an object with string keys and string/number/boolean values');
            }
          }
        }
        return true;
      });
  },

  // Helm revision validation
  helmRevision: () => {
    return body('revision')
      .optional()
      .isInt({ min: 0, max: 999999 }).withMessage('revision must be a positive integer')
      .toInt();
  },

  // Pagination limit validation
  paginationLimit: () => {
    return query('per_page')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('per_page must be between 1 and 100')
      .toInt();
  }
};

/**
 * Validation rule sets for different endpoints
 */
const validators = {
  // ArgoCD validators
  argocd: {
    getApplication: [validations.argocdAppName(), handleValidationErrors],
    syncApplication: [validations.argocdAppName(), handleValidationErrors],
    getApplicationHistory: [validations.argocdAppName(), handleValidationErrors]
  },

  // Prometheus validators
  prometheus: {
    query: [validations.prometheusQuery(), validations.prometheusTime(), handleValidationErrors],
    queryRange: [
      validations.prometheusQuery(),
      ...validations.prometheusTimeRange(),
      handleValidationErrors
    ],
    getMetrics: [
      validations.namespace(),
      param('deployment')
        .trim()
        .notEmpty().withMessage('deployment is required')
        .isLength({ min: 1, max: 253 }).withMessage('deployment name is too long')
        .matches(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
        .withMessage('deployment must be a valid Kubernetes resource name')
        .customSanitizer(value => value.toLowerCase().trim()),
      handleValidationErrors
    ]
  },

  // GitHub validators
  github: {
    getWorkflowRuns: [validations.workflowId(), handleValidationErrors],
    triggerWorkflow: [
      validations.workflowId(),
      validations.githubRef(),
      validations.workflowInputs(),
      handleValidationErrors
    ]
  },

  // Helm validators
  helm: {
    getRelease: [
      validations.namespace(),
      validations.applicationName(),
      handleValidationErrors
    ],
    getReleaseHistory: [
      validations.namespace(),
      validations.applicationName(),
      handleValidationErrors
    ],
    rollbackRelease: [
      validations.namespace(),
      validations.applicationName(),
      validations.helmRevision(),
      handleValidationErrors
    ],
    getReleaseValues: [
      validations.namespace(),
      validations.applicationName(),
      handleValidationErrors
    ]
  },

  // Applications validators
  applications: {
    getApplication: [
      param('id')
        .trim()
        .notEmpty().withMessage('id is required')
        .isLength({ min: 1, max: 100 }).withMessage('id must be between 1 and 100 characters')
        .matches(/^[a-z0-9-]+$/).withMessage('id must contain only lowercase letters, numbers, and hyphens')
        .customSanitizer(value => value.toLowerCase().trim()),
      handleValidationErrors
    ]
  }
};

module.exports = {
  validators,
  validations,
  handleValidationErrors
};
