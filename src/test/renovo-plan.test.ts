import { describe, expect, it } from "vitest";

import { buildPlan } from "@/lib/renovo.functions";

const input = {
  image: "data:image/jpeg;base64,AA==",
  renovation: "Replace the kitchen worktops and repaint the cabinets",
  location: "Manchester, UK",
  constraints: "Renting",
  budget: "£4,000",
  history: [],
};

const ideas = {
  summary: "Refresh a small kitchen with new worktops and painted cabinets.",
  budget: "GBP 1,500-2,500",
  toolsAndResources: [
    {
      name: "Cordless drill",
      category: "tool",
      whyNeeded: "Driving screws",
      estimatedPrice: "GBP 50-100",
      whereToBuy: ["Wickes", "B&Q"],
    },
  ],
  stores: [{ name: "Wickes", type: "home improvement", bestFor: "tools" }],
  steps: [{ title: "Clear the room", detail: "Remove everything.", estimatedTime: "1 hour" }],
  tips: ["Protect the floor."],
};

describe("ideas to Renovo plan", () => {
  it("maps prices, stores, steps and budget", () => {
    const plan = buildPlan(input, ideas);

    expect(plan.currency).toBe("GBP");
    expect(plan.budgetLabel).toBe("GBP 1,500-2,500");
    expect(plan.totalCost).toBe(2000);
    expect(plan.materials).toHaveLength(1);
    expect(plan.materials[0]?.unitPrice).toBe(75);
    expect(plan.materials[0]?.note).toContain("Wickes");
    expect(plan.stores?.[0]?.name).toBe("Wickes");
    expect(plan.steps[0]).toEqual({
      title: "Clear the room",
      detail: "Remove everything.",
      duration: "1 hour",
    });
    expect(plan.tips).toEqual(["Protect the floor."]);
    expect(plan.diagrams).toEqual([]);
    expect(plan.renderPrompt).toContain("Replace the kitchen worktops");
  });

  it("prefers the model's short title", () => {
    const plan = buildPlan(input, { ...ideas, title: "Painted Kitchen Refresh" });

    expect(plan.title).toBe("Painted Kitchen Refresh");
  });

  it("keeps a fallback title short and on a word boundary", () => {
    const plan = buildPlan(
      {
        ...input,
        renovation:
          "Installing vertical wooden plank style floor tiles or vinyl planks involves surfacing and adhesive work",
      },
      ideas,
    );

    expect(plan.title.length).toBeLessThanOrEqual(48);
    expect(plan.title.split(" ").length).toBeLessThanOrEqual(6);
    expect(plan.title).not.toMatch(/[.,;:!?]$/);
    expect(plan.title.split(" ").at(-1)).toBeTruthy();
  });
});
