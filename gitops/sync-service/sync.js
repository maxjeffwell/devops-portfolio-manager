#!/usr/bin/env node

const { exec } = require('child_process');
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
    console.log(`Loaded configuration for ${this.config.applications.length} applications`);
  }

  async cloneRepository() {
    try {
      await fs.access(this.repoPath);
      console.log('Repository already exists, fetching latest changes...');
      await this.updateRepository();
    } catch {
      console.log('Cloning repository...');
      await execWithTimeout(`git clone ${this.config.git.repository} ${this.repoPath}`);
      await execWithTimeout(`cd ${this.repoPath} && git checkout ${this.config.git.branch}`);
    }
  }

  async updateRepository() {
    const branch = this.config.git.branch;

    try {
      // Fetch latest changes with timeout
      await execWithTimeout(`cd ${this.repoPath} && git fetch origin ${branch}`);

      // Reset to latest remote branch (safer than pull)
      await execWithTimeout(`cd ${this.repoPath} && git reset --hard origin/${branch}`);

      // Clean any untracked files
      await execWithTimeout(`cd ${this.repoPath} && git clean -fd`);

      this.logger.info('Repository updated successfully', { branch });
    } catch (error) {
      this.logger.error('Failed to update repository', error);
      throw error;
    }
  }

  async checkForChanges() {
    const { stdout } = await execAsync(`cd ${this.repoPath} && git rev-parse HEAD`);
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
      await execAsync(`helm status ${name} -n ${namespace}`);
      return true;
    } catch {
      return false;
    }
  }

  async helmInstall(app, chartPath) {
    const valueFiles = app.valueFiles.map(f => `-f ${path.join(chartPath, f)}`).join(' ');
    const dryRun = this.config.sync.dryRun ? '--dry-run' : '';

    const command = `helm install ${app.name} ${chartPath} -n ${app.namespace} ${valueFiles} ${dryRun} --create-namespace --wait`;

    console.log(`Executing: ${command}`);
    const { stdout, stderr } = await execAsync(command);

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  }

  async helmUpgrade(app, chartPath) {
    const valueFiles = app.valueFiles.map(f => `-f ${path.join(chartPath, f)}`).join(' ');
    const dryRun = this.config.sync.dryRun ? '--dry-run' : '';

    const command = `helm upgrade ${app.name} ${chartPath} -n ${app.namespace} ${valueFiles} ${dryRun} --wait`;

    console.log(`Executing: ${command}`);
    const { stdout, stderr } = await execAsync(command);

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  }

  async rollback(app) {
    try {
      console.log(`Rolling back ${app.name} to previous revision...`);
      await execAsync(`helm rollback ${app.name} -n ${app.namespace} --wait`);
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
        await execAsync(
          `kubectl wait --for=condition=Available deployment -n ${app.namespace} -l app=${app.name} --timeout=${timeout}s`
        );

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
