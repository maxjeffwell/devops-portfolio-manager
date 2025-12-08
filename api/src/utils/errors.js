/**
 * Custom error classes for structured error handling
 * Provides type-safe errors with contextual information
 */

/**
 * Base application error class
 */
class ApplicationError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: this.name,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
      timestamp: this.timestamp
    };
  }
}

/**
 * API request errors (4xx)
 */
class APIError extends ApplicationError {
  constructor(message, statusCode = 400, details = {}) {
    super(message, statusCode, details);
  }
}

/**
 * External service errors (upstream failures)
 */
class ServiceError extends ApplicationError {
  constructor(serviceName, message, details = {}) {
    super(`${serviceName} service error: ${message}`, 502, {
      service: serviceName,
      ...details
    });
    this.serviceName = serviceName;
  }
}

/**
 * Kubernetes/Helm operation errors
 */
class InfrastructureError extends ApplicationError {
  constructor(operation, resource, message, details = {}) {
    super(`Infrastructure error during ${operation} on ${resource}: ${message}`, 500, {
      operation,
      resource,
      ...details
    });
    this.operation = operation;
    this.resource = resource;
  }
}

/**
 * Validation errors
 */
class ValidationError extends APIError {
  constructor(field, message, details = {}) {
    super(`Validation failed for ${field}: ${message}`, 400, {
      field,
      ...details
    });
    this.field = field;
  }
}

/**
 * Resource not found errors
 */
class NotFoundError extends APIError {
  constructor(resource, identifier, details = {}) {
    super(`${resource} not found: ${identifier}`, 404, {
      resource,
      identifier,
      ...details
    });
    this.resource = resource;
    this.identifier = identifier;
  }
}

/**
 * Authentication/Authorization errors
 */
class AuthError extends APIError {
  constructor(message, details = {}) {
    super(message, 401, details);
  }
}

/**
 * Configuration errors
 */
class ConfigurationError extends ApplicationError {
  constructor(message, details = {}) {
    super(`Configuration error: ${message}`, 500, details);
  }
}

/**
 * Timeout errors
 */
class TimeoutError extends ApplicationError {
  constructor(operation, timeout, details = {}) {
    super(`Operation timed out: ${operation} (${timeout}ms)`, 504, {
      operation,
      timeout,
      ...details
    });
    this.operation = operation;
    this.timeout = timeout;
  }
}

/**
 * Error result for operations that should not throw
 */
class ErrorResult {
  constructor(error, context = {}) {
    this.success = false;
    this.error = {
      name: error.name,
      message: error.message,
      statusCode: error.statusCode || 500,
      details: error.details || {},
      timestamp: error.timestamp || new Date().toISOString()
    };
    this.context = context;
  }

  static from(error, context = {}) {
    if (error instanceof ApplicationError) {
      return new ErrorResult(error, context);
    }

    // Wrap unknown errors
    const appError = new ApplicationError(error.message || 'Unknown error', 500);
    return new ErrorResult(appError, context);
  }
}

/**
 * Success result for operations
 */
class SuccessResult {
  constructor(data, context = {}) {
    this.success = true;
    this.data = data;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Utility to wrap async operations with error handling
 */
async function wrapAsync(operation, errorContext = {}) {
  try {
    const result = await operation();
    return new SuccessResult(result, errorContext);
  } catch (error) {
    return ErrorResult.from(error, errorContext);
  }
}

/**
 * Parse error from external service response
 */
function parseServiceError(serviceName, response, fallbackMessage = 'Service request failed') {
  const details = {
    statusCode: response.status,
    statusText: response.statusText
  };

  let message = fallbackMessage;

  if (response.data) {
    if (typeof response.data === 'string') {
      message = response.data;
    } else if (response.data.error) {
      message = response.data.error;
    } else if (response.data.message) {
      message = response.data.message;
    }
  }

  return new ServiceError(serviceName, message, details);
}

/**
 * Check if error is a specific type
 */
function isErrorType(error, ErrorClass) {
  return error instanceof ErrorClass;
}

/**
 * Extract user-friendly error message
 */
function getUserMessage(error) {
  if (error instanceof ApplicationError) {
    return error.message;
  }

  // Generic message for unknown errors
  return 'An unexpected error occurred. Please try again later.';
}

module.exports = {
  // Error classes
  ApplicationError,
  APIError,
  ServiceError,
  InfrastructureError,
  ValidationError,
  NotFoundError,
  AuthError,
  ConfigurationError,
  TimeoutError,

  // Result types
  ErrorResult,
  SuccessResult,

  // Utilities
  wrapAsync,
  parseServiceError,
  isErrorType,
  getUserMessage
};
