import { awsS3 } from "./aws-s3";
import { cloudflareWorkers } from "./cloudflare-workers";
import { demo } from "./demo";
import { githubActions } from "./github-actions";
import { googleDrive } from "./google-drive";
import { openaiCosts } from "./openai-costs";
import type { Collector } from "./types";

const ALL: Collector[] = [githubActions, cloudflareWorkers, openaiCosts, googleDrive, awsS3, demo];

/** サービスを追加するときは shared/collectors.ts にメタデータ、ここに実装を 1 つ足すだけ */
export function getCollector(id: string, opts: { allowDemo: boolean }): Collector | undefined {
  const c = ALL.find((x) => x.meta.id === id);
  if (!c || (c.meta.devOnly && !opts.allowDemo)) return undefined;
  return c;
}

export function listCollectors(opts: { allowDemo: boolean }) {
  return ALL.filter((c) => !c.meta.devOnly || opts.allowDemo).map((c) => c.meta);
}
