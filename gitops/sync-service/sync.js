#!/usr/bin/env node

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const execAsync = promisify(exec);

class GitOpsSyncService {
  constructor(configPath) {
    this.configPath = configPath;
    this.config = null;
    this.repoPath = '/tmp/gitops-repo';
    this.lastCommit = null;
    this.syncInProgress = false;
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
      console.log('Repository already exists, pulling latest changes...');
      await execAsync(`cd ${this.repoPath} && git pull origin ${this.config.git.branch}`);
    } catch {
      console.log('Cloning repository...');
      await execAsync(`git clone ${this.config.git.repository} ${this.repoPath}`);
      await execAsync(`cd ${this.repoPath} && git checkout ${this.config.git.branch}`);
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
    if (!app.enabled || !app.autoSync) {
      console.log(`Skipping ${app.name} (auto-sync disabled)`);
      return;
    }

    console.log(`Syncing application: ${app.name}`);
    const chartPath = path.join(this.repoPath, app.path);

    try {
      // Check if Helm release exists
      const releaseExists = await this.helmReleaseExists(app.name, app.namespace);

      if (releaseExists) {
        console.log(`Upgrading existing release: ${app.name}`);
        await this.helmUpgrade(app, chartPath);
      } else {
        console.log(`Installing new release: ${app.name}`);
        await this.helmInstall(app, chartPath);
      }

      // Perform health check
      if (this.config.healthCheck.enabled) {
        await this.healthCheck(app);
      }

      console.log(`Successfully synced ${app.name}`);
    } catch (error) {
      console.error(`Failed to sync ${app.name}:`, error.message);

      if (this.config.sync.autoRollback && releaseExists) {
        console.log(`Auto-rolling back ${app.name}...`);
        await this.rollback(app);
      }
      throw error;
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
    console.log(`Performing health check for ${app.name}...`);
    const maxRetries = this.config.healthCheck.retries;
    const timeout = 30000; // 30 seconds between retries

    for (let i = 0; i < maxRetries; i++) {
      try {
        const { stdout } = await execAsync(
          `kubectl get deployment -n ${app.namespace} -l app=${app.name} -o jsonpath='{.items[0].status.conditions[?(@.type=="Available")].status}'`
        );

        if (stdout.includes('True')) {
          console.log(`Health check passed for ${app.name}`);
          return;
        }
      } catch (error) {
        console.warn(`Health check attempt ${i + 1}/${maxRetries} failed for ${app.name}`);
      }

      if (i < maxRetries - 1) {
        console.log(`Waiting ${timeout / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, timeout));
      }
    }

    throw new Error(`Health check failed for ${app.name} after ${maxRetries} attempts`);
  }

  async syncAll() {
    if (this.syncInProgress) {
      console.log('Sync already in progress, skipping...');
      return;
    }

    this.syncInProgress = true;

    try {
      // Pull latest changes
      await execAsync(`cd ${this.repoPath} && git pull origin ${this.config.git.branch}`);

      // Check for changes
      const hasChanges = await this.checkForChanges();

      if (!hasChanges && this.lastCommit) {
        console.log('No changes detected, skipping sync');
        return;
      }

      console.log('Starting sync for all applications...');

      // Sync each application
      for (const app of this.config.applications) {
        try {
          await this.syncApplication(app);
        } catch (error) {
          console.error(`Failed to sync ${app.name}:`, error.message);
          // Continue with other applications
        }
      }

      console.log('Sync cycle completed');
    } catch (error) {
      console.error('Sync cycle failed:', error.message);
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

    console.log(`Sync interval: ${this.config.sync.interval} (${interval}ms)`);
    console.log(`Auto-rollback: ${this.config.sync.autoRollback ? 'enabled' : 'disabled'}`);
    console.log(`Dry-run mode: ${this.config.sync.dryRun ? 'enabled' : 'disabled'}`);

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
