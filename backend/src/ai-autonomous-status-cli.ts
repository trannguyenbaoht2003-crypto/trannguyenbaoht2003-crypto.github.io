import { pathToFileURL } from 'node:url';
import { createPool } from './database/pool.js';
import { readAutonomousReviewStatus } from './modules/ai-review/read-autonomous-review-status.js';
export async function runAutonomousStatusCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const flag = env.AI_AUTONOMOUS_PUBLICATION_ENABLED;
    if ((flag !== undefined && flag !== 'true' && flag !== 'false') || !env.DATABASE_URL?.trim())
        throw new Error('AI_AUTONOMOUS_STATUS_CONFIG_INVALID');
    const pool = createPool(env.DATABASE_URL);
    try {
        process.stdout.write(`${JSON.stringify(await readAutonomousReviewStatus(pool, { enabled: flag === 'true' }))}\n`);
    }
    finally {
        await pool.end();
    }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void runAutonomousStatusCli().catch(() => { process.stderr.write('AI_AUTONOMOUS_STATUS_FAILED\n'); process.exitCode = 1; });
}
