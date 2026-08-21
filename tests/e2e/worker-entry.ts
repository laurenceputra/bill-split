// Wrangler's dev runtime expects the entry module to export only a Worker
// handler. Keep the production module's named test exports out of this local
// entrypoint without changing application behavior.
import worker from '../../src/worker/index';

export default worker;
