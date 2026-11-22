import type { CollectorMeta } from "../shared/collectors";
import type {
  AppSettings,
  CollectorConnection,
  CollectorRun,
  DashboardResponse,
  Metric,
  MetricInput,
  Service,
  SeriesResponse,
  ServiceInput,
  Snapshot,
  SnapshotInput,
  PollingInput,
} from "../shared/types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  dashboard: () => request<DashboardResponse>("GET", "/dashboard"),
  getService: (id: number) => request<{ service: Service; metrics: Metric[] }>("GET", `/services/${id}`),
  createService: (input: ServiceInput) => request<Service>("POST", "/services", input),
  updateService: (id: number, input: ServiceInput) => request<Service>("PUT", `/services/${id}`, input),
  deleteService: (id: number) => request<void>("DELETE", `/services/${id}`),
  createMetric: (serviceId: number, input: MetricInput) =>
    request<Metric>("POST", `/services/${serviceId}/metrics`, input),
  updateMetric: (id: number, input: MetricInput) => request<Metric>("PUT", `/metrics/${id}`, input),
  deleteMetric: (id: number) => request<void>("DELETE", `/metrics/${id}`),
  listSnapshots: (metricId: number, limit = 20) =>
    request<Snapshot[]>("GET", `/metrics/${metricId}/snapshots?limit=${limit}`),
  addSnapshot: (metricId: number, input: SnapshotInput) =>
    request<Snapshot>("POST", `/metrics/${metricId}/snapshots`, input),
  deleteSnapshot: (id: number) => request<void>("DELETE", `/snapshots/${id}`),
  collectors: () => request<CollectorMeta[]>("GET", "/collectors"),
  getConnection: (serviceId: number) => request<CollectorConnection>("GET", `/services/${serviceId}/collector`),
  connect: (serviceId: number, collectorId: string, fields: Record<string, string>) =>
    request<{ ok: true; createdMetrics: number }>("PUT", `/services/${serviceId}/collector`, { collectorId, fields }),
  disconnect: (serviceId: number) => request<void>("DELETE", `/services/${serviceId}/collector`),
  collectNow: (serviceId: number) =>
    request<{ status: string; error: string | null; saved: number }>("POST", `/services/${serviceId}/collect`),
  backfill: (serviceId: number) =>
    request<{ saved: number; days: number }>("POST", `/services/${serviceId}/backfill`),
  runs: (serviceId: number) => request<CollectorRun[]>("GET", `/services/${serviceId}/runs`),
  setPolling: (serviceId: number, input: PollingInput) => request<Service>("PUT", `/services/${serviceId}/polling`, input),
  setMetricPolling: (metricId: number, enabled: boolean) =>
    request<Metric>("PUT", `/metrics/${metricId}/polling`, { enabled }),
  getSettings: () => request<AppSettings>("GET", "/settings"),
  saveSettings: (s: Pick<AppSettings, "schedulerEnabled" | "autoPauseAfter" | "notificationsEnabled">) =>
    request<AppSettings>("PUT", "/settings", s),
  setWebhook: (url: string) => request<AppSettings>("PUT", "/settings/webhook", { url }),
  testWebhook: () => request<{ ok: true }>("POST", "/settings/webhook/test"),
  series: (metricId: number, granularity: "day" | "month", count: number) =>
    request<SeriesResponse>(
      "GET",
      `/metrics/${metricId}/series?granularity=${granularity}&${granularity === "day" ? "days" : "months"}=${count}`,
    ),
};
