'use strict';

// This compatibility entrypoint intentionally registers every T12 cycle in source order.
require('./lifecycle-public-flow.scenario');
require('./lifecycle-gap.scenario');
require('./lifecycle-stale-revision.scenario');
require('./lifecycle-concurrency.scenario');
require('./lifecycle-expired-claim.scenario');
require('./lifecycle-proof-replay.scenario');
require('./lifecycle-stale-artifact.scenario');
require('./lifecycle-artifact-retry.scenario');
require('./lifecycle-enterprise-read-retry.scenario');
require('./lifecycle-evidence-classification.scenario');
require('./lifecycle-error-taxonomy.scenario');
