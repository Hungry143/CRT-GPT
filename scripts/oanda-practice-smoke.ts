import { runOandaPracticeSmokeTest } from '@/server/marketData/oandaPracticeSmoke';

async function main(): Promise<void> {
  const requireCreds = process.argv.includes('--require-creds');
  const report = await runOandaPracticeSmokeTest({
    env: process.env,
    sampleLimit: 5,
  });

  console.log(JSON.stringify(report, null, 2));

  if (report.status === 'PASSED') {
    process.exit(0);
  }
  if (report.status === 'SKIPPED' && !requireCreds) {
    process.exit(0);
  }
  process.exit(1);
}

void main();
