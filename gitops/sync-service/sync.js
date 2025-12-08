#!/usr/bin/env node

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const execAsync = promisify(exec);

// Default timeout for git operations (30 seconds)
const GIT_OPERATION_TIMEOUT = 30000;
// Default concurrency for parallel syncing (3 applications at a time)
const DEFAULT_CONCURRENCY = 3;

/**
 * Input validation to prevent command injection
 */
const InputValidator = {
  // Kubernetes resource name: lowercase alphanumeric, hyphens, max 253 chars
  isValidK8sName(name) {
    return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) && name.length <= 253;
  },

  // Git branch name: alphanumeric, hyphens, slashes, underscores, dots
  isValidBranchName(branch) {
    return /^[a-zA-Z0-9/_.-]+$/.test(branch) && branch.length <= 255 && !branch.includes('..');
  },

  // Path validation: no traversal attempts
  isValidPath(pathStr) {
    const normalized = path.normalize(pathStr);
    return !normalized.includes('..') && !normalized.startsWith('/');
  },

  // Validate and sanitize input
  validate(value, type, fieldName) {
    if (!value || typeof value !== 'string') {
      throw new Error(`Invalid ${fieldName}: must be a non-empty string`);
    }

    switch (type) {
      case 'k8sName':
        if (!this.isValidK8sName(value)) {
          throw new Error(
            `Invalid ${fieldName}: "${value}" - must match Kubernetes naming conventions (lowercase alphanumeric and hyphens only)`
          );
        }
        break;
      case 'branch':
        if (!this.isValidBranchName(value)) {
          throw new Error(
            `Invalid ${fieldName}: "${value}" - contains invalid characters or path traversal`
          );
        }
        break;
      case 'path':
        if (!this.isValidPath(value)) {
          throw new Error(
            `Invalid ${fieldName}: "${value}" - contains path traversal or absolute path`
          );
        }
        break;
      default:
        throw new Error(`Unknown validation type: ${type}`);
    }

    return value;
  }
};

/**
 * Safe command execution using spawn
 */
function spawnCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.captureOutput ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      ...options
    });

    let stdout = '';
    let stderr = '';

    if (options.captureOutput) {
      child.stdout.on('data', data => stdout += data.toString());
      child.stderr.on('data', data => stderr += data.toString());
    }

    child.on('error', err => {
      reject(new Error(`Failed to execute ${command}: ${err.message}`));
    });

    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error(`Command ${command} exited with code ${code}${stderr ? ': ' + stderr : ''}`));
      }
    });

    // Handle timeout
    if (options.timeout) {
      setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command ${command} timed out after ${options.timeout}ms`));
      }, options.timeout);
    }
  });
}

/**
 * Execute command with timeout
 */
async function execWithTimeout(command, timeout = GIT_OPERATION_TIMEOUT) {
  return Promise.race([
    execAsync(command),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Command timed out after ${timeout}ms: ${command}`)), timeout)
    )
  ]);
}

/**
 * Run tasks with concurrency limit
 */
async function runWithConcurrency(tasks, concurrency = DEFAULT_CONCURRENCY) {
  const results = [];
  const executing = [];

  for (const task of tasks) {
    const promise = task().then(result => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });

    results.push(promise);
    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.allSettled(results);
}

/**
 * Sync result tracking
 */
class SyncResult {
  constructor(appName) {
    this.appName = appName;
    this.success = false;
    this.error = null;
    this.startTime = Date.now();
    this.endTime = null;
    this.action = null; // 'install', 'upgrade', 'skip'
    this.rolledBack = false;
  }

  markSuccess(action) {
    this.success = true;
    this.action = action;
    this.endTime = Date.now();
  }

  markFailure(error, rolledBack = false) {
    this.success = false;
    this.error = {
      message: error.message,
      stack: error.stack
    };
    this.rolledBack = rolledBack;
    this.endTime = Date.now();
  }

  getDuration() {
    return this.endTime ? this.endTime - this.startTime : Date.now() - this.startTime;
  }

  toJSON() {
    return {
      appName: this.appName,
      success: this.success,
      action: this.action,
      error: this.error,
      rolledBack: this.rolledBack,
      duration: this.getDuration()
    };
  }
}

/**
 * Sync cycle summary
 */
class SyncCycleSummary {
  constructor() {
    this.results = [];
    this.startTime = Date.now();
    this.endTime = null;
  }

  addResult(result) {
    this.results.push(result);
  }

  complete() {
    this.endTime = Date.now();
  }

  getSuccessCount() {
    return this.results.filter(r => r.success).length;
  }

  getFailureCount() {
    return this.results.filter(r => !r.success).length;
  }

  getSkippedCount() {
    return this.results.filter(r => r.action === 'skip').length;
  }

  getDuration() {
    return this.endTime ? this.endTime - this.startTime : Date.now() - this.startTime;
  }

  toJSON() {
    return {
      totalApps: this.results.length,
      successful: this.getSuccessCount(),
      failed: this.getFailureCount(),
      skipped: this.getSkippedCount(),
      duration: this.getDuration(),
      results: this.results.map(r => r.toJSON())
    };
  }

  getSummaryString() {
    const total = this.results.length;
    const success = this.getSuccessCount();
    const failed = this.getFailureCount();
    const skipped = this.getSkippedCount();
    const duration = (this.getDuration() / 1000).toFixed(2);

    return `Sync completed: ${success}/${total} succeeded, ${failed} failed, ${skipped} skipped (${duration}s)`;
  }
}

class GitOpsSyncService {
  constructor(configPath) {
    this.configPath = configPath;
    this.config = null;
    this.repoPath = '/tmp/gitops-repo';
    this.lastCommit = null;
    this.syncInProgress = false;
    this.logger = this.createLogger();
  }

  createLogger() {
    return {
      info: (msg, data = {}) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] INFO: ${msg}`, data.error ? '' : JSON.stringify(data));
      },
      error: (msg, error, data = {}) => {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] ERROR: ${msg}`);
        if (error) {
          console.error('  Error:', error.message);
          if (error.stack) {
            console.error('  Stack:', error.stack);
          }
        }
        if (Object.keys(data).length > 0) {
          console.error('  Details:', JSON.stringify(data));
        }
      },
      warn: (msg, data = {}) => {
        const timestamp = new Date().toISOString();
        console.warn(`[${timestamp}] WARN: ${msg}`, JSON.stringify(data));
      }
    };
  }

  async init() {
    console.log('Initializing GitOps Sync Service...');
    await this.loadConfig();
    await this.cloneRepository();
    console.log('GitOps Sync Service initialized successfully');
  }

  async loadConfig() {
    const configContent = await fs.readFile(this.configPath, 'utf8');
    this.config = yaml.load(configContent);

    // Validate configuration to prevent command injection
    InputValidator.validate(this.config.git.branch, 'branch', 'git.branch');

    this.config.applications.forEach((app, index) => {
      try {
        InputValidator.validate(app.name, 'k8sName', `applications[${index}].name`);
        InputValidator.validate(app.namespace, 'k8sName', `applications[${index}].namespace`);
        InputValidator.validate(app.path, 'path', `applications[${index}].path`);
      } catch (error) {
        throw new Error(`Configuration validation failed for application at index ${index}: ${error.message}`);
      }
    });

    console.log(`Loaded and validated configuration for ${this.config.applications.length} applications`);
  }

  async cloneRepository() {
    try {
      await fs.access(this.repoPath);
      console.log('Repository already exists, fetching latest changes...');
      await this.updateRepository();
    } catch {
      console.log('Cloning repository...');
      await spawnCommand('git', ['clone', this.config.git.repository, this.repoPath], {
        timeout: GIT_OPERATION_TIMEOUT
      });
      await spawnCommand('git', ['checkout', this.config.git.branch], {
        cwd: this.repoPath,
        timeout: GIT_OPERATION_TIMEOUT
      });
    }
  }

  async updateRepository() {
    const branch = this.config.git.branch;

    try {
      // Fetch latest changes with timeout
      await spawnCommand('git', ['fetch', 'origin', branch], {
        cwd: this.repoPath,
        timeout: GIT_OPERATION_TIMEOUT
      });

      // Reset to latest remote branch (safer than pull)
      await spawnCommand('git', ['reset', '--hard', `origin/${branch}`], {
        cwd: this.repoPath,
        timeout: GIT_OPERATION_TIMEOUT
      });

      // Clean any untracked files
      await spawnCommand('git', ['clean', '-fd'], {
        cwd: this.repoPath,
        timeout: GIT_OPERATION_TIMEOUT
      });

      this.logger.info('Repository updated successfully', { branch });
    } catch (error) {
      this.logger.error('Failed to update repository', error);
      throw error;
    }
  }

  async checkForChanges() {
    const { stdout } = await spawnCommand('git', ['rev-parse', 'HEAD'], {
      cwd: this.repoPath,
      captureOutput: true
    });
    const currentCommit = stdout.trim();

    if (this.lastCommit && this.lastCommit === currentCommit) {
      return false;
    }

    console.log(`New commit detected: ${currentCommit}`);
    this.lastCommit = currentCommit;
    return true;
  }

  async syncApplication(app) {
    const result = new SyncResult(app.name);

    if (!app.enabled || !app.autoSync) {
      this.logger.info(`Skipping ${app.name} (auto-sync disabled)`);
      result.markSuccess('skip');
      return result;
    }

    this.logger.info(`Syncing application: ${app.name}`);
    const chartPath = path.join(this.repoPath, app.path);
    let releaseExists = false;

    try {
      // Check if Helm release exists
      releaseExists = await this.helmReleaseExists(app.name, app.namespace);

      if (releaseExists) {
        this.logger.info(`Upgrading existing release: ${app.name}`);
        await this.helmUpgrade(app, chartPath);
        result.markSuccess('upgrade');
      } else {
        this.logger.info(`Installing new release: ${app.name}`);
        await this.helmInstall(app, chartPath);
        result.markSuccess('install');
      }

      // Perform health check
      if (this.config.healthCheck.enabled) {
        await this.healthCheck(app);
      }

      this.logger.info(`Successfully synced ${app.name}`, {
        action: result.action,
        duration: result.getDuration()
      });

      return result;
    } catch (error) {
      this.logger.error(`Failed to sync ${app.name}`, error, {
        action: releaseExists ? 'upgrade' : 'install'
      });

      let rolledBack = false;

      // Attempt auto-rollback if enabled and release existed
      if (this.config.sync.autoRollback && releaseExists) {
        this.logger.info(`Auto-rolling back ${app.name}...`);
        try {
          await this.rollback(app);
          rolledBack = true;
          this.logger.info(`Successfully rolled back ${app.name}`);
        } catch (rollbackError) {
          this.logger.error(`Failed to rollback ${app.name}`, rollbackError);
        }
      }

      result.markFailure(error, rolledBack);
      return result;
    }
  }

  async helmReleaseExists(name, namespace) {
    try {
      await spawnCommand('helm', ['status', name, '-n', namespace], {
        captureOutput: true
      });
      return true;
    } catch {
      return false;
    }
  }

  async helmInstall(app, chartPath) {
    const args = ['install', app.name, chartPath, '-n', app.namespace];

    // Add value files as separate arguments
    app.valueFiles.forEach(f => {
      args.push('-f', path.join(chartPath, f));
    });

    if (this.config.sync.dryRun) {
      args.push('--dry-run');
    }

    args.push('--create-namespace', '--wait');

    console.log(`Executing: helm ${args.join(' ')}`);
    const { stdout, stderr } = await spawnCommand('helm', args, {
      captureOutput: true
    });

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  }

  async helmUpgrade(app, chartPath) {
    const args = ['upgrade', app.name, chartPath, '-n', app.namespace];

    // Add value files as separate arguments
    app.valueFiles.forEach(f => {
      args.push('-f', path.join(chartPath, f));
    });

    if (this.config.sync.dryRun) {
      args.push('--dry-run');
    }

    args.push('--wait');

    console.log(`Executing: helm ${args.join(' ')}`);
    const { stdout, stderr } = await spawnCommand('helm', args, {
      captureOutput: true
    });

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  }

  async rollback(app) {
    try {
      console.log(`Rolling back ${app.name} to previous revision...`);
      await spawnCommand('helm', ['rollback', app.name, '-n', app.namespace, '--wait']);
      console.log(`Successfully rolled back ${app.name}`);
    } catch (error) {
      console.error(`Failed to rollback ${app.name}:`, error.message);
    }
  }

  async healthCheck(app) {
    this.logger.info(`Performing health check for ${app.name}...`);
    const maxRetries = this.config.healthCheck.retries;
    const initialDelay = this.config.healthCheck.initialDelay || 5000; // Default 5s
    const backoffFactor = this.config.healthCheck.backoffFactor || 2; // Default 2x
    const maxDelay = this.config.healthCheck.maxDelay || 60000; // Default 60s

    for (let i = 0; i < maxRetries; i++) {
      try {
        // Use kubectl wait for more efficient checking
        // This waits for the condition instead of polling repeatedly
        const timeout = 30; // 30 seconds timeout for kubectl wait
        await spawnCommand('kubectl', [
          'wait',
          '--for=condition=Available',
          'deployment',
          '-n', app.namespace,
          '-l', `app=${app.name}`,
          `--timeout=${timeout}s`
        ]);

        this.logger.info(`Health check passed for ${app.name}`);
        return;
      } catch (error) {
        this.logger.warn(`Health check attempt ${i + 1}/${maxRetries} failed for ${app.name}`);

        if (i < maxRetries - 1) {
          // Calculate exponential backoff delay
          const delay = Math.min(
            initialDelay * Math.pow(backoffFactor, i),
            maxDelay
          );
          this.logger.info(`Retrying in ${(delay / 1000).toFixed(1)}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Health check failed for ${app.name} after ${maxRetries} attempts`);
  }

  async syncAll() {
    if (this.syncInProgress) {
      this.logger.warn('Sync already in progress, skipping...');
      return null;
    }

    this.syncInProgress = true;
    const summary = new SyncCycleSummary();

    try {
      this.logger.info('Starting sync cycle...');

      // Update repository with timeout
      try {
        await this.updateRepository();
      } catch (error) {
        this.logger.error('Failed to update git repository', error);
        throw new Error(`Git update failed: ${error.message}`);
      }

      // Check for changes
      const hasChanges = await this.checkForChanges();

      if (!hasChanges && this.lastCommit) {
        this.logger.info('No changes detected, skipping sync');
        summary.complete();
        return summary;
      }

      this.logger.info('Changes detected, syncing applications in parallel...', {
        commit: this.lastCommit,
        appCount: this.config.applications.length,
        concurrency: this.config.sync.concurrency || DEFAULT_CONCURRENCY
      });

      // Create sync tasks for parallel execution
      const syncTasks = this.config.applications.map(app => {
        return () => this.syncApplication(app);
      });

      // Execute syncs in parallel with concurrency control
      const concurrency = this.config.sync.concurrency || DEFAULT_CONCURRENCY;
      const results = await runWithConcurrency(syncTasks, concurrency);

      // Process results
      for (const result of results) {
        if (result.status === 'fulfilled') {
          summary.addResult(result.value);
        } else {
          // Handle rejected promises (shouldn't happen as syncApplication catches errors)
          this.logger.error('Unexpected sync failure', result.reason);
          const errorResult = new SyncResult('unknown');
          errorResult.markFailure(result.reason);
          summary.addResult(errorResult);
        }
      }

      summary.complete();

      // Log summary
      this.logger.info(summary.getSummaryString());

      // Log failures in detail
      const failures = summary.results.filter(r => !r.success && r.action !== 'skip');
      if (failures.length > 0) {
        this.logger.error('Failed applications:', null, {
          failures: failures.map(f => ({
            app: f.appName,
            error: f.error.message,
            rolledBack: f.rolledBack
          }))
        });
      }

      return summary;
    } catch (error) {
      this.logger.error('Sync cycle failed', error);
      summary.complete();
      return summary;
    } finally {
      this.syncInProgress = false;
    }
  }

  parseInterval(intervalStr) {
    const match = intervalStr.match(/^(\d+)([smh])$/);
    if (!match) {
      throw new Error(`Invalid interval format: ${intervalStr}`);
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    const multipliers = { s: 1000, m: 60000, h: 3600000 };
    return value * multipliers[unit];
  }

  async start() {
    console.log('Starting GitOps Sync Service...');
    const interval = this.parseInterval(this.config.sync.interval);
    const concurrency = this.config.sync.concurrency || DEFAULT_CONCURRENCY;

    console.log(`Sync interval: ${this.config.sync.interval} (${interval}ms)`);
    console.log(`Parallel concurrency: ${concurrency} applications`);
    console.log(`Auto-rollback: ${this.config.sync.autoRollback ? 'enabled' : 'disabled'}`);
    console.log(`Dry-run mode: ${this.config.sync.dryRun ? 'enabled' : 'disabled'}`);
    console.log(`Git operation timeout: ${GIT_OPERATION_TIMEOUT / 1000}s`);

    // Initial sync
    await this.syncAll();

    // Schedule periodic syncs
    setInterval(async () => {
      await this.syncAll();
    }, interval);

    console.log('GitOps Sync Service is running');
  }
}

// Main entry point
async function main() {
  const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.yaml');

  try {
    const service = new GitOpsSyncService(configPath);
    await service.init();
    await service.start();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Start the service
if (require.main === module) {
  main();
}

module.exports = GitOpsSyncService;
