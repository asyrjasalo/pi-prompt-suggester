import { promises as fs } from "node:fs";
import type { SeedStore } from "../../app/ports/seed-store.js";
import type { SeedArtifact } from "../../domain/seed.js";
import { atomicWriteJson } from "./atomic-write.js";

export class JsonSeedStore implements SeedStore {
	public constructor(
		private readonly filePath: string,
		private readonly legacyFilePath?: string,
	) {}

	public async load(): Promise<SeedArtifact | null> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8");
			return JSON.parse(raw) as SeedArtifact;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				if (!this.legacyFilePath) return null;
				try {
					const raw = await fs.readFile(this.legacyFilePath, "utf8");
					return JSON.parse(raw) as SeedArtifact;
				} catch (legacyError) {
					if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw new Error(`Failed to read legacy seed file ${this.legacyFilePath}: ${(legacyError as Error).message}`);
				}
			}
			throw new Error(`Failed to read seed file ${this.filePath}: ${(error as Error).message}`);
		}
	}

	public async save(seed: SeedArtifact): Promise<void> {
		await atomicWriteJson(this.filePath, seed);
	}
}
