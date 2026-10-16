# tree-view.directory

List the files beside a document in the same order and with the same visibility policy as the tree.

|             |                                       |
| ----------- | ------------------------------------- |
| Version     | `1.0.0`                               |
| Provided by | `provideTreeViewDirectory()`          |
| Consumed by | `consumeTreeViewDirectory(directory)` |
| Owner       | `tree-view`                           |

## Registration

```json
{
  "consumedServices": {
    "tree-view.directory": {
      "versions": { "^1.0.0": "consumeTreeViewDirectory" }
    }
  }
}
```

## Contract

```ts
type TreeViewDirectory = {
  listFiles(directoryPath: string): Promise<string[]>;
  onDidChange(callback: () => void): Disposable;
  watchDirectory(directoryPath: string, callback: () => void): DirectoryWatch;
};

type DirectoryWatch = {
  ready: Promise<void>;
  dispose(): void;
};
```

| Member                                    | Description                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listFiles(directoryPath)`                | A fresh list of absolute paths to the directory's files, sorted and filtered by the current tree-view settings.                                                 |
| `onDidChange(callback)`                   | Invalidates cached listings when sorting, visibility, project paths, project observation recovery or repository state changes.                                  |
| `watchDirectory(directoryPath, callback)` | Watches the directory and its direct children, invalidating on additions, removals, renames and observation recovery. Await `ready` before the initial listing. |

## Minimal example

```js
const { CompositeDisposable, Disposable } = require("lumine");

module.exports = {
  consumeTreeViewDirectory(directory) {
    this.directory = directory;
    return new CompositeDisposable(
      directory.onDidChange(() => this.invalidateFileLists()),
      new Disposable(() => {
        if (this.directory === directory) this.directory = null;
      }),
    );
  },

  async filesBeside(directoryPath) {
    return (await this.directory?.listFiles(directoryPath)) ?? [];
  },
};
```

## Behavior

Listing a directory does not create, show, focus, expand or select anything in the tree. It also works without a project folder and when the directory is outside the project. Consumption is passive: a consumer must provide its own fallback when the service is unavailable.

Files follow `sortMethod` and `sortByBase`; directories are excluded, so `sortFoldersBeforeFiles` cannot change their relative order. Files hidden by `hideIgnoredNames` or `hideVcsIgnoredFiles` are excluded. Ignored-name patterns are relative to the most specific containing project folder, or to the requested directory outside the project. Symlinks to files are included under their displayed paths; directories, broken links and entries removed during the scan are excluded. Missing or unreadable directories yield an empty array.

Each call reads a fresh snapshot. Changes during an asynchronous scan may make it stale; invalidate and request another listing when `onDidChange` or the directory watcher fires. `watchDirectory` uses core's nonrecursive observation and works outside project folders. Subscribe first, await its `ready` promise, then read the initial listing to avoid missing changes during watcher startup. Content-only updates do not change directory membership and do not invalidate the list. Readiness rejects when observation fails or is disposed before it is armed; runtime errors are reported to the console.

## Teardown

Dispose subscriptions returned by `onDidChange` and `watchDirectory`, and return a `Disposable` from the consumption callback that releases that provider's state and subscriptions. Disposing a directory watch releases only its owned observation and immediately stops its callbacks. The provider also disposes outstanding subscriptions when it deactivates.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
