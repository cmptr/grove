/**
 * Image auto-tagging via Claude Vision.
 *
 * Given an image buffer, calls Claude (haiku) with the image and asks for
 * a description, detected concepts, OCR text, and suggested tags.
 * Returns the structured result; caller decides how to use it.
 */

import Anthropic from "@anthropic-ai/sdk";

const TAG_MODEL = "claude-haiku-4-5-20251001";

export interface ImageTagResult {
  description: string;
  tags: string[];
  concepts: string[];
  ocr_text: string;
}

const PROMPT = `Analyze this image and respond with JSON only (no prose, no code fences):
{
  "description": "1-2 sentences describing the image",
  "tags": ["lowercase", "kebab-case", "tags"],
  "concepts": ["Named entities or concepts visible"],
  "ocr_text": "Any visible text, or empty string"
}`;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/** Inject a mock client (tests). */
export function setClient(mock: Anthropic | null): void {
  client = mock;
}

/**
 * Call Claude Vision to auto-tag an image. Returns a best-effort result;
 * falls back to empty fields on API failure or JSON parse errors so the
 * upload pipeline can still complete.
 */
export async function autoTagImage(data: Buffer, contentType: string): Promise<ImageTagResult> {
  const empty: ImageTagResult = { description: "", tags: [], concepts: [], ocr_text: "" };
  try {
    const response = await getClient().messages.create({
      model: TAG_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: contentType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
                data: data.toString("base64"),
              },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const stripped = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(stripped) as Partial<ImageTagResult>;

    return {
      description: typeof parsed.description === "string" ? parsed.description : "",
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === "string") : [],
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts.filter((c) => typeof c === "string") : [],
      ocr_text: typeof parsed.ocr_text === "string" ? parsed.ocr_text : "",
    };
  } catch (err) {
    console.error("[image-tag] auto-tag failed:", (err as Error).message);
    return empty;
  }
}
