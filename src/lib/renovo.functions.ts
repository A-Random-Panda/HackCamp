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

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "currency", "materials", "diagrams", "steps", "totalCost", "renderPrompt"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    currency: { type: "string" },
    totalCost: { type: "number" },
    renderPrompt: { type: "string" },
    materials: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quantity", "unitPrice", "total", "note"],
        properties: {
          name: { type: "string" },
          quantity: { type: "string" },
          unitPrice: { type: "number" },
          total: { type: "number" },
          note: { type: "string" },
        },
      },
    },
    diagrams: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "unit", "width", "height", "shapes"],
        properties: {
          title: { type: "string" },
          unit: { type: "string" },
          width: { type: "number" },
          height: { type: "number" },
          shapes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "x", "y", "w", "h"],
              properties: {
                label: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
            },
          },
        },
      },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "duration"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          duration: { type: "string" },
        },
      },
    },
  },
} as const;

export const createPlan = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => planInput.parse(d))
  .handler(async ({ data }): Promise<RenovationPlan> => {
    const { generateResponse } = await import("@lovable.dev/ai-gateway");
    const historyText = data.history.length
      ? `\n\nPrevious iterations and the homeowner's requested changes (apply ALL of these, the latest feedback wins):\n${data.history
          .map((h, i) => `${i + 1}. Previous plan: ${h.summary}\n   Requested change: ${h.feedback}`)
          .join("\n")}`
      : "";
    const text = `Renovation request: ${data.renovation}
Location: ${data.location}
Budget: ${data.budget || "not specified"}
Living constraints: ${data.constraints || "none given"}${historyText}

Return the renovation plan as JSON matching the schema.`;

    const res = await generateResponse({
      model: "openai/gpt-6-astra",
      instructions: `You are Renovo, an expert home-renovation planner. Study the photo of the existing space.
Produce: a concise title and summary; a priced materials list using realistic local retail prices for the given location in its local currency (currency = ISO code); 1-3 top-down plan diagrams with real measurements (unit "ft" or "m" per locale; shapes are rectangles positioned inside width x height, never outside); 6-12 ordered steps with durations; totalCost = sum of material totals. Respect the budget and constraints (rentals, HOA, permits, climate, building codes for the location). renderPrompt: a vivid description of the finished room for an image editor, keeping the same camera angle and room geometry. Respond only with JSON.`,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text },
            { type: "input_image", image_url: data.image, detail: "auto" },
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "renovation_plan", strict: true, schema: planSchema } },
    });

    const out = (res as { output?: Array<{ content?: Array<{ type: string; text?: string }> }> }).output ?? [];
    const raw = out
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("");
    if (!raw) throw new Error("Renovo could not produce a plan. Please try again.");
    return JSON.parse(raw) as RenovationPlan;
  });

export const renderFinished = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ image: z.string().startsWith("data:image/").max(6_000_000), prompt: z.string().min(1).max(4000) }).parse(d),
  )
  .handler(async ({ data }): Promise<{ image: string }> => {
    const { editImage } = await import("@lovable.dev/ai-gateway");
    const [meta = "", b64 = ""] = data.image.split(",");
    const mime = meta.match(/data:(.*?);/)?.[1] ?? "image/jpeg";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const res = await editImage({
      model: "openai/gpt-image-2.5-sunburst",
      image: new Blob([bytes], { type: mime }),
      prompt: `Photorealistic render of this exact room after renovation, same camera angle and geometry. ${data.prompt}`,
      output_format: "jpeg",
      output_compression: 70,
      quality: "medium",
      size: "1024x1024",
    });
    const img = (res as { data?: Array<{ b64_json?: string }> }).data?.[0]?.b64_json;
    if (!img) throw new Error("No image was produced.");
    return { image: `data:image/jpeg;base64,${img}` };
  });
