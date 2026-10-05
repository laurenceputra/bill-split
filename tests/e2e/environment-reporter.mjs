import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Playwright does not otherwise fail a completed run when webServer dies mid-run.
export default class EnvironmentReporter {
  onTestBegin() {
    this.ranTests = true;
  }
  onEnd() {
    // --list invokes reporters without starting the server or cleaning output.
    if (!this.ranTests) return;
    const marker = path.join(process.cwd(), 'test-results/e2e-environment-failure.json');
    if (!existsSync(marker)) return;
    console.error(`[E2E environment failure] ${readFileSync(marker, 'utf8')}`);
    return { status: 'failed' };
  }
}
