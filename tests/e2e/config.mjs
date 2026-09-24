const DEFAULT_E2E_PORT = 8788;
const configuredPort = process.env.BILLSPLIT_E2E_PORT ?? String(DEFAULT_E2E_PORT);

if (!/^\d+$/.test(configuredPort)) {
  throw new Error('BILLSPLIT_E2E_PORT must be a numeric TCP port between 1 and 65535');
}

const port = Number(configuredPort);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('BILLSPLIT_E2E_PORT must be a numeric TCP port between 1 and 65535');
}

export const E2E_PORT = port;
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
