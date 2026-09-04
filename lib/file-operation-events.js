const { Disposable } = require("lumine");

const KINDS = ["willCreate", "willRename", "willDelete", "didCreate", "didRename", "didDelete"];

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
    for (const callback of this.listeners.get(kind) || []) {
      try {
        if ((await callback(payload)) === false) return false;
      } catch (error) {
        console.error("tree-view file operation listener failed", error);
        return false;
      }
    }
    return true;
  }

  async did(kind, payload) {
    const settled = await Promise.allSettled(
      [...(this.listeners.get(kind) || [])].map((callback) => callback(payload)),
    );
    for (const result of settled) {
      if (result.status === "rejected") {
        console.error("tree-view file operation listener failed", result.reason);
      }
    }
  }

  service() {
    return {
      onWillCreateFiles: (callback) => this.on("willCreate", callback),
      onWillRenameFiles: (callback) => this.on("willRename", callback),
      onWillDeleteFiles: (callback) => this.on("willDelete", callback),
      onDidCreateFiles: (callback) => this.on("didCreate", callback),
      onDidRenameFiles: (callback) => this.on("didRename", callback),
      onDidDeleteFiles: (callback) => this.on("didDelete", callback),
    };
  }
};
