// Model providers (ADR 0017). Every provider the pinned Pi runtime can reach with an API key alone. Providers that
// need more than a key (Amazon Bedrock, Google Vertex, Azure OpenAI, Cloudflare, GitHub Copilot and OpenAI Codex
// sign-in) are not offered yet. `packages/runtime-pi/test/providers.test.ts` checks this list against Pi on every
// upgrade: each id must be a Pi provider with models, and `env` must be the variable Pi reads for it.

export interface ProviderInfo {
  id: string;
  label: string;
  /** Variable that supplies the key when it is exported in the shell that launches ATLAS. */
  env: string;
  /** Where to create a key. */
  keyUrl?: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google', label: 'Google Gemini', env: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'mistral', label: 'Mistral', env: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'xai', label: 'xAI', env: 'XAI_API_KEY', keyUrl: 'https://console.x.ai' },
  { id: 'deepseek', label: 'DeepSeek', env: 'DEEPSEEK_API_KEY', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'groq', label: 'Groq', env: 'GROQ_API_KEY', keyUrl: 'https://console.groq.com/keys' },
  { id: 'cerebras', label: 'Cerebras', env: 'CEREBRAS_API_KEY', keyUrl: 'https://cloud.cerebras.ai' },
  { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', env: 'AI_GATEWAY_API_KEY' },
  { id: 'together', label: 'Together', env: 'TOGETHER_API_KEY', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'fireworks', label: 'Fireworks', env: 'FIREWORKS_API_KEY', keyUrl: 'https://fireworks.ai/account/api-keys' },
  { id: 'huggingface', label: 'Hugging Face', env: 'HF_TOKEN', keyUrl: 'https://huggingface.co/settings/tokens' },
  { id: 'nvidia', label: 'NVIDIA', env: 'NVIDIA_API_KEY', keyUrl: 'https://build.nvidia.com' },
  { id: 'baseten', label: 'Baseten', env: 'BASETEN_API_KEY' },
  { id: 'moonshotai', label: 'Moonshot AI', env: 'MOONSHOT_API_KEY' },
  { id: 'moonshotai-cn', label: 'Moonshot AI (China)', env: 'MOONSHOT_API_KEY' },
  { id: 'kimi-coding', label: 'Kimi For Coding', env: 'KIMI_API_KEY' },
  { id: 'zai', label: 'Z.AI', env: 'ZAI_API_KEY' },
  { id: 'zai-coding-cn', label: 'Z.AI Coding (China)', env: 'ZAI_CODING_CN_API_KEY' },
  { id: 'minimax', label: 'MiniMax', env: 'MINIMAX_API_KEY' },
  { id: 'minimax-cn', label: 'MiniMax (China)', env: 'MINIMAX_CN_API_KEY' },
  { id: 'meta', label: 'Meta', env: 'META_API_KEY' },
  { id: 'xiaomi', label: 'Xiaomi', env: 'XIAOMI_API_KEY' },
  { id: 'ant-ling', label: 'Ant Ling', env: 'ANT_LING_API_KEY' },
  { id: 'radius', label: 'Radius', env: 'RADIUS_API_KEY' },
  { id: 'opencode', label: 'OpenCode Zen', env: 'OPENCODE_API_KEY', keyUrl: 'https://opencode.ai/zen' },
  { id: 'opencode-go', label: 'OpenCode Go', env: 'OPENCODE_API_KEY' },
  { id: 'qwen-token-plan', label: 'Qwen Token Plan', env: 'QWEN_TOKEN_PLAN_API_KEY' },
  { id: 'qwen-token-plan-cn', label: 'Qwen Token Plan (China)', env: 'QWEN_TOKEN_PLAN_CN_API_KEY' },
  { id: 'qwen-token-plan-individual', label: 'Qwen Token Plan Individual', env: 'QWEN_TOKEN_PLAN_API_KEY' },
  { id: 'xiaomi-token-plan-cn', label: 'Xiaomi Token Plan (China)', env: 'XIAOMI_TOKEN_PLAN_CN_API_KEY' },
  { id: 'xiaomi-token-plan-ams', label: 'Xiaomi Token Plan (Amsterdam)', env: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY' },
  { id: 'xiaomi-token-plan-sgp', label: 'Xiaomi Token Plan (Singapore)', env: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY' },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id) as [string, ...string[]];

/** Model provider → variable that can supply its key. */
export const PROVIDER_ENV: Record<string, string> = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.env]));

/** "provider/model", the model id may itself contain slashes (openrouter/anthropic/claude-…). */
export const MODEL_REF = /^[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;

/** Model tiers roles ask for (roles.ts `modelPreference`); the operator maps each to a model in Settings. */
export const MODEL_TIERS = ['default', 'fast', 'strong'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface ModelInfo {
  /** provider/model */
  ref: string;
  provider: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  /** USD per million tokens, when the catalog knows it. */
  cost: { input: number; output: number } | null;
  /** A key for its provider is configured. */
  available: boolean;
}
