const { CompositeDisposable, Emitter, Range, Point } = require("lumine");
const path = require("path");

module.exports = class Dialog {
  constructor(param) {
    if (param == null) {
      param = {};
    }
    const { initialPath, select, isDirectory, iconClass, prompt, info } = param;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();

    // The prompt renders above the input as an icon label.
    this.promptText = document.createElement("label");
    this.promptText.classList.add("icon");
    if (iconClass) {
      this.promptText.classList.add(iconClass);
    }
    this.promptText.textContent = prompt;

    this.inputDialogView = lumine.workspace.buildInputDialog({
      className: "tree-view-dialog",
      headerElement: this.promptText,
      infoMessage: info,
      // The path is seeded below, before the dialog is ever shown: the query
      // here is the value being edited, not a filter to start empty.
      preserveQuery: true,
      didConfirm: (newPath) => this.onConfirm(newPath),
      didCancel: () => this.cancel(),
    });
    this.element = this.inputDialogView.element;
    this.miniEditor = this.inputDialogView.refs.queryEditor;
    this.isDirectory = isDirectory;

    // Registered on the dialog root in the package's own namespace, which is
    // what puts it in the item-actions list (F12) with its description and
    // keystroke. The dialogs contribute nothing else, so this is the whole
    // list.
    this.disposables.add(
      lumine.commands.add(this.element, {
        "tree-view:select-name": {
          description: "Select the whole name, or the base name when it is already selected",
          didDispatch: () => this.selectName(),
        },
      }),
    );

    this.miniEditor.setText(initialPath);

    if (select) {
      // Open on the base name, so a rename types over the name and leaves the
      // directory prefix and the extension alone.
      this.selectionRange = this.nameRanges().baseName;
    } else {
      // InputDialogView selects the full query when it opens. Add dialogs keep
      // their seeded directory prefix and append the new name at its end.
      const cursor = Point(0, initialPath.length);
      this.selectionRange = Range(cursor, cursor);
    }
  }

  /**
   * The two ranges the name in the input spans: `name` is everything after the
   * last separator, `baseName` is that without its extension. The extension is
   * the last one — `dialog.spec.js` renames as `dialog.spec`, not as `dialog` —
   * and a leading dot belongs to the name, so `.gitignore` has none. Neither
   * does a directory, which makes the two ranges equal for one.
   * @returns {Object} `{name, baseName}` buffer ranges on the single line
   */
  nameRanges() {
    const text = this.miniEditor.getText();
    // `path.sep` alone would miss a Windows path typed with forward slashes,
    // and on POSIX both lookups are the same one.
    const start = Math.max(text.lastIndexOf(path.sep), text.lastIndexOf("/")) + 1;
    const extension = this.isDirectory ? "" : path.extname(text.slice(start));
    return {
      name: Range(Point(0, start), Point(0, text.length)),
      baseName: Range(Point(0, start), Point(0, text.length - extension.length)),
    };
  }

  /**
   * Selects the whole name, extension included, and selects the base name
   * instead when the whole name is already selected — so the key that opens
   * the dialog also cycles what the next keystroke replaces. A name with no
   * extension has one state and stays on it.
   */
  selectName() {
    const { name, baseName } = this.nameRanges();
    const selected = this.miniEditor.getSelectedBufferRange();
    this.miniEditor.setSelectedBufferRange(selected.isEqual(name) ? baseName : name);
  }

  attach() {
    this.inputDialogView.show();
    // Show() selects the whole query; restore the requested selection or caret.
    this.miniEditor.setSelectedBufferRange(this.selectionRange);
    this.miniEditor.scrollToCursorPosition();
  }

  close() {
    this.emitter.dispose();
    this.disposables.dispose();
    this.inputDialogView.destroy();
    const activePane = lumine.workspace.getCenter().getActivePane();
    if (!activePane.isDestroyed()) {
      return activePane.activate();
    }
  }

  cancel() {
    this.close();
    document.querySelector(".tree-view")?.focus();
  }

  // The dialog clears the status itself on the next keystroke, so this only
  // ever has to raise one. It used to also flash an `error` class on the root
  // for 300ms, which nothing in this package or any theme ever styled.
  showError(message) {
    this.inputDialogView.update({
      status: message ? { type: "error", message } : null,
    });
  }
};
