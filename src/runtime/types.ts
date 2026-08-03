export type RuntimeKind = "ollama" | "lmstudio" | "llamacpp" | "openai-compatible";
export type ModelCapability = "chat" | "tools" | "thinking" | "vision" | "audio" | "embeddings";

export interface RuntimeHealth {
  healthy: boolean;
  message?: string;
}

export interface LocalModel {
  id: string;
  runtime: RuntimeKind;
  size?: number;
}

export interface ModelCapabilities {
  chat: boolean;
  tools: boolean;
  thinking: boolean;
  vision: boolean;
  audio: boolean;
  embeddings: boolean;
  contextWindow?: number;
}

export interface ModelCandidate {
  ref: string;
  local: boolean;
  healthy: boolean;
  capabilities: ModelCapability[];
  requiresCloudApproval?: boolean;
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  health(): Promise<RuntimeHealth>;
  listModels(): Promise<LocalModel[]>;
  inspectModel(id: string): Promise<ModelCapabilities>;
  pullModel?(id: string, signal?: AbortSignal): AsyncIterable<PullProgress>;
}

export const EMPTY_CAPABILITIES: ModelCapabilities = {
  chat: true,
  tools: false,
  thinking: false,
  vision: false,
  audio: false,
  embeddings: false,
};
