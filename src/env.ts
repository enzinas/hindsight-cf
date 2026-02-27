export interface Env {
  // Cloudflare bindings
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  R2: R2Bucket;
  AI: Ai;
  QUEUE: Queue;

  // Configuration
  HINDSIGHT_VERSION: string;
  DEFAULT_LLM_MODEL: string;
  DEFAULT_EMBEDDING_MODEL: string;
  DEFAULT_RERANKER_MODEL: string;
  EMBEDDING_DIMENSIONS: string;

  // Optional external LLM API keys
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  EXTERNAL_LLM_BASE_URL?: string;
  EXTERNAL_LLM_MODEL?: string;
}
