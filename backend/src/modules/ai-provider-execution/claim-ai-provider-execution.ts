import type { Pool } from 'pg';

export interface ClaimAiProviderExecutionCommand {
  executionId: string;
  leaseToken: string;
  leaseSeconds: 120;
}

export async function claimAiProviderExecution(
  pool: Pool,
  command: ClaimAiProviderExecutionCommand,
): Promise<boolean> {
  if (command.leaseSeconds !== 120) throw new Error('AI_PROVIDER_EXECUTION_LEASE_INVALID');
  const result = await pool.query(
    `update ai_provider_executions
        set lease_token=$2,
            leased_at=clock_timestamp(),
            lease_expires_at=clock_timestamp()+make_interval(secs=>$3),
            updated_at=clock_timestamp()
      where ai_provider_execution_id=$1
        and status='PREPARED'
        and (lease_token is null or lease_expires_at <= clock_timestamp() or lease_token=$2)
      returning ai_provider_execution_id`,
    [command.executionId,command.leaseToken,command.leaseSeconds],
  );
  return result.rowCount === 1;
}
