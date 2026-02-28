import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const DRIZZLE_DIR = resolve(process.cwd(), "drizzle");
const JOURNAL_PATH = resolve(DRIZZLE_DIR, "meta/_journal.json");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

describe("Drizzle migration journal", () => {
  const journal: Journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8"));

  it("has sequential idx values starting at 0", () => {
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
    });
  });

  it("every journal entry has a matching SQL file", () => {
    for (const entry of journal.entries) {
      const sqlPath = resolve(DRIZZLE_DIR, `${entry.tag}.sql`);
      expect(existsSync(sqlPath), `Missing SQL file for ${entry.tag}`).toBe(true);
    }
  });

  it("every SQL file in drizzle/ has a journal entry", () => {
    const { readdirSync } = require("fs");
    const sqlFiles: string[] = readdirSync(DRIZZLE_DIR)
      .filter((f: string) => f.endsWith(".sql"))
      .map((f: string) => f.replace(".sql", ""));

    const journalTags = new Set(journal.entries.map((e) => e.tag));

    for (const file of sqlFiles) {
      expect(journalTags.has(file), `SQL file ${file}.sql not in journal`).toBe(true);
    }
  });

  it("migration 0009 uses DROP COLUMN IF EXISTS for idempotency", () => {
    const sql = readFileSync(resolve(DRIZZLE_DIR, "0009_drop_status_column.sql"), "utf-8");
    expect(sql).toContain("DROP COLUMN IF EXISTS");
    expect(sql).not.toMatch(/DROP COLUMN "status"/);
  });

  it("migration 0005 does not reference the dropped status column", () => {
    const sql = readFileSync(
      resolve(DRIZZLE_DIR, "0005_add_signature_unique_constraints.sql"),
      "utf-8",
    );
    expect(sql).not.toContain("status");
  });

  it("includes style columns migration (0010)", () => {
    const entry = journal.entries.find((e) => e.tag === "0010_add_style_columns");
    expect(entry).toBeDefined();

    const sql = readFileSync(resolve(DRIZZLE_DIR, "0010_add_style_columns.sql"), "utf-8");
    expect(sql).toContain("human_id");
    expect(sql).toContain("style_name");
  });
});
