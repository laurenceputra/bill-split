import { describe, expect, it } from 'vitest';
// @ts-expect-error Node types are not shipped to the browser build.
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
// @ts-expect-error Node types are not shipped to the browser build.
import { tmpdir } from 'node:os';
// @ts-expect-error Node types are not shipped to the browser build.
import { resolve } from 'node:path';
// @ts-expect-error The Node build script has no browser declaration.
import { decodeWranglerConfig, prepareDeployConfig, validateFrontendBuildEnvironment, validateProductionConfig } from './prepare-cloudflare-build.mjs';
// @ts-expect-error The Node deploy script has no browser declaration.
import { assertProductionBuild, deployProduction, runWrangler } from './deploy-cloudflare-build.mjs';
// @ts-expect-error The local deploy validation script has no browser declaration.
import { validateLocalDeployConfig } from './validate-cloudflare-deploy.mjs';

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

[[queues.producers]]
binding = "NOTIFICATION_QUEUE"
queue = "bill-split-notifications"

[[queues.consumers]]
queue = "bill-split-notifications"
max_batch_size = 1
max_batch_timeout = 5
max_retries = 4
retry_delay = 30
dead_letter_queue = "bill-split-notifications-dead-letter"

[vars]
ENVIRONMENT = "production"
CLERK_AUTHORIZED_PARTIES = "https://split.test"
VAPID_PUBLIC_KEY = "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"
VAPID_CONTACT = "mailto:admin@split.test"

[secrets]
required = ["CLERK_SECRET_KEY", "IDENTITY_TOMBSTONE_KEY", "VAPID_PRIVATE_KEY", "PUSH_SUBSCRIPTION_ENCRYPTION_KEY"]

[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "0123456789abcdef0123456789abcdef"

[[routes]]
pattern = "split.test"
custom_domain = true
`;

const clerkJwtPublicKey = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyCB7w92OYReZZwedlkp6
I/4tPPP0QmeD/PxDeTf1xxMamW/7o0CwhhTPdEELLeNthHHNfg/7BoudcRX1GJGI
F7WvJgUKpAamWYKBEnll8IPVBPQn2gI2Y8e39ND0Z7L9qhdDH5+GG21auKb+E5nh
rk9kUaSVnvcVOju172my0a9wiO+iD2yqKuk7usGYxVl1+02XPv9XGrS6X/36I/cp
L4j7YUdY8y7rUPle8G9Vn6KK56NJmhUNqOFay0hdCCbPqYtW01NlgpcMkcw2tM04
LnuhV6BD6/i4uu0qlly8URx8IPDX9zAV9xiUZiGlPR/NU+bSz24kb9onLCCJgVhp
DQIDAQAB
-----END PUBLIC KEY-----`;

const configuredProductionConfig = productionConfig.replace(
  'CLERK_AUTHORIZED_PARTIES = "https://split.test"',
  `CLERK_AUTHORIZED_PARTIES = "https://split.test"\nCLERK_PUBLISHABLE_KEY = "pk_live_abc123"\nCLERK_JWT_KEY = """${clerkJwtPublicKey}"""`,
);
const encodedConfig = Buffer.from(productionConfig).toString('base64');
const encodedConfiguredConfig = Buffer.from(configuredProductionConfig).toString('base64');

describe('Cloudflare Workers Builds preparation', () => {
  const productionBuildEnv = {
    WORKERS_CI: '1',
    WORKERS_CI_BRANCH: 'main',
    VITE_CLERK_PUBLISHABLE_KEY: ' pk_live_abc123 ',
  };

  it('accepts dashboard-managed Clerk runtime variables omitted from TOML', () => {
    expect(productionConfig).not.toMatch(/^CLERK_(?:PUBLISHABLE_KEY|JWT_KEY)\s*=/m);
    expect(validateProductionConfig(productionConfig, { expectedClerkPublishableKey: 'pk_live_abc123' })).toBe(true);
  });

  it('validates optional Clerk runtime values with bare and quoted TOML keys', () => {
    for (const publishableKey of ['CLERK_PUBLISHABLE_KEY', '"CLERK_PUBLISHABLE_KEY"', "'CLERK_PUBLISHABLE_KEY'"]) {
      for (const jwtKey of ['CLERK_JWT_KEY', '"CLERK_JWT_KEY"', "'CLERK_JWT_KEY'"]) {
        const config = productionConfig.replace(
          'CLERK_AUTHORIZED_PARTIES = "https://split.test"',
          `CLERK_AUTHORIZED_PARTIES = "https://split.test"\n${publishableKey} = "pk_live_abc123"\n${jwtKey} = """${clerkJwtPublicKey}"""`,
        );
        expect(validateProductionConfig(config, { expectedClerkPublishableKey: 'pk_live_abc123' })).toBe(true);
      }
    }

    const quotedConfig = productionConfig.replace(
      'CLERK_AUTHORIZED_PARTIES = "https://split.test"',
      `CLERK_AUTHORIZED_PARTIES = "https://split.test"\n"CLERK_PUBLISHABLE_KEY" = "pk_live_abc123"\n'CLERK_JWT_KEY' = """${clerkJwtPublicKey}"""`,
    );
    expect(() => validateProductionConfig(quotedConfig.replace('pk_live_abc123', 'pk_live_other'), { expectedClerkPublishableKey: 'pk_live_abc123' })).toThrow(/match/);
    expect(() => validateProductionConfig(quotedConfig.replace(clerkJwtPublicKey, 'jwt-public-key'))).toThrow(/PEM/);
    expect(() => validateProductionConfig(quotedConfig.replace(clerkJwtPublicKey, '-----BEGIN PUBLIC KEY-----\nQUFBQQ==\n-----END PUBLIC KEY-----'))).toThrow(/PEM/);
  });

  it('does not let lowercase Clerk decoys shadow exact uppercase values', () => {
    const publishableCollision = productionConfig.replace(
      'CLERK_AUTHORIZED_PARTIES = "https://split.test"',
      'CLERK_AUTHORIZED_PARTIES = "https://split.test"\nclerk_publishable_key = "pk_live_abc123"\nCLERK_PUBLISHABLE_KEY = "pk_live_other"',
    );
    expect(() => validateProductionConfig(publishableCollision, { expectedClerkPublishableKey: 'pk_live_abc123' })).toThrow(/match/);

    const jwtCollision = productionConfig.replace(
      'CLERK_AUTHORIZED_PARTIES = "https://split.test"',
      `CLERK_AUTHORIZED_PARTIES = "https://split.test"\nclerk_jwt_key = """${clerkJwtPublicKey}"""\nCLERK_JWT_KEY = "not-a-pem"`,
    );
    expect(() => validateProductionConfig(jwtCollision)).toThrow(/PEM/);
  });

  it('rejects Clerk runtime table and array-of-table bindings', () => {
    for (const key of ['CLERK_PUBLISHABLE_KEY', 'CLERK_JWT_KEY', '"CLERK_PUBLISHABLE_KEY"', '"CLERK_JWT_KEY"', "'CLERK_PUBLISHABLE_KEY'", "'CLERK_JWT_KEY'"]) {
      const dottedConfig = productionConfig.replace('[secrets]', `${key} . value = "not-a-string-binding"\n\n[secrets]`);
      expect(() => validateProductionConfig(dottedConfig)).toThrow(new RegExp(`${key.replace(/["']/g, '')}.*table binding`));
      for (const parent of ['vars', '"vars"', "'vars'"]) {
        for (const [opening, closing] of [['[', ']'], ['[[', ']]']]) {
          const header = `${opening} ${parent} . ${key} ${closing} # unsupported table binding`;
          const config = productionConfig.replace('[secrets]', `${header}\nvalue = "not-a-string-binding"\n\n[secrets]`);
          expect(() => validateProductionConfig(config)).toThrow(new RegExp(`${key.replace(/["']/g, '')}.*table binding`));
        }
      }
    }
  });

  it('rejects protected secret dotted and table bindings without rejecting required declarations', () => {
    expect(validateProductionConfig(productionConfig)).toBe(true);
    for (const key of ['CLERK_SECRET_KEY', 'IDENTITY_TOMBSTONE_KEY', '"CLERK_SECRET_KEY"', '"IDENTITY_TOMBSTONE_KEY"', "'CLERK_SECRET_KEY'", "'IDENTITY_TOMBSTONE_KEY'"]) {
      const dottedConfig = productionConfig.replace('[secrets]', `${key} . value = "runtime-secret"\n\n[secrets]`);
      expect(() => validateProductionConfig(dottedConfig)).toThrow(/must not embed/);

      const tableConfig = productionConfig.replace('[secrets]', `[ vars . ${key} ] # unsupported table binding\nvalue = "runtime-secret"\n\n[secrets]`);
      expect(() => validateProductionConfig(tableConfig)).toThrow(/must not embed/);
    }
  });

  it('strictly decodes non-empty base64 and rejects malformed input', () => {
    expect(decodeWranglerConfig(encodedConfig)).toBe(productionConfig);
    expect(() => decodeWranglerConfig('')).toThrow(/base64/);
    expect(() => decodeWranglerConfig('not-base64!')).toThrow(/base64/);
    expect(() => decodeWranglerConfig(Buffer.from(' ').toString('base64'))).toThrow(/empty config/);
  });

  it('accepts production invariants and rejects development or incomplete configs', () => {
    expect(validateProductionConfig(productionConfig)).toBe(true);
    expect(validateProductionConfig(configuredProductionConfig)).toBe(true);
    expect(validateProductionConfig(`# CLERK_SECRET_KEY = "comment-only"\n${productionConfig}`)).toBe(true);
    expect(validateProductionConfig(configuredProductionConfig.replace(clerkJwtPublicKey, `${clerkJwtPublicKey}\n`))).toBe(true);
    expect(() => validateProductionConfig(productionConfig.replace('production', 'development'))).toThrow(/production/);
    expect(() => validateProductionConfig(productionConfig.replace('binding = "ASSETS"', 'binding = "WRONG"'))).toThrow(/assets/i);
    expect(() => validateProductionConfig(productionConfig.replace('database_id = "01234567-89ab-4cde-8123-456789abcdef"', 'database_id = "00000000-0000-4000-8000-000000000000"'))).toThrow(/D1/);
    expect(() => validateProductionConfig(`${productionConfig}\nCLERK_SECRET_KEY = "runtime-secret"`)).toThrow(/must not embed/i);
    expect(() => validateProductionConfig(`${productionConfig}\nIDENTITY_TOMBSTONE_KEY = "runtime-secret"`)).toThrow(/must not embed/i);
    expect(() => validateProductionConfig(`${productionConfig}\n"CLERK_SECRET_KEY" = "runtime-secret"`)).toThrow(/must not embed/i);
    expect(() => validateProductionConfig(`${productionConfig}\nvars.IDENTITY_TOMBSTONE_KEY = "runtime-secret"`)).toThrow(/must not embed/i);
    expect(() => validateProductionConfig(`${productionConfig}\n"CLERK\\u005fSECRET_KEY" = "runtime-secret"`)).toThrow(/Unicode escape/);
    expect(() => validateProductionConfig(productionConfig.replace('https://split.test', 'http://split.test'))).toThrow(/HTTPS/);
    expect(() => validateProductionConfig(configuredProductionConfig.replace('pk_live_abc123', 'pk_test_abc123'))).toThrow(/placeholder|live Clerk/);
    expect(() => validateProductionConfig(configuredProductionConfig.replace(clerkJwtPublicKey, ''))).toThrow(/JWT/);
    expect(() => validateProductionConfig(configuredProductionConfig.replace(clerkJwtPublicKey, 'jwt-public-key'))).toThrow(/PEM/);
    expect(() => validateProductionConfig(productionConfig.replace('namespace_id = "0123456789abcdef0123456789abcdef"', 'namespace_id = ""'))).toThrow(/RATE_LIMITER/);
    expect(() => validateProductionConfig(productionConfig.replace('custom_domain = true', 'custom_domain = false'))).toThrow(/custom-domain/);
    expect(() => validateProductionConfig(configuredProductionConfig, { expectedClerkPublishableKey: 'pk_live_other' })).toThrow(/match/);
    expect(() => validateProductionConfig(productionConfig.replace('pattern = "split.test"', 'pattern = "other.test"'))).toThrow(/custom-domain/);
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
      await expect(prepareDeployConfig({ env: { ...productionBuildEnv, WRANGLER_DEPLOY_TOML_BASE64: encodedConfiguredConfig, VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_other' }, outputPath })).rejects.toThrow(/match/);
      await expect(prepareDeployConfig({ env: { ...productionBuildEnv, WORKERS_CI_BRANCH: 'preview', WRANGLER_DEPLOY_TOML_BASE64: encodedConfig } })).rejects.toThrow(/main branch/);
      await expect(prepareDeployConfig({ env: { ...productionBuildEnv, WRANGLER_DEPLOY_TOML_BASE64: encodedConfig, WRANGLER_CI_OVERRIDE_NAME: 'wrong-worker' }, outputPath })).rejects.toThrow(/Worker name/);
      const remoteCommands: string[] = [];
      await expect(deployProduction({
        env: { ...productionBuildEnv, WRANGLER_DEPLOY_TOML_BASE64: encodedConfig, WRANGLER_CI_OVERRIDE_NAME: 'wrong-worker' },
        run: async (args: string[]) => { remoteCommands.push(args.join(' ')); },
      })).rejects.toThrow(/Worker name/);
      expect(remoteCommands).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates the local deploy config against the frontend build key', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'bill-split-cf-local-'));
    const configPath = resolve(root, 'wrangler.deploy.toml');
    try {
      await writeFile(configPath, productionConfig, 'utf8');
      await expect(validateLocalDeployConfig({ configPath, env: { VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_abc123' } })).resolves.toBe(true);
      await writeFile(configPath, configuredProductionConfig, 'utf8');
      await expect(validateLocalDeployConfig({ configPath, env: { VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_other' } })).rejects.toThrow(/match/);
      await expect(validateLocalDeployConfig({ configPath, env: { VITE_CLERK_PUBLISHABLE_KEY: '' } })).rejects.toThrow(/VITE_CLERK/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    });
  });

  it('requires the notification Queue wiring and push secret declarations', () => {
    expect(validateProductionConfig(productionConfig)).toBe(true);
    for (const key of ['VAPID_PRIVATE_KEY', 'PUSH_SUBSCRIPTION_ENCRYPTION_KEY']) {
      expect(() => validateProductionConfig(`${productionConfig}\n${key} = "runtime-secret"`)).toThrow(/must not embed/i);
      expect(() => validateProductionConfig(`${productionConfig}\n"${key}" = "runtime-secret"`)).toThrow(/must not embed/i);
      expect(() => validateProductionConfig(productionConfig.replace(`, "${key}"`, ''))).toThrow(/required/);
    }
    expect(() => validateProductionConfig(productionConfig.replace('queue = "bill-split-notifications"', 'queue = "other-notifications"'))).toThrow(/Queue/);
    expect(() => validateProductionConfig(productionConfig.replace('VAPID_CONTACT = "mailto:admin@split.test"', 'VAPID_CONTACT = "not-a-contact"'))).toThrow(/VAPID_CONTACT/);
    expect(() => validateProductionConfig(productionConfig.replace(/VAPID_PUBLIC_KEY = "[^"]+"/, 'VAPID_PUBLIC_KEY = "bad"'))).toThrow(/VAPID_PUBLIC_KEY/);
    expect(() => validateProductionConfig(productionConfig.replace(/VAPID_PUBLIC_KEY = "[^"]+"/, 'VAPID_PUBLIC_KEY = "' + 'B' + 'A'.repeat(86) + '"'))).toThrow(/P-256/);
     expect(() => validateProductionConfig(productionConfig.replace('dead_letter_queue = "bill-split-notifications-dead-letter"', 'dead_letter_queue = "bill-split-notifications"'))).toThrow(/distinct/);
     expect(() => validateProductionConfig(productionConfig.replace('max_batch_size = 1', 'max_batch_size = 2'))).toThrow(/max_batch_size = 1/);
     expect(() => validateProductionConfig(productionConfig.replace('max_retries = 4', 'max_retries = 5'))).toThrow(/4 Queue retries/);
   });

  it('keeps checked-in local and example Queue consumers at the safe batch bound', async () => {
    for (const [path, count] of [['../wrangler.toml', 2], ['../wrangler.deploy.toml.example', 1]] as const) {
      const config = await readFile(new URL(path, import.meta.url), 'utf8');
      expect(config.match(/max_batch_size\s*=\s*1/g)?.length).toBe(count);
      expect(config).not.toMatch(/max_batch_size\s*=\s*(?:[2-9]|\d{2,})/);
    }
  });

 describe('Cloudflare Workers Builds deployment guards and ordering', () => {
  const buildEnv = {
    WORKERS_CI: '1',
    WORKERS_CI_BRANCH: 'main',
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
  });

  it('prepares, keeps runtime vars for dry-run and final deploy, migrates, and deploys in order without rebuilding', async () => {
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
