/**
 * Snapshot - Persistence layer for Merkle tree snapshots
 * Stores file hashes and tree structure for incremental updates
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { MerkleTree } from "./merkle.js";

export interface Snapshot {
  codebasePath: string;
  timestamp: number;
  fileHashes: Record<string, string>;
  merkleTree: string; // Serialized tree
}

export class SnapshotSaveError extends Error {
  readonly code?: string;

  constructor(
    readonly snapshotPath: string,
    cause: unknown
  ) {
    const causeCode =
      typeof cause === "object" && cause !== null && "code" in cause
        ? (cause as NodeJS.ErrnoException).code
        : undefined;
    const code = causeCode === undefined ? undefined : String(causeCode);
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Failed to persist snapshot at "${snapshotPath}"${code ? ` [${code}]` : ""}: ${detail}`,
      { cause }
    );
    this.name = "SnapshotSaveError";
    this.code = code;
  }
}

export class SnapshotManager {
  constructor(private snapshotPath: string) {}

  /**
   * Save snapshot to disk
   */
  async save(
    codebasePath: string,
    fileHashes: Map<string, string>,
    tree: MerkleTree
  ): Promise<void> {
    const snapshot: Snapshot = {
      codebasePath,
      timestamp: Date.now(),
      fileHashes: Object.fromEntries(fileHashes),
      merkleTree: tree.serialize(),
    };

    const tempPath = `${this.snapshotPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 9)}`;

    try {
      // Ensure directory exists
      await fs.mkdir(dirname(this.snapshotPath), { recursive: true });

      // Write snapshot atomically (write to temp file, then rename).
      // A failed write or rename leaves the last valid snapshot authoritative.
      await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf-8");
      await fs.rename(tempPath, this.snapshotPath);
    } catch (error) {
      // Best-effort cleanup must never hide the persistence failure.
      await fs.unlink(tempPath).catch(() => undefined);
      throw new SnapshotSaveError(this.snapshotPath, error);
    }
  }

  /**
   * Load snapshot from disk
   */
  async load(): Promise<{
    codebasePath: string;
    fileHashes: Map<string, string>;
    merkleTree: MerkleTree;
    timestamp: number;
  } | null> {
    try {
      const data = await fs.readFile(this.snapshotPath, "utf-8");
      const snapshot: Snapshot = JSON.parse(data);

      const fileHashes = new Map(Object.entries(snapshot.fileHashes));
      const tree = MerkleTree.deserialize(snapshot.merkleTree);

      return {
        codebasePath: snapshot.codebasePath,
        fileHashes,
        merkleTree: tree,
        timestamp: snapshot.timestamp,
      };
    } catch (_error) {
      // Snapshot doesn't exist or is corrupted
      return null;
    }
  }

  /**
   * Check if snapshot exists
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.snapshotPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete snapshot
   */
  async delete(): Promise<void> {
    try {
      await fs.unlink(this.snapshotPath);
    } catch {
      // Ignore if doesn't exist
    }
  }

  /**
   * Validate snapshot (check for corruption)
   */
  async validate(): Promise<boolean> {
    try {
      const snapshot = await this.load();
      if (!snapshot) return false;

      // Basic validation: check if tree can be deserialized
      return snapshot.merkleTree.getRootHash() !== undefined || snapshot.fileHashes.size === 0;
    } catch {
      return false;
    }
  }
}
