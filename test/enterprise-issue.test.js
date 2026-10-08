'use strict';

// T8 integration coverage is split by behavior to keep callbacks focused.
// Cycle 1 creates once; cycle 2 reuses one exact issue; cycle 3 rejects unsafe
// ownership/cardinality and falls back safely; cycle 4 replays persisted proof.
// Every suite uses fake GitHub transport and real temporary metadata.

require('../test-support/enterprise-issue/basic');
require('../test-support/enterprise-issue/reconciliation');
require('../test-support/enterprise-issue/replay');
