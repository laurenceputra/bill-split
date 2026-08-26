import { describe, expect, it } from 'vitest';
// @ts-expect-error Node types are not shipped to the browser build.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
// @ts-expect-error Node types are not shipped to the browser build.
import { tmpdir } from 'node:os';
// @ts-expect-error Node types are not shipped to the browser build.
import { resolve } from 'node:path';
// @ts-expect-error The Node build script has no browser declaration.
import { decodeWranglerConfig, prepareDeployConfig, validateFrontendBuildEnvironment, validateProductionBuildEnvironment, validateProductionConfig } from './prepare-cloudflare-build.mjs';
// @ts-expect-error The Node deploy script has no browser declaration.
import { assertProductionBuild, deployProduction, runWrangler } from './deploy-cloudflare-build.mjs';

const productionConfig = `name = "bill-split"
account_id = "0123456789abcdef0123456789abcdef"
main = "src/worker/index.ts"
workers_dev = false

[assets]
directory = "dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = true

[[d1_databases]]
binding = "DB"
database_name = "bill-split"
database_id = "01234567-89ab-4cde-8123-456789abcdef"
migrations_dir = "migrations"

[vars]
ENVIRONMENT = "production"
CLERK_AUTHORIZED_PARTIES = "https://split.test"
CLERK_PUBLISHABLE_KEY = "pk_live_abc123"
CLERK_JWT_KEY = "jwt-public-key"

[secrets]
required = ["CLERK_SECRET_KEY", "IDENTITY_TOMBSTONE_KEY"]

[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "0123456789abcdef0123456789abcdef"

[[routes]]
pattern = "split.test"
custom_domain = true
`;

const encodedConfig = Buffer.from(productionConfig).toString('base64');

describe('Cloudflare Workers Builds preparation', () => {
  const productionBuildEnv = {
    WORKERS_CI: '1',
    WORKERS_CI_BRANCH: 'main',
    PRODUCTION_WORKER_NAME: 'bill-split',
    PRODUCTION_ORIGIN: 'https://split.test',
    VITE_CLERK_PUBLISHABLE_KEY: ' pk_live_abc123 ',
  };

  it('strictly decodes non-empty base64 and rejects malformed input', () => {
    expect(decodeWranglerConfig(encodedConfig)).toBe(productionConfig);
    expect(() => decodeWranglerConfig('')).toThrow(/base64/);
    expect(() => decodeWranglerConfig('not-base64!')).toThrow(/base64/);
    expect(() => decodeWranglerConfig(Buffer.from(' ').toString('base64'))).toThrow(/empty config/);
  });

  it('accepts production invariants and rejects development or incomplete configs', () => {
    expect(validateProductionConfig(productionConfig)).toBe(true);
    expect(validateProductionConfig(`# CLERK_SECRET_KEY = "comment-only"\n${productionConfig}`)).toBe(true);
    expect(validateProductionConfig(productionConfig.replace('CLERK_JWT_KEY = "jwt-public-key"', 'CLERK_JWT_KEY = """-----BEGIN PUBLIC KEY-----\npublic-key\n-----END PUBLIC KEY-----"""'))).toBe(true);
    expect(() => validateProductionConfig(productionConfig.replace('production', 'development'))).toThrow(/production/);
    expect(() => validateProductionConfig(productionConfig.replace('binding = "ASSETS"', 'binding = "WRONG"'))).toThrow(/assets/i);
    expect(() => validateProductionConfig(productionConfig.replace('database_id = "01234567-89ab-4cde-8123-456789abcdef"', 'database_id = "00000000-0000-4000-8000-000000000000"'))).toThrow(/D1/);
    expect(() => validateProductionConfig(`${productionConfig}\nCLERK_SECRET_KEY = "runtime-secret"`)).toThrow(/must not embed/i);
    expect(() => validateProductionConfig(`${productionConfig}\nIDENTITY_TOMBSTONE_KEY = "runtime-secret"`)).toThrow(/must not embed/i);
    expect(() => validateProductionConfig(`${productionConfig}\n"CLERK_SECRET_KEY" = "runtime-secret"`)).toThrow(/must not embed/i);
    expect(() => validateProductionConfig(`${productionConfig}\nvars.IDENTITY_TOMBSTONE_KEY = "runtime-secret"`)).toThrow(/must not embed/i);
    expect(() => validateProductionConfig(`${productionConfig}\n"CLERK\\u005fSECRET_KEY" = "runtime-secret"`)).toThrow(/Unicode escape/);
    expect(() => validateProductionConfig(productionConfig.replace('https://split.test', 'http://split.test'))).toThrow(/HTTPS/);
    expect(() => validateProductionConfig(productionConfig.replace('pk_live_abc123', 'pk_test_abc123'))).toThrow(/placeholder|live Clerk/);
    expect(() => validateProductionConfig(productionConfig.replace('CLERK_JWT_KEY = "jwt-public-key"', 'CLERK_JWT_KEY = ""'))).toThrow(/JWT/);
    expect(() => validateProductionConfig(productionConfig.replace('namespace_id = "0123456789abcdef0123456789abcdef"', 'namespace_id = ""'))).toThrow(/RATE_LIMITER/);
    expect(() => validateProductionConfig(productionConfig.replace('custom_domain = true', 'custom_domain = false'))).toThrow(/custom-domain/);
    expect(() => validateProductionConfig(productionConfig, { expectedClerkPublishableKey: 'pk_live_other' })).toThrow(/match/);
    expect(() => validateProductionConfig(productionConfig, { expectedWorkerName: 'different-worker' })).toThrow(/PRODUCTION_WORKER_NAME/);
    expect(() => validateProductionConfig(productionConfig, { expectedOrigin: 'https://other.test' })).toThrow(/PRODUCTION_ORIGIN/);
  });

  it('writes a validated config with restrictive permissions without printing it', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'bill-split-cf-builds-'));
    const outputPath = resolve(root, 'wrangler.deploy.toml');
    const rootConfigPath = resolve(root, 'wrangler.toml');
    try {
      await prepareDeployConfig({ env: { ...productionBuildEnv, WRANGLER_DEPLOY_TOML_BASE64: encodedConfig }, outputPath, rootConfigPath });
      expect(await readFile(outputPath, 'utf8')).toBe(productionConfig);
      expect(await readFile(rootConfigPath, 'utf8')).toBe(productionConfig);
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      expect((await stat(rootConfigPath)).mode & 0o777).toBe(0o600);
      expect(() => validateFrontendBuildEnvironment({})).toThrow(/VITE_CLERK/);
      expect(() => validateFrontendBuildEnvironment({ VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_abc123' })).toThrow(/live/);
      expect(() => validateProductionBuildEnvironment({ ...productionBuildEnv, PRODUCTION_WORKER_NAME: 'bill-split dev' })).toThrow(/safe/);
      expect(() => validateProductionBuildEnvironment({ ...productionBuildEnv, PRODUCTION_ORIGIN: 'https://split.test/path' })).toThrow(/origin/);
      await expect(prepareDeployConfig({ env: { ...productionBuildEnv, WRANGLER_DEPLOY_TOML_BASE64: encodedConfig, VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_other' }, outputPath })).rejects.toThrow(/match/);
      await expect(prepareDeployConfig({ env: { ...productionBuildEnv, WORKERS_CI_BRANCH: 'preview', WRANGLER_DEPLOY_TOML_BASE64: encodedConfig } })).rejects.toThrow(/main branch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Cloudflare Workers Builds deployment guards and ordering', () => {
  const buildEnv = {
    WORKERS_CI: '1',
    WORKERS_CI_BRANCH: 'main',
    PRODUCTION_WORKER_NAME: 'bill-split',
    PRODUCTION_ORIGIN: 'https://split.test',
    VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_abc123',
  };

  it('requires the Workers Builds main production branch', () => {
    expect(() => assertProductionBuild({})).toThrow(/Workers Builds/);
    expect(() => assertProductionBuild({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'feature/test' })).toThrow(/main/);
    expect(() => assertProductionBuild(buildEnv)).not.toThrow();
  });

  it('does not pass build secrets to the Wrangler child process', () => {
    let invocation: { args: string[]; env: Record<string, string> } | undefined;
    runWrangler(['deploy', '--config=wrangler.deploy.toml'], {
      env: { ...buildEnv, WRANGLER_DEPLOY_TOML_BASE64: 'config-secret', WRANGLER_CI_OVERRIDE_NAME: 'bill-split' },
      execute: (_command: string, args: string[], options: { env: Record<string, string>; stdio: string }) => {
        invocation = { args, env: options.env };
        expect(options.stdio).toBe('inherit');
      },
    });
    expect(invocation?.args).not.toContain('config-secret');
    expect(invocation?.env.WRANGLER_DEPLOY_TOML_BASE64).toBeUndefined();
    expect(invocation?.env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(invocation?.env.WRANGLER_CI_OVERRIDE_NAME).toBeUndefined();
    expect(() => runWrangler(['deploy'], { env: { ...buildEnv, WRANGLER_CI_OVERRIDE_NAME: 'wrong-worker' }, execute: () => {} })).toThrow(/match/);
  });

  it('prepares, dry-runs, migrates, and deploys in order without rebuilding', async () => {
    const calls: string[] = [];
    await deployProduction({
      env: buildEnv,
      cwd: '/tmp/bill-split-build-test',
      prepare: async () => { calls.push('prepare'); },
      run: async (args: string[]) => { calls.push(args.join(' ')); },
    });
    expect(calls).toEqual([
      'prepare',
      'deploy --config=wrangler.deploy.toml --keep-vars --dry-run',
      'd1 migrations apply DB --remote --config=wrangler.deploy.toml',
      'deploy --config=wrangler.deploy.toml --keep-vars',
    ]);
  });

  it('stops before deployment when migration fails', async () => {
    const calls: string[] = [];
    await expect(deployProduction({
      env: buildEnv,
      prepare: async () => { calls.push('prepare'); },
      run: async (args: string[]) => {
        calls.push(args.join(' '));
        if (args[0] === 'd1') throw new Error('fake migration failure');
      },
    })).rejects.toThrow('fake migration failure');
    expect(calls).toEqual([
      'prepare',
      'deploy --config=wrangler.deploy.toml --keep-vars --dry-run',
      'd1 migrations apply DB --remote --config=wrangler.deploy.toml',
    ]);
  });
});
