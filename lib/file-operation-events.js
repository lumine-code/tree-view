const { Disposable } = require("lumine");
const {
  isPreparation,
  commitPreparation,
  disposePreparation,
} = require("./file-operation-preparation");

const KINDS = ["willCreate", "willRename", "willDelete", "didCreate", "didRename", "didDelete"];
const CANCELLED = Symbol("cancelled file operation preparation");

function awaitListener(callback, payload) {
  const signal = payload?.signal;
  if (signal?.aborted) return Promise.resolve(CANCELLED);
  const pending = Promise.resolve(callback(payload));
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      signal.removeEventListener("abort", onAbort);
      resolve(CANCELLED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted || signal.aborted) {
          void disposePreparation(result);
          resolve(CANCELLED);
        } else {
          resolve(result);
        }
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted || signal.aborted) resolve(CANCELLED);
        else reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function collectedPreparation(preparations, signal) {
  let disposed = false;
  let commitPromise;
  return {
    commit({ isCurrent: current = () => true } = {}) {
      const isCurrent = () => !disposed && !signal?.aborted && current();
      commitPromise ??= (async () => {
        for (const preparation of preparations) {
          if (!(await commitPreparation(preparation, { isCurrent }))) return false;
        }
        return isCurrent();
      })();
      return commitPromise;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.all(preparations.map(disposePreparation));
    },
  };
}

module.exports = class FileOperationEvents {
  constructor() {
    this.listeners = new Map(KINDS.map((kind) => [kind, new Set()]));
  }

  on(kind, callback) {
    const listeners = this.listeners.get(kind);
    if (!listeners) throw new Error(`Unknown file operation event '${kind}'`);
    listeners.add(callback);
    return new Disposable(() => listeners.delete(callback));
  }

  async will(kind, payload) {
    const preparations = [];
    let accepted = false;
    try {
      for (const callback of this.listeners.get(kind) || []) {
        const result = await awaitListener(callback, payload);
        if (result === false || result === CANCELLED) return false;
        if (isPreparation(result)) preparations.push(result);
      }
      if (payload?.signal?.aborted) return false;
      accepted = true;
      return preparations.length ? collectedPreparation(preparations, payload?.signal) : true;
    } catch (error) {
      if (!payload?.signal?.aborted)
        console.error("tree-view file operation listener failed", error);
      return false;
    } finally {
      if (!accepted) await Promise.all(preparations.map(disposePreparation));
    }
  }

  async did(kind, payload) {
    const settled = await Promise.allSettled(
      [...(this.listeners.get(kind) || [])].map((callback) => {
        try {
          return callback(payload);
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
    for (const result of settled) {
      if (result.status === "rejected") {
        console.error("tree-view file operation listener failed", result.reason);
      }
    }
  }

  service() {
    return {
      supportsStagedPreparations: () => true,
      onWillCreateFiles: (callback) => this.on("willCreate", callback),
      onWillRenameFiles: (callback) => this.on("willRename", callback),
      onWillDeleteFiles: (callback) => this.on("willDelete", callback),
      onDidCreateFiles: (callback) => this.on("didCreate", callback),
      onDidRenameFiles: (callback) => this.on("didRename", callback),
      onDidDeleteFiles: (callback) => this.on("didDelete", callback),
    };
  }
};
