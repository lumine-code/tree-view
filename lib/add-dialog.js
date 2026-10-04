const path = require("path");
const fs = require("./fs-compat");
const Dialog = require("./dialog");
const { repoForPath } = require("./helpers");
const {
  isPreparation,
  commitPreparation,
  disposePreparation,
} = require("./file-operation-preparation");

module.exports = class AddDialog extends Dialog {
  constructor(initialPath, isCreatingFile, { willCreate, didCreate } = {}) {
    let directoryPath;

    if (fs.isFileSync(initialPath)) {
      directoryPath = path.dirname(initialPath);
    } else {
      directoryPath = initialPath;
    }

    let rootProjectPath;
    let relativeDirectoryPath;
    [rootProjectPath, relativeDirectoryPath] = lumine.project.relativizePath(directoryPath);
    if (relativeDirectoryPath.length > 0) {
      relativeDirectoryPath += path.sep;
    }

    super({
      prompt: "Enter the path for the new " + (isCreatingFile ? "file." : "folder."),
      info: isCreatingFile
        ? "Paths are relative to the project root unless absolute."
        : "Paths are relative to the project root unless absolute. Nested folders are created as needed.",
      initialPath: relativeDirectoryPath,
      select: false,
      isDirectory: !isCreatingFile,
      iconClass: isCreatingFile ? "icon-file-add" : "icon-file-directory-create",
    });

    this.isCreatingFile = isCreatingFile;
    this.rootProjectPath = rootProjectPath;
    this.willCreate = willCreate;
    this.didCreate = didCreate;
  }

  // The callback is handed `{path, open}`: `open` is what the confirm asked
  // for, and whoever adds the entry to the tree decides what to do with it.
  onDidCreateFile(callback) {
    return this.emitter.on("did-create-file", callback);
  }

  onDidCreateDirectory(callback) {
    return this.emitter.on("did-create-directory", callback);
  }

  async onConfirm(newPath, { open = false, signal } = {}) {
    newPath = newPath.replace(/\s+$/, ""); // Remove trailing whitespace
    const endsWithDirectorySeparator = newPath[newPath.length - 1] === path.sep;
    if (!path.isAbsolute(newPath)) {
      if (this.rootProjectPath == null) {
        this.showError("You must open a directory to create a file with a relative path");
        return;
      }

      newPath = path.join(this.rootProjectPath, newPath);
    }

    if (!newPath) {
      return;
    }

    let preparation;
    try {
      if (fs.existsSync(newPath)) {
        return this.showError(`'${newPath}' already exists.`);
      } else if (this.isCreatingFile) {
        if (endsWithDirectorySeparator) {
          return this.showError(`File names must not end with a '${path.sep}' character.`);
        } else {
          const payload = { paths: [newPath], entries: [{ path: newPath, isDirectory: false }] };
          const destinationSnapshot = this.pathSnapshot(newPath);
          const isCurrent = () =>
            this.preparationIsCurrent(signal) && this.pathIsCurrent(newPath, destinationSnapshot);
          if (this.willCreate) {
            preparation = await this.willCreate({ ...payload, signal });
            if (!this.preparationIsCurrent(signal) || preparation === false) return;
          }
          if (!this.pathIsCurrent(newPath, destinationSnapshot))
            return this.showError(`'${newPath}' already exists.`);
          if (!isCurrent()) return;
          this.startOperation();
          if (isPreparation(preparation) && !(await commitPreparation(preparation, { isCurrent })))
            return;
          if (!isCurrent()) return;
          fs.writeFileSync(newPath, "", { flag: "wx" });
          if (this.didCreate) await this.didCreate(payload);
          repoForPath(newPath)?.scheduleStatusSnapshotRefresh();
          this.emitter.emit("did-create-file", { path: newPath, open });
          // Opening the file takes focus to the editor it lands in; leaving it
          // closed stays in the tree, which is where a new folder already lands.
          return open ? this.close() : this.cancel();
        }
      } else {
        const payload = { paths: [newPath], entries: [{ path: newPath, isDirectory: true }] };
        const destinationSnapshot = this.pathSnapshot(newPath);
        const isCurrent = () =>
          this.preparationIsCurrent(signal) && this.pathIsCurrent(newPath, destinationSnapshot);
        if (this.willCreate) {
          preparation = await this.willCreate({ ...payload, signal });
          if (!this.preparationIsCurrent(signal) || preparation === false) return;
        }
        if (!this.pathIsCurrent(newPath, destinationSnapshot))
          return this.showError(`'${newPath}' already exists.`);
        if (!isCurrent()) return;
        this.startOperation();
        if (isPreparation(preparation) && !(await commitPreparation(preparation, { isCurrent })))
          return;
        if (!isCurrent()) return;
        fs.makeTreeSync(path.dirname(newPath));
        fs.mkdirSync(newPath);
        if (this.didCreate) await this.didCreate(payload);
        this.emitter.emit("did-create-directory", newPath);
        return this.cancel();
      }
    } catch (error) {
      if (signal?.aborted && !this.operationStarted) return;
      if (this.closed) {
        lumine.notifications.addWarning(`Failed to create '${newPath}'`, {
          detail: error.message,
          dismissable: true,
        });
        return;
      }
      if (error.code === "EEXIST") return this.showError(`'${newPath}' already exists.`);
      return this.showError(`${error.message}.`);
    } finally {
      await disposePreparation(preparation);
      this.finishOperation();
    }
  }
};
