export type Shape = { label: string; x: number; y: number; w: number; h: number };
export type Diagram = { title: string; unit: string; width: number; height: number; shapes: Shape[] };
export type RenovationPlan = {
  title: string;
  summary: string;
  currency: string;
  totalCost: number;
  budgetLabel?: string;
  renderPrompt: string;
  materials: { name: string; quantity: string; unitPrice: number; total: number; note: string }[];
  diagrams: Diagram[];
  steps: { title: string; detail: string; duration: string }[];
  stores?: { name: string; type?: string; bestFor?: string }[];
  tips?: string[];
};
export type Iteration = { plan: RenovationPlan; render?: string; feedback?: string };
export type Project = {
  id: string;
  name: string;
  createdAt: number;
  image: string;
  renovation: string;
  location: string;
  constraints: string;
  budget: string;
  iterations: Iteration[];
  accepted?: boolean;
};
