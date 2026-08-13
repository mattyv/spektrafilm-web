import { readdir, readFile } from "node:fs/promises";
import v8ToIstanbul from "v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const map = libCoverage.createCoverageMap({});
for (const file of await readdir("coverage/e2e-raw")) {
  for (const entry of JSON.parse(await readFile(`coverage/e2e-raw/${file}`, "utf8"))) {
    if (!entry.url.includes("/src/main.ts")) continue;
    const converter = v8ToIstanbul(entry.url, 0, { source: entry.source });
    await converter.load();
    converter.applyCoverage(entry.functions);
    map.merge(converter.toIstanbul());
  }
}

const context = libReport.createContext({ dir: "coverage/browser", coverageMap: map });
reports.create("text", { maxCols: 1000 }).execute(context);
reports.create("lcovonly").execute(context);
const summary = map.getCoverageSummary();
if (summary.lines.pct !== 100) throw new Error(`Browser line coverage is ${summary.lines.pct}%, expected 100%`);
