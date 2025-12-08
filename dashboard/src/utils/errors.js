/**
 * Frontend error handling utilities
 * Provides structured error handling for API calls and user-facing error messages
 */

/**
 * Custom API error class
 */
export class APIError extends Error {
  constructor(message, statusCode, details = {}) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  /**
   * Check if error indicates service unavailability
   */
  isServiceUnavailable() {
    return this.statusCode >= 500 || this.statusCode === 0;
  }

  /**
   * Check if error is a client error
   */
  isClientError() {
    return this.statusCode >= 400 && this.statusCode < 500;
  }

  /**
   * Get user-friendly error message
   */
  getUserMessage() {
    if (this.statusCode === 404) {
      return 'The requested resource was not found';
    }
    if (this.statusCode === 401 || this.statusCode === 403) {
      return 'You do not have permission to access this resource';
    }
    if (this.statusCode >= 500) {
      return 'A server error occurred. Please try again later';
    }
    if (this.statusCode === 0) {
      return 'Unable to connect to the server. Please check your connection';
    }
    return this.message || 'An error occurred';
  }
}

/**
 * Service unavailable error
 */
export class ServiceUnavailableError extends APIError {
  constructor(serviceName, details = {}) {
    super(`${serviceName} service is currently unavailable`, 503, {
      service: serviceName,
      ...details
    });
    this.serviceName = serviceName;
  }

  getUserMessage() {
    return `The ${this.serviceName} service is currently unavailable. Some features may be limited.`;
  }
}

/**
 * Result wrapper for operations that should not throw
 */
export class Result {
  constructor(success, data = null, error = null) {
    this.success = success;
    this.data = data;
    this.error = error;
    this.timestamp = new Date().toISOString();
  }

  static success(data) {
    return new Result(true, data, null);
  }

  static failure(error) {
    return new Result(false, null, error);
  }

  /**
   * Check if result is successful
   */
  isSuccess() {
    return this.success;
  }

  /**
   * Check if result is failure
   */
  isFailure() {
    return !this.success;
  }

  /**
   * Get data or throw error
   */
  unwrap() {
    if (this.success) {
      return this.data;
    }
    throw this.error;
  }

  /**
   * Get data or return default value
   */
  unwrapOr(defaultValue) {
    return this.success ? this.data : defaultValue;
  }

  /**
   * Map over successful result
   */
  map(fn) {
    if (this.success) {
      try {
        return Result.success(fn(this.data));
      } catch (error) {
        return Result.failure(error);
      }
    }
    return this;
  }

  /**
   * Handle error case
   */
  mapError(fn) {
    if (this.isFailure()) {
      try {
        return Result.failure(fn(this.error));
      } catch (error) {
        return Result.failure(error);
      }
    }
    return this;
  }
}

/**
 * Handle fetch response
 */
export async function handleResponse(response) {
  if (!response.ok) {
    let errorData = {};
    try {
      errorData = await response.json();
    } catch {
      // Response may not be JSON
    }

    throw new APIError(
      errorData.error || errorData.message || response.statusText,
      response.status,
      errorData.details || {}
    );
  }

  try {
    return await response.json();
  } catch {
    // Response may be empty
    return null;
  }
}

/**
 * Wrap API call with error handling
 */
export async function safeAPICall(apiFunction, options = {}) {
  const {
    fallbackValue = null,
    onError = null,
    retries = 0,
    retryDelay = 1000
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await apiFunction();
      return Result.success(data);
    } catch (error) {
      lastError = error;

      // Call error handler if provided
      if (onError) {
        onError(error, attempt);
      }

      // Retry if not last attempt
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
    }
  }

  // All attempts failed
  if (fallbackValue !== null) {
    console.warn('API call failed, using fallback value', { error: lastError });
    return Result.success(fallbackValue);
  }

  return Result.failure(lastError);
}

/**
 * Check if service is available
 */
export function isServiceAvailable(error) {
  if (error instanceof ServiceUnavailableError) {
    return false;
  }
  if (error instanceof APIError) {
    return !error.isServiceUnavailable();
  }
  return true;
}

/**
 * Log error to console with context
 */
export function logError(context, error, additionalData = {}) {
  const errorData = {
    context,
    timestamp: new Date().toISOString(),
    error: {
      name: error.name,
      message: error.message,
      statusCode: error.statusCode,
      details: error.details
    },
    ...additionalData
  };

  console.error(`[${context}]`, error.message, errorData);
}

/**
 * Create error notification data
 */
export function createErrorNotification(error) {
  let message = 'An error occurred';
  let type = 'error';

  if (error instanceof APIError) {
    message = error.getUserMessage();
    type = error.isServiceUnavailable() ? 'warning' : 'error';
  } else if (error instanceof Error) {
    message = error.message;
  }

  return {
    type,
    message,
    timestamp: new Date().toISOString()
  };
}

/**
 * Parse error from unknown source
 */
export function parseError(error) {
  if (error instanceof APIError) {
    return error;
  }

  if (error instanceof Error) {
    return new APIError(error.message, 500);
  }

  if (typeof error === 'string') {
    return new APIError(error, 500);
  }

  return new APIError('An unknown error occurred', 500);
}
