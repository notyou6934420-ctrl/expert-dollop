#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);

// Configuration
const ROOTFS_DIR = process.cwd();
const MAX_RETRIES = 50;
const TIMEOUT = 1;
const SSH_PORT = 2222;

// Marker files
const INSTALLED_MARKER = path.join(ROOTFS_DIR, '.installed');          // host-side
const SSHD_INSTALLED_MARKER = path.join(ROOTFS_DIR, 'root', '.sshd_installed'); // inside rootfs

const hostArch = os.arch();
let PROOT_ARCH, UBUNTU_ARCH;
if (hostArch === 'x64') {
    PROOT_ARCH = 'x86_64';
    UBUNTU_ARCH = 'amd64';
} else if (hostArch === 'arm64') {
    PROOT_ARCH = 'aarch64';
    UBUNTU_ARCH = 'arm64';
} else {
    console.error(`Unsupported architecture: ${hostArch}`);
    process.exit(1);
}

const UBUNTU_BASE_URL = `http://cdimage.ubuntu.com/ubuntu-base/releases/20.04/release/ubuntu-base-20.04.4-base-${UBUNTU_ARCH}.tar.gz`;
const PROOT_BINARY_URL = `https://raw.githubusercontent.com/foxytouxxx/freeroot/main/proot-${PROOT_ARCH}`;
const PROOT_DEST = path.join(ROOTFS_DIR, 'usr', 'local', 'bin', 'proot');
const RESOLV_CONF = path.join(ROOTFS_DIR, 'etc', 'resolv.conf');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadFile(url, destPath, retries = MAX_RETRIES) {
    const protocol = url.startsWith('https') ? https : http;
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Downloading ${url} -> ${destPath}`);
            const response = await new Promise((resolve, reject) => {
                const req = protocol.get(url, (res) => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    resolve(res);
                });
                req.setTimeout(TIMEOUT * 1000);
                req.on('error', reject);
            });
            await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
            const fileStream = fs.createWriteStream(destPath);
            await streamPipeline(response, fileStream);
            console.log(`Download complete: ${destPath}`);
            return;
        } catch (err) {
            console.log(`Attempt ${i + 1} failed: ${err.message}`);
            if (i < retries - 1) await sleep(1000);
            else throw new Error(`Failed to download ${url} after ${retries} attempts`);
        }
    }
}

async function extractTarGz(tarballPath, destDir) {
    console.log(`Extracting ${tarballPath} into ${destDir}`);
    return new Promise((resolve, reject) => {
        const tar = spawn('tar', ['-xzf', tarballPath, '-C', destDir]);
        tar.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`tar exited with code ${code}`));
        });
        tar.on('error', reject);
    });
}

(async () => {
    try {
        // 1. Install base Ubuntu + PROOT (host side)
        const isInstalled = fs.existsSync(INSTALLED_MARKER);
        if (!isInstalled) {
            console.log('Setting up Ubuntu rootfs...');
            const tarballPath = '/tmp/ubuntu-rootfs.tar.gz';
            await downloadFile(UBUNTU_BASE_URL, tarballPath);
            await extractTarGz(tarballPath, ROOTFS_DIR);
            fs.unlinkSync(tarballPath);
            await downloadFile(PROOT_BINARY_URL, PROOT_DEST);
            fs.chmodSync(PROOT_DEST, 0o755);
            await fs.promises.writeFile(RESOLV_CONF, 'nameserver 1.1.1.1\nnameserver 1.0.0.1\n');
            await fs.promises.writeFile(INSTALLED_MARKER, '');
            console.log('Base rootfs ready.');
        } else {
            console.log('Rootfs already installed. Skipping setup.');
        }

        // 2. Install SSH server inside PROOT (check marker inside rootfs)
        const sshdInstalled = fs.existsSync(SSHD_INSTALLED_MARKER);
        if (!sshdInstalled) {
            console.log('Installing openssh-server inside PROOT...');
            const setupCmd = `
                set -e
                apt-get update -qq
                apt-get install -y -qq openssh-server
                mkdir -p /var/run/sshd
                echo 'root:root' | chpasswd
                sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config
                sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config
                sed -i 's/#Port 22/Port ${SSH_PORT}/' /etc/ssh/sshd_config
                ssh-keygen -A
                touch /root/.sshd_installed
            `;
            const prootBinary = PROOT_DEST;
            const args = [
                `--rootfs=${ROOTFS_DIR}`,
                '-0',
                '-w', '/root',
                '-b', '/dev',
                '-b', '/sys',
                '-b', '/proc',
                '-b', '/etc/resolv.conf',
                '--kill-on-exit',
                '/bin/bash', '-c', setupCmd
            ];
            await new Promise((resolve, reject) => {
                const proc = spawn(prootBinary, args, { stdio: 'inherit' });
                proc.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`PROOT setup command failed with code ${code}`));
                });
                proc.on('error', reject);
            });
            console.log('SSH server installed and configured.');
        } else {
            console.log('SSH server already installed. Skipping configuration.');
        }

        // 3. Start SSH daemon
        console.log(`Starting SSH server on port ${SSH_PORT}...`);
        const startCmd = '/usr/sbin/sshd -D -e';
        const prootBinary = PROOT_DEST;
        const args = [
            `--rootfs=${ROOTFS_DIR}`,
            '-0',
            '-w', '/root',
            '-b', '/dev',
            '-b', '/sys',
            '-b', '/proc',
            '-b', '/etc/resolv.conf',
            '--kill-on-exit',
            '/bin/bash', '-c', startCmd
        ];
        const sshdProcess = spawn(prootBinary, args, { stdio: 'inherit' });
        await sleep(3000);
        console.log(`
╔══════════════════════════════════════════════════════════════╗
║  SSH server is running inside PROOT                          ║
║  Connect using:                                              ║
║                                                              ║
║      ssh root@localhost -p ${SSH_PORT}                          ║
║      password: root                                          ║
║                                                              ║
║  To stop the server, press Ctrl+C                            ║
╚══════════════════════════════════════════════════════════════╝
        `);

        const shutdown = () => {
            console.log('\nShutting down SSH server...');
            sshdProcess.kill('SIGTERM');
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        await new Promise((resolve) => sshdProcess.on('close', resolve));
    } catch (err) {
        console.error('Fatal error:', err);
        process.exit(1);
    }
})();
