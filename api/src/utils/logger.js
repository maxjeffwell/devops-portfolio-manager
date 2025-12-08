/**
 * Structured logging utility with contextual information
 * Provides consistent logging format across the application
 */

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

const LOG_COLORS = {
  ERROR: '\x1b[31m', // Red
  WARN: '\x1b[33m',  // Yellow
  INFO: '\x1b[36m',  // Cyan
  DEBUG: '\x1b[90m', // Gray
  RESET: '\x1b[0m'
};

class Logger {
  constructor(context = '', level = 'INFO') {
    this.context = context;
    this.level = LOG_LEVELS[level.toUpperCase()] || LOG_LEVELS.INFO;
    this.enableColors = process.env.NODE_ENV !== 'production';
  }

  /**
   * Format log entry with structured data
   */
  format(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      context: this.context,
      message,
      ...data
    };

    // Pretty print for development
    if (this.enableColors && process.env.NODE_ENV !== 'production') {
      const color = LOG_COLORS[level];
      const reset = LOG_COLORS.RESET;
      const contextStr = this.context ? `[${this.context}]` : '';
      const dataStr = Object.keys(data).length > 0 ? `\n${JSON.stringify(data, null, 2)}` : '';
      return `${color}[${timestamp}] ${level}${reset} ${contextStr} ${message}${dataStr}`;
    }

    // JSON for production
    return JSON.stringify(entry);
  }

  /**
   * Check if level should be logged
   */
  shouldLog(level) {
    return LOG_LEVELS[level] <= this.level;
  }

  /**
   * Log error message
   */
  error(message, error = null, data = {}) {
    if (!this.shouldLog('ERROR')) return;

    const logData = { ...data };

    if (error) {
      logData.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        statusCode: error.statusCode,
        details: error.details
      };
    }

    console.error(this.format('ERROR', message, logData));
  }

  /**
   * Log warning message
   */
  warn(message, data = {}) {
    if (!this.shouldLog('WARN')) return;
    console.warn(this.format('WARN', message, data));
  }

  /**
   * Log info message
   */
  info(message, data = {}) {
    if (!this.shouldLog('INFO')) return;
    console.log(this.format('INFO', message, data));
  }

  /**
   * Log debug message
   */
  debug(message, data = {}) {
    if (!this.shouldLog('DEBUG')) return;
    console.log(this.format('DEBUG', message, data));
  }

  /**
   * Log API request
   */
  logRequest(req, data = {}) {
    this.info(`${req.method} ${req.path}`, {
      method: req.method,
      path: req.path,
      query: req.query,
      params: req.params,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      ...data
    });
  }

  /**
   * Log API response
   */
  logResponse(req, res, duration, data = {}) {
    const logMethod = res.statusCode >= 400 ? 'error' : 'info';
    this[logMethod](`${req.method} ${req.path} - ${res.statusCode}`, {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ...data
    });
  }

  /**
   * Log operation start
   */
  logOperationStart(operation, data = {}) {
    this.info(`Starting operation: ${operation}`, data);
  }

  /**
   * Log operation success
   */
  logOperationSuccess(operation, duration, data = {}) {
    this.info(`Operation completed: ${operation}`, {
      duration: `${duration}ms`,
      ...data
    });
  }

  /**
   * Log operation failure
   */
  logOperationFailure(operation, error, duration, data = {}) {
    this.error(`Operation failed: ${operation}`, error, {
      duration: `${duration}ms`,
      ...data
    });
  }

  /**
   * Create child logger with additional context
   */
  child(childContext) {
    const context = this.context ? `${this.context}:${childContext}` : childContext;
    return new Logger(context, Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === this.level));
  }
}

/**
 * Create logger instance
 */
function createLogger(context = '', level = process.env.LOG_LEVEL || 'INFO') {
  return new Logger(context, level);
}

/**
 * Express middleware for request logging
 */
function requestLogger(logger) {
  return (req, res, next) => {
    const start = Date.now();

    // Log request
    logger.logRequest(req);

    // Override res.json to capture response
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      const duration = Date.now() - start;
      logger.logResponse(req, res, duration);
      return originalJson(data);
    };

    // Handle response end
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (!res.headersSent || res.statusCode >= 400) {
        logger.logResponse(req, res, duration);
      }
    });

    next();
  };
}

/**
 * Express middleware for error logging
 */
function errorLogger(logger) {
  return (err, req, res, next) => {
    logger.error('Request error', err, {
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body
    });
    next(err);
  };
}

module.exports = {
  Logger,
  createLogger,
  requestLogger,
  errorLogger,
  LOG_LEVELS
};
