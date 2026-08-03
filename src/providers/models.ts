import type { Profile } from "../config.js";

export interface ModelInfo {
  id: string;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}

export async function fetchModels(profile: Profile): Promise<ModelInfo[]> {
  if (profile.format !== "openai") return [];
  const url = `${profile.baseURL.replace(/\/$/, "")}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${profile.apiKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: any = await res.json();
  const data: any[] = json.data ?? [];
  return data.map((m) => ({
    id: m.id,
    inputPricePerMillion: m.pricing?.input_per_million,
    outputPricePerMillion: m.pricing?.output_per_million,
  }));
}
