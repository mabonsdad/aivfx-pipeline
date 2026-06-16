function stripProviderPrefix(value: string): string {
  return value
    .replace(/^Gemini did not return an image:\s*/i, "")
    .replace(/^\d+\s+Client Error:[^|]*\|\s*/i, "")
    .trim();
}

function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const match = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  return (match?.[1] ?? normalized).trim();
}

export function summarizeImageGenerationError(error: string | null | undefined, modelLabel = "This model"): string | null {
  const raw = error?.trim();
  if (!raw) return null;
  const normalized = stripProviderPrefix(raw);
  const lower = normalized.toLowerCase();

  if (lower.includes("finishreason=image_other") || lower.includes("unable to show the generated image")) {
    return "Model could not generate for the specific prompt/refs provided";
  }

  if (lower.includes("prompt blocked")) {
    return `${modelLabel} blocked this prompt. Rephrase it and try again.`;
  }

  if (lower.includes("aspect ratio")) {
    return firstSentence(normalized);
  }

  return firstSentence(normalized);
}
