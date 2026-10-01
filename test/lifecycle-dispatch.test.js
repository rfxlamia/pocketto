'use strict';

// Keep every lifecycle dispatch scenario registered through this explicit entry point.
require('../test-support/lifecycle-dispatch/ordered-events');
require('../test-support/lifecycle-dispatch/revision-gaps');
require('../test-support/lifecycle-dispatch/repair-projection');
require('../test-support/lifecycle-dispatch/repair-fail-closed');
require('../test-support/lifecycle-dispatch/repair-concurrency');
require('../test-support/lifecycle-dispatch/concurrent-claims');
require('../test-support/lifecycle-dispatch/expired-claims');
require('../test-support/lifecycle-dispatch/guard-recovery');
require('../test-support/lifecycle-dispatch/adapter-protocol');
require('../test-support/lifecycle-dispatch/concurrent-mutations');
