// The composition root. It does exactly two things: name the modules, and
// hand them to the base.
//
// ⚠️ `createAgent` DOES NOT EXIST YET. The base runtime lands by extraction
// from swampratnz/community-agent (see the base repo's docs/ROADMAP.md), so
// this import will not resolve until it does. The shape is stable enough to
// write against; the implementation is not there.
//
// Everything else — config parsing, migrations, adapter construction, the
// router spine, the job scheduler, shutdown — is the base's job. If you find
// yourself wiring one of those here, that is a signal the seam is missing, not
// that this file should grow.
import { createAgent } from '@swampratnz/agent-base';

import { myAgentModule } from './module/index.js';

await createAgent({ modules: [myAgentModule] });
