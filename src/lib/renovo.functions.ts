import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { RenovationPlan } from "./renovo-types";

const planInput = z.object({
  image: z.string().startsWith("data:image/").max(6_000_000),
  renovation: z.string().min(1).max(4000),
  location: z.string().min(1).max(300),
  constraints: z.string().max(4000).optional().default(""),
  budget: z.string().max(200).optional().default(""),
  history: z
    .array(z.object({ summary: z.string().max(4000), feedback: z.string().max(4000) }))
    .max(30)
    .default([]),
});

export type PlanInput = z.infer<typeof planInput>;

type IdeaTool = {
  name?: string;
  category?: string;
  whyNeeded?: string;
  estimatedPrice?: string;
  whereToBuy?: string[];
};

type IdeaStore = { name?: string; type?: string; bestFor?: string };
type IdeaStep = { title?: string; detail?: string; estimatedTime?: string } | string;

export type IdeasResponse = {
  title?: string;
  summary?: string;
  budget?: string;
  toolsAndResources?: IdeaTool[];
  stores?: IdeaStore[];
  steps?: IdeaStep[];
  tips?: string[];
  error?: string;
};

type ImageResponse = {
  ok?: boolean;
  image_base64?: string;
  image_mime_type?: string;
  error?: { code?: string; message?: string };
};

function serviceUrl(envName: "IDEAS_API_URL" | "IMAGE_API_URL", fallback: string): string {
  const value = typeof process !== "undefined" ? process.env[envName] : undefined;
  return (value || fallback).replace(/\/+$/, "");
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const record = payload as { error?: unknown; message?: unknown };
    if (typeof record.error === "string" && record.error.trim()) return record.error;
    if (
      record.error &&
      typeof record.error === "object" &&
      "message" in record.error &&
      typeof (record.error as { message?: unknown }).message === "string"
    ) {
      return (record.error as { message: string }).message;
    }
    if (typeof record.message === "string" && record.message.trim()) return record.message;
  }
  return `Request failed (HTTP ${status}).`;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function requestJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  serviceName: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`Could not reach the ${serviceName} at ${url}. Is it running?`);
  }

  const payload = await parseJson(response);
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return payload;
}

function numbersIn(value: string): number[] {
  return (value.match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((part) => Number(part.replace(/,/g, "")))
    .filter((part) => Number.isFinite(part));
}

function parseMoney(value: string): number {
  const numbers = numbersIn(value);
  if (!numbers.length) return 0;
  const [first = 0, second] = numbers;
  return Math.round(second === undefined ? first : (first + second) / 2);
}

function parseBudget(value: string): number {
  return parseMoney(value);
}

function currencyFromBudget(budget: string): string {
  const code = budget.toUpperCase().match(/\b(GBP|USD|EUR|CAD|AUD|NZD|JPY|INR|ZAR)\b/);
  if (code?.[1]) return code[1];
  if (budget.includes("£")) return "GBP";
  if (budget.includes("€")) return "EUR";
  if (budget.includes("$")) return "USD";
  return "USD";
}

const TITLE_WORDS = 6;
const TITLE_CHARS = 48;

/** Keep titles to a few words, cut on a word boundary, without a trailing period. */
function shortenTitle(text: string): string {
  const firstClause = text.split(/[.,;:!?]\s/)[0]?.trim() || text.trim();
  const words = firstClause.split(/\s+/).slice(0, TITLE_WORDS).join(" ");
  const clipped = words.length > TITLE_CHARS ? words.slice(0, TITLE_CHARS).replace(/\s+\S*$/, "").trim() : words;
  return clipped.replace(/[.,;:!?]+$/, "").trim();
}

function titleFrom(ideas: IdeasResponse, renovation: string): string {
  return shortenTitle(ideas.title ?? "") || shortenTitle(renovation) || "Renovation plan";
}

export function buildPlan(data: PlanInput, ideas: IdeasResponse): RenovationPlan {
  const budget = (ideas.budget ?? "").trim();
  const tools = Array.isArray(ideas.toolsAndResources) ? ideas.toolsAndResources : [];

  const materials = tools.map((tool) => {
    const price = parseMoney(tool.estimatedPrice ?? "");
    const where = Array.isArray(tool.whereToBuy)
      ? tool.whereToBuy.filter((store): store is string => typeof store === "string" && !!store.trim())
      : [];
    const note = [
      tool.whyNeeded?.trim(),
      where.length ? `Buy: ${where.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      name: tool.name?.trim() || "Material",
      quantity: "1",
      unitPrice: price,
      total: price,
      note,
    };
  });

  const totalCost = parseBudget(budget) || materials.reduce((sum, item) => sum + item.total, 0);

  const steps = (Array.isArray(ideas.steps) ? ideas.steps : []).map((step, index) => {
    if (typeof step === "string") {
      return { title: `Step ${index + 1}`, detail: step, duration: "" };
    }
    return {
      title: step.title?.trim() || `Step ${index + 1}`,
      detail: step.detail?.trim() || "",
      duration: step.estimatedTime?.trim() || "",
    };
  });

  const stores = (Array.isArray(ideas.stores) ? ideas.stores : [])
    .map((store) => ({
      name: store.name?.trim() || "",
      type: store.type?.trim() || "",
      bestFor: store.bestFor?.trim() || "",
    }))
    .filter((store) => store.name);

  const tips = (Array.isArray(ideas.tips) ? ideas.tips : []).filter(
    (tip): tip is string => typeof tip === "string" && !!tip.trim(),
  );

  const latestFeedback = data.history.at(-1)?.feedback.trim();
  const summary =
    [ideas.summary?.trim(), budget ? `Rough budget: ${budget}.` : ""].filter(Boolean).join(" ") ||
    data.renovation;
  const renderPrompt = [
    `Renovate this room: ${data.renovation}.`,
    ideas.summary ?? "",
    latestFeedback ? `Also: ${latestFeedback}.` : "",
    "Keep the same camera angle, layout and room geometry; photorealistic interior.",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 4000);

  return {
    title: titleFrom(ideas, data.renovation),
    summary,
    currency: currencyFromBudget(budget),
    totalCost,
    ...(budget ? { budgetLabel: budget } : {}),
    renderPrompt,
    materials,
    diagrams: [],
    steps,
    stores,
    tips,
  };
}

export const createPlan = createServerFn({ method: "POST" })
  .validator((d: unknown) => planInput.parse(d))
  .handler(async ({ data }): Promise<RenovationPlan> => {
    if (data.renovation.trim().length < 10) {
      throw new Error("Please describe the renovation in at least 10 characters.");
    }

    const historyText = data.history
      .map((entry, index) => `${index + 1}. ${entry.summary} — ${entry.feedback}`)
      .join(" ");
    const constraints = [
      data.constraints,
      data.budget ? `Budget: ${data.budget}` : "",
      historyText ? `Previous feedback: ${historyText}` : "",
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 500);

    const payload = (await requestJson(
      `${serviceUrl("IDEAS_API_URL", "http://127.0.0.1:3000")}/api/ideas`,
      {
        description: data.renovation.trim().slice(0, 2000),
        location: data.location.trim().slice(0, 120),
        constraints,
      },
      150_000,
      "ideas service",
    )) as IdeasResponse | null;

    if (!payload || typeof payload !== "object") {
      throw new Error("The ideas service returned an empty response.");
    }
    return buildPlan(data, payload);
  });

export const renderFinished = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        image: z.string().startsWith("data:image/").max(6_000_000),
        prompt: z.string().min(1).max(4000),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<{ image: string }> => {
    const match = data.image.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error("The uploaded image could not be read.");

    const mime = match[1];
    const base64 = match[2];
    if (!mime || !base64) throw new Error("The uploaded image could not be read.");

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    } catch {
      throw new Error("The uploaded image could not be read.");
    }

    const imageBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(imageBuffer).set(bytes);
    const form = new FormData();
    form.append("image", new Blob([imageBuffer], { type: mime }), "room.jpg");
    form.append("change_request", data.prompt.slice(0, 4000));
    form.append("restrictions", "Keep the same camera angle, layout and room geometry.");

    let response: Response;
    try {
      response = await fetch(`${serviceUrl("IMAGE_API_URL", "http://127.0.0.1:8000")}/api/edit`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(240_000),
      });
    } catch {
      throw new Error("Could not reach the image service. Is it running?");
    }

    const payload = (await parseJson(response)) as ImageResponse | null;
    if (!response.ok || !payload?.ok || !payload.image_base64) {
      throw new Error(errorMessage(payload, response.status));
    }

    return { image: `data:${payload.image_mime_type || "image/jpeg"};base64,${payload.image_base64}` };
  });
