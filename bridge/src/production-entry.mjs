// Only this entry point is deployed. Node tests import bridge-wrapper separately.
import bridge from './bridge-wrapper.mjs';
export { ExhaustiveMailSearchWorkflow } from './search-workflow.mjs';
export default bridge;
