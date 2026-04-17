export interface Env {
  // Cloudflare bindings
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  R2: R2Bucket;
  AI: Ai;
  QUEUE: Queue;
  ANALYTICS?: AnalyticsEngineDataset;

  // Configuration
  HINDSIGHT_VERSION: string;
  DEFAULT_LLM_MODEL: string;
  DEFAULT_EMBEDDING_MODEL: string;
  DEFAULT_RERANKER_MODEL: string;
  DEFAULT_VISION_MODEL: string;
  EMBEDDING_DIMENSIONS: string;

  // Optional auth — if set, all API requests must include a matching Bearer token
  HINDSIGHT_API_KEY?: string;

  // Optional — Analytics Engine read access (for GET /metrics)
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;

  // Optional external LLM API keys
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  EXTERNAL_LLM_BASE_URL?: string;
  EXTERNAL_LLM_MODEL?: string;
}
