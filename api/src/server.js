const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

const { createLogger, requestLogger, errorLogger } = require('./utils/logger');
const { ApplicationError } = require('./utils/errors');

const app = express();
const PORT = process.env.PORT || 5001;

// Create logger
const logger = createLogger('API', process.env.LOG_LEVEL || 'INFO');

// CORS Configuration
// Restrict origins to prevent unauthorized cross-origin requests
const corsOptions = {
  // Parse allowed origins from environment variable, fallback to localhost for development
  origin: function (origin, callback) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : ['http://localhost:3000', 'http://localhost:31256'];

    // Allow requests with no origin (like mobile apps, Postman, curl)
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn('CORS request blocked', { origin, allowedOrigins });
      callback(new Error('Not allowed by CORS'));
    }
  },
  // Enable credentials (cookies, authorization headers)
  credentials: true,
  // Restrict HTTP methods
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  // Allow specific headers
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  // Cache preflight requests for 24 hours
  maxAge: 86400,
  // Expose headers to the client
  exposedHeaders: ['X-Total-Count', 'X-Page-Number']
};

// Middleware
app.use(helmet());
app.use(cors(corsOptions));

// Logging middleware
if (process.env.NODE_ENV === 'production') {
  app.use(requestLogger(logger));
} else {
  app.use(morgan('dev'));
}

// Request body size limits to prevent DoS attacks
app.use(express.json({ limit: '1mb' })); // Limit JSON payloads to 1MB
app.use(express.urlencoded({ extended: true, limit: '1mb' })); // Limit URL-encoded payloads to 1MB

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/argocd', require('./routes/argocd'));
app.use('/api/prometheus', require('./routes/prometheus'));
app.use('/api/github', require('./routes/github'));
app.use('/api/helm', require('./routes/helm'));
app.use('/api/applications', require('./routes/applications'));

// Error logging middleware
app.use(errorLogger(logger));

// Error handling
app.use((err, req, res, next) => {
  // Handle body size limit errors
  if (err.type === 'entity.too.large') {
    logger.warn('Request entity too large', {
      path: req.path,
      contentLength: req.get('content-length')
    });

    return res.status(413).json({
      error: 'Request entity too large',
      message: 'Request body exceeds the maximum allowed size of 1MB'
    });
  }

  // Handle validation errors from express-validator
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      message: err.message
    });
  }

  // Handle application errors
  if (err instanceof ApplicationError) {
    return res.status(err.statusCode).json(err.toJSON());
  }

  // Generic error response for unknown errors
  logger.error('Unhandled error', err, {
    path: req.path,
    method: req.method
  });

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message
  });
});

app.listen(PORT, () => {
  logger.info(`DevOps API server started`, {
    port: PORT,
    env: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'INFO'
  });
});
