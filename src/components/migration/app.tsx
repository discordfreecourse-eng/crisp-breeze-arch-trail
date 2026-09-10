import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  FileText,
  Folder,
  HardDrive,
  LoaderCircle,
  Pause,
  Play,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  cancelCopyFn,
  deleteItemFn,
  disconnectGoogleFn,
  getOverview,
  ingestLinks,
  pauseCopyFn,
  resumeCopyFn,
  selectAllFn,
  startCopyFn,
  startGoogleConnect,
  startResolve,
  toggleItemFn,
  updateSettingsFn,
} from "@/lib/fn/migration";
import { formatBytes, formatEta, formatGbPerHour, formatRate, mimeLabel } from "@/lib/jobs/format";
import type { Overview, SourceItem } from "@/lib/jobs/types";
import { cn } from "@/lib/utils";

function useOverview(initial?: Overview) {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => getOverview(),
    initialData: initial,
    refetchInterval: (query) => {
      const status = query.state.data?.job?.status;
      if (status === "running" || status === "resolving") return 1000;
      return 4000;
    },
  });
}

function statusTone(status: string | undefined) {
  if (status === "completed") return "ok" as const;
  if (status === "running" || status === "resolving") return "info" as const;
  if (status === "paused") return "warn" as const;
  if (status === "failed") return "danger" as const;
  return "neutral" as const;
}

function statusLabel(status: string | undefined) {
  switch (status) {
    case "draft":
      return "Links extracted";
    case "resolving":
      return "Resolving";
    case "ready":
      return "Ready";
    case "running":
      return "Copying";
    case "paused":
      return "Paused";
    case "completed":
      return "Done";
    case "failed":
      return "Stopped";
    default:
      return "Idle";
  }
}

export function MigrationApp({ initial }: { initial?: Overview }) {
  const query = useOverview(initial);
  const data = query.data;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (!oauth) return;
    if (oauth === "connected") toast.success("Google Drive connected");
    if (oauth === "error") {
      toast.error(params.get("reason") || "Google sign-in failed");
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("oauth");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url.pathname);
  }, []);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
        <Header data={data} />
        {query.isLoading && !data ? <SkeletonBoard /> : null}
        {query.error ? (
          <p className="text-sm text-danger">
            {query.error instanceof Error ? query.error.message : "Could not load status."}
          </p>
        ) : null}
        {data ? (
          <>
            <ConnectPanel data={data} />
            <SourcePanel data={data} />
            <InventoryPanel data={data} />
            <ProgressPanel data={data} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function Header({ data }: { data?: Overview }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-2">
        <p className="font-mono text-xs tracking-[0.18em] text-subtle uppercase">
          One-time Drive migration
        </p>
        <h1 className="font-display text-4xl font-medium tracking-[-0.03em] text-foreground sm:text-5xl">
          Raw Copy
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          Pull vendor Drive links from a PDF, pick what to keep, then copy files
          server-side into <span className="font-mono text-foreground">/{data?.destFolderName ?? "Raw"}</span>.
          The browser can close. Nothing is downloaded through this machine.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={data?.google.connected ? "ok" : "neutral"}>
          {data?.google.connected ? data.google.email ?? "Connected" : "Drive disconnected"}
        </Badge>
        <Badge tone={statusTone(data?.job?.status)}>{statusLabel(data?.job?.status)}</Badge>
      </div>
    </header>
  );
}

function Panel({
  step,
  title,
  children,
}: {
  step: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)] sm:p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium tracking-tight">
          <span className="mr-2 font-mono text-xs text-subtle">{step}</span>
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function ConnectPanel({ data }: { data: Overview }) {
  const qc = useQueryClient();
  const connect = useMutation({
    mutationFn: () => startGoogleConnect(),
    onSuccess: ({ url }) => {
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) window.location.href = url;
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Connect failed"),
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectGoogleFn(),
    onSuccess: async () => {
      toast.message("Disconnected");
      await qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  const ready = data.google.hasClientId && data.google.hasClientSecret;

  return (
    <Panel step="01" title="Connect your Google Drive">
      {!ready ? (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Add your own OAuth client (not a shared Cursor or Grok account). Create a
            Google Cloud project, enable Drive API, then set these environment variables:
          </p>
          <ul className="space-y-1 font-mono text-xs text-foreground">
            <li>GOOGLE_CLIENT_ID {data.google.hasClientId ? "· set" : "· missing"}</li>
            <li>GOOGLE_CLIENT_SECRET {data.google.hasClientSecret ? "· set" : "· missing"}</li>
            <li>PUBLIC_BASE_URL · {data.google.publicOrigin}</li>
            <li>DATABASE_URL · Postgres on Northflank; this preview uses a local store</li>
          </ul>
          <p>
            Authorized redirect URI to register in Google Cloud:
          </p>
          <code className="block break-all rounded-md bg-raised px-3 py-2 font-mono text-xs text-foreground">
            {data.google.redirectUri}
          </code>
        </div>
      ) : data.google.connected ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Signed in as <span className="text-foreground">{data.google.email}</span>.
            Files copy into this account, under /{data.destFolderName}.
          </p>
          <Button variant="secondary" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            OAuth is configured. Connect the destination Drive that should own /{data.destFolderName}.
          </p>
          <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
            {connect.isPending ? "Redirecting…" : "Connect Google Drive"}
          </Button>
        </div>
      )}
    </Panel>
  );
}

function SourcePanel({ data }: { data: Overview }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState("");
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);

  const ingest = useMutation({
    mutationFn: (payload: { text: string; filename: string | null }) => ingestLinks({ data: payload }),
    onSuccess: async (res) => {
      toast.success(`Found ${res.count} Drive link(s)`);
      setPaste("");
      await qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "No links found"),
  });

  const resolve = useMutation({
    mutationFn: () => startResolve(),
    onSuccess: async () => {
      toast.message("Resolving files in the background");
      await qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Resolve failed"),
  });

  async function uploadPdf(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/jobs/pdf", { method: "POST", body: form });
      const json = (await res.json()) as { count?: number; error?: string };
      if (!res.ok) throw new Error(json.error || "Upload failed");
      toast.success(`Found ${json.count} Drive link(s) in ${file.name}`);
      await qc.invalidateQueries({ queryKey: ["overview"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const locked = data.job?.status === "running" || data.job?.status === "resolving";

  return (
    <Panel step="02" title="Load vendor links">
      <div
        className={cn(
          "flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg bg-raised px-4 py-8 text-center shadow-[var(--shadow-border)]",
          drag && "shadow-[var(--shadow-border-hover)]",
        )}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const file = e.dataTransfer.files[0];
          if (file) void uploadPdf(file);
        }}
      >
        <Upload className="size-5 text-muted-foreground" />
        <p className="text-sm text-foreground">Drop a PDF of Drive links, or click to choose</p>
        <p className="text-xs text-subtle">PDFs up to 25 MB. Links are extracted on the server.</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          disabled={busy || locked}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadPdf(file);
            e.target.value = "";
          }}
        />
      </div>

      <div className="mt-4 space-y-2">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="paste">
          Or paste links
        </label>
        <textarea
          id="paste"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="https://drive.google.com/drive/folders/…"
          rows={3}
          disabled={locked}
          className="w-full resize-y rounded-md bg-raised px-3 py-2 font-mono text-xs text-foreground shadow-[var(--shadow-border)] placeholder:text-subtle outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={!paste.trim() || ingest.isPending || locked}
            onClick={() => ingest.mutate({ text: paste, filename: "pasted-links" })}
          >
            Extract pasted links
          </Button>
          <Button
            disabled={!data.job || data.links.length === 0 || resolve.isPending || locked || !data.google.connected}
            onClick={() => resolve.mutate()}
          >
            {data.job?.status === "resolving" ? "Resolving…" : "Resolve folders and files"}
          </Button>
        </div>
      </div>

      {data.links.length > 0 ? (
        <div className="mt-3 space-y-2">
          <p className="font-mono text-xs text-muted-foreground">
            {data.links.length} unique Drive ID{data.links.length === 1 ? "" : "s"}
            {data.job?.sourceFilename ? ` from ${data.job.sourceFilename}` : ""}.
          </p>
          <ul className="max-h-32 overflow-auto rounded-md bg-raised/60 px-3 py-2 font-mono text-xs text-subtle">
            {data.links.map((link) => (
              <li key={link.driveId} className="truncate py-0.5">
                <span className="text-muted-foreground">{link.kindHint}</span>
                {" · "}
                {link.driveId}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

function InventoryPanel({ data }: { data: Overview }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [concurrency, setConcurrency] = useState(String(data.concurrency));
  const [budget, setBudget] = useState(String(Math.round(data.dailyBudgetGb)));
  const [destName, setDestName] = useState(data.destFolderName);

  useEffect(() => {
    setConcurrency(String(data.concurrency));
    setBudget(String(Math.round(data.dailyBudgetGb)));
    setDestName(data.destFolderName);
  }, [data.concurrency, data.dailyBudgetGb, data.destFolderName]);

  const toggle = useMutation({
    mutationFn: (payload: { driveId: string; selected: boolean }) => toggleItemFn({ data: payload }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview"] }),
  });
  const selectAll = useMutation({
    mutationFn: (selected: boolean) => selectAllFn({ data: { selected } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview"] }),
  });
  const remove = useMutation({
    mutationFn: (driveId: string) => deleteItemFn({ data: { driveId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview"] }),
  });
  const saveSettings = useMutation({
    mutationFn: () =>
      updateSettingsFn({
        data: {
          concurrency: Number(concurrency) || 5,
          dailyBudgetGb: Number(budget) || 600,
          destFolderName: destName.trim() || "Raw",
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview"] }),
  });
  const start = useMutation({
    mutationFn: async () => {
      await saveSettings.mutateAsync();
      return startCopyFn();
    },
    onSuccess: async (res) => {
      toast.success(`Queued ${res.queued} file(s)`);
      await qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not start"),
  });

  const roots = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? data.items.filter((i) => i.name.toLowerCase().includes(q) || i.path.toLowerCase().includes(q))
      : data.items;
    return filtered.filter((i) => !i.parentDriveId || !data.items.some((p) => p.driveId === i.parentDriveId));
  }, [data.items, query]);

  const childrenOf = (id: string) => data.items.filter((i) => i.parentDriveId === id);

  const locked = data.job?.status === "running" || data.job?.status === "resolving";
  const canStart =
    Boolean(data.google.connected) &&
    data.selectedFiles > 0 &&
    !locked &&
    data.job?.status !== "completed";

  if (!data.job || (data.items.length === 0 && data.job.status === "draft")) {
    return (
      <Panel step="03" title="Select what to copy">
        <p className="text-sm text-muted-foreground">
          Resolve Drive links to see names, types, sizes, and folder file counts.
        </p>
      </Panel>
    );
  }

  return (
    <Panel step="03" title="Select what to copy">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={locked} onClick={() => selectAll.mutate(true)}>
            Select all
          </Button>
          <Button variant="secondary" size="sm" disabled={locked} onClick={() => selectAll.mutate(false)}>
            Select none
          </Button>
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name"
          className="sm:max-w-56"
        />
      </div>

      <div className="max-h-[28rem] overflow-auto rounded-lg bg-raised/60">
        {data.job.status === "resolving" && data.items.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-8 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Walking folders…
          </div>
        ) : roots.length === 0 ? (
          <p className="px-3 py-8 text-sm text-muted-foreground">No items match.</p>
        ) : (
          <ul>
            {roots.map((item) => (
              <TreeRow
                key={item.id}
                item={item}
                depth={0}
                childrenOf={childrenOf}
                open={open}
                setOpen={setOpen}
                locked={locked}
                onToggle={(driveId, selected) => toggle.mutate({ driveId, selected })}
                onDelete={(driveId) => remove.mutate(driveId)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Selected items" value={String(data.selectedCount)} />
        <Stat label="Selected files" value={String(data.selectedFiles)} />
        <Stat label="Selected size" value={formatBytes(data.selectedBytes)} />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          Concurrent workers
          <Input
            type="number"
            min={1}
            max={20}
            value={concurrency}
            disabled={data.job.status === "resolving"}
            onChange={(e) => setConcurrency(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Daily budget (GB)
          <Input
            type="number"
            min={1}
            max={5000}
            value={budget}
            disabled={data.job.status === "resolving"}
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Destination folder
          <Input
            value={destName}
            disabled={locked || data.job.status === "running"}
            onChange={(e) => setDestName(e.target.value)}
          />
        </label>
      </div>
      <div className="mt-4">
        <Button
          className="w-full sm:w-auto"
          disabled={!canStart || start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending ? "Starting…" : "Start Copy"}
        </Button>
      </div>
    </Panel>
  );
}

function TreeRow({
  item,
  depth,
  childrenOf,
  open,
  setOpen,
  locked,
  onToggle,
  onDelete,
}: {
  item: SourceItem;
  depth: number;
  childrenOf: (id: string) => SourceItem[];
  open: Record<string, boolean>;
  setOpen: Dispatch<SetStateAction<Record<string, boolean>>>;
  locked: boolean;
  onToggle: (driveId: string, selected: boolean) => void;
  onDelete: (driveId: string) => void;
}) {
  const kids = childrenOf(item.driveId);
  const expanded = open[item.driveId] ?? depth < 1;
  return (
    <li>
      <div
        className="flex items-center gap-2 border-b border-border px-2 py-2"
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {item.kind === "folder" ? (
          <button
            type="button"
            className="relative size-8 shrink-0 text-subtle after:absolute after:inset-0"
            onClick={() => setOpen((s) => ({ ...s, [item.driveId]: !expanded }))}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronRight className={cn("size-4 transition-transform duration-[var(--motion-quick)]", expanded && "rotate-90")} />
          </button>
        ) : (
          <span className="size-8 shrink-0" />
        )}
        <Checkbox
          checked={item.selected}
          disabled={locked}
          onCheckedChange={(v) => onToggle(item.driveId, v === true)}
          aria-label={`Select ${item.name}`}
        />
        {item.kind === "folder" ? (
          <Folder className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">{item.name}</p>
          <p className="truncate font-mono text-xs text-subtle">
            {mimeLabel(item.mimeType, item.kind)}
            {item.kind === "folder"
              ? ` · ${item.fileCount} files · ${formatBytes(item.totalSizeBytes)}`
              : ` · ${formatBytes(item.sizeBytes)}`}
          </p>
        </div>
        <button
          type="button"
          className="relative size-11 shrink-0 text-subtle hover:text-danger"
          disabled={locked}
          onClick={() => onDelete(item.driveId)}
          aria-label={`Remove ${item.name}`}
        >
          <Trash2 className="mx-auto size-4" />
        </button>
      </div>
      {item.kind === "folder" && expanded ? (
        <ul>
          {kids.map((child) => (
            <TreeRow
              key={child.id}
              item={child}
              depth={depth + 1}
              childrenOf={childrenOf}
              open={open}
              setOpen={setOpen}
              locked={locked}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ProgressPanel({ data }: { data: Overview }) {
  const qc = useQueryClient();
  const pause = useMutation({
    mutationFn: () => pauseCopyFn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview"] }),
  });
  const resume = useMutation({
    mutationFn: () => resumeCopyFn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview"] }),
  });
  const cancel = useMutation({
    mutationFn: () => cancelCopyFn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview"] }),
  });

  const p = data.progress;
  const job = data.job;
  if (!job || !p || p.filesTotal === 0 && job.status === "draft") {
    return (
      <Panel step="04" title="Live copy">
        <p className="text-sm text-muted-foreground">
          After Start Copy, the backend walks the queue with {data.concurrency} workers,
          throttled to about {Math.round(data.dailyBudgetGb)} GB / 24 hours.
          {data.longRunning
            ? " Close the browser — the job keeps going on this Northflank service."
            : " Keep this tab open here so the worker can tick; on Northflank the job keeps going after you close the browser."}
        </p>
      </Panel>
    );
  }

  const done = p.filesCopied + p.filesFailed + p.filesSkipped;
  const pct = p.filesTotal ? (done / p.filesTotal) * 100 : 0;
  const remaining = p.filesPending + p.filesCopying;

  return (
    <Panel step="04" title="Live copy">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge>
        <span className="font-mono text-xs text-subtle">
          Destination /{job.destFolderName}
        </span>
      </div>
      <Progress value={pct} className="mb-5" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Completed" value={`${p.filesCopied}/${p.filesTotal}`} />
        <Stat label="Remaining" value={String(remaining)} />
        <Stat label="Data copied" value={formatBytes(p.bytesCopied)} />
        <Stat label="ETA" value={formatEta(p.etaSeconds)} />
        <Stat label="Files / sec" value={formatRate(p.filesPerSec)} />
        <Stat label="Throughput" value={formatGbPerHour(p.gbPerHour)} />
        <Stat label="Failures" value={String(p.filesFailed)} />
        <Stat label="Retries" value={String(p.retries)} />
      </div>
      <p className="mt-3 font-mono text-xs text-subtle">
        24h window {formatBytes(p.bytesCopiedWindow24h)} / {formatBytes(job.dailyBudgetBytes)}
        {p.filesCopying ? ` · ${p.filesCopying} in flight` : ""}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {job.status === "running" ? (
          <Button variant="secondary" onClick={() => pause.mutate()} disabled={pause.isPending}>
            <Pause className="size-4" /> Pause
          </Button>
        ) : null}
        {job.status === "paused" ? (
          <Button onClick={() => resume.mutate()} disabled={resume.isPending}>
            <Play className="size-4" /> Resume
          </Button>
        ) : null}
        {job.status === "running" || job.status === "paused" ? (
          <Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Cancel remaining
          </Button>
        ) : null}
        {job.status === "completed" ? (
          <span className="inline-flex items-center gap-1 text-sm text-ok">
            <Check className="size-4" /> Copy finished
          </span>
        ) : null}
      </div>

      {job.status === "running" ? (
        <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <HardDrive className="mt-0.5 size-3.5 shrink-0" />
          This job runs on the server. You can close the tab. On Northflank, keep this
          service running — copies use Drive <span className="font-mono">files.copy</span>, not local disk.
        </p>
      ) : null}

      {data.recentCopies && data.recentCopies.length > 0 ? (
        <div className="mt-5">
          <p className="mb-2 text-xs tracking-wide text-subtle uppercase">Recent destination IDs</p>
          <ul className="max-h-36 space-y-1 overflow-auto font-mono text-xs">
            {data.recentCopies.map((row, i) => (
              <li key={`${row.sourceName}-${row.destFileId ?? i}`} className="flex gap-2 text-subtle">
                <span
                  className={cn(
                    "shrink-0",
                    row.status === "copied" && "text-ok",
                    row.status === "failed" && "text-danger",
                    row.status === "copying" && "text-warn",
                  )}
                >
                  {row.status}
                </span>
                <span className="min-w-0 truncate text-foreground">{row.sourceName}</span>
                <span className="ml-auto shrink-0">{row.destFileId ?? "—"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.logs.length > 0 ? (
        <ol className="mt-5 max-h-48 space-y-1 overflow-auto font-mono text-xs leading-relaxed">
          {data.logs.map((log) => (
            <li
              key={log.id}
              className={cn(
                "text-subtle",
                log.level === "error" && "text-danger",
                log.level === "warn" && "text-warn",
                log.level === "info" && "text-muted-foreground",
              )}
            >
              {log.message}
            </li>
          ))}
        </ol>
      ) : null}
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-raised px-3 py-3">
      <p className="text-micro tracking-wide text-subtle uppercase">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function SkeletonBoard() {
  return (
    <div className="space-y-4">
      <div className="h-36 animate-pulse rounded-xl bg-card" />
      <div className="h-48 animate-pulse rounded-xl bg-card" />
    </div>
  );
}
