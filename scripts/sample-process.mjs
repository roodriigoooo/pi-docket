#!/usr/bin/env node
/**
 * Sample a process's CPU and RSS over time using `ps`.
 *
 * Usage:
 *   node scripts/sample-process.mjs <pid> [durationSeconds=300] [intervalSeconds=5]
 *
 * Output:
 *   t=0s   cpu=2.4%   rss=128 MB
 *   t=5s   cpu=2.6%   rss=131 MB
 *   ...
 *   summary: cpu avg/max, rss avg/max, n samples
 */

import { spawnSync } from "node:child_process";

const pid = Number(process.argv[2]);
const durationSeconds = Number(process.argv[3] ?? 300);
const intervalSeconds = Number(process.argv[4] ?? 5);

if (!Number.isFinite(pid) || pid <= 0) {
	console.error("usage: node scripts/sample-process.mjs <pid> [durationSeconds=300] [intervalSeconds=5]");
	process.exit(2);
}

function samplePs(pid) {
	const result = spawnSync("ps", ["-o", "%cpu=,rss=", "-p", String(pid)], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const parts = result.stdout.trim().split(/\s+/);
	if (parts.length < 2) return undefined;
	const cpu = Number(parts[0]);
	const rssKb = Number(parts[1]);
	if (!Number.isFinite(cpu) || !Number.isFinite(rssKb)) return undefined;
	return { cpu, rssMb: rssKb / 1024 };
}

const samples = [];
const start = Date.now();
const endAt = start + durationSeconds * 1000;

console.log(`sampling pid=${pid} for ${durationSeconds}s @ ${intervalSeconds}s interval`);
const tick = () => {
	const elapsed = Math.round((Date.now() - start) / 1000);
	const s = samplePs(pid);
	if (!s) {
		console.log(`t=${elapsed}s  process not found, stopping`);
		summarise();
		process.exit(0);
	}
	samples.push(s);
	console.log(`t=${elapsed}s  cpu=${s.cpu.toFixed(1)}%  rss=${s.rssMb.toFixed(0)} MB`);
	if (Date.now() >= endAt) {
		summarise();
		process.exit(0);
	}
	setTimeout(tick, intervalSeconds * 1000);
};

function summarise() {
	if (samples.length === 0) {
		console.log("no samples collected");
		return;
	}
	const cpus = samples.map((s) => s.cpu);
	const rss = samples.map((s) => s.rssMb);
	const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
	const max = (xs) => xs.reduce((a, b) => Math.max(a, b), -Infinity);
	console.log("---");
	console.log(`samples=${samples.length}`);
	console.log(`cpu  avg=${avg(cpus).toFixed(2)}%  max=${max(cpus).toFixed(2)}%`);
	console.log(`rss  avg=${avg(rss).toFixed(0)} MB  max=${max(rss).toFixed(0)} MB`);
}

tick();
