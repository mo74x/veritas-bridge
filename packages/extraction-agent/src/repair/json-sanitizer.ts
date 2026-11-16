/**
 * Deterministically strips Markdown wrappers, fixes trailing commas,
 * and extracts the core JSON object from raw LLM text responses.
 */
export function sanitizeAndParseJson<T = unknown>(rawText: string): T {
  let cleaned = rawText.trim();

  // 1. Strip ```json ... ``` or ``` ... ``` markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 2. Isolate the outermost JSON object if conversational text leaked around it
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  // 3. Remove trailing commas before closing braces/brackets: , } -> } and , ] -> ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

  // 4. Strip non-printable ASCII control characters (except \n, \r, \t)
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  return JSON.parse(cleaned) as T;
}