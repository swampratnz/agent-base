// The composition root. It does exactly two things: name the modules, and
// hand them to the base.
//
// `createAgent` plans the composition (refusing an incomplete one with the
// process untouched), runs each module's init, performs every registration in
// a fixed order, probes that the registries took it, and only then hands back
// an agent. `start()` runs the migrations — base fragments first, then this
// module's — and then whatever callback you give it.
//
// Everything else — config parsing, adapter construction, the router spine,
// the job scheduler, shutdown — is the base's job. If you find yourself wiring
// one of those here, that is a signal the seam is missing, not that this file
// should grow. A scaffolded repo has not filled every required registration
// yet, so this will start by TELLING you which ones are missing.
import { createAgent } from '@swampratnz/agent-base';

import { myAgentModule } from './module/index.js';

const agent = await createAgent({ modules: [myAgentModule] });

// Pass a callback to bring your adapters and jobs up:
//   await agent.start(() => startAdaptersAndJobs());
await agent.start();
