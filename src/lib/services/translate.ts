import { geminiText } from "./gemini";

/**
 * Translate the whole narration script into targetLanguage via Gemini. Returns
 * the source unchanged when targetLanguage is empty. Output is plain continuous
 * narration (no JSON, no notes) so it feeds straight into the voice stage.
 */
export async function translateScript(script: string, targetLanguage: string): Promise<string> {
  const lang = targetLanguage.trim();
  if (!lang) return script;
  const system =
    `You are a professional translator for a faceless YouTube channel about manifestation, universal energy, ` +
    `spirituality and ancient wisdom. Translate the user's narration script into ${lang}. Preserve the meaning, ` +
    `tone, rhythm and flow so it narrates naturally. Keep the same paragraph structure. Output ONLY the translated ` +
    `script as continuous narration — no notes, no quotes, no preamble, no explanations.`;
  const out = await geminiText(system, script, { temperature: 0.3, json: false });
  return out.trim();
}
