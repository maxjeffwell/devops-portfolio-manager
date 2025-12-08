const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Configuration loader for external application configuration
 * Loads and parses YAML configuration files with caching support
 */
class ConfigLoader {
  constructor() {
    this.cache = new Map();
    this.configDir = path.join(__dirname);
  }

  /**
   * Load configuration from a YAML file
   * @param {string} configFileName - Name of the config file (without path)
   * @param {boolean} useCache - Whether to use cached config (default: true)
   * @returns {Object} Parsed configuration object
   * @throws {Error} If file cannot be read or parsed
   */
  loadConfig(configFileName, useCache = true) {
    // Return cached config if available and caching is enabled
    if (useCache && this.cache.has(configFileName)) {
      return this.cache.get(configFileName);
    }

    const configPath = path.join(this.configDir, configFileName);

    try {
      // Check if file exists
      if (!fs.existsSync(configPath)) {
        throw new Error(`Configuration file not found: ${configPath}`);
      }

      // Read and parse YAML file
      const fileContents = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(fileContents);

      // Validate configuration structure
      this.validateConfig(config, configFileName);

      // Cache the configuration
      this.cache.set(configFileName, config);

      return config;
    } catch (error) {
      if (error.name === 'YAMLException') {
        throw new Error(`Invalid YAML syntax in ${configFileName}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Validate configuration structure
   * @param {Object} config - Configuration object to validate
   * @param {string} fileName - Name of the config file for error messages
   * @throws {Error} If configuration is invalid
   */
  validateConfig(config, fileName) {
    if (!config || typeof config !== 'object') {
      throw new Error(`Invalid configuration format in ${fileName}: expected object`);
    }

    // Add specific validation based on config type
    // This can be extended for different config files
    if (fileName === 'applications.yaml') {
      if (!Array.isArray(config.applications)) {
        throw new Error(`Invalid applications configuration: 'applications' must be an array`);
      }

      config.applications.forEach((app, index) => {
        const requiredFields = ['id', 'name', 'description', 'namespace', 'helmChart', 'argocdApp', 'github'];
        const missingFields = requiredFields.filter(field => !app[field]);

        if (missingFields.length > 0) {
          throw new Error(
            `Invalid application at index ${index}: missing required fields: ${missingFields.join(', ')}`
          );
        }

        if (!app.github.owner || !app.github.repo) {
          throw new Error(
            `Invalid application '${app.id}': github.owner and github.repo are required`
          );
        }
      });
    }
  }

  /**
   * Clear cached configuration
   * @param {string} configFileName - Name of config file to clear (optional, clears all if not specified)
   */
  clearCache(configFileName) {
    if (configFileName) {
      this.cache.delete(configFileName);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Reload configuration from disk (bypasses cache)
   * @param {string} configFileName - Name of the config file
   * @returns {Object} Parsed configuration object
   */
  reloadConfig(configFileName) {
    this.clearCache(configFileName);
    return this.loadConfig(configFileName, false);
  }
}

// Export singleton instance
module.exports = new ConfigLoader();
