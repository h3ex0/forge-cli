export async function fetchModels(profile) {
    if (profile.format !== "openai")
        return [];
    const url = `${profile.baseURL.replace(/\/$/, "")}/models`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${profile.apiKey}` },
    });
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const data = json.data ?? [];
    return data.map((m) => ({
        id: m.id,
        inputPricePerMillion: m.pricing?.input_per_million,
        outputPricePerMillion: m.pricing?.output_per_million,
    }));
}
