# tree-view.selection

Read what is selected in the tree, find the element for a path, and scroll a path into view.

|             |                                                             |
| ----------- | ----------------------------------------------------------- |
| Version     | `1.0.0`                                                     |
| Provided by | `provideTreeViewSelection()` returning selection operations |
| Consumed by | `consumeTreeViewSelection(treeView)`                        |
| Owner       | `tree-view` (bundled)                                       |

This is how a package acts on "the files the user has selected" — a publish command, a formatter, a linter run, a clipboard operation. The service reads the selection and reveals paths without changing the project folders.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "tree-view.selection": {
      "versions": { "^1.0.0": "consumeTreeViewSelection" }
    }
  }
}
```

## Contract

```ts
type TreeViewSelection = {
  getSelectionSnapshot(): Readonly<{
    count: number;
    removableCount: number;
    directoryCount: number;
    paths: readonly string[];
    entries: readonly { path: string; kind: string; projectRoot: boolean; removable: boolean }[];
    primary: { path: string; kind: string; projectRoot: boolean; removable: boolean } | null;
  }>;
  onDidChangeSelection(callback: (snapshot: object) => void): Disposable;
  selectedPaths(): string[];
  entryForPath(entryPath: string): HTMLElement | undefined;
  revealPath(filePath: string, options?: object): Promise<void>;
};
```

| Member                    | Description                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `selectedPaths()`         | Absolute paths of every selected entry, in tree order. Empty when nothing is selected.                                 |
| `entryForPath(entryPath)` | The entry element for a path, or `undefined` if that path is not currently rendered.                                   |
| `revealPath(filePath)`    | Expands the tree to the path, selects it, and scrolls it into view; `show: true` or `focus: true` also shows the tree. |

`getSelectionSnapshot()` returns the current immutable selection metadata without constructing the tree, touching the filesystem or materializing its visible rows. It returns an empty snapshot before the tree exists and after that activation is retired. Use its cached `count`, `paths` or `primary` in command availability predicates; `selectedPaths()` remains the execution API and may construct the tree. `onDidChangeSelection()` observes actual snapshot changes and returns a disposable. Tree selection changes also invalidate command availability.

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeTreeViewSelection(treeView) {
    this.treeView = treeView;
    return new Disposable(() => (this.treeView = null));
  },

  formatSelection() {
    for (const filePath of this.treeView?.selectedPaths() ?? []) {
      this.format(filePath);
    }
  },
};
```

## Behavior

`selectedPaths` reflects the tree's current selection, which is not the same as the active editor. A command that should work from either needs its own fallback — the usual pattern is to prefer the tree selection when the tree has focus and the active editor's path otherwise.

Entries are only rendered while their parent directory is expanded, so `entryForPath` returns `undefined` for a collapsed subtree even though the path exists on disk. Do not use it to test existence.

`revealPath` reads each ancestor's filesystem metadata asynchronously before continuing along the path, then publishes each completed directory listing in one update. The target is selected and scrolled into view once its ancestors have loaded, without waiting for every directory watcher to become ready; the returned promise settles after that remaining expansion work finishes. A newer reveal, selection or project change takes precedence over an older load. A directory reveals like a file: it is expanded, selected and scrolled to.

The service resolves against the live tree-view instance on each call, so holding the service object across a tree-view teardown and re-creation is safe.

## Teardown

Return a `Disposable` from `consumeTreeViewSelection` that drops your reference. The service object itself needs no disposal.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
