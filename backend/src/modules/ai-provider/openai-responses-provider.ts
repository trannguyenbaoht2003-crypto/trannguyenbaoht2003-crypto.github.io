import type { AiProviderRequest } from './build-provider-request.js';

const DEFAULT_OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_RATIONALE_LENGTH = 2_000;
const MAX_PROPOSALS = 64;
const MAX_SELECTION_IDS = 128;
const MAX_OUTPUT_TEXT_BYTES = 256 * 1024;
const PRINTABLE_IDENTIFIER_PATTERN = /^[!-~]+$/u;

export interface AiProviderProposal {
  subjectExternalId: string;
  augmentExternalIds: string[];
  itemExternalIds: string[];
  rationale: string | null;
}

export interface AiProviderResult {
  providerRequestId: string | null;
  providerResponseId: string | null;
  outputText: string;
  proposals: AiProviderProposal[];
}

export interface AiProviderExecuteOptions {
  clientRequestId: string;
}

export interface AiDiscoveryProvider {
  readonly providerKey: string;
  execute(request: AiProviderRequest, options?: AiProviderExecuteOptions): Promise<AiProviderResult>;
}

export class AiProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly failureCode: string,
    public readonly providerRequestId: string | null = null,
  ) {
    super(code);
    this.name = 'AiProviderError';
  }
}

export interface OpenAiResponsesProviderConfig {
  apiKey: string;
  model: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key,index)=>key===required[index]);
}
function failOutput(providerRequestId:string|null=null):never {
  throw new AiProviderError('AI_PROVIDER_OUTPUT_INVALID',false,'PROVIDER_RESPONSE_INVALID',providerRequestId);
}
function failAllowlist(providerRequestId:string|null=null):never {
  throw new AiProviderError('AI_PROVIDER_ALLOWLIST_VIOLATION',false,'PROVIDER_RESPONSE_INVALID',providerRequestId);
}
function failConfig():never {
  throw new AiProviderError('AI_PROVIDER_CONFIG_INVALID',false,'PROVIDER_REQUEST_REJECTED');
}
function requireIdentifier(value:unknown):string {
  if (typeof value !== 'string' || value.length===0 || value.length>MAX_IDENTIFIER_LENGTH || value!==value.trim() || !PRINTABLE_IDENTIFIER_PATTERN.test(value)) return failOutput();
  return value;
}
function compareAscii(left:string,right:string):number { return left<right?-1:left>right?1:0; }
function requireSelectionIds(value:unknown):string[] {
  if (!Array.isArray(value) || value.length>MAX_SELECTION_IDS) return failOutput();
  const ids=value.map(requireIdentifier);
  if (new Set(ids).size!==ids.length) return failOutput();
  return ids.sort(compareAscii);
}
function requireRationale(value:unknown):string|null {
  if (value===null) return null;
  if (typeof value!=='string' || value.length>MAX_RATIONALE_LENGTH) return failOutput();
  return value;
}
function validateStructuredOutput(value:unknown,request:AiProviderRequest,providerRequestId:string|null):AiProviderProposal[] {
  if (!isRecord(value) || !hasExactKeys(value,['proposals'])) return failOutput(providerRequestId);
  if (!Array.isArray(value.proposals) || value.proposals.length>MAX_PROPOSALS) return failOutput(providerRequestId);
  const structurallyValid=value.proposals.map((proposal):AiProviderProposal=>{
    if (!isRecord(proposal) || !hasExactKeys(proposal,['augmentExternalIds','itemExternalIds','rationale','subjectExternalId'])) return failOutput(providerRequestId);
    return {
      subjectExternalId:requireIdentifier(proposal.subjectExternalId),
      augmentExternalIds:requireSelectionIds(proposal.augmentExternalIds),
      itemExternalIds:requireSelectionIds(proposal.itemExternalIds),
      rationale:requireRationale(proposal.rationale),
    };
  });
  const subjects=new Map(request.input.subjects.map((subject)=>[subject.subjectExternalId,subject] as const));
  for (const proposal of structurallyValid) {
    const subject=subjects.get(proposal.subjectExternalId);
    if (!subject) return failAllowlist(providerRequestId);
    const augmentAllowlist=new Set(subject.allowedAugmentExternalIds);
    const itemAllowlist=new Set(subject.allowedItemExternalIds);
    if (proposal.augmentExternalIds.some((id)=>!augmentAllowlist.has(id)) || proposal.itemExternalIds.some((id)=>!itemAllowlist.has(id))) return failAllowlist(providerRequestId);
  }
  return structurallyValid;
}
function safeHeader(value:string|null):string|null {
  if (value===null || value.length===0 || value.length>256 || !/^[\x20-\x7e]+$/u.test(value)) return null;
  return value;
}
function safeHttpError(status:number,providerRequestId:string|null):AiProviderError {
  if (status===401 || status===403) return new AiProviderError('PROVIDER_AUTH_REJECTED',false,'PROVIDER_AUTH_REJECTED',providerRequestId);
  if (status===408) return new AiProviderError('PROVIDER_TIMEOUT',true,'PROVIDER_TIMEOUT',providerRequestId);
  if (status===429) return new AiProviderError('PROVIDER_RATE_LIMITED',true,'PROVIDER_RATE_LIMITED',providerRequestId);
  if (status>=500 && status<=599) return new AiProviderError('PROVIDER_UNAVAILABLE',true,'PROVIDER_UNAVAILABLE',providerRequestId);
  return new AiProviderError('PROVIDER_REQUEST_REJECTED',false,'PROVIDER_REQUEST_REJECTED',providerRequestId);
}
function extractOutputText(value:unknown,providerRequestId:string|null):{providerResponseId:string|null;outputText:string} {
  if (!isRecord(value) || value.status!=='completed' || !Array.isArray(value.output)) return failOutput(providerRequestId);
  const texts:string[]=[];
  for (const item of value.output) {
    if (!isRecord(item) || item.type!=='message' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || content.type!=='output_text' || typeof content.text!=='string') continue;
      texts.push(content.text);
    }
  }
  if (texts.length!==1) return failOutput(providerRequestId);
  const outputText=texts[0]!;
  if (Buffer.byteLength(outputText,'utf8')>MAX_OUTPUT_TEXT_BYTES) return failOutput(providerRequestId);
  const providerResponseId=typeof value.id==='string' && value.id.length>0 && value.id.length<=256 ? value.id : null;
  return {providerResponseId,outputText};
}
function validateConfig(config:OpenAiResponsesProviderConfig):Required<Pick<OpenAiResponsesProviderConfig,'apiKey'|'model'|'endpoint'|'timeoutMs'|'fetchImpl'>> {
  if (typeof config.apiKey!=='string' || config.apiKey.length===0 || typeof config.model!=='string' || config.model.length===0 || config.model.length>MAX_IDENTIFIER_LENGTH || config.model!==config.model.trim()) return failConfig();
  const endpoint=config.endpoint??DEFAULT_OPENAI_RESPONSES_ENDPOINT;
  try { new URL(endpoint); } catch { return failConfig(); }
  const timeoutMs=config.timeoutMs??DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<MIN_TIMEOUT_MS || timeoutMs>MAX_TIMEOUT_MS) return failConfig();
  return {apiKey:config.apiKey,model:config.model,endpoint,timeoutMs,fetchImpl:config.fetchImpl??fetch};
}
function validateClientRequestId(value:string):string {
  if (value.length===0 || value.length>512 || !/^[\x20-\x7e]+$/u.test(value)) throw new AiProviderError('AI_PROVIDER_CLIENT_REQUEST_ID_INVALID',false,'PROVIDER_REQUEST_REJECTED');
  return value;
}

export function createOpenAiResponsesProvider(config:OpenAiResponsesProviderConfig):AiDiscoveryProvider {
  const validated=validateConfig(config);
  return {
    providerKey:'openai',
    async execute(request:AiProviderRequest,options?:AiProviderExecuteOptions):Promise<AiProviderResult> {
      let response:Response;
      const clientRequestId=options?.clientRequestId === undefined ? null : validateClientRequestId(options.clientRequestId);
      try {
        const headers:Record<string,string>={Authorization:`Bearer ${validated.apiKey}`,'Content-Type':'application/json'};
        if (clientRequestId!==null) headers['X-Client-Request-Id']=clientRequestId;
        response=await validated.fetchImpl(validated.endpoint,{
          method:'POST',headers,
          body:JSON.stringify({model:validated.model,input:request.messages,store:false,text:{format:{type:'json_schema',name:'aram_mayhem_discovery',strict:true,schema:request.responseSchema}}}),
          signal:AbortSignal.timeout(validated.timeoutMs),
        });
      } catch (error) {
        if (error instanceof AiProviderError) throw error;
        if (error instanceof Error && (error.name==='AbortError' || error.name==='TimeoutError')) throw new AiProviderError('PROVIDER_TIMEOUT',true,'PROVIDER_TIMEOUT');
        throw new AiProviderError('PROVIDER_TRANSPORT_ERROR',true,'PROVIDER_TRANSPORT_ERROR');
      }
      const providerRequestId=safeHeader(response.headers.get('x-request-id'));
      if (!response.ok) throw safeHttpError(response.status,providerRequestId);
      let transportBody:unknown;
      try { transportBody=await response.json(); } catch { return failOutput(providerRequestId); }
      const {providerResponseId,outputText}=extractOutputText(transportBody,providerRequestId);
      let structured:unknown;
      try { structured=JSON.parse(outputText); } catch { return failOutput(providerRequestId); }
      const proposals=validateStructuredOutput(structured,request,providerRequestId);
      return {providerRequestId,providerResponseId,outputText,proposals};
    },
  };
}
