import test from "node:test";
import assert from "node:assert/strict";
import { parseAnalysisProviderList, parseAudioProviderList } from "@/lib/config";

test("parseAnalysisProviderList trims, lowercases, filters, and dedupes", () => {
  // "groq" appears twice and case varies — the result contains it once.
  const list = parseAnalysisProviderList(" Groq , NVIDIA ,,groq, openrouter");
  assert.deepEqual(list, ["groq", "nvidia", "openrouter"]);
});

test("parseAnalysisProviderList drops unknown entries", () => {
  assert.deepEqual(parseAnalysisProviderList("azure, gemini"), ["gemini"]);
});

test("parseAnalysisProviderList honors the ANALYSIS_PROVIDERS order exactly", () => {
  // The environment list IS the fallback priority — not a canonical order.
  assert.deepEqual(parseAnalysisProviderList("gemini,groq,openrouter,nvidia"), ["gemini", "groq", "openrouter", "nvidia"]);
  assert.deepEqual(parseAnalysisProviderList("nvidia,groq,openrouter,gemini"), ["nvidia", "groq", "openrouter", "gemini"]);
});

test("parseAudioProviderList keeps caller order (audio lists are explicit)", () => {
  assert.deepEqual(parseAudioProviderList("openai, mock, gemini", ["gemini", "openai", "freetouse", "b2", "mock"]), ["openai", "mock", "gemini"]);
});

test("parseAudioProviderList rejects unknown providers", () => {
  assert.deepEqual(parseAudioProviderList("elevenlabs, b2", ["gemini", "openai", "freetouse", "b2", "mock"]), ["b2"]);
});
