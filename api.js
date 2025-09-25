/**
 * @fileoverview Employee Time Tracking API Client
 * @version 2.0.0
 */
(function () {
  'use strict';

  /**
   * Configuration object for API settings
   * @const {Object}
   */
  const CONFIG = {
    API_URL: 'https://script.google.com/macros/s/AKfycbxYwfb7YGfsUAeTH-WaqF79HyXDooksC2pfK1aZkDcKSU3DA0-gL60sJTojUVyVnjQI/exec',
    DEFAULT_TIMEOUT: 30000,
    DEFAULT_RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000,
    DEFAULT_HISTORY_DAYS: 30
  };

  /**
   * Custom error class for API-related errors
   * @class
   */
  class ApiError extends Error {
    constructor(message, code = 'API_ERROR', details = null) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.details = details;
    }
  }

  /**
   * Custom error class for validation errors
   * @class
   */
  class ValidationError extends Error {
    constructor(message, field = null) {
      super(message);
      this.name = 'ValidationError';
      this.field = field;
    }
  }

  /**
   * Utility functions
   * @namespace
   */
  const Utils = {
    /**
     * Escapes HTML special characters to prevent XSS
     * @param {*} value - Value to escape
     * @returns {string} Escaped HTML string
     */
    escapeHtml(value) {
      const htmlEscapeMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      };
      return String(value).replace(/[&<>"']/g, char => htmlEscapeMap[char]);
    },

    /**
     * Formats date to YYYY-MM-DD format
     * @param {Date} date - Date object to format
     * @returns {string} Formatted date string
     * @throws {ValidationError} If date is invalid
     */
    formatDate(date) {
      if (!(date instanceof Date) || isNaN(date.getTime())) {
        throw new ValidationError('Invalid date object');
      }
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    },

    /**
     * Delays execution for specified milliseconds
     * @param {number} ms - Milliseconds to delay
     * @returns {Promise<void>}
     */
    delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    /**
     * Validates that a value is a non-empty string
     * @param {*} value - Value to validate
     * @param {string} fieldName - Field name for error message
     * @throws {ValidationError} If validation fails
     */
    validateString(value, fieldName) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ValidationError(`${fieldName} must be a non-empty string`, fieldName);
      }
    },

    /**
     * Validates that a value is a positive number
     * @param {*} value - Value to validate
     * @param {string} fieldName - Field name for error message
     * @throws {ValidationError} If validation fails
     */
    validatePositiveNumber(value, fieldName) {
      if (typeof value !== 'number' || value <= 0 || isNaN(value)) {
        throw new ValidationError(`${fieldName} must be a positive number`, fieldName);
      }
    }
  };

  /**
   * JSONP request handler with timeout and retry logic
   * @namespace
   */
  const JsonpClient = {
    /**
     * Makes a JSONP request with timeout and retry capabilities
     * @param {string} url - URL to request
     * @param {Object} options - Request options
     * @param {number} [options.timeout] - Request timeout in milliseconds
     * @param {number} [options.retryAttempts] - Number of retry attempts
     * @param {number} [options.retryDelay] - Delay between retries in milliseconds
     * @returns {Promise<Object>} Response data
     * @throws {ApiError} If request fails after all retries
     */
    async request(url, options = {}) {
      const {
        timeout = CONFIG.DEFAULT_TIMEOUT,
        retryAttempts = CONFIG.DEFAULT_RETRY_ATTEMPTS,
        retryDelay = CONFIG.RETRY_DELAY
      } = options;

      let lastError;

      for (let attempt = 0; attempt < retryAttempts; attempt++) {
        try {
          if (attempt > 0) {
            await Utils.delay(retryDelay * Math.pow(2, attempt - 1)); // Exponential backoff
          }

          const result = await this._executeJsonp(url, timeout);
          return result;
        } catch (error) {
          lastError = error;
          console.warn(`JSONP request attempt ${attempt + 1} failed:`, error);
        }
      }

      throw new ApiError(
        `Request failed after ${retryAttempts} attempts`,
        'REQUEST_FAILED',
        { originalError: lastError, url }
      );
    },

    /**
     * Executes a single JSONP request
     * @private
     * @param {string} url - URL to request
     * @param {number} timeout - Request timeout
     * @returns {Promise<Object>} Response data
     */
    _executeJsonp(url, timeout) {
      return new Promise((resolve, reject) => {
        const callbackName = `jsonp_callback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const separator = url.includes('?') ? '&' : '?';
        const scriptUrl = `${url}${separator}callback=${callbackName}`;

        let script = null;
        let timeoutId = null;
        let isCleanedUp = false;

        const cleanup = () => {
          if (isCleanedUp) return;
          isCleanedUp = true;

          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }

          if (window[callbackName]) {
            try {
              delete window[callbackName];
            } catch (e) {
              window[callbackName] = undefined;
            }
          }

          if (script && script.parentNode) {
            script.parentNode.removeChild(script);
          }
        };

        window[callbackName] = (data) => {
          cleanup();
          resolve(data);
        };

        script = document.createElement('script');
        script.src = scriptUrl;
        script.async = true;

        script.onerror = (error) => {
          cleanup();
          reject(new ApiError('JSONP script loading failed', 'SCRIPT_ERROR', { error, url }));
        };

        timeoutId = setTimeout(() => {
          cleanup();
          reject(new ApiError('Request timeout', 'TIMEOUT', { timeout, url }));
        }, timeout);

        document.head.appendChild(script);
      });
    }
  };

  /**
   * API methods for employee management
   * @namespace
   */
  const EmployeeAPI = {
    /**
     * Fetches all employees
     * @param {Object} [options] - Request options
     * @returns {Promise<Array>} Array of employee objects
     * @throws {ApiError} If request fails
     */
    async fetchEmployees(options = {}) {
      const url = `${CONFIG.API_URL}?action=employee.list`;
      const data = await JsonpClient.request(url, options);

      if (!data.ok) {
        throw new ApiError(
          data.error || 'Failed to fetch employees',
          'FETCH_EMPLOYEES_ERROR',
          data
        );
      }

      return data.employees || [];
    },

    /**
     * Fetches a specific employee by ID
     * @param {string|number} id - Employee ID
     * @param {Object} [options] - Request options
     * @returns {Promise<Object>} Employee object
     * @throws {ValidationError} If ID is invalid
     * @throws {ApiError} If request fails
     */
    async fetchEmployee(id, options = {}) {
      if (id === null || id === undefined || id === '') {
        throw new ValidationError('Employee ID is required', 'id');
      }

      const url = `${CONFIG.API_URL}?action=employee.get&id=${encodeURIComponent(String(id))}`;
      const data = await JsonpClient.request(url, options);

      if (!data.ok) {
        throw new ApiError(
          data.error || 'Failed to fetch employee',
          'FETCH_EMPLOYEE_ERROR',
          { ...data, employeeId: id }
        );
      }

      return data.employee;
    },

    /**
     * Sends a punch (clock in/out) request
     * @param {Object} params - Punch parameters
     * @param {string|number} params.id - Employee ID
     * @param {string} params.name - Employee name
     * @param {string} params.punchType - Type of punch (e.g., 'clockIn', 'clockOut')
     * @param {string} params.position - Position/location data
     * @param {Object} [options] - Request options
     * @returns {Promise<Object>} Saved punch data
     * @throws {ValidationError} If required parameters are missing
     * @throws {ApiError} If request fails
     */
    async sendPunch(params, options = {}) {
      const { id, name, punchType, position } = params || {};

      // Validate required parameters
      if (id === null || id === undefined || id === '') {
        throw new ValidationError('Employee ID is required', 'id');
      }
      Utils.validateString(name, 'Employee name');
      Utils.validateString(punchType, 'Punch type');
      const pos = punchType === '退勤' ? position : (position ?? '');
      if (punchType === '退勤') {
       Utils.validateString(pos, 'Position');
      }

      const queryParams = new URLSearchParams({
        action: 'punch',
        employeeId: String(id),
        employeeName: String(name),
        punchType: punchType,
        position: pos
      });

      const url = `${CONFIG.API_URL}?${queryParams.toString()}`;
      const data = await JsonpClient.request(url, options);

      if (!data.ok) {
        throw new ApiError(
          data.error || 'Failed to send punch',
          'PUNCH_ERROR',
          { ...data, params }
        );
      }

      return data.saved;
    },

    /**
     * Fetches employee time tracking history
     * @param {Object} params - History parameters
     * @param {string|number} params.employeeId - Employee ID
     * @param {number} [params.days] - Number of days to fetch (default: 30)
     * @param {Date} [params.from] - Start date
     * @param {Date} [params.to] - End date
     * @param {Object} [options] - Request options
     * @returns {Promise<Array>} Array of history records
     * @throws {ValidationError} If parameters are invalid
     * @throws {ApiError} If request fails
     */
    async fetchHistory(params, options = {}) {
      const { employeeId, days = CONFIG.DEFAULT_HISTORY_DAYS, from, to } = params || {};

      if (employeeId === null || employeeId === undefined || employeeId === '') {
        throw new ValidationError('Employee ID is required', 'employeeId');
      }

      const queryParams = new URLSearchParams({
        action: 'history',
        employeeId: String(employeeId)
      });

      // Handle date range
      if (from && to) {
        if (!(from instanceof Date) || !(to instanceof Date)) {
          throw new ValidationError('From and to must be Date objects');
        }
        if (from > to) {
          throw new ValidationError('From date must be before or equal to to date');
        }
        queryParams.set('from', Utils.formatDate(from));
        queryParams.set('to', Utils.formatDate(to));
      } else if (typeof days === 'number' && days > 0) {
        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(toDate.getDate() - days + 1);
        queryParams.set('from', Utils.formatDate(fromDate));
        queryParams.set('to', Utils.formatDate(toDate));
      }

      const url = `${CONFIG.API_URL}?${queryParams.toString()}`;
      const data = await JsonpClient.request(url, options);

      if (!data.ok) {
        throw new ApiError(
          data.error || 'Failed to fetch history',
          'FETCH_HISTORY_ERROR',
          { ...data, params }
        );
      }

      return data.rows || [];
    }
  };

  /**
   * Public API interface
   * @namespace window.API
   */
  window.API = {
    // Configuration
    config: CONFIG,

    // Error classes
    ApiError,
    ValidationError,

    // Utility functions
    escapeHtml: Utils.escapeHtml,
    formatDate: Utils.formatDate,
    ymd: Utils.formatDate, // Backward compatibility

    // Core API methods
    fetchEmployees: EmployeeAPI.fetchEmployees.bind(EmployeeAPI),
    fetchEmployee: EmployeeAPI.fetchEmployee.bind(EmployeeAPI),
    sendPunch: EmployeeAPI.sendPunch.bind(EmployeeAPI),
    fetchHistory: EmployeeAPI.fetchHistory.bind(EmployeeAPI),

    // Advanced features
    jsonp: JsonpClient.request.bind(JsonpClient),

    // Backward compatibility
    API_URL: CONFIG.API_URL
  };
})();