import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertWorkersBuildMainBranch, DEPLOY_CONFIG_FILENAME, prepareDeployConfig } from './prepare-cloudflare-build.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const assertProductionBuild = assertWorkersBuildMainBranch;

function sanitizedEnvironment(env) {
  const childEnv = { ...env };
  delete childEnv.WRANGLER_DEPLOY_TOML_BASE64;
  delete childEnv.VITE_CLERK_PUBLISHABLE_KEY;
  // Do not let Workers Builds override the production Worker name from the
  // validated config. The connected Worker's name is checked against that
  // config by Wrangler before the migration step.
  delete childEnv.WRANGLER_CI_OVERRIDE_NAME;
  return childEnv;
}

export function runWrangler(args, { cwd = ROOT, env = process.env, execute = execFileSync } = {}) {
  try {
    // npx --no-install resolves only the Wrangler version installed by this
    // checkout and never downloads or activates an unpinned global CLI.
    execute('npx', ['--no-install', 'wrangler', ...args], {
      cwd,
      env: sanitizedEnvironment(env),
      stdio: 'inherit',
    });
  } catch {
    throw new Error(`Wrangler command failed: ${args[0]} ${args[1] ?? ''}`.trim());
  }
}

export async function deployProduction({ env = process.env, cwd = ROOT, prepare = prepareDeployConfig, run = runWrangler } = {}) {
  assertProductionBuild(env);
  const configPath = resolve(cwd, DEPLOY_CONFIG_FILENAME);
  await prepare({ env, outputPath: configPath, rootConfigPath: resolve(cwd, 'wrangler.toml') });

  // A dry run validates the generated Worker and bindings before the first
  // mutating operation. This wrapper intentionally does not run a frontend
  // build: cf:build owns that step and deploy reuses its dist/ output.
  await run(['deploy', `--config=${DEPLOY_CONFIG_FILENAME}`, '--keep-vars', '--dry-run'], { cwd, env });
  await run(['d1', 'migrations', 'apply', 'DB', '--remote', `--config=${DEPLOY_CONFIG_FILENAME}`], { cwd, env });
  await run(['deploy', `--config=${DEPLOY_CONFIG_FILENAME}`, '--keep-vars'], { cwd, env });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    await deployProduction();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Production deployment failed.'}\n`);
    process.exitCode = 1;
  }
}
