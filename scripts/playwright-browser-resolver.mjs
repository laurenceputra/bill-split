import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

export const DEFAULT_PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';
export const PLAYWRIGHT_EXECUTABLE_ENV = 'BILLSPLIT_PLAYWRIGHT_EXECUTABLE_PATH';
export const PLAYWRIGHT_VALIDATED_EXECUTABLE_ENV = 'BILLSPLIT_PLAYWRIGHT_VALIDATED_EXECUTABLE_PATH';
export const PLAYWRIGHT_VALIDATED_MARKER_ENV = 'BILLSPLIT_PLAYWRIGHT_VALIDATED_OVERRIDE';
export const PLAYWRIGHT_VALIDATED_MARKER = '1';

const LINUX_LAYOUTS = {
  x64: {
    headless: [
      ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
      ['chrome-headless-shell-linux-x64', 'chrome-headless-shell'],
      ['chrome-linux', 'headless_shell'],
    ],
    full: [
      ['chrome-linux64', 'chrome'],
      ['chrome-linux-x64', 'chrome'],
      ['chrome-linux', 'chrome'],
    ],
  },
  arm64: {
    headless: [
      ['chrome-headless-shell-linux-arm64', 'chrome-headless-shell'],
      ['chrome-linux', 'headless_shell'],
    ],
    full: [
      ['chrome-linux-arm64', 'chrome'],
      ['chrome-linux', 'chrome'],
    ],
  },
};

function cacheEntry(entry) {
  const match = /^(chromium_headless_shell|chromium)-(\d+)$/.exec(entry);
  if (!match) return undefined;
  return {
    name: entry,
    kind: match[1] === 'chromium_headless_shell' ? 'headless' : 'full',
    revision: match[2],
    revisionNumber: BigInt(match[2]),
  };
}

function compareRevisionDescending(left, right) {
  if (left.revisionNumber === right.revisionNumber) return 0;
  return left.revisionNumber > right.revisionNumber ? -1 : 1;
}

export function assertAutomaticDiscoveryAllowed({ ci = '', explicitPath } = {}) {
  const ciValue = ci == null ? '' : String(ci);
  if (ciValue !== '' && !/^(?:0|false)$/i.test(ciValue) && explicitPath === undefined) {
    throw new Error(
      'Refusing automatic browser discovery when CI is set to a truthy value. Set ' +
        `${PLAYWRIGHT_EXECUTABLE_ENV} to an existing executable path if an explicit opt-in is intended.`,
    );
  }
}

function getValidatedPlaywrightLaunchOptions(env = {}) {
  const executablePath = env[PLAYWRIGHT_VALIDATED_EXECUTABLE_ENV];
  if (env[PLAYWRIGHT_VALIDATED_MARKER_ENV] !== PLAYWRIGHT_VALIDATED_MARKER || !executablePath) return {};
  return { launchOptions: { executablePath } };
}

export function requireValidatedPlaywrightLaunchOptions(env = {}) {
  const options = getValidatedPlaywrightLaunchOptions(env);
  if (!options.launchOptions?.executablePath) {
    throw new Error('The local Playwright config requires the test:e2e:local wrapper\'s validated browser handoff.');
  }
  return options;
}

export function listChromiumCandidates({ cacheRoot, entries, platform = 'linux', arch = 'x64' }) {
  if (platform !== 'linux') return [];
  const layouts = LINUX_LAYOUTS[arch];
  if (!layouts) return [];

  const parsedEntries = entries.map(cacheEntry).filter(Boolean);
  const candidates = [];
  // Headless shell is preferred as a class, even when a full browser has a
  // newer revision. Within each class, the highest numeric revision wins.
  for (const kind of ['headless', 'full']) {
    for (const entry of parsedEntries.filter((item) => item.kind === kind).sort(compareRevisionDescending)) {
      for (const [directory, executable] of layouts[kind]) {
        candidates.push({
          kind,
          revision: entry.revision,
          path: join(cacheRoot, entry.name, directory, executable),
        });
      }
    }
  }
  return candidates;
}

/**
 * Resolve a browser path using only supplied cache metadata and available paths.
 * This is deliberately filesystem-free so selection and revision ordering can
 * be tested without touching the host Playwright cache.
 */
export function resolveChromiumExecutable({
  cacheRoot,
  entries,
  platform = 'linux',
  arch = 'x64',
  availablePaths = [],
}) {
  const available = new Set(availablePaths);
  return listChromiumCandidates({ cacheRoot, entries, platform, arch }).find((candidate) => available.has(candidate.path));
}

async function isRegularExecutableFile(filePath, fileSystem = fs) {
  try {
    const file = await fileSystem.stat(filePath);
    if (!file.isFile() || (file.mode & 0o111) === 0) return false;
    await fileSystem.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function validatePlaywrightExecutablePath(executablePath, { fileSystem = fs } = {}) {
  const selectedPath = isAbsolute(executablePath) ? executablePath : resolvePath(executablePath);
  if (!(await isRegularExecutableFile(selectedPath, fileSystem))) {
    throw new Error(
      `${PLAYWRIGHT_EXECUTABLE_ENV} must point to a regular executable file that is accessible: ${selectedPath}`,
    );
  }
  return selectedPath;
}

export async function discoverChromiumExecutable({
  cacheRoot = DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
  platform = process.platform,
  arch = process.arch,
  fileSystem = fs,
} = {}) {
  let entries;
  try {
    entries = (await fileSystem.readdir(cacheRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    throw new Error(
      `Could not read PLAYWRIGHT_BROWSERS_PATH=${JSON.stringify(cacheRoot)}. ` +
        'Set it to an existing Playwright browser cache; this command does not install browsers.',
    );
  }

  const candidates = listChromiumCandidates({
    cacheRoot,
    entries,
    platform,
    arch,
  });
  // Probe the pure resolver's ordered list.
  // Keeping the probe separate means an unusable newest revision can safely
  // fall through to an older usable revision.
  for (const candidate of candidates) {
    if (await isRegularExecutableFile(candidate.path, fileSystem)) return candidate;
  }

  const platformDescription = `${platform}/${arch}`;
  throw new Error(
    `No usable Chromium executable was found in PLAYWRIGHT_BROWSERS_PATH=${JSON.stringify(cacheRoot)} ` +
      `for ${platformDescription}. Expected a numeric chromium_headless_shell-* or chromium-* ` +
      'cache directory with an accessible regular executable; this command does not rename, symlink, or install browsers.',
  );
}

export function formatSelectedBrowser({ path, revision, kind }) {
  return `[test:e2e:local] Selected ${kind === 'headless' ? 'Chromium headless shell' : 'Chromium'} revision ${revision}: ${path}`;
}

export function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

function installSignalForwarding(child, processObject) {
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = signals.map((signal) => {
    const handler = () => {
      try { child.kill(signal); } catch { /* The child may have exited between signal delivery and forwarding. */ }
    };
    processObject.on(signal, handler);
    return [signal, handler];
  });
  return () => handlers.forEach(([signal, handler]) => processObject.removeListener(signal, handler));
}

export function runPlaywrightProcess({ spawnProcess, processObject = process, command, args = [], options = {} }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, options);
    } catch (error) {
      reject(error);
      return;
    }

    const removeSignalForwarding = installSignalForwarding(child, processObject);
    const cleanup = () => removeSignalForwarding();
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); resolve({ code, signal }); });
  });
}
