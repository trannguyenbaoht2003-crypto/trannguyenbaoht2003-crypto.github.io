export type PublicFeedbackReasonCode =
  | 'OUTDATED'
  | 'WRONG_BUILD'
  | 'WRONG_ITEMS'
  | 'WRONG_AUGMENTS'
  | 'MISMATCHED_CHAMPION'
  | 'OTHER';

export type FeedbackClientResult =
  | { outcome: 'accepted' }
  | { outcome: 'rate_limited'; retryAfterSeconds?: number }
  | { outcome: 'unavailable' }
  | { outcome: 'invalid' };

export type SubmitPublicFeedbackInput = {
  publicationId: string;
  publicationVersionId: string;
  submissionId: string;
  reasonCode: PublicFeedbackReasonCode;
  details?: string;
  fetchImpl?: typeof fetch;
};

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(86_400, Math.ceil(seconds));
}

export async function submitPublicFeedback(
  input: SubmitPublicFeedbackInput,
): Promise<FeedbackClientResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = {
    schemaVersion: 1,
    submissionId: input.submissionId,
    publicationVersionId: input.publicationVersionId,
    reasonCode: input.reasonCode,
    ...(input.details === undefined ? {} : { details: input.details }),
  };

  try {
    const response = await fetchImpl(
      `/api/v1/publications/${input.publicationId}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hai-Dau-Feedback': 'web-v1',
        },
        body: JSON.stringify(body),
      },
    );

    if (response.status === 202) return { outcome: 'accepted' };
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
      return retryAfterSeconds === undefined
        ? { outcome: 'rate_limited' }
        : { outcome: 'rate_limited', retryAfterSeconds };
    }
    if ([400, 404, 409, 413].includes(response.status)) {
      return { outcome: 'invalid' };
    }
    return { outcome: 'unavailable' };
  } catch {
    return { outcome: 'unavailable' };
  }
}
