const path = require("path");
const fs = require("./fs-compat");
const Dialog = require("./dialog");
const { repoForPath } = require("./helpers");

module.exports = class CopyDialog extends Dialog {
  constructor(initialPath, { copy, onCopy, onCopyFailed }) {
    const isDirectory = fs.isDirectorySync(initialPath);
    const checkboxes = isDirectory
      ? undefined
      : [{ label: "Open file after copying", config: "tree-view.openAfterCopy" }];
    super({
      prompt: "Enter the new path for the duplicate.",
      info: "Paths are relative to the project root unless absolute.",
      initialPath: lumine.project.relativize(initialPath),
      select: true,
      isDirectory,
      iconClass: "icon-arrow-right",
      checkboxes,
    });

    this.initialPath = initialPath;
    this.copy =
      copy ??
      ((sourcePath, destinationPath) =>
        new Promise((resolve, reject) => {
          fs.copy(sourcePath, destinationPath, (error) => (error ? reject(error) : resolve()));
        }));
    this.onCopy = onCopy;
    this.onCopyFailed = onCopyFailed;
  }

  async onConfirm(newPath) {
    newPath = newPath.replace(/\s+$/, ""); // Remove trailing whitespace
    if (!path.isAbsolute(newPath)) {
      const [rootPath] = Array.from(lumine.project.relativizePath(this.initialPath));
      if (rootPath == null) {
        return;
      }
      newPath = path.join(rootPath, newPath);
    }

    if (this.initialPath === newPath) {
      this.close();
      return;
    }

    if (fs.existsSync(newPath)) {
      this.showError(`'${newPath}' already exists.`);
      return;
    }

    let activeEditor = lumine.workspace.getActiveTextEditor();
    if (activeEditor?.getPath() !== this.initialPath) {
      activeEditor = null;
    }
    this.close();
    try {
      const result = await this.copy(this.initialPath, newPath);
      if (result?.cancelled) {
        this.onCopyFailed?.({ initialPath: this.initialPath, newPath });
        return;
      }
      this.onCopy?.({ initialPath: this.initialPath, newPath });
      if (!fs.isDirectorySync(newPath) && lumine.config.get("tree-view.openAfterCopy")) {
        const openOptions = { activatePane: true };
        if (activeEditor) {
          openOptions.initialLine = activeEditor.getLastCursor().getBufferRow();
          openOptions.initialColumn = activeEditor.getLastCursor().getBufferColumn();
        }
        await lumine.workspace.open(newPath, openOptions);
      }
      let repo;
      if ((repo = repoForPath(newPath))) {
        repo.scheduleStatusSnapshotRefresh();
      }
    } catch (error) {
      this.onCopyFailed?.({ initialPath: this.initialPath, newPath });
      lumine.notifications.addWarning(`Failed to copy '${this.initialPath}'`, {
        detail: error.message,
        dismissable: true,
      });
    }
  }
};
