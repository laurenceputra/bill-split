import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from 'vite';
import { DEPLOY_CONFIG_PATH, validateFrontendBuildEnvironment, validateProductionConfig } from './prepare-cloudflare-build.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function validateLocalDeployConfig({ env = process.env, configPath = DEPLOY_CONFIG_PATH } = {}) {
  const config = await readFile(resolve(configPath), 'utf8');
  const buildEnv = { ...loadEnv('production', ROOT, 'VITE_'), ...env };
  validateFrontendBuildEnvironment(buildEnv);
  validateProductionConfig(config, { expectedClerkPublishableKey: buildEnv.VITE_CLERK_PUBLISHABLE_KEY.trim() });
  return true;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    await validateLocalDeployConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Local production config validation failed.'}\n`);
    process.exitCode = 1;
  }
}
