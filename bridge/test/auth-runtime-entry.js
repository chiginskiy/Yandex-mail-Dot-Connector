import { createAuthenticatedBridge } from '../src/bridge-wrapper.mjs';
import { createWorker } from '../src/worker.js';
import { TEST_GRANT } from './fake-client.js';
import { featureClient } from './feature-client.js';
export default createAuthenticatedBridge({
  coreFactory:options=>createWorker({...options,createClient:()=>featureClient()}),
  validateToken:async(owner,token)=>owner===TEST_GRANT.owner && token===TEST_GRANT.accessToken,

});
