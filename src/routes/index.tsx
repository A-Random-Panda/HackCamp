import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Hammer, ImagePlus, Loader2, MapPin, Plus, RefreshCw, Trash2, Wallet, X } from "lucide-react";
import { createPlan, renderFinished } from "@/lib/renovo.functions";
import type { Iteration, Project } from "@/lib/renovo-types";
import { DiagramView } from "@/components/renovo/Diagram";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Renovo — Plan your home renovation with AI" },
      { name: "description", content: "Upload a photo, share your location, budget and constraints, and get priced materials, local stores and renovation steps." },
      { property: "og:title", content: "Renovo — Plan your home renovation with AI" },
      { property: "og:description", content: "Priced materials, local stores, steps and a preview of your finished space." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const STORAGE = "renovo-projects";

const EXAMPLES = [
  { label: "Modern kitchen refresh", renovation: "Replace dated oak cabinets with matte white shaker cabinets, quartz countertops, and a subway tile backsplash. Add under-cabinet lighting.", location: "Vancouver, BC, Canada", constraints: "Condo with strata rules: no work before 9am, no structural changes, shared plumbing stack.", budget: "$15,000 CAD", img: "https://images.unsplash.com/photo-1556911220-bff31c812dba?w=1024&q=70" },
  { label: "Spa-style bathroom", renovation: "Turn the tub into a walk-in glass shower, add a floating vanity, large-format porcelain tile and a heated floor.", location: "Austin, Texas, USA", constraints: "Only bathroom in the house; need it usable within 2 weeks.", budget: "$12,000", img: "https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=1024&q=70" },
  { label: "Cozy living room", renovation: "Add built-in shelving around the fireplace, warm wood flooring and a reading nook by the window.", location: "Manchester, UK", constraints: "Renting — landlord allows only reversible changes. Old Victorian walls.", budget: "£4,000", img: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=1024&q=70" },
];

async function toDataUrl(src: Blob | string): Promise<string> {
  const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8);
}

function money(n: number, cur: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n);
  } catch {
    return `${cur} ${n.toFixed(2)}`;
  }
}

function Index() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      setProjects(JSON.parse(localStorage.getItem(STORAGE) || "[]"));
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE, JSON.stringify(projects));
    } catch {
      // storage full: keep only the latest render per project
      try {
        localStorage.setItem(STORAGE, JSON.stringify(projects.slice(0, 5)));
      } catch { /* ignore */ }
    }
  }, [projects, loaded]);

  const update = (id: string, fn: (p: Project) => Project) =>
    setProjects((ps) => ps.map((p) => (p.id === id ? fn(p) : p)));
  const active = projects.find((p) => p.id === activeId) ?? null;

  return (
    <div className="relative flex min-h-screen">
      <FallingLogos />
      <aside className="z-10 sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-4 backdrop-blur-xl md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand glow"><Hammer className="h-4 w-4 text-primary-foreground" /></div>
          <span className="font-display text-xl font-extrabold text-brand">Renovo</span>
        </div>
        <button onClick={() => setActiveId(null)} className="mb-4 flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm transition hover:bg-accent">
          <Plus className="h-4 w-4" /> New renovation
        </button>
        <p className="mb-2 px-2 text-xs uppercase tracking-wider text-muted-foreground">Your renovations</p>
        <nav className="flex-1 space-y-1 overflow-y-auto">
          {projects.length === 0 && <p className="px-2 text-sm text-muted-foreground">No renovations yet.</p>}
          {projects.map((p) => (
            <div key={p.id} className={`group flex items-center rounded-xl text-sm transition ${p.id === activeId ? "bg-secondary" : "hover:bg-accent/60"}`}>
              <button onClick={() => setActiveId(p.id)} className="flex-1 truncate px-3 py-2 text-left">
                {p.accepted && <Check className="mr-1 inline h-3 w-3 text-brand" />}
                {p.name}
              </button>
              <button aria-label="Delete" onClick={() => { setProjects((ps) => ps.filter((x) => x.id !== p.id)); if (activeId === p.id) setActiveId(null); }} className="px-2 opacity-0 transition group-hover:opacity-70">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </nav>
      </aside>

      <main className="relative z-10 flex-1 px-4 py-10 md:px-10">
        {active ? (
          <ProjectView key={active.id} project={active} onUpdate={(fn) => update(active.id, fn)} />
        ) : (
          <NewForm
            onCreated={(p) => {
              setProjects((ps) => [p, ...ps]);
              setActiveId(p.id);
            }}
          />
        )}
      </main>
    </div>
  );
}

function NewForm({ onCreated }: { onCreated: (p: Project) => void }) {
  const [constraints, setConstraints] = useState("");
  const [location, setLocation] = useState("");
  const [budget, setBudget] = useState("");
  const [renovation, setRenovation] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const ready = location.trim() && renovation.trim() && image && !busy;

  const fill = async (ex: (typeof EXAMPLES)[number]) => {
    setConstraints(ex.constraints); setLocation(ex.location); setBudget(ex.budget); setRenovation(ex.renovation);
    try { setImage(await toDataUrl(ex.img)); } catch { setImage(null); }
  };

  const submit = () => {
    if (!ready || !image) return;
    setBusy(true);
    onCreated({
      id: crypto.randomUUID(),
      name: renovation.slice(0, 40),
      createdAt: Date.now(),
      image, renovation, location, constraints, budget,
      iterations: [],
    });
  };

  return (
    <div className="mx-auto flex min-h-[85vh] max-w-3xl flex-col justify-center fade-up">
      <div className="mb-10 text-center">
        <h1 className="font-display text-6xl font-extrabold tracking-tight text-brand md:text-7xl">Renovo</h1>
        <p className="mt-3 text-lg text-brand">Snap your space. Get the materials, prices, stores and steps to transform it.</p>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs text-muted-foreground">Try an example:</span>
        {EXAMPLES.map((ex) => (
          <button key={ex.label} onClick={() => fill(ex)} className="rounded-full border border-border bg-muted px-3 py-1 text-xs transition hover:border-brand hover:text-brand">
            {ex.label}
          </button>
        ))}
      </div>

      <div className="glass glow space-y-3 rounded-3xl p-4">
        <textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} rows={2} placeholder="Constraints (optional) — renting, HOA rules, timeline, kids or pets…" className="w-full resize-none rounded-xl bg-muted px-4 py-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="flex flex-1 items-center gap-2 rounded-xl bg-muted px-4 focus-within:ring-1 focus-within:ring-ring">
            <MapPin className="h-4 w-4 text-brand" />
            <input required value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location *  (city, region, country)" className="w-full bg-transparent py-3 text-sm placeholder:text-muted-foreground focus:outline-none" />
          </label>
          <label className="flex items-center gap-2 rounded-xl bg-muted px-4 focus-within:ring-1 focus-within:ring-ring sm:w-48">
            <Wallet className="h-4 w-4 text-brand" />
            <input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Budget" className="w-full bg-transparent py-3 text-sm placeholder:text-muted-foreground focus:outline-none" />
          </label>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setImage(await toDataUrl(f)); }} />
        {image ? (
          <div className="relative overflow-hidden rounded-xl">
            <img src={image} alt="Original space" className="max-h-64 w-full object-cover" />
            <button aria-label="Remove image" onClick={() => setImage(null)} className="absolute right-2 top-2 rounded-full bg-secondary p-1.5"><X className="h-4 w-4" /></button>
          </div>
        ) : (
          <button onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted py-8 text-sm text-muted-foreground transition hover:border-brand hover:text-brand">
            <ImagePlus className="h-6 w-6" /> Upload a photo of the current layout *
          </button>
        )}
        <div className="relative">
          <textarea value={renovation} onChange={(e) => setRenovation(e.target.value)} rows={3} placeholder="What do you want renovated? *" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} className="w-full resize-none rounded-xl bg-muted px-4 py-3 pr-14 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
          <button aria-label="Generate plan" disabled={!ready} onClick={submit} className="absolute bottom-3 right-3 grid h-9 w-9 place-items-center rounded-full bg-brand text-primary-foreground transition disabled:opacity-30">
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-muted-foreground">* required</p>
    </div>
  );
}

function ProjectView({ project, onUpdate }: { project: Project; onUpdate: (fn: (p: Project) => Project) => void }) {
  const planFn = useServerFn(createPlan);
  const renderFn = useServerFn(renderFinished);
  const [busy, setBusy] = useState<"preview" | "plan" | "render" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [showChange, setShowChange] = useState(false);
  const [refine, setRefine] = useState("");
  const [showRefine, setShowRefine] = useState(false);
  const started = useRef(false);

  // No plan yet: the edited room is waiting for a yes/no from the user.
  const awaitingApproval = project.iterations.length === 0;

  const previewPrompt = (instruction?: string) =>
    [
      `Renovate this room: ${project.renovation}.`,
      instruction?.trim() ? `Refine the previous result: ${instruction.trim()}.` : "",
      "Keep the same camera angle, layout and room geometry; photorealistic interior.",
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 4000);

  // Step 1: show the edited room before spending anything on pricing.
  const renderPreview = async (instruction?: string) => {
    setError(null);
    setBusy("preview");
    try {
      const { image } = await renderFn({
        data: { image: project.preview ?? project.image, prompt: previewPrompt(instruction) },
      });
      onUpdate((p) => ({ ...p, preview: image }));
      setShowRefine(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  // Step 2: the user approved the image, so now price the materials and write the steps.
  const approvePreview = async () => {
    if (!project.preview) return;
    setError(null);
    setBusy("plan");
    try {
      const plan = await planFn({
        data: {
          image: project.image,
          renovation: project.renovation,
          location: project.location,
          constraints: project.constraints,
          budget: project.budget,
          history: [],
        },
      });
      onUpdate((p) => ({
        ...p,
        name: plan.title || p.name,
        iterations: [...p.iterations, p.preview ? { plan, render: p.preview } : { plan }],
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const run = async (extraFeedback?: string) => {
    setError(null);
    setBusy("plan");
    try {
      const history = project.iterations.map((it, i) => ({
        summary: it.plan.summary,
        feedback: i === project.iterations.length - 1 && extraFeedback ? extraFeedback : (it.feedback ?? ""),
      })).filter((h) => h.feedback);
      if (extraFeedback) onUpdate((p) => ({ ...p, accepted: false, iterations: p.iterations.map((it, i) => (i === p.iterations.length - 1 ? { ...it, feedback: extraFeedback } : it)) }));
      const plan = await planFn({ data: { image: project.image, renovation: project.renovation, location: project.location, constraints: project.constraints, budget: project.budget, history } });
      const idx = project.iterations.length;
      onUpdate((p) => ({ ...p, name: plan.title || p.name, iterations: [...p.iterations, { plan }] }));
      setBusy("render");
      const { image } = await renderFn({ data: { image: project.preview ?? project.image, prompt: plan.renderPrompt } });
      onUpdate((p) => ({ ...p, iterations: p.iterations.map((it, i) => (i === idx ? { ...it, render: image } : it)) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!started.current && project.iterations.length === 0 && !project.preview) {
      started.current = true;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-10 pb-24">
      <header className="glass rounded-3xl p-6 fade-up">
        <div className="flex flex-col gap-5 md:flex-row">
          <img src={project.image} alt="Original" className="h-40 w-full rounded-2xl object-cover md:w-56" />
          <div className="space-y-2 text-sm">
            <h1 className="font-display text-3xl font-extrabold text-brand">{project.name}</h1>
            <p>{project.renovation}</p>
            <p className="text-muted-foreground"><MapPin className="mr-1 inline h-3.5 w-3.5" />{project.location}{project.budget && ` · Budget ${project.budget}`}</p>
            {project.constraints && <p className="text-muted-foreground">Constraints: {project.constraints}</p>}
          </div>
        </div>
      </header>

      {awaitingApproval ? (
        <section className="glass glow space-y-5 rounded-3xl p-6 fade-up">
          <div>
            <h2 className="font-display text-2xl font-bold text-brand">Your renovated space</h2>
            <p className="text-sm text-muted-foreground">
              Check the preview first. Once you're happy with it, Renovo prices the materials, finds stores and writes the steps.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <figure className="overflow-hidden rounded-2xl bg-muted">
              <img src={project.image} alt="Before" className="aspect-square w-full object-cover" />
              <figcaption className="px-4 py-2 text-xs text-muted-foreground">Your photo</figcaption>
            </figure>
            <figure className="overflow-hidden rounded-2xl bg-muted">
              {project.preview ? (
                <img src={project.preview} alt="After" className="aspect-square w-full object-cover" />
              ) : (
                <div className="grid aspect-square place-items-center text-sm text-muted-foreground">
                  <Loader2 className="h-6 w-6 animate-spin text-brand" />
                </div>
              )}
              <figcaption className="px-4 py-2 text-xs text-muted-foreground">Proposed renovation</figcaption>
            </figure>
          </div>
          {project.preview && !busy && (showRefine ? (
            <div className="space-y-3">
              <p className="font-display text-lg font-bold text-brand">What should change in the image?</p>
              <textarea value={refine} onChange={(e) => setRefine(e.target.value)} rows={3} placeholder="e.g. keep the cabinets, but swap the floor for lighter oak and drop the rug" className="w-full resize-none rounded-xl bg-muted px-4 py-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
              <div className="flex gap-2">
                <button disabled={!refine.trim()} onClick={() => { const f = refine; setRefine(""); renderPreview(f); }} className="flex items-center gap-2 rounded-full bg-brand px-5 py-2 text-sm text-primary-foreground disabled:opacity-40"><RefreshCw className="h-4 w-4" /> Update preview</button>
                <button onClick={() => setShowRefine(false)} className="rounded-full px-4 py-2 text-sm hover:bg-accent">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-display text-lg font-bold">Happy with this preview?</p>
              <div className="flex flex-wrap gap-2">
                <button onClick={approvePreview} className="flex items-center gap-2 rounded-full bg-brand px-5 py-2 text-sm text-primary-foreground"><Check className="h-4 w-4" /> Yes, price this</button>
                <button onClick={() => setShowRefine(true)} className="flex items-center gap-2 rounded-full bg-secondary px-5 py-2 text-sm"><RefreshCw className="h-4 w-4" /> Refine the image</button>
              </div>
            </div>
          ))}
        </section>
      ) : (
        project.iterations.map((it, i) => (
          <IterationView key={i} it={it} index={i} total={project.iterations.length} original={project.image} />
        ))
      )}

      {busy && (
        <div className="glass flex items-center gap-3 rounded-2xl p-5 text-sm">
          <Loader2 className="h-5 w-5 animate-spin text-brand" />
          {busy === "preview" ? "Rendering your renovated room…" : busy === "plan" ? "Renovo is pricing materials, finding stores and writing your steps…" : "Rendering your finished renovation…"}
        </div>
      )}
      {error && (
        <div className="glass flex items-center justify-between rounded-2xl border-destructive p-5 text-sm">
          <span>{error}</span>
          <button onClick={() => (awaitingApproval ? (project.preview ? approvePreview() : renderPreview()) : project.iterations.length && !project.iterations.at(-1)!.render ? renderAgain() : run())} className="rounded-full bg-brand px-4 py-1.5 text-primary-foreground">Try again</button>
        </div>
      )}

      {!busy && project.iterations.length > 0 && (
        <section className="glass glow rounded-3xl p-6">
          {project.accepted ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 font-display text-lg font-bold text-brand"><Check className="h-5 w-5" /> You're going with this plan.</p>
              <button onClick={() => { onUpdate((p) => ({ ...p, accepted: false })); setShowChange(true); }} className="rounded-full border border-border px-4 py-2 text-sm hover:bg-accent">Change it anyway</button>
            </div>
          ) : showChange ? (
            <div className="space-y-3">
              <p className="font-display text-lg font-bold text-brand">What should change?</p>
              <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="e.g. Keep it under $10k, use darker cabinets and open shelving instead of uppers" className="w-full resize-none rounded-xl bg-muted px-4 py-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
              <div className="flex gap-2">
                <button disabled={!feedback.trim()} onClick={() => { const f = feedback; setFeedback(""); setShowChange(false); run(f); }} className="flex items-center gap-2 rounded-full bg-brand px-5 py-2 text-sm text-primary-foreground disabled:opacity-40"><RefreshCw className="h-4 w-4" /> Generate new version</button>
                <button onClick={() => setShowChange(false)} className="rounded-full px-4 py-2 text-sm hover:bg-accent">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-display text-lg font-bold">Happy with the plan?</p>
              <div className="flex gap-2">
                <button onClick={() => onUpdate((p) => ({ ...p, accepted: true }))} className="flex items-center gap-2 rounded-full bg-brand px-5 py-2 text-sm text-primary-foreground"><Check className="h-4 w-4" /> Go with this</button>
                <button onClick={() => setShowChange(true)} className="flex items-center gap-2 rounded-full bg-secondary px-5 py-2 text-sm"><RefreshCw className="h-4 w-4" /> Change it</button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );

  async function renderAgain() {
    const idx = project.iterations.length - 1;
    setError(null);
    setBusy("render");
    try {
      const { image } = await renderFn({ data: { image: project.preview ?? project.image, prompt: project.iterations[idx]?.plan.renderPrompt ?? "" } });
      onUpdate((p) => ({ ...p, iterations: p.iterations.map((it, i) => (i === idx ? { ...it, render: image } : it)) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }
}

function IterationView({ it, index, total, original }: { it: Iteration; index: number; total: number; original: string }) {
  const { plan } = it;
  return (
    <article className="space-y-6 fade-up">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-secondary px-3 py-1 text-xs">Version {index + 1}{index === total - 1 ? " · latest" : ""}</span>
        <h2 className="font-display text-2xl font-bold text-brand">{plan.title}</h2>
      </div>
      <p className="text-sm">{plan.summary}</p>

      <section className="glass overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h3 className="font-bold text-brand">Materials</h3>
            {plan.budgetLabel && <p className="text-xs text-muted-foreground">Rough budget</p>}
          </div>
          <span className="font-display text-lg font-bold">{plan.budgetLabel ?? money(plan.totalCost, plan.currency)}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="px-5 py-2">Item</th><th className="px-3 py-2">Qty</th><th className="px-3 py-2 text-right">Unit</th><th className="px-5 py-2 text-right">Total</th></tr>
            </thead>
            <tbody>
              {plan.materials.map((m, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-5 py-2"><div>{m.name}</div>{m.note && <div className="text-xs text-muted-foreground">{m.note}</div>}</td>
                  <td className="px-3 py-2">{m.quantity}</td>
                  <td className="px-3 py-2 text-right">{money(m.unitPrice, plan.currency)}</td>
                  <td className="px-5 py-2 text-right text-brand">{money(m.total, plan.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {plan.diagrams.length > 0 && (
        <section>
          <h3 className="mb-3 font-bold text-brand">Diagrams & measurements</h3>
          <div className="grid gap-4 md:grid-cols-2">{plan.diagrams.map((d, i) => <DiagramView key={i} d={d} />)}</div>
        </section>
      )}

      {plan.stores && plan.stores.length > 0 && (
        <section>
          <h3 className="mb-3 font-bold text-brand">Where to buy</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {plan.stores.map((store, i) => (
              <div key={`${store.name}-${i}`} className="glass rounded-2xl p-4 text-sm">
                <p className="font-bold text-brand">{store.name}</p>
                <p className="text-muted-foreground">{[store.type, store.bestFor].filter(Boolean).join(" · ")}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-3 font-bold text-brand">Steps</h3>
        <ol className="space-y-3">
          {plan.steps.map((s, i) => (
            <li key={i} className="glass flex gap-4 rounded-2xl p-4">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand font-bold text-primary-foreground">{i + 1}</span>
              <div className="text-sm">
                <p className="font-bold">{s.title} <span className="ml-2 text-xs font-normal text-muted-foreground">{s.duration}</span></p>
                <p className="mt-1 text-muted-foreground">{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {plan.tips && plan.tips.length > 0 && (
        <section>
          <h3 className="mb-3 font-bold text-brand">Good to know</h3>
          <ul className="glass space-y-2 rounded-2xl p-4 text-sm text-muted-foreground">
            {plan.tips.map((tip, i) => <li key={i}>• {tip}</li>)}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-3 font-bold text-brand">Before & after</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <figure className="glass overflow-hidden rounded-2xl"><img src={original} alt="Before" className="aspect-square w-full object-cover" /><figcaption className="px-4 py-2 text-xs text-muted-foreground">Your photo</figcaption></figure>
          <figure className="glass overflow-hidden rounded-2xl">
            {it.render ? <img src={it.render} alt="After renovation" className="aspect-square w-full object-cover" /> : <div className="grid aspect-square place-items-center text-sm text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div>}
            <figcaption className="px-4 py-2 text-xs text-muted-foreground">Finished renovation</figcaption>
          </figure>
        </div>
      </section>
      {it.feedback && <p className="rounded-xl border-l-2 border-brand bg-muted px-4 py-2 text-sm">You asked to change: “{it.feedback}”</p>}
    </article>
  );
}

const FALLING = [
  { left: 6, size: 18, dur: 26, delay: -3 },
  { left: 18, size: 14, dur: 32, delay: -18 },
  { left: 31, size: 22, dur: 28, delay: -9 },
  { left: 45, size: 16, dur: 35, delay: -24 },
  { left: 58, size: 20, dur: 30, delay: -14 },
  { left: 71, size: 14, dur: 34, delay: -5 },
  { left: 83, size: 18, dur: 27, delay: -20 },
  { left: 94, size: 16, dur: 31, delay: -11 },
];

function FallingLogos() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      {FALLING.map((f, i) => (
        <div
          key={i}
          className="logo-fall absolute -top-10 grid place-items-center rounded-md bg-brand opacity-20"
          style={{ left: `${f.left}%`, width: f.size + 10, height: f.size + 10, animationDuration: `${f.dur}s`, animationDelay: `${f.delay}s` }}
        >
          <Hammer className="text-primary-foreground" style={{ width: f.size * 0.6, height: f.size * 0.6 }} />
        </div>
      ))}
    </div>
  );
}
