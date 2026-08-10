import { createRequire } from "node:module";

export interface SqliteRunResult {
	readonly changes: number;
}

export interface SqliteStatement {
	run(...parameters: readonly unknown[]): SqliteRunResult;
	get(...parameters: readonly unknown[]): unknown;
	all(...parameters: readonly unknown[]): readonly unknown[];
}

export interface SqliteDatabase {
	exec(sql: string): void;
	query(sql: string): SqliteStatement;
	transaction<TValue>(operation: () => TValue): () => TValue;
	close(): void;
}

interface BunSqliteModule {
	readonly Database: new (path: string, options: { readonly create: boolean; readonly strict: boolean }) => SqliteDatabase;
}

interface NodeDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface NodeSqliteModule {
	readonly DatabaseSync: new (path: string) => NodeDatabase;
}

const runtimeRequire = createRequire(import.meta.url);

export function openSqliteDatabase(path: string): SqliteDatabase {
	if (process.versions.bun) {
		const sqliteModule = runtimeRequire("bun:sqlite") as BunSqliteModule;
		return new sqliteModule.Database(path, { create: true, strict: true });
	}

	const sqliteModule = runtimeRequire("node:sqlite") as NodeSqliteModule;
	const database = new sqliteModule.DatabaseSync(path);
	return {
		exec(sql) {
			database.exec(sql);
		},
		query(sql) {
			return database.prepare(sql);
		},
		transaction(operation) {
			return () => {
				database.exec("BEGIN");
				try {
					const value = operation();
					database.exec("COMMIT");
					return value;
				} catch (error) {
					database.exec("ROLLBACK");
					throw error;
				}
			};
		},
		close() {
			database.close();
		},
	};
}
