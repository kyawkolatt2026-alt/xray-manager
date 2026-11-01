
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const XRAY_BIN = process.env.XRAY_BIN || '/usr/local/bin/xray';
const XRAY_CONFIG = process.env.XRAY_CONFIG || '/usr/local/etc/xray/config.json';
const XRAY_SERVICE = process.env.XRAY_SERVICE || 'xray';

function getConfig() {
  if (!fs.existsSync(XRAY_CONFIG)) {
    throw new Error('Xray configuration file not found');
  }

  return JSON.parse(fs.readFileSync(XRAY_CONFIG, 'utf8'));
}

async function getVersion() {
  if (!fs.existsSync(XRAY_BIN)) {
    return {
      installed: false,
      version: null,
      message: 'Xray binary not found'
    };
  }

  try {
    const { stdout } = await execFileAsync(XRAY_BIN, ['version'], {
      timeout: 5000
    });

    return {
      installed: true,
      version: stdout.trim().split('\n')[0],
      message: 'Xray binary detected'
    };
  } catch (error) {
    return {
      installed: true,
      version: null,
      message: error.message
    };
  }
}

async function getServiceStatus() {
  try {
    const { stdout } = await execFileAsync(
      'systemctl',
      ['is-active', XRAY_SERVICE],
      { timeout: 5000 }
    );

    return {
      active: stdout.trim() === 'active',
      status: stdout.trim()
    };
  } catch (error) {
    return {
      active: false,
      status: error.stdout ? error.stdout.trim() : 'unknown'
    };
  }
}

async function checkConfig() {
  if (!fs.existsSync(XRAY_CONFIG)) {
    return {
      valid: false,
      message: 'Xray config file not found'
    };
  }

  try {
    getConfig();

    if (!fs.existsSync(XRAY_BIN)) {
      return {
        valid: false,
        message: 'Xray binary not found'
      };
    }

    await execFileAsync(
      XRAY_BIN,
      ['run', '-test', '-config', XRAY_CONFIG],
      { timeout: 10000 }
    );

    return {
      valid: true,
      message: 'Xray configuration is valid'
    };
  } catch (error) {
    return {
      valid: false,
      message: error.message
    };
  }
}

async function getStatus() {
  const [version, service, config] = await Promise.all([
    getVersion(),
    getServiceStatus(),
    checkConfig()
  ]);

  return {
    version,
    service,
    config,
    ready: version.installed && service.active && config.valid
  };
}

function readConfig() {
  return getConfig();
}

module.exports = {
  getVersion,
  getServiceStatus,
  checkConfig,
  getStatus,
  readConfig
};
