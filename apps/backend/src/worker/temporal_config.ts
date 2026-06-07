/**
 * Worker Temporal-connection config resolver + production-misconfiguration guard (finding H).
 *
 * The spine worker defaults to the dualrun-ISOLATED namespace/queue (`dualrun` /
 * `review-pull-request-dualrun` on `localhost:7233`) so dev + the dual-run never touch a real cluster's
 * path. But those defaults are DANGEROUS against a real cluster: a worker pointed at a production Temporal
 * address while still falling back to the `dualrun` queue would silently poll the wrong queue and process
 * ZERO reviews — a misconfiguration with no error. This resolver fails boot loudly in that case.
 */

export type WorkerTemporalConfig = {
  address: string;
  namespace: string;
  taskQueue: string;
  tls: boolean;
};

const DEFAULT_ADDRESS = "localhost:7233";
const DUALRUN_NAMESPACE = "dualrun";
const DUALRUN_TASK_QUEUE = "review-pull-request-dualrun";

/**
 * A loopback host — dev / dual-run / a `kubectl port-forward`. Never a real cluster. The host is the
 * segment before the (optional) `:port`. An empty/unset address is treated as loopback (the default).
 */
function isLoopbackAddress(address: string): boolean {
  const host = (address.split(":")[0] ?? "").toLowerCase();
  return host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Resolve `{address, namespace, taskQueue, tls}` from an env-like object. When the worker is pointed at a
 * REAL cluster — a non-loopback `TEMPORAL_ADDRESS`, or `NODE_ENV=production` — both `TEMPORAL_NAMESPACE`
 * and `TEMPORAL_TASK_QUEUE` MUST be set explicitly; otherwise this throws rather than fall back to the
 * dualrun-isolated defaults (which would silently process nothing). On a loopback address the defaults
 * apply (dev / dual-run convenience).
 */
export function resolveWorkerTemporalConfig(env: NodeJS.ProcessEnv): WorkerTemporalConfig {
  const address = env.TEMPORAL_ADDRESS ?? DEFAULT_ADDRESS;
  const tls = env.TEMPORAL_TLS === "1";
  const namespace = env.TEMPORAL_NAMESPACE;
  const taskQueue = env.TEMPORAL_TASK_QUEUE;

  const isRealCluster = !isLoopbackAddress(address) || env.NODE_ENV === "production";
  const namespaceMissing = namespace === undefined || namespace === "";
  const taskQueueMissing = taskQueue === undefined || taskQueue === "";

  if (isRealCluster && (namespaceMissing || taskQueueMissing)) {
    throw new Error(
      `Refusing to boot the worker against a real cluster (address=${address}, ` +
        `NODE_ENV=${env.NODE_ENV ?? "unset"}) without TEMPORAL_NAMESPACE + TEMPORAL_TASK_QUEUE set. The ` +
        `dualrun-isolated defaults (${DUALRUN_NAMESPACE} / ${DUALRUN_TASK_QUEUE}) would silently poll the ` +
        `wrong queue and process zero reviews. Set both env vars explicitly.`,
    );
  }

  return {
    address,
    namespace: namespace ?? DUALRUN_NAMESPACE,
    taskQueue: taskQueue ?? DUALRUN_TASK_QUEUE,
    tls,
  };
}
