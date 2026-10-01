const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const fsp = fs.promises;
const conflictResolvers = new Map();
const cancelledJobs = new Set();
let nextConflictId = 1;
const OWNED_PATH = Symbol("ownedPath");

// This module is forked directly instead of running through Task so the worker
// can pause a directory merge for a replace/skip/cancel decision from the UI.
function emit(message) {
  if (process.connected) process.send(message);
}

function serializeError(error) {
  const serialized = { message: error.message, code: error.code, stack: error.stack };
  for (const property of [
    "creates",
    "renames",
    "partial",
    "skipped",
    "cancelled",
    "cleanupError",
    "cleanupPath",
  ]) {
    if (error[property] !== undefined) serialized[property] = error[property];
  }
  return serialized;
}

function isCancelled(jobId) {
  return cancelledJobs.has(jobId);
}

function setJobCancelled(jobId, cancelled = true) {
  if (cancelled) cancelledJobs.add(jobId);
  else cancelledJobs.delete(jobId);
}

async function statNoException(filePath, method = "lstat") {
  try {
    return await fsp[method](filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameFile(sourceStat, destinationStat) {
  return (
    sourceStat &&
    destinationStat &&
    sourceStat.dev === destinationStat.dev &&
    sourceStat.ino === destinationStat.ino
  );
}

async function pathsAreSameEntry(sourcePath, destinationPath, sourceStat, destinationStat) {
  if (!sameFile(sourceStat, destinationStat)) return false;
  const [realSource, realDestination] = await Promise.all([
    fsp.realpath(sourcePath),
    fsp.realpath(destinationPath),
  ]);
  return process.platform === "win32"
    ? realSource.toLowerCase() === realDestination.toLowerCase()
    : realSource === realDestination;
}

function snapshotFromStat(stat) {
  return stat
    ? {
        dev: stat.dev,
        ino: stat.ino,
        birthtimeMs: stat.birthtimeMs,
        isDirectory: stat.isDirectory(),
      }
    : null;
}

function guardFromStat(stat) {
  return stat
    ? {
        ...snapshotFromStat(stat),
        isSymbolicLink: stat.isSymbolicLink(),
        mode: stat.mode,
        size: stat.size,
        birthtimeMs: stat.birthtimeMs,
        ctimeMs: stat.ctimeMs,
        mtimeMs: stat.mtimeMs,
      }
    : null;
}

async function pathSnapshot(filePath) {
  return snapshotFromStat(await statNoException(filePath));
}

async function pathMatchesSnapshot(filePath, snapshot) {
  const current = await pathSnapshot(filePath);
  if (!current || !snapshot) return current === snapshot;
  return (
    current.dev === snapshot.dev &&
    current.ino === snapshot.ino &&
    (snapshot.birthtimeMs === undefined || current.birthtimeMs === snapshot.birthtimeMs) &&
    current.isDirectory === snapshot.isDirectory
  );
}

async function pathMatchesGuard(filePath, guard) {
  const currentStat = await statNoException(filePath);
  if (!currentStat || !guard) return currentStat === guard;
  const current = guardFromStat(currentStat);
  return Object.keys(guard).every((key) => current[key] === guard[key]);
}

function stalePathError(filePath) {
  const error = new Error(`'${filePath}' changed while the file operation was waiting.`);
  error.code = "ESTALE";
  return error;
}

async function requirePathSnapshot(filePath, snapshot) {
  if (!(await pathMatchesSnapshot(filePath, snapshot))) throw stalePathError(filePath);
}

async function requirePathGuard(filePath, guard) {
  if (!(await pathMatchesGuard(filePath, guard))) throw stalePathError(filePath);
}

function privateSiblingPath(filePath, label, jobId) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.lumine-${label}-${process.pid}-${jobId}-${crypto.randomUUID()}`,
  );
}

function createdEntry(filePath, stat) {
  return { path: filePath, isDirectory: stat.isDirectory() };
}

function renamedEntry(oldPath, newPath, stat) {
  return { oldPath, newPath, isDirectory: stat.isDirectory() };
}

function prependErrorChanges(error, { creates = [], renames = [] } = {}) {
  const existingCreates = Array.isArray(error.creates) ? error.creates : [];
  const existingRenames = Array.isArray(error.renames) ? error.renames : [];
  error.creates = [...creates, ...existingCreates];
  error.renames = [...renames, ...existingRenames];
  if (error.creates.length > 0 || error.renames.length > 0) error.partial = true;
  return error;
}

async function describeExistingPath(filePath, expectedSnapshot = null) {
  const stat = await statNoException(filePath);
  if (!stat) return [];
  if (expectedSnapshot && !(await pathMatchesSnapshot(filePath, expectedSnapshot))) return [];
  return [createdEntry(filePath, stat)];
}

async function cleanCopiedPath(destinationPath, expectedSnapshot) {
  if (!expectedSnapshot || !(await pathMatchesSnapshot(destinationPath, expectedSnapshot))) {
    return [];
  }
  try {
    await fsp.rm(destinationPath, { recursive: true, force: true });
  } catch {
    // The original copy result remains the useful outcome. Report anything the
    // cleanup could not remove so the renderer can still publish the real disk
    // changes to interested packages.
  }
  return describeExistingPath(destinationPath, expectedSnapshot);
}

function withOwnedPath(result, snapshot) {
  Object.defineProperty(result, OWNED_PATH, { value: snapshot, configurable: true });
  return result;
}

function progressReporter(jobId, phase) {
  let entries = 0;
  let lastReport = 0;
  return {
    visit() {
      entries++;
      if (entries !== 1 && entries % 128 !== 0) return true;
      const now = Date.now();
      if (now - lastReport >= 250) {
        lastReport = now;
        emit({ type: "progress", jobId, progress: { phase, entries } });
      }
      return true;
    },
    finish() {
      emit({ type: "progress", jobId, progress: { phase, entries } });
    },
  };
}

async function copyPath(sourcePath, destinationPath, jobId, phase = "copying") {
  let destinationSnapshot = null;
  let destinationHandle = null;
  try {
    if (isCancelled(jobId)) return { cancelled: true, creates: [] };
    const destinationStat = await statNoException(destinationPath);
    if (isCancelled(jobId)) return { cancelled: true, creates: [] };
    if (destinationStat) {
      const error = new Error(`'${destinationPath}' already exists.`);
      error.code = "EEXIST";
      throw error;
    }

    const sourceStat = await fsp.lstat(sourcePath);
    if (isCancelled(jobId)) return { cancelled: true, creates: [] };
    await requirePathSnapshot(sourcePath, snapshotFromStat(sourceStat));
    emit({
      type: "progress",
      jobId,
      progress: {
        phase,
        bytesTotal: sourceStat.isFile() ? sourceStat.size : null,
      },
    });

    const progress = progressReporter(jobId, phase);
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    if (sourceStat.isFile()) {
      destinationHandle = await fsp.open(destinationPath, "wx", sourceStat.mode);
      destinationSnapshot = snapshotFromStat(await destinationHandle.stat());
      await pipeline(
        fs.createReadStream(sourcePath),
        fs.createWriteStream(destinationPath, {
          autoClose: false,
          fd: destinationHandle.fd,
        }),
      );
      await destinationHandle.chmod(sourceStat.mode);
      await destinationHandle.close();
      destinationHandle = null;
      progress.visit();
    } else if (sourceStat.isDirectory()) {
      await fsp.mkdir(destinationPath, { mode: sourceStat.mode });
      destinationSnapshot = await pathSnapshot(destinationPath);
      for (const entry of await fsp.readdir(sourcePath)) {
        await fsp.cp(path.join(sourcePath, entry), path.join(destinationPath, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
          filter() {
            if (isCancelled(jobId)) return false;
            return progress.visit();
          },
        });
      }
    } else {
      await fsp.cp(sourcePath, destinationPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter() {
          if (isCancelled(jobId)) return false;
          return progress.visit();
        },
      });
      destinationSnapshot = await pathSnapshot(destinationPath);
    }
    if (isCancelled(jobId)) {
      const remaining =
        phase === "copying-to-move"
          ? await cleanMoveCopy(sourcePath, destinationPath, destinationSnapshot)
          : await cleanCopiedPath(destinationPath, destinationSnapshot);
      return {
        cancelled: true,
        creates: phase === "copying-to-move" ? remaining : [],
        ...(phase === "copying-to-move" && remaining.length > 0 && { partial: true }),
        ...(remaining.length > 0 && {
          cleanupError: `Unable to remove the cancelled copy at '${destinationPath}'.`,
          cleanupPath: destinationPath,
        }),
      };
    }
    await requirePathSnapshot(destinationPath, destinationSnapshot);
    progress.finish();
    return withOwnedPath(
      {
        copied: true,
        creates: await describeExistingPath(destinationPath, destinationSnapshot),
      },
      destinationSnapshot,
    );
  } catch (error) {
    try {
      await destinationHandle?.close();
    } catch {
      // Cleanup below still owns the path by identity and is the useful result.
    }
    const remaining =
      phase === "copying-to-move"
        ? await cleanMoveCopy(sourcePath, destinationPath, destinationSnapshot)
        : await cleanCopiedPath(destinationPath, destinationSnapshot);
    if (remaining.length > 0) {
      error.partial = true;
      error.cleanupError = `Unable to remove the failed copy at '${destinationPath}'.`;
      error.cleanupPath = destinationPath;
    }
    throw prependErrorChanges(error, { creates: phase === "copying-to-move" ? remaining : [] });
  }
}

function askConflict(jobId, conflict) {
  const conflictId = nextConflictId++;
  return new Promise((resolve) => {
    conflictResolvers.set(`${jobId}:${conflictId}`, resolve);
    emit({ type: "conflict", jobId, conflictId, conflict });
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function pathsHaveSameContents(leftPath, rightPath, verified = []) {
  const [left, right] = await Promise.all([fsp.lstat(leftPath), fsp.lstat(rightPath)]);
  if (
    left.isDirectory() !== right.isDirectory() ||
    left.isFile() !== right.isFile() ||
    left.isSymbolicLink() !== right.isSymbolicLink()
  )
    return false;
  const leftGuard = guardFromStat(left);
  const rightGuard = guardFromStat(right);
  let childNames = null;
  if (left.isSymbolicLink()) {
    const [leftTarget, rightTarget] = await Promise.all([
      fsp.readlink(leftPath),
      fsp.readlink(rightPath),
    ]);
    if (leftTarget !== rightTarget) return false;
  } else if (left.isFile()) {
    if (left.size !== right.size) return false;
    const [leftHash, rightHash] = await Promise.all([hashFile(leftPath), hashFile(rightPath)]);
    if (leftHash !== rightHash) return false;
  } else if (left.isDirectory()) {
    const [leftEntries, rightEntries] = await Promise.all([
      fsp.readdir(leftPath),
      fsp.readdir(rightPath),
    ]);
    leftEntries.sort();
    rightEntries.sort();
    childNames = leftEntries;
    if (
      leftEntries.length !== rightEntries.length ||
      leftEntries.some((entry, index) => entry !== rightEntries[index])
    )
      return false;
    for (const entry of leftEntries) {
      if (
        !(await pathsHaveSameContents(
          path.join(leftPath, entry),
          path.join(rightPath, entry),
          verified,
        ))
      )
        return false;
    }
  } else {
    return false;
  }
  await requirePathGuard(leftPath, leftGuard);
  await requirePathGuard(rightPath, rightGuard);
  verified.push({
    sourcePath: leftPath,
    destinationPath: rightPath,
    sourceGuard: leftGuard,
    destinationGuard: rightGuard,
    childNames,
  });
  return true;
}

async function cleanMoveCopy(sourcePath, destinationPath, destinationSnapshot) {
  if (!destinationSnapshot || !(await pathMatchesSnapshot(destinationPath, destinationSnapshot)))
    return [];
  const verified = [];
  try {
    if (!(await pathsHaveSameContents(sourcePath, destinationPath, verified)))
      return describeExistingPath(destinationPath, destinationSnapshot);
    for (const entry of verified) {
      await requirePathGuard(entry.sourcePath, entry.sourceGuard);
      await requirePathGuard(entry.destinationPath, entry.destinationGuard);
    }
    const sourceSnapshot = verified[verified.length - 1].sourceGuard;
    const directories = new Map(
      verified
        .filter((entry) => entry.destinationGuard.isDirectory)
        .map((entry) => [entry.destinationPath, entry.destinationGuard]),
    );
    for (const entry of verified) {
      await requirePathSnapshot(sourcePath, sourceSnapshot);
      await requirePathGuard(entry.sourcePath, entry.sourceGuard);
      await requirePathSnapshot(destinationPath, destinationSnapshot);
      const parent = path.dirname(entry.destinationPath);
      if (directories.has(parent)) await requirePathSnapshot(parent, directories.get(parent));
      if (entry.destinationGuard.isDirectory) {
        await requirePathSnapshot(entry.destinationPath, entry.destinationGuard);
        await fsp.rmdir(entry.destinationPath);
      } else {
        await requirePathGuard(entry.destinationPath, entry.destinationGuard);
        await fsp.unlink(entry.destinationPath);
      }
    }
  } catch {
    // A visible destination may already contain somebody else's edits. Keep
    // them, including new entries that prevent removing an otherwise empty copy.
  }
  return describeExistingPath(destinationPath, destinationSnapshot);
}

async function copyThenRemove(sourcePath, destinationPath, jobId, sourceStat) {
  await requirePathGuard(sourcePath, guardFromStat(sourceStat));
  // Copy straight to the requested path. Keep the original source available
  // until every copied entry has been verified; no private move directories.
  const result = await copyPath(sourcePath, destinationPath, jobId, "copying-to-move");
  if (result.cancelled) {
    const { creates, ...outcome } = result;
    return { ...outcome, renames: [], ...(creates?.length && { creates }) };
  }
  const destinationSnapshot = result[OWNED_PATH];
  const verified = [];
  try {
    await requirePathSnapshot(sourcePath, snapshotFromStat(sourceStat));
    await requirePathSnapshot(destinationPath, destinationSnapshot);
    if (!(await pathsHaveSameContents(sourcePath, destinationPath, verified))) {
      throw stalePathError(sourcePath);
    }
    if (isCancelled(jobId)) {
      const remaining = await cleanMoveCopy(sourcePath, destinationPath, destinationSnapshot);
      return {
        cancelled: true,
        renames: [],
        ...(remaining.length && { creates: remaining }),
        ...(remaining.length && {
          partial: true,
          cleanupError: `Unable to remove the cancelled move copy at '${destinationPath}'.`,
          cleanupPath: destinationPath,
        }),
      };
    }
    // Check the whole tree before starting irreversible cleanup, then each
    // entry again immediately before removing it. A changed/new source stays
    // at its original path and the complete destination remains recoverable.
    for (const entry of verified) {
      await requirePathGuard(entry.sourcePath, entry.sourceGuard);
      await requirePathGuard(entry.destinationPath, entry.destinationGuard);
    }
  } catch (error) {
    throw prependErrorChanges(error, {
      creates: await describeExistingPath(destinationPath, destinationSnapshot),
    });
  }
  const renames = new Map();
  const sourceDirectories = new Map(
    verified
      .filter((entry) => entry.sourceGuard.isDirectory)
      .map((entry) => [entry.sourcePath, entry.sourceGuard]),
  );
  const destinationDirectories = new Map(
    verified
      .filter((entry) => entry.destinationGuard.isDirectory)
      .map((entry) => [entry.destinationPath, entry.destinationGuard]),
  );
  try {
    for (const entry of verified) {
      await requirePathSnapshot(sourcePath, snapshotFromStat(sourceStat));
      await requirePathSnapshot(destinationPath, destinationSnapshot);
      const sourceParent = path.dirname(entry.sourcePath);
      const destinationParent = path.dirname(entry.destinationPath);
      if (sourceDirectories.has(sourceParent))
        await requirePathSnapshot(sourceParent, sourceDirectories.get(sourceParent));
      if (destinationDirectories.has(destinationParent))
        await requirePathSnapshot(destinationParent, destinationDirectories.get(destinationParent));
      if (entry.sourceGuard.isDirectory) {
        await requirePathSnapshot(entry.sourcePath, entry.sourceGuard);
        await requirePathSnapshot(entry.destinationPath, entry.destinationGuard);
        await fsp.rmdir(entry.sourcePath);
      } else {
        await requirePathGuard(entry.sourcePath, entry.sourceGuard);
        await requirePathGuard(entry.destinationPath, entry.destinationGuard);
        await fsp.unlink(entry.sourcePath);
      }
      if (entry.sourceGuard.isDirectory) {
        for (const child of entry.childNames) renames.delete(path.join(entry.sourcePath, child));
      }
      renames.set(entry.sourcePath, {
        oldPath: entry.sourcePath,
        newPath: entry.destinationPath,
        isDirectory: entry.sourceGuard.isDirectory,
      });
    }
  } catch (error) {
    return {
      skipped: true,
      partial: true,
      renames: [...renames.values()],
      creates: await describeExistingPath(destinationPath, destinationSnapshot),
      cleanupError: `Unable to remove '${sourcePath}' after copying it to '${destinationPath}': ${error.message}`,
      cleanupPath: sourcePath,
    };
  }
  return { moved: true, renames: [renamedEntry(sourcePath, destinationPath, sourceStat)] };
}

async function replacePathSafely(sourcePath, destinationPath, jobId, sourceStat, destinationStat) {
  const sourceSnapshot = snapshotFromStat(sourceStat);
  const destinationSnapshot = snapshotFromStat(destinationStat);
  await requirePathSnapshot(sourcePath, sourceSnapshot);
  await requirePathSnapshot(destinationPath, destinationSnapshot);

  const backupPath = privateSiblingPath(destinationPath, "replaced", jobId);
  await fsp.rename(destinationPath, backupPath);
  const backupSnapshot = await pathSnapshot(backupPath);
  try {
    await requirePathSnapshot(sourcePath, sourceSnapshot);
    const result = await renameFresh(sourcePath, destinationPath, jobId, sourceStat, false);
    if (result.cancelled) {
      if (
        (await pathMatchesSnapshot(destinationPath, null)) &&
        (await pathMatchesSnapshot(backupPath, backupSnapshot))
      ) {
        try {
          await fsp.rename(backupPath, destinationPath);
        } catch (error) {
          result.cleanupError = error.message;
          result.cleanupPath = backupPath;
        }
      } else {
        result.cleanupError = `The original destination remains at '${backupPath}'.`;
        result.cleanupPath = backupPath;
      }
      return result;
    }
    const remaining = await cleanCopiedPath(backupPath, backupSnapshot);
    if (remaining.length) {
      result.cleanupError = `Unable to remove '${backupPath}' after replacing the destination.`;
      result.cleanupPath = backupPath;
    }
    return result;
  } catch (error) {
    // Restore the original destination only while the failed move left its path
    // vacant. Otherwise keep the backup beside it; retaining both entries is
    // safer than overwriting either one during error recovery.
    if (
      (await pathMatchesSnapshot(destinationPath, null)) &&
      (await pathMatchesSnapshot(backupPath, backupSnapshot))
    ) {
      try {
        await fsp.rename(backupPath, destinationPath);
      } catch (restoreError) {
        error.cleanupError = restoreError.message;
        error.cleanupPath = backupPath;
      }
    } else {
      error.cleanupError ||= `The original destination remains at '${backupPath}'.`;
      error.cleanupPath = backupPath;
    }
    throw error;
  }
}

async function renameFresh(
  sourcePath,
  destinationPath,
  jobId,
  sourceStat,
  allowCancellation = true,
) {
  if (allowCancellation && isCancelled(jobId)) return { cancelled: true, renames: [] };
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fsp.rename(sourcePath, destinationPath);
    return {
      moved: true,
      renames: [renamedEntry(sourcePath, destinationPath, sourceStat)],
    };
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    return copyThenRemove(sourcePath, destinationPath, jobId, sourceStat);
  }
}

async function movePath(sourcePath, destinationPath, jobId, relativeTo) {
  try {
    if (isCancelled(jobId)) return { cancelled: true, renames: [] };
    const sourceStat = await fsp.lstat(sourcePath);
    const destinationStat = await statNoException(destinationPath);

    if (!destinationStat) {
      return renameFresh(sourcePath, destinationPath, jobId, sourceStat);
    }

    if (await pathsAreSameEntry(sourcePath, destinationPath, sourceStat, destinationStat)) {
      await fsp.rename(sourcePath, destinationPath);
      return {
        moved: true,
        renames: [renamedEntry(sourcePath, destinationPath, sourceStat)],
      };
    }

    if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
      let skipped = false;
      let partiallyMoved = false;
      const renames = [];
      const creates = [];
      for (const entry of await fsp.readdir(sourcePath)) {
        let result;
        try {
          result = await movePath(
            path.join(sourcePath, entry),
            path.join(destinationPath, entry),
            jobId,
            relativeTo,
          );
        } catch (error) {
          throw prependErrorChanges(error, { creates, renames });
        }
        renames.push(...(result.renames ?? []));
        creates.push(...(result.creates ?? []));
        if (result.cancelled) {
          return {
            cancelled: true,
            partial: partiallyMoved || result.partial === true,
            renames,
            ...(creates.length > 0 && { creates }),
          };
        }
        if (result.skipped) skipped = true;
        if (result.moved || result.partial) partiallyMoved = true;
      }
      try {
        if ((await fsp.readdir(sourcePath)).length === 0) {
          await fsp.rmdir(sourcePath);
        } else {
          skipped = true;
        }
      } catch (error) {
        throw prependErrorChanges(error, { creates, renames });
      }
      if (skipped) {
        return {
          skipped: true,
          partial: true,
          renames,
          ...(creates.length > 0 && { creates }),
        };
      }
      return { moved: true, renames, ...(creates.length > 0 && { creates }) };
    }

    const resolution = await askConflict(jobId, {
      relativePath: path.relative(relativeTo, destinationPath),
      sourcePath,
      destinationPath,
    });
    if (resolution === "cancel") return { cancelled: true, renames: [] };
    if (resolution === "skip") return { skipped: true, renames: [] };

    await requirePathGuard(sourcePath, guardFromStat(sourceStat));
    await requirePathGuard(destinationPath, guardFromStat(destinationStat));

    if (sourceStat.isDirectory() !== destinationStat.isDirectory()) {
      const error = new Error(`Cannot replace '${destinationPath}' with a different entry type.`);
      error.code = sourceStat.isDirectory() ? "ENOTDIR" : "EISDIR";
      throw error;
    }

    return replacePathSafely(sourcePath, destinationPath, jobId, sourceStat, destinationStat);
  } catch (error) {
    if (Array.isArray(error.renames)) throw error;
    throw prependErrorChanges(error);
  }
}

async function validateMoveExecutionPlan(executionPlan) {
  if (
    executionPlan?.version !== 1 ||
    !Array.isArray(executionPlan.checks) ||
    !Array.isArray(executionPlan.actions)
  ) {
    const error = new Error("Invalid planned move payload.");
    error.code = "EINVAL";
    throw error;
  }
  for (const check of executionPlan.checks) {
    if (!check || typeof check.path !== "string") {
      const error = new Error("Invalid planned move path check.");
      error.code = "EINVAL";
      throw error;
    }
    await requirePathGuard(check.path, check.snapshot ?? null);
  }
}

async function executeMovePlan(executionPlan, jobId) {
  await validateMoveExecutionPlan(executionPlan);
  const renames = [];
  const creates = [];
  let cleanupError = null;
  let cleanupPath = null;

  for (const action of executionPlan.actions) {
    if (isCancelled(jobId)) {
      return {
        cancelled: true,
        renames,
        ...(renames.length > 0 && { partial: true }),
        ...(creates.length > 0 && { creates }),
        ...(cleanupError && { cleanupError, cleanupPath }),
      };
    }

    try {
      if (action.type === "remove-directory") {
        await requirePathSnapshot(action.path, action.snapshot);
        await fsp.rmdir(action.path);
        continue;
      }
      if (action.type !== "rename") {
        const error = new Error(`Unknown planned move action '${action.type}'.`);
        error.code = "EINVAL";
        throw error;
      }

      await requirePathSnapshot(action.sourcePath, action.sourceSnapshot);
      await requirePathSnapshot(action.destinationPath, action.destinationSnapshot ?? null);
      const sourceStat = await fsp.lstat(action.sourcePath);
      let result;
      if (action.sameFile) {
        await fsp.rename(action.sourcePath, action.destinationPath);
        result = {
          moved: true,
          renames: [renamedEntry(action.sourcePath, action.destinationPath, sourceStat)],
        };
      } else if (action.replace) {
        const destinationStat = await fsp.lstat(action.destinationPath);
        result = await replacePathSafely(
          action.sourcePath,
          action.destinationPath,
          jobId,
          sourceStat,
          destinationStat,
        );
      } else {
        result = await renameFresh(action.sourcePath, action.destinationPath, jobId, sourceStat);
      }
      renames.push(...(result.renames ?? []));
      creates.push(...(result.creates ?? []));
      cleanupError ||= result.cleanupError ?? null;
      cleanupPath ||= result.cleanupPath ?? null;
      if (result.cancelled) {
        return {
          cancelled: true,
          renames,
          ...(renames.length > 0 && { partial: true }),
          ...(creates.length > 0 && { creates }),
          ...(cleanupError && { cleanupError, cleanupPath }),
        };
      }
    } catch (error) {
      if (cleanupError && !error.cleanupError) {
        error.cleanupError = cleanupError;
        error.cleanupPath = cleanupPath;
      }
      throw prependErrorChanges(error, { creates, renames });
    }
  }

  return {
    ...(executionPlan.skipped ? { skipped: true, partial: true } : { moved: true }),
    renames,
    ...(creates.length > 0 && { creates }),
    ...(cleanupError && { cleanupError, cleanupPath }),
  };
}

async function runJob(message) {
  const { jobId, operation, sourcePath, destinationPath, executionPlan } = message;
  if (operation === "copy") {
    return copyPath(sourcePath, destinationPath, jobId);
  }
  if (operation === "move") {
    emit({ type: "progress", jobId, progress: { phase: "moving" } });
    if (executionPlan) return executeMovePlan(executionPlan, jobId);
    return movePath(sourcePath, destinationPath, jobId, path.dirname(destinationPath));
  }
  throw new Error(`Unknown file operation '${operation}'.`);
}

if (require.main === module) {
  process.on("message", async (message) => {
    if (message?.type === "cancel") {
      setJobCancelled(message.jobId);
      for (const [key, resolve] of conflictResolvers) {
        if (!key.startsWith(`${message.jobId}:`)) continue;
        conflictResolvers.delete(key);
        resolve("cancel");
      }
      return;
    }
    if (message?.type === "resolve-conflict") {
      const key = `${message.jobId}:${message.conflictId}`;
      const resolve = conflictResolvers.get(key);
      if (resolve) {
        conflictResolvers.delete(key);
        resolve(message.resolution);
      }
      return;
    }
    if (message?.type !== "run") return;

    try {
      const result = await runJob(message);
      emit({ type: "complete", jobId: message.jobId, result });
    } catch (error) {
      emit({ type: "error", jobId: message.jobId, error: serializeError(error) });
    } finally {
      setJobCancelled(message.jobId, false);
    }
  });
}

module.exports = {
  copyPath,
  movePath,
  executeMovePlan,
  replacePathSafely,
  runJob,
  setJobCancelled,
};
