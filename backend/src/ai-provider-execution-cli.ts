import { randomUUID } from 'node:crypto';

import { createPool } from './database/pool.js';
import { readAiProviderExecutionStatus } from './modules/ai-provider-execution/read-ai-provider-execution-status.js';
import { reconcileAiProviderExecution } from './modules/ai-provider-execution/reconcile-ai-provider-execution.js';
import { recoverStaleAiProviderExecutions } from './modules/ai-provider-execution/recover-stale-ai-provider-executions.js';
import type { AiProviderReconciliationDecision } from './modules/ai-provider-execution/types.js';

function value(args:string[],name:string):string|undefined {
  const index=args.indexOf(name);
  return index>=0?args[index+1]:undefined;
}
function required(args:string[],name:string):string {
  const found=value(args,name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
function databaseUrl():string {
  const url=process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return url;
}
function decision(value:string):AiProviderReconciliationDecision {
  if (value==='CONFIRMED_NOT_RECEIVED'||value==='CONFIRMED_RECEIVED'||value==='ABANDONED') return value;
  throw new Error('Invalid reconciliation decision');
}

export async function runAiProviderExecutionCli(args:string[]):Promise<unknown> {
  const action=args[0];
  const pool=createPool(databaseUrl());
  try {
    if (action==='status') {
      return await readAiProviderExecutionStatus(pool,{
        executionId:value(args,'--execution-id'),
        runId:value(args,'--run-id'),
      });
    }
    if (action==='recover') {
      const raw=value(args,'--limit');
      return await recoverStaleAiProviderExecutions(pool,raw?{limit:Number(raw)}:{});
    }
    if (action==='reconcile') {
      return await reconcileAiProviderExecution(pool,{
        actorId:process.env.AI_OPERATOR_ACTOR_ID??'private-ai-operator',
        correlationId:randomUUID(),
        attemptId:required(args,'--attempt'),
        decision:decision(required(args,'--decision')),
        reasonCode:required(args,'--reason-code'),
        evidenceReference:required(args,'--evidence-reference'),
      });
    }
    throw new Error('Usage: ai-provider-execution status|recover|reconcile');
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('ai-provider-execution-cli.js')) {
  runAiProviderExecutionCli(process.argv.slice(2))
    .then((result)=>process.stdout.write(`${JSON.stringify(result,null,2)}\n`))
    .catch((error)=>{
      const message=error instanceof Error?error.message:'AI provider execution command failed';
      process.stderr.write(`${message}\n`);
      process.exitCode=1;
    });
}
