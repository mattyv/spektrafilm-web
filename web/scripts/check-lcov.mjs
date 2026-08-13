import { readFile } from "node:fs/promises";

const records = [...(await readFile(process.argv[2], "utf8")).matchAll(/^DA:(\d+),(\d+)/gm)];
const missed = records.filter((record) => Number(record[2]) === 0).map((record) => record[1]);
if (!records.length || missed.length) throw new Error(`Uncovered source lines: ${missed.join(", ") || "no LCOV records"}`);
console.log(`Source line coverage: 100% (${records.length}/${records.length})`);
