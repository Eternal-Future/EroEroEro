// Fire-and-forget work (tag db refresh, cache warmups). On Workers/Vercel an
// unawaited promise can be cancelled as soon as the response is returned, so
// the request-scoped ExecutionContext is used when the runtime provides one.

type BackgroundRunner = (work: Promise<unknown>) => void;

const defaultRunner: BackgroundRunner = (work) => {
  void work.catch(() => {});
};

let runner: BackgroundRunner = defaultRunner;

export function runInBackground(work: Promise<unknown>): void {
  runner(work);
}

/** Bind the current request's ExecutionContext (Workers/Vercel). */
export function setBackgroundRunner(ctx: { waitUntil?: (p: Promise<unknown>) => void } | null): void {
  if (!ctx || typeof ctx.waitUntil !== "function") {
    runner = defaultRunner;
    return;
  }
  const waitUntil = ctx.waitUntil.bind(ctx);
  runner = (work) => {
    try {
      waitUntil(work.catch(() => {}));
    } catch {
      // context already finished; run detached instead of throwing
      void work.catch(() => {});
    }
  };
}