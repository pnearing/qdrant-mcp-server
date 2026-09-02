/**
 * CodeIndexer - Main orchestrator for code vectorization
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import picomatch from "picomatch";
import type { EmbeddingProvider } from "../embeddings/base.js";
import { BM25SparseVectorGenerator } from "../embeddings/sparse.js";
import logger from "../logger.js";
import type { QdrantManager } from "../qdrant/client.js";
import { TreeSitterChunker } from "./chunker/tree-sitter-chunker.js";
import {
  getCodeCollectionName,
  resolveCodebaseIdentity,
  type CodebaseIdentity,
} from "./identity.js";
import { MetadataExtractor } from "./metadata.js";
import { FileScanner } from "./scanner.js";
import { FileSynchronizer } from "./sync/synchronizer.js";
import type {
  ChangeStats,
  CodeChunk,
  CodeConfig,
  CodeSearchResult,
  IndexOptions,
  IndexStats,
  IndexStatus,
  ProgressCallback,
  SearchOptions,
} from "./types.js";

/** Reserved ID for storing indexing metadata in the collection */
const INDEXING_METADATA_ID = "__indexing_metadata__";

export class CodeIndexer {
  private log = logger.child({ component: "code-indexer" });

  constructor(
    private qdrant: QdrantManager,
    private embeddings: EmbeddingProvider,
    private config: CodeConfig,
    private synchronizerFactory: (
      codebasePath: string,
      collectionName: string
    ) => FileSynchronizer = (codebasePath, collectionName) =>
      new FileSynchronizer(codebasePath, collectionName)
  ) {}

  /**
   * Validate that a path doesn't attempt directory traversal
   * @throws Error if path traversal is detected
   */
  private async validatePath(path: string): Promise<string> {
    const absolutePath = resolve(path);

    try {
      // Resolve the real path (follows symlinks)
      const realPath = await fs.realpath(absolutePath);

      // For now, we just ensure the path exists and is resolved
      // In a more restrictive environment, you could check against an allowlist
      return realPath;
    } catch (_error) {
      // If realpath fails, the path doesn't exist yet or is invalid
      // For operations like indexing, we still need to accept non-existent paths
      // so we just return the resolved absolute path
      return absolutePath;
    }
  }

  /**
   * Index a codebase from scratch or force re-index
   */
  async indexCodebase(
    path: string,
    options?: IndexOptions,
    progressCallback?: ProgressCallback
  ): Promise<IndexStats> {
    const startTime = Date.now();
    const stats: IndexStats = {
      filesScanned: 0,
      filesIndexed: 0,
      chunksCreated: 0,
      durationMs: 0,
      status: "completed",
      errors: [],
    };

    const absolutePath = await this.validatePath(path);
    const identity = await resolveCodebaseIdentity(absolutePath);
    const collectionName = getCodeCollectionName(identity);

    this.log.info({ path: absolutePath, collectionName }, "Indexing started");

    try {
      // 1. Scan files
      progressCallback?.({
        phase: "scanning",
        current: 0,
        total: 100,
        percentage: 0,
        message: "Scanning files...",
      });

      const scanner = new FileScanner({
        supportedExtensions: options?.extensions || this.config.supportedExtensions,
        ignorePatterns: this.config.ignorePatterns,
        customIgnorePatterns: options?.ignorePatterns || this.config.customIgnorePatterns,
      });

      await scanner.loadIgnorePatterns(absolutePath);
      const files = await scanner.scanDirectory(absolutePath);

      stats.filesScanned = files.length;
      this.log.info({ filesFound: files.length }, "File scan complete");

      if (files.length === 0) {
        stats.status = "completed";
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // 2. Create or verify collection
      const collectionExists = await this.qdrant.collectionExists(collectionName);

      if (options?.forceReindex && collectionExists) {
        await this.qdrant.deleteCollection(collectionName);
      }

      if (!collectionExists || options?.forceReindex) {
        const vectorSize = this.embeddings.getDimensions();
        await this.qdrant.createCollection(
          collectionName,
          vectorSize,
          "Cosine",
          this.config.enableHybridSearch
        );
        this.log.debug({ collectionName, vectorSize }, "Collection created");
      }

      // Store "indexing in progress" marker immediately after collection is ready
      await this.storeIndexingMarker(collectionName, false);

      // 3. Process files and create chunks
      const chunker = new TreeSitterChunker({
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        maxChunkSize: this.config.chunkSize * 2,
      });
      const metadataExtractor = new MetadataExtractor();
      const allChunks: Array<{ chunk: CodeChunk; id: string }> = [];
      const indexedFileHashes = new Map<string, string>();

      for (const [index, filePath] of files.entries()) {
        try {
          progressCallback?.({
            phase: "chunking",
            current: index + 1,
            total: files.length,
            percentage: Math.round(((index + 1) / files.length) * 40), // 0-40%
            message: `Chunking file ${index + 1}/${files.length}`,
          });

          const code = await fs.readFile(filePath, "utf-8");
          const relativePath = relative(absolutePath, filePath);

          // Check for secrets (basic detection)
          if (metadataExtractor.containsSecrets(code)) {
            stats.errors?.push(`Skipped ${filePath}: potential secrets detected`);
            indexedFileHashes.set(relativePath, this.hashContent(code));
            continue;
          }

          // Keep intentionally skipped files in the snapshot after the total
          // chunk budget is exhausted. Otherwise the next incremental run
          // would misclassify them as newly added and bypass the initial cap.
          if (this.config.maxTotalChunks && allChunks.length >= this.config.maxTotalChunks) {
            indexedFileHashes.set(relativePath, this.hashContent(code));
            continue;
          }

          const language = metadataExtractor.extractLanguage(filePath);
          const chunks = await chunker.chunk(code, filePath, language);
          indexedFileHashes.set(relativePath, this.hashContent(code));

          // Apply chunk limits if configured
          const chunksToAdd = this.config.maxChunksPerFile
            ? chunks.slice(0, this.config.maxChunksPerFile)
            : chunks;

          for (const chunk of chunksToAdd) {
            const id = metadataExtractor.generateChunkId(chunk);
            allChunks.push({ chunk, id });

            // Check total chunk limit
            if (this.config.maxTotalChunks && allChunks.length >= this.config.maxTotalChunks) {
              break;
            }
          }

          stats.filesIndexed++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          stats.errors?.push(`Failed to process ${filePath}: ${errorMessage}`);
        }
      }

      stats.chunksCreated = allChunks.length;

      if (allChunks.length === 0) {
        // Commit the snapshot only after all required Qdrant work has succeeded.
        const synchronizer = this.synchronizerFactory(absolutePath, collectionName);
        await synchronizer.updateSnapshotFromHashes(indexedFileHashes);

        // Still store completion marker even with no chunks.
        await this.storeIndexingMarker(collectionName, true);
        stats.status = "completed";
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // 4. Generate embeddings and store in batches
      const batchSize = this.config.batchSize;
      this.log.debug({ totalChunks: allChunks.length, batchSize }, "Starting embedding generation");
      for (let i = 0; i < allChunks.length; i += batchSize) {
        const batch = allChunks.slice(i, i + batchSize);

        progressCallback?.({
          phase: "embedding",
          current: i + batch.length,
          total: allChunks.length,
          percentage: 40 + Math.round(((i + batch.length) / allChunks.length) * 30), // 40-70%
          message: `Generating embeddings ${i + batch.length}/${allChunks.length}`,
        });

        try {
          const texts = batch.map((b) => b.chunk.content);
          const embeddings = await this.embeddings.embedBatch(texts);

          // 5. Store to Qdrant
          const points = batch.map((b, idx) => ({
            id: b.id,
            vector: embeddings[idx].embedding,
            payload: {
              content: b.chunk.content,
              relativePath: relative(absolutePath, b.chunk.metadata.filePath),
              startLine: b.chunk.startLine,
              endLine: b.chunk.endLine,
              fileExtension: extname(b.chunk.metadata.filePath),
              language: b.chunk.metadata.language,
              codebasePath: absolutePath,
              chunkIndex: b.chunk.metadata.chunkIndex,
              ...this.gitPayload(identity),
              ...(b.chunk.metadata.name && { name: b.chunk.metadata.name }),
              ...(b.chunk.metadata.chunkType && {
                chunkType: b.chunk.metadata.chunkType,
              }),
            },
          }));

          progressCallback?.({
            phase: "storing",
            current: i + batch.length,
            total: allChunks.length,
            percentage: 70 + Math.round(((i + batch.length) / allChunks.length) * 30), // 70-100%
            message: `Storing chunks ${i + batch.length}/${allChunks.length}`,
          });

          if (this.config.enableHybridSearch) {
            // Generate sparse vectors for hybrid search
            const sparseGenerator = new BM25SparseVectorGenerator();
            const hybridPoints = batch.map((b, idx) => ({
              id: b.id,
              vector: embeddings[idx].embedding,
              sparseVector: sparseGenerator.generate(b.chunk.content),
              payload: {
                content: b.chunk.content,
                relativePath: relative(absolutePath, b.chunk.metadata.filePath),
                startLine: b.chunk.startLine,
                endLine: b.chunk.endLine,
                fileExtension: extname(b.chunk.metadata.filePath),
                language: b.chunk.metadata.language,
                codebasePath: absolutePath,
                chunkIndex: b.chunk.metadata.chunkIndex,
                ...this.gitPayload(identity),
                ...(b.chunk.metadata.name && { name: b.chunk.metadata.name }),
                ...(b.chunk.metadata.chunkType && {
                  chunkType: b.chunk.metadata.chunkType,
                }),
              },
            }));

            await this.qdrant.addPointsWithSparse(collectionName, hybridPoints);
          } else {
            await this.qdrant.addPoints(collectionName, points);
          }
        } catch (error) {
          throw new Error(`Failed to process batch at index ${i}`, { cause: error });
        }
      }

      // The snapshot becomes authoritative only after every embedding and Qdrant
      // operation succeeds. Atomic replacement preserves the last valid snapshot.
      const synchronizer = this.synchronizerFactory(absolutePath, collectionName);
      await synchronizer.updateSnapshotFromHashes(indexedFileHashes);

      // Store completion marker only after the required snapshot is durable.
      await this.storeIndexingMarker(collectionName, true);

      stats.durationMs = Date.now() - startTime;
      this.log.info(
        {
          filesIndexed: stats.filesIndexed,
          chunksCreated: stats.chunksCreated,
          durationMs: stats.durationMs,
        },
        "Indexing complete"
      );
      return stats;
    } catch (error) {
      this.log.error(
        { err: error, path: absolutePath, collectionName, durationMs: Date.now() - startTime },
        "Indexing failed"
      );
      throw error;
    }
  }

  /**
   * Store an indexing status marker in the collection.
   * Called at the start of indexing with complete=false, and at the end with complete=true.
   */
  private async storeIndexingMarker(collectionName: string, complete: boolean): Promise<void> {
    // Create a dummy vector of zeros (required by Qdrant)
    const vectorSize = this.embeddings.getDimensions();
    const zeroVector = new Array(vectorSize).fill(0);

    // Check if collection uses hybrid mode
    const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);

    const payload = {
      _type: "indexing_metadata",
      indexingComplete: complete,
      ...(complete
        ? { completedAt: new Date().toISOString() }
        : { startedAt: new Date().toISOString() }),
    };

    if (collectionInfo.hybridEnabled) {
      await this.qdrant.addPointsWithSparse(collectionName, [
        {
          id: INDEXING_METADATA_ID,
          vector: zeroVector,
          sparseVector: { indices: [], values: [] },
          payload,
        },
      ]);
    } else {
      await this.qdrant.addPoints(collectionName, [
        {
          id: INDEXING_METADATA_ID,
          vector: zeroVector,
          payload,
        },
      ]);
    }
  }

  /**
   * Search code semantically
   */
  async searchCode(
    path: string,
    query: string,
    options?: SearchOptions
  ): Promise<CodeSearchResult[]> {
    const absolutePath = await this.validatePath(path);
    const collectionName = getCodeCollectionName(await resolveCodebaseIdentity(absolutePath));

    // Check if collection exists
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) {
      throw new Error(`Codebase not indexed: ${path}`);
    }

    // Check if collection has hybrid search enabled
    const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);
    const useHybrid =
      (options?.useHybrid ?? this.config.enableHybridSearch) && collectionInfo.hybridEnabled;

    // Generate query embedding
    const { embedding } = await this.embeddings.embed(query);

    // Build filter for Qdrant (only fileTypes - pathPattern uses post-filtering)
    let filter: any;
    if (options?.fileTypes && options.fileTypes.length > 0) {
      filter = {
        must: [
          {
            key: "fileExtension",
            match: { any: options.fileTypes },
          },
        ],
      };
    }

    // Prepare pathPattern matcher for post-filtering
    // Qdrant doesn't support regex/glob filtering, so we filter results in JS
    const pathMatcher = options?.pathPattern ? picomatch(options.pathPattern, { dot: true }) : null;

    // When using pathPattern, fetch more results to account for filtering
    const fetchLimit = pathMatcher
      ? Math.min((options?.limit || this.config.defaultSearchLimit) * 5, 100)
      : options?.limit || this.config.defaultSearchLimit;

    // Search with hybrid or standard search
    let results;
    if (useHybrid) {
      const sparseGenerator = new BM25SparseVectorGenerator();
      const sparseVector = sparseGenerator.generate(query);
      results = await this.qdrant.hybridSearch(
        collectionName,
        embedding,
        sparseVector,
        fetchLimit,
        filter
      );
    } else {
      results = await this.qdrant.search(collectionName, embedding, fetchLimit, filter);
    }

    // Apply pathPattern post-filtering if specified
    let filteredResults = results;
    if (pathMatcher) {
      filteredResults = results.filter((r) => {
        const relativePath = r.payload?.relativePath || "";
        return pathMatcher(relativePath);
      });
    }

    // Apply score threshold if specified
    if (options?.scoreThreshold) {
      filteredResults = filteredResults.filter((r) => r.score >= (options.scoreThreshold || 0));
    }

    // Apply the requested limit after all filtering
    const requestedLimit = options?.limit || this.config.defaultSearchLimit;
    const finalResults = filteredResults.slice(0, requestedLimit);

    // Format results
    return finalResults.map((r) => ({
      content: r.payload?.content || "",
      filePath: r.payload?.relativePath || "",
      startLine: r.payload?.startLine || 0,
      endLine: r.payload?.endLine || 0,
      language: r.payload?.language || "unknown",
      score: r.score,
      fileExtension: r.payload?.fileExtension || "",
      repositoryRemote: r.payload?.repositoryRemote || undefined,
      branch: r.payload?.branch || undefined,
      commit: r.payload?.commit || undefined,
    }));
  }

  /**
   * Get indexing status for a codebase
   */
  async getIndexStatus(path: string): Promise<IndexStatus> {
    const absolutePath = await this.validatePath(path);
    const collectionName = getCodeCollectionName(await resolveCodebaseIdentity(absolutePath));
    const exists = await this.qdrant.collectionExists(collectionName);

    if (!exists) {
      return { isIndexed: false, status: "not_indexed" };
    }

    // Check for indexing marker in Qdrant (persisted across instances)
    const indexingMarker = await this.qdrant.getPoint(collectionName, INDEXING_METADATA_ID);
    const info = await this.qdrant.getCollectionInfo(collectionName);

    // Check marker status
    const isComplete = indexingMarker?.payload?.indexingComplete === true;
    const isInProgress = indexingMarker?.payload?.indexingComplete === false;

    // Subtract 1 from points count if marker exists (metadata point doesn't count as a chunk)
    const actualChunksCount = indexingMarker ? Math.max(0, info.pointsCount - 1) : info.pointsCount;

    if (isInProgress) {
      // Indexing in progress - marker exists with indexingComplete=false
      return {
        isIndexed: false,
        status: "indexing",
        collectionName,
        chunksCount: actualChunksCount,
      };
    }

    if (isComplete) {
      // Indexing completed - marker exists with indexingComplete=true
      return {
        isIndexed: true,
        status: "indexed",
        collectionName,
        chunksCount: actualChunksCount,
        lastUpdated: indexingMarker.payload?.completedAt
          ? new Date(indexingMarker.payload.completedAt)
          : undefined,
      };
    }

    // Legacy collection (no marker) - check if it has content
    // If it has chunks, assume it's indexed (backwards compatibility)
    if (actualChunksCount > 0) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName,
        chunksCount: actualChunksCount,
      };
    }

    // Collection exists but no chunks and no marker - not indexed
    return {
      isIndexed: false,
      status: "not_indexed",
      collectionName,
      chunksCount: 0,
    };
  }

  /**
   * Incrementally re-index only changed files
   */
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    const startTime = Date.now();
    const stats: ChangeStats = {
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      chunksAdded: 0,
      chunksDeleted: 0,
      durationMs: 0,
    };

    try {
      const absolutePath = await this.validatePath(path);
      const identity = await resolveCodebaseIdentity(absolutePath);
      const collectionName = getCodeCollectionName(identity);

      this.log.info({ path: absolutePath }, "Reindex started");

      // Check if collection exists
      const exists = await this.qdrant.collectionExists(collectionName);
      if (!exists) {
        throw new Error(`Codebase not indexed: ${path}`);
      }

      // Initialize synchronizer
      const synchronizer = this.synchronizerFactory(absolutePath, collectionName);
      const hasSnapshot = await synchronizer.initialize();

      if (!hasSnapshot) {
        throw new Error("No previous snapshot found. Use index_codebase for initial indexing.");
      }

      // Scan current files
      progressCallback?.({
        phase: "scanning",
        current: 0,
        total: 100,
        percentage: 0,
        message: "Scanning for changes...",
      });

      const scanner = new FileScanner({
        supportedExtensions: this.config.supportedExtensions,
        ignorePatterns: this.config.ignorePatterns,
        customIgnorePatterns: this.config.customIgnorePatterns,
      });

      await scanner.loadIgnorePatterns(absolutePath);
      const currentFiles = await scanner.scanDirectory(absolutePath);

      // Detect changes
      const changes = await synchronizer.detectChanges(currentFiles);
      stats.filesAdded = changes.added.length;
      stats.filesModified = changes.modified.length;
      stats.filesDeleted = changes.deleted.length;

      if (stats.filesAdded === 0 && stats.filesModified === 0 && stats.filesDeleted === 0) {
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      const chunker = new TreeSitterChunker({
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        maxChunkSize: this.config.chunkSize * 2,
      });
      const metadataExtractor = new MetadataExtractor();

      // Delete chunks for modified and deleted files BEFORE adding new ones
      const filesToDelete = [...changes.modified, ...changes.deleted];

      if (filesToDelete.length > 0) {
        progressCallback?.({
          phase: "scanning",
          current: 0,
          total: filesToDelete.length,
          percentage: 5,
          message: `Deleting old chunks for ${filesToDelete.length} files...`,
        });

        for (const relativePath of filesToDelete) {
          try {
            const filter = {
              must: [{ key: "relativePath", match: { value: relativePath } }],
            };
            await this.qdrant.deletePointsByFilter(collectionName, filter);
          } catch (error) {
            this.log.error({ relativePath, err: error }, "Failed to delete chunks during reindex");
            throw error;
          }
        }
      }

      const filesToIndex = [...changes.added, ...changes.modified];
      const allChunks: Array<{ chunk: CodeChunk; id: string }> = [];
      const changedFileHashes = new Map<string, string>();

      for (const [index, filePath] of filesToIndex.entries()) {
        try {
          progressCallback?.({
            phase: "chunking",
            current: index + 1,
            total: filesToIndex.length,
            percentage: Math.round(((index + 1) / filesToIndex.length) * 40),
            message: `Processing file ${index + 1}/${filesToIndex.length}`,
          });

          const absoluteFilePath = join(absolutePath, filePath);
          const code = await fs.readFile(absoluteFilePath, "utf-8");

          // Check for secrets
          if (metadataExtractor.containsSecrets(code)) {
            changedFileHashes.set(filePath, this.hashContent(code));
            continue;
          }

          const language = metadataExtractor.extractLanguage(absoluteFilePath);
          const chunks = await chunker.chunk(code, absoluteFilePath, language);
          changedFileHashes.set(filePath, this.hashContent(code));

          for (const chunk of chunks) {
            const id = metadataExtractor.generateChunkId(chunk);
            allChunks.push({ chunk, id });
          }
        } catch (error) {
          this.log.error({ filePath, err: error }, "Failed to process file during reindex");
          throw error;
        }
      }

      stats.chunksAdded = allChunks.length;

      // Generate embeddings and store in batches
      const batchSize = this.config.batchSize;
      for (let i = 0; i < allChunks.length; i += batchSize) {
        const batch = allChunks.slice(i, i + batchSize);

        progressCallback?.({
          phase: "embedding",
          current: i + batch.length,
          total: allChunks.length,
          percentage: 40 + Math.round(((i + batch.length) / allChunks.length) * 30),
          message: `Generating embeddings ${i + batch.length}/${allChunks.length}`,
        });

        const texts = batch.map((b) => b.chunk.content);
        const embeddings = await this.embeddings.embedBatch(texts);

        const points = batch.map((b, idx) => ({
          id: b.id,
          vector: embeddings[idx].embedding,
          payload: {
            content: b.chunk.content,
            relativePath: relative(absolutePath, b.chunk.metadata.filePath),
            startLine: b.chunk.startLine,
            endLine: b.chunk.endLine,
            fileExtension: extname(b.chunk.metadata.filePath),
            language: b.chunk.metadata.language,
            codebasePath: absolutePath,
            chunkIndex: b.chunk.metadata.chunkIndex,
            ...this.gitPayload(identity),
            ...(b.chunk.metadata.name && { name: b.chunk.metadata.name }),
            ...(b.chunk.metadata.chunkType && {
              chunkType: b.chunk.metadata.chunkType,
            }),
          },
        }));

        progressCallback?.({
          phase: "storing",
          current: i + batch.length,
          total: allChunks.length,
          percentage: 70 + Math.round(((i + batch.length) / allChunks.length) * 30),
          message: `Storing chunks ${i + batch.length}/${allChunks.length}`,
        });

        if (this.config.enableHybridSearch) {
          const sparseGenerator = new BM25SparseVectorGenerator();
          const hybridPoints = points.map((point, idx) => ({
            ...point,
            sparseVector: sparseGenerator.generate(allChunks[i + idx].chunk.content),
          }));
          await this.qdrant.addPointsWithSparse(collectionName, hybridPoints);
        } else {
          await this.qdrant.addPoints(collectionName, points);
        }
      }

      // Update snapshot
      await synchronizer.updateSnapshotFromChanges(changes, changedFileHashes);

      stats.durationMs = Date.now() - startTime;
      this.log.info(
        {
          filesAdded: stats.filesAdded,
          filesModified: stats.filesModified,
          filesDeleted: stats.filesDeleted,
          chunksAdded: stats.chunksAdded,
          durationMs: stats.durationMs,
        },
        "Reindex complete"
      );
      return stats;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Incremental re-indexing failed: ${errorMessage}`, { cause: error });
    }
  }

  /**
   * Clear all indexed data for a codebase
   */
  async clearIndex(path: string): Promise<void> {
    this.log.info({ path }, "Clearing index");
    const absolutePath = await this.validatePath(path);
    const collectionName = getCodeCollectionName(await resolveCodebaseIdentity(absolutePath));
    const exists = await this.qdrant.collectionExists(collectionName);

    if (exists) {
      await this.qdrant.deleteCollection(collectionName);
    }

    // Also delete snapshot
    try {
      const synchronizer = this.synchronizerFactory(absolutePath, collectionName);
      await synchronizer.deleteSnapshot();
    } catch (_error) {
      // Ignore snapshot deletion errors
    }
  }

  private gitPayload(identity: CodebaseIdentity): Record<string, string> {
    return {
      ...(identity.repositoryRemote && { repositoryRemote: identity.repositoryRemote }),
      ...(identity.branch && { branch: identity.branch }),
      ...(identity.commit && { commit: identity.commit }),
    };
  }

  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
