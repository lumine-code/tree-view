const fs = require("./fs-compat");
const { Emitter } = require("lumine");
const { repoForPath } = require("./helpers");
const repositoryStatusObserver = require("./repository-status-observer");

module.exports = class File {
  constructor({ name, fullPath, symlink, ignoredByName = false, useSyncFS, stats }) {
    this.name = name;
    this.symlink = symlink;
    this.ignoredByName = ignoredByName;
    this.stats = stats;
    this.destroyed = false;
    this.emitter = new Emitter();

    this.path = fullPath;
    this.realPath = this.path;

    this.repositoryStatusRegistration = repositoryStatusObserver.observe(this, {
      onSnapshot: (repository) => this.updateStatus(repository),
      onRepositoryChange: (repository) => this.updateStatus(repository),
    });
    this.updateStatus(this.repositoryStatusRegistration.repository);

    if (useSyncFS) {
      this.realPath = fs.realpathSync(this.path);
    } else {
      fs.realpath(this.path, (error, realPath) => {
        if (this.destroyed) return;
        if (error) {
          // Resolving the real path is best-effort; keep the original path and
          // carry on rather than dropping the entry. A missing path is an
          // expected race with watcher-driven moves and removals.
          if (!fs.isMissingPathError(error)) {
            console.warn(
              `tree-view: could not resolve real path for ${this.path}: ${error.message}`,
            );
          }
          return;
        }
        if (realPath && realPath !== this.path) {
          this.realPath = realPath;
          this.updateStatus();
        }
      });
    }
  }

  destroy() {
    this.destroyed = true;
    this.repositoryStatusRegistration.dispose();
    this.emitter.emit("did-destroy");
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  onDidStatusChange(callback) {
    return this.emitter.on("did-status-change", callback);
  }

  // Update the status property of this file using the repo.
  updateStatus(repo = repoForPath(this.path)) {
    let newStatus = null;
    if (repo != null && repo.isPathIgnoredCached(this.path)) {
      newStatus = "ignored";
    } else if (repo != null) {
      const summary = repo.getPathStatusSummary(this.path);
      if (summary != null) {
        if (summary.conflicted) {
          newStatus = "conflicted";
        } else if (summary.modified) {
          newStatus = "modified";
        } else if (summary.added) {
          newStatus = "added";
        }
      }
    }

    if (newStatus !== this.status) {
      this.status = newStatus;
      this.emitter.emit("did-status-change", newStatus);
    }
  }

  isPathEqual(pathToCompare) {
    return this.path === pathToCompare || this.realPath === pathToCompare;
  }
};
