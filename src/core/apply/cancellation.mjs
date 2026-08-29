export function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

export async function runAbortable(signal, action) {
  throwIfAborted(signal);
  try {
    const result = await action();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
}

export function withAbortSignal(input, signal) {
  return signal ? { ...input, signal } : input;
}

export function abortableDelay(delayMs, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
