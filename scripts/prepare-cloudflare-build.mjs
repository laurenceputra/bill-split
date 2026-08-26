import { chmod, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEPLOY_CONFIG_FILENAME = 'wrangler.deploy.toml';
export const DEPLOY_CONFIG_PATH = resolve(ROOT, DEPLOY_CONFIG_FILENAME);
export const ROOT_CONFIG_PATH = resolve(ROOT, 'wrangler.toml');

export function assertWorkersBuildMainBranch(env = process.env) {
  if (env.WORKERS_CI !== '1') {
    throw new Error('Production preparation is only permitted from Cloudflare Workers Builds.');
  }
  if (env.WORKERS_CI_BRANCH !== 'main') {
    throw new Error('Production preparation is only permitted from the main branch.');
  }
}

function sectionContents(source, sectionName) {
  const section = new RegExp(`^\\s*\\[\\[?${sectionName.replace('.', '\\.') }\\]\\]?\\s*$`, 'mi').exec(source);
  if (!section) return '';
  const rest = source.slice(section.index + section[0].length);
  return rest.split(/^\s*\[\[?.*\]\]?\s*$/m, 1)[0];
}

function assignment(source, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escapedKey}\\s*=\\s*`, 'mi').exec(source);
  if (!match) return '';
  const remainder = source.slice(match.index + match[0].length);
  const quote = remainder.match(/^("""|'''|"|')/)?.[1];
  if (quote?.length === 3) {
    const closingQuote = remainder.indexOf(quote, quote.length);
    return closingQuote < 0 ? remainder.trim() : remainder.slice(0, closingQuote + quote.length).trim();
  }
  return remainder.split(/\r?\n/, 1)[0].replace(/\s+#.*$/, '').trim();
}

function quotedValue(source, key) {
  const value = assignment(source, key);
  return value.match(/^(['"]{1,3})(.*?)\1\s*$/s)?.[2]?.trim() ?? '';
}

function isPlaceholderValue(value) {
  return /replace[-_]?with|placeholder|your[-_]|localhost|127\.0\.0\.1|(?:^|\.)example(?:\.|$)|\.invalid|bill-split-(?:local|dev|test|development|staging|preview)/i.test(value);
}

function safeWorkerName(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value) || isPlaceholderValue(value)) {
    throw new Error(`${label} must be a safe, non-placeholder Worker name.`);
  }
  return value;
}

function httpsOrigin(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be an HTTPS origin.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS origin.`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || isPlaceholderValue(parsed.hostname)) {
    throw new Error(`${label} must be an HTTPS origin.`);
  }
  return parsed;
}

function requireNonPlaceholderValue(source, key, label = key) {
  const value = requireNonEmptyValue(source, key, label);
  if (isPlaceholderValue(value) || /^0+$/.test(value)) throw new Error(`Production config must set a real ${label}.`);
  return value;
}

function quotedArrayValues(value) {
  return [...value.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]);
}

function hasPlaintextSecretAssignment(source) {
  const secret = `(?:CLERK_SECRET_KEY|IDENTITY_TOMBSTONE_KEY)`;
  const key = `(?:(?:[A-Za-z0-9_-]+|"[^"]+"|'[^']+')\.)*(?:${secret}|"${secret}"|'${secret}')`;
  const assignmentPattern = new RegExp(`^\\s*${key}\\s*=`, 'i');
  const inlineAssignmentPattern = new RegExp(`[,{]\\s*${key}\\s*=`, 'i');
  return source.split(/\r?\n/).some((line) => {
    const uncommented = line.replace(/(^|\s)#.*$/, '$1');
    return assignmentPattern.test(uncommented) || inlineAssignmentPattern.test(uncommented);
  });
}

function requireSectionValue(source, sectionName, key, expected) {
  const section = sectionContents(source, sectionName);
  if (!section || quotedValue(section, key) !== expected) {
    throw new Error(`Production config must set ${sectionName}.${key} to ${expected}.`);
  }
}

function requireNonEmptyValue(source, key, label = key) {
  const value = quotedValue(source, key);
  if (!value) throw new Error(`Production config must set ${label}.`);
  return value;
}

export function decodeWranglerConfig(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('WRANGLER_DEPLOY_TOML_BASE64 is missing or is not valid base64.');
  }

  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new Error('WRANGLER_DEPLOY_TOML_BASE64 is not valid base64.');
  }

  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('WRANGLER_DEPLOY_TOML_BASE64 does not contain valid UTF-8 TOML.');
  }
  if (!decoded.trim()) throw new Error('WRANGLER_DEPLOY_TOML_BASE64 decodes to an empty config.');
  return decoded;
}

export function validateProductionConfig(source, { expectedClerkPublishableKey } = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The production Wrangler config is empty.');

  // Ignore comments while checking for development/example values. This keeps
  // useful comments from making a real config fail while still rejecting the
  // values shipped in wrangler.deploy.toml.example.
  const withoutComments = source.replace(/^\s*#.*$/gm, '');
  if (/replace[-_]with|your[-_]bill[-_]split|placeholder|localhost|127\.0\.0\.1|bill-split-(?:local|dev|test|development|staging|preview)|pk_test|sk_test/i.test(withoutComments)) {
    throw new Error('The production Wrangler config contains a development or placeholder value.');
  }
  // Without a TOML parser, reject escaped Unicode keys rather than allowing a
  // secret name to be disguised as a different spelling of the key.
  if (/\\u[0-9a-f]{4}|\\U[0-9a-f]{8}/i.test(source)) {
    throw new Error('Production config must not contain Unicode escape sequences.');
  }
  if (hasPlaintextSecretAssignment(source)) {
    throw new Error('Production config must not embed runtime secret values; declare them only in [secrets].required.');
  }

  const workerName = safeWorkerName(quotedValue(source, 'name'), 'Production config name');
  requireNonPlaceholderValue(source, 'account_id', 'account_id');
  if (quotedValue(source, 'main') !== 'src/worker/index.ts') {
    throw new Error('Production config must point main at src/worker/index.ts.');
  }
  requireSectionValue(source, 'vars', 'ENVIRONMENT', 'production');

  if (assignment(source, 'workers_dev') !== 'false') {
    throw new Error('Production config must set workers_dev = false.');
  }

  const assets = sectionContents(source, 'assets');
  if (!assets || quotedValue(assets, 'directory') !== 'dist' || quotedValue(assets, 'binding') !== 'ASSETS' || quotedValue(assets, 'not_found_handling') !== 'single-page-application' || assignment(assets, 'run_worker_first') !== 'true') {
    throw new Error('Production config must define the dist directory with the ASSETS binding.');
  }

  const database = sectionContents(source, 'd1_databases');
  if (!database || quotedValue(database, 'binding') !== 'DB' || quotedValue(database, 'migrations_dir') !== 'migrations') {
    throw new Error('Production config must define the DB D1 binding and migrations directory.');
  }
  const databaseId = quotedValue(database, 'database_id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId) || /^0{8}-0{4}-/i.test(databaseId)) {
    throw new Error('Production config must contain a real D1 database ID.');
  }
  requireNonPlaceholderValue(database, 'database_name', 'D1 database_name');

  const vars = sectionContents(source, 'vars');
  const authorizedParties = requireNonPlaceholderValue(vars, 'CLERK_AUTHORIZED_PARTIES', 'CLERK_AUTHORIZED_PARTIES');
  const authorizedUrl = httpsOrigin(authorizedParties, 'CLERK_AUTHORIZED_PARTIES');

  const clerkPublishableKey = requireNonPlaceholderValue(vars, 'CLERK_PUBLISHABLE_KEY', 'CLERK_PUBLISHABLE_KEY');
  if (!/^pk_live_[A-Za-z0-9_-]+$/.test(clerkPublishableKey)) {
    throw new Error('Production config must contain a live Clerk publishable key.');
  }
  if (expectedClerkPublishableKey !== undefined && clerkPublishableKey !== expectedClerkPublishableKey.trim()) {
    throw new Error('VITE_CLERK_PUBLISHABLE_KEY must exactly match CLERK_PUBLISHABLE_KEY.');
  }
  const clerkJwtKey = requireNonPlaceholderValue(vars, 'CLERK_JWT_KEY', 'CLERK_JWT_KEY');
  if (!clerkJwtKey) throw new Error('Production config must set CLERK_JWT_KEY.');

  const secrets = sectionContents(source, 'secrets');
  const requiredSecrets = quotedArrayValues(assignment(secrets, 'required'));
  if (!requiredSecrets.includes('CLERK_SECRET_KEY') || !requiredSecrets.includes('IDENTITY_TOMBSTONE_KEY')) {
    throw new Error('Production config [secrets].required must declare the required runtime secrets.');
  }

  const rateLimits = sectionContents(source, 'ratelimits');
  if (quotedValue(rateLimits, 'name') !== 'RATE_LIMITER' || !requireNonPlaceholderValue(rateLimits, 'namespace_id', 'RATE_LIMITER namespace_id')) {
    throw new Error('Production config must define the RATE_LIMITER ratelimit binding.');
  }

  const routes = sectionContents(source, 'routes');
  if (requireNonPlaceholderValue(routes, 'pattern', 'production route') !== authorizedUrl.hostname || assignment(routes, 'custom_domain') !== 'true') {
    throw new Error('Production config must define a production custom-domain route.');
  }
  return true;
}

export function validateFrontendBuildEnvironment(env = process.env) {
  if (typeof env.VITE_CLERK_PUBLISHABLE_KEY !== 'string' || !env.VITE_CLERK_PUBLISHABLE_KEY.trim()) {
    throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required for the production frontend build.');
  }
  const key = env.VITE_CLERK_PUBLISHABLE_KEY.trim();
  if (!/^pk_live_[A-Za-z0-9_-]+$/.test(key)) throw new Error('VITE_CLERK_PUBLISHABLE_KEY must be a live Clerk publishable key.');
  return true;
}

async function writeSecureConfig(outputPath, source) {
  const temporaryPath = `${outputPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(source, 'utf8');
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
    await chmod(outputPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function prepareDeployConfig({ env = process.env, outputPath = DEPLOY_CONFIG_PATH, rootConfigPath } = {}) {
  const resolvedOutputPath = resolve(outputPath);
  const workersBuildPreparation = rootConfigPath !== undefined || resolvedOutputPath === DEPLOY_CONFIG_PATH;
  if (workersBuildPreparation) assertWorkersBuildMainBranch(env);
  validateFrontendBuildEnvironment(env);
  const frontendPublishableKey = env.VITE_CLERK_PUBLISHABLE_KEY.trim();
  const config = decodeWranglerConfig(env.WRANGLER_DEPLOY_TOML_BASE64);
  validateProductionConfig(config, { expectedClerkPublishableKey: frontendPublishableKey });
  const workerName = quotedValue(config, 'name');
  if (env.WRANGLER_CI_OVERRIDE_NAME !== undefined && env.WRANGLER_CI_OVERRIDE_NAME !== workerName) {
    throw new Error('WRANGLER_CI_OVERRIDE_NAME must match the Worker name in the production config.');
  }
  await writeSecureConfig(resolvedOutputPath, config);
  if (workersBuildPreparation) {
    const resolvedRootConfigPath = resolve(rootConfigPath ?? ROOT_CONFIG_PATH);
    if (resolvedRootConfigPath !== resolvedOutputPath) await writeSecureConfig(resolvedRootConfigPath, config);
  }
  return resolvedOutputPath;
}

export const decodeBase64Config = decodeWranglerConfig;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  await prepareDeployConfig();
}
