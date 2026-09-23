import {
  inspectEphemeralResourceCleanup,
  sweepExpiredEphemeralResources,
} from '../apps/server/src/services/ephemeralResourceCleanup';
import { getServerDB } from '../packages/database/src/core/db-adaptor';

const argumentsList = process.argv.slice(2);
const allowed = /^(?:--apply|--batch-size=\d+|--retention-days=\d+|--max-batches=\d+)$/;
if (argumentsList.some((argument) => !allowed.test(argument))) {
  throw new Error('Expected --apply, --batch-size=1..500, --max-batches=1..100, or --retention-days=positive-integer');
}
const numberOption = (name: string, fallback: number) => {
  const matches = argumentsList.filter((argument) => argument.startsWith(`${name}=`));
  if (matches.length > 1) throw new Error(`Duplicate argument: ${name}`);
  return matches.length ? Number(matches[0]!.split('=')[1]) : fallback;
};

const run = async () => {
  const options = {
    batchSize: numberOption('--batch-size', 100),
    retentionMilliseconds: numberOption('--retention-days', 7) * 24 * 60 * 60 * 1000,
  };
  const database = await getServerDB();
  const maxBatches = numberOption('--max-batches', 10);
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) {
    throw new RangeError('Maximum batches must be an integer between 1 and 100');
  }
  let after;
  let failed = false;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = argumentsList.includes('--apply')
      ? await sweepExpiredEphemeralResources(database, { ...options, after })
      : await inspectEphemeralResourceCleanup(database, { ...options, after });
    console.log(JSON.stringify(result));
    failed ||= 'failed' in result && result.failed > 0;
    after = result.nextCursor;
    if (!after) break;
  }
  process.exit(failed ? 1 : 0);
};

run().catch(() => {
  console.error('Ephemeral resource cleanup failed; inspect database and storage availability.');
  process.exit(1);
});
