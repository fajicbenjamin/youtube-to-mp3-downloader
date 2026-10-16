const { spawn } = require('node:child_process');
const path = require('node:path');

const children = new Set();
let stopping = false;

function spawnTool(command, args, options = {}) {
    if (stopping) throw Object.assign(new Error('App is closing.'), { code: 'DOWNLOAD_CANCELLED' });
    const child = spawn(command, args, {
        ...options,
        shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    children.add(child);
    child.once('close', () => children.delete(child));
    return child;
}

function stopChild(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('exit', (code) => { if (code) child.kill(); });
        killer.unref();
    } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
    }
}

function stopTools() {
    stopping = true;
    for (const child of children) stopChild(child);
}

function isToolRunningIn(directory) {
    const prefix = path.resolve(directory) + path.sep;
    return [...children].some((child) => path.resolve(child.spawnfile).startsWith(prefix));
}

module.exports = { spawnTool, stopChild, stopTools, isToolRunningIn };
