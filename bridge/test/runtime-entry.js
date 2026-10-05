import { createWorker } from '../src/worker.js';
import { TEST_GRANT } from './fake-client.js';
import { featureClient } from './feature-client.js';
export default createWorker({getAccessToken:async()=>TEST_GRANT,createClient:()=>featureClient()});
