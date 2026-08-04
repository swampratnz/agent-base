// `npm run migrate` — apply the base schema fragments, then this module's.
//
// Imported from the runner's own path rather than the package barrel on
// purpose: the barrel pulls in `createAgent` and the whole registry surface,
// which drags the base's full config schema into the import graph, and this
// command is meant to run on DATABASE_URL alone (the base validates only its
// db + log slices on this path). Keep it that way — a migrate step that
// demands the app's whole env is a migrate step that cannot run before the
// app is configured.
import { migrate } from '@swampratnz/agent-base/storage/migrate.js';

import { myAgentModule } from './module/index.js';

await migrate(myAgentModule.migrations ?? []);
