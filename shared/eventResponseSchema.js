const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const text = { type: 'string', minLength: 1, maxLength: 600 };
const references = { type: 'array', minItems: 1, maxItems: 1, items: text };
const object = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const EVENT_OUTPUT_SCHEMA = object({
  quality: { type: 'string', enum: ['clear', 'uncertain'] }, summary: text,
  candidates: { type: 'array', maxItems: 32, items: object({
    id: text, category: { type: 'string', enum: ['fire', 'security', 'assistance', 'environment', 'facility'] },
    subtype: text, confidence: number(0, 1),
    scores: object({ consequence: number(0, 100), exposure: number(0, 100), urgency: number(0, 100) }),
    observation: text, evidenceFrameIds: references,
    box: object({ x: number(0, 1), y: number(0, 1), width: number(0, 1), height: number(0, 1) }),
    regionId: { type: ['string', 'null'] }
  }) },
  eventChecks: { type: 'array', maxItems: 32, items: object({
    eventId: text, verdict: { type: 'string', enum: ['present', 'absent', 'unknown'] },
    regionVisible: { type: 'boolean' }, evidenceFrameIds: references
  }) }
});

// OpenAI-compatible json_schema wrapper; llama.cpp b9484 reads json_schema.schema.
export const EVENT_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'community_event_observation', strict: true, schema: EVENT_OUTPUT_SCHEMA }
};
